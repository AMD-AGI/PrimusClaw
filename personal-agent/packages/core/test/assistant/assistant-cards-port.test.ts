// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A result that waits, its Accept and Stop, and `/board` (teams/tests/test_assistant_cards.py, the tests that read no card's
 * words): against the work-items Claw of the Python fake, driven through the say planner, the proactive delivery, the board and
 * the presses as the worker wires them. What the router does around them (reading the presser's key, settling the pressed card)
 * is done by the world as the router does it. The tests that read the cards themselves are in
 * teams/test/assistant-cards-render.test.ts.
 */
import assert from "node:assert/strict";
import { it } from "node:test";

import { ALICE, BOB, CardsWorld } from "../../../../test-support/assistant/cards-world.js";
import type { JsonObject } from "../../src/json.js";

const KEY = "ak-alice";

/** A result that waits: the item is `ready` and Claw's `assistant.say` for it was delivered; its card's id. */
async function readyCard(
  w: CardsWorld,
  o: { title?: string; say?: string; version?: number } = {},
): Promise<{ item: string; card: string }> {
  const item = w.server.addItem(KEY, o.title ?? "Fix the flaky test", {
    board: "needs_you",
    last: "ready",
    version: o.version ?? 1,
  });
  assert.equal(
    await w.push(w.server.say(KEY, o.say ?? "Done: the test no longer flakes. PR #12 is open.", item)),
    "delivered",
  );
  const view = w.views().at(-1);
  assert.ok(view?.name === "workCard");
  return { item, card: view.model.cardId };
}

function press(card: string, op: string): JsonObject {
  return { primusclaw: "work", op, card };
}

function posts(w: CardsWorld): string[] {
  return w.calledPaths().filter((c) => c.startsWith("POST /v1/work-items/"));
}

it("a say about an item that does not wait for acceptance is only a message", async () => {
  const w = CardsWorld.start();
  const item = w.server.addItem(KEY, "Migrate", { board: "needs_you", last: "waiting", question: "Which branch?" });
  assert.equal(await w.push(w.server.say(KEY, "Which branch should I use for #1?", item)), "delivered");
  const sent = w.sent();
  assert.equal(sent.length, 1);
  assert.notEqual(sent[0]?.message.body.type, "view");
  assert.equal(w.cardsRepo.added, 0);
});

it("the version pressed is the one on the card and what the click says is not believed", async () => {
  const w = CardsWorld.start();
  const { item, card } = await readyCard(w);
  const other = w.server.addItem(KEY, "Other", { board: "needs_you", last: "ready", version: 5 });
  await w.click({ ...press(card, "accept"), item_id: other, version: 5, item: other });
  assert.equal(w.server.row(item).outcome, "accepted");
  assert.equal(w.server.row(other).boardState, "needs_you");
  assert.deepEqual(
    w.server.calls.filter(([, path]) => path.endsWith("/accept")),
    [["POST", `/v1/work-items/${item}/accept`, "u-alice"]],
  );
});

it("two presses on one card carry out one", async () => {
  const w = CardsWorld.start();
  const { card } = await readyCard(w);
  // a double tap, and a Stop on the same card at the same moment
  await Promise.all([w.click(press(card, "accept")), w.click(press(card, "accept")), w.click(press(card, "stop"))]);
  assert.equal(posts(w).length, 1);
  const said = w.said();
  const count = (line: string) => said.filter((s) => s === line).length;
  assert.equal(count("Accepted #1 Fix the flaky test (version 1).") + count("Stopped #1 Fix the flaky test."), 1);
  // the other two are told, each in the card and in a message
  assert.equal(said.filter((s) => s.includes("already used")).length, 4);
});

it("a card pressed again after it was used is refused without asking claw", async () => {
  const w = CardsWorld.start();
  const { card } = await readyCard(w);
  await w.click(press(card, "accept"));
  const calls = w.server.calls.length;
  await w.click(press(card, "accept"), { cardId: "card-2" });
  const last = w.said().at(-1) ?? "";
  assert.equal(w.server.calls.length, calls);
  assert.ok(last.includes("already used") && last.includes("/board"), last);
});

it("a card that is forged or someone elses does nothing", async () => {
  const w = CardsWorld.start();
  w.link(BOB);
  const { item, card } = await readyCard(w);
  const calls = w.server.calls.length;
  const presses: [JsonObject, string][] = [
    [{ ...press(card, "accept"), card: "forged" }, ALICE],
    [{ primusclaw: "work", op: "accept" }, ALICE],
    [press(card, "accept"), BOB], // Bob presses Alice's card
    [{ ...press(card, "accept"), op: "frobnicate" }, ALICE],
  ];
  for (const [data, user] of presses) {
    await w.click(data, { user });
    assert.ok(w.said().at(-1)?.includes("no longer valid"), JSON.stringify(data));
  }
  assert.equal(w.server.calls.length, calls);
  assert.equal(w.server.row(item).boardState, "needs_you");
  assert.equal(w.store.assistantCards.getAssistantCard(card)?.state, "open"); // and Alice's card still works
  await w.click(press(card, "accept"));
  assert.equal(w.server.row(item).outcome, "accepted");
});

it("a task claw does not know any more is said so and the card is done", async () => {
  const w = CardsWorld.start();
  const { item, card } = await readyCard(w);
  w.server.items.delete(item);
  await w.click(press(card, "accept"));
  assert.ok(w.said().at(-1)?.includes("could not find that task"));
  assert.equal(w.store.assistantCards.getAssistantCard(card)?.state, "done");
});

it("a rejected key is told what to do", async () => {
  const w = CardsWorld.start();
  const { card } = await readyCard(w);
  w.server.fail.set("accept", 401);
  await w.click(press(card, "accept"));
  assert.ok(w.said().at(-1)?.includes("rejected your linked key"));
});

it("a press by the user is made with their own key and claw is the second check", async () => {
  const w = CardsWorld.start();
  w.link(BOB);
  const { item } = await readyCard(w);
  // a record that names Alice's item for Bob: Claw refuses it (404)
  const bobCard = w.store.assistantCards.addAssistantCard(BOB, item, 1, true);
  await w.click(press(bobCard, "accept"), { user: BOB });
  assert.ok(w.server.calls.some(([m, p, u]) => m === "POST" && p === `/v1/work-items/${item}/accept` && u === "u-bob"));
  assert.equal(w.server.row(item).boardState, "needs_you");
  assert.ok(w.said().at(-1)?.includes("could not find that task"));
});

it("the cards still work when the switch is turned off", async () => {
  // Turning the assistant off is a way back, not a way to leave results unaccepted.
  const w = CardsWorld.start();
  const { item, card } = await readyCard(w);
  w.assistant = false;
  await w.click(press(card, "accept"));
  assert.equal(w.server.row(item).outcome, "accepted");
});

it("stop on an item that is done another way says so", async () => {
  const w = CardsWorld.start();
  const { item, card } = await readyCard(w);
  Object.assign(w.server.row(item), { boardState: "done", outcome: "accepted" });
  await w.click(press(card, "stop"));
  assert.equal(w.said().at(-1), "#1 Fix the flaky test is already accepted.");
  assert.deepEqual(w.server.stoppedWorkers, []);
});

// --- /board ----------------------------------------------------------------------------------------------------------------------

it("a board card accepts like any other", async () => {
  const w = CardsWorld.start();
  const item = w.server.addItem(KEY, "Fix the flaky test", { board: "needs_you", last: "ready", version: 1 });
  await w.showBoard();
  const view = w.views().at(-1);
  assert.ok(view?.name === "workCard");
  await w.click(press(view.model.cardId, "accept"));
  assert.equal(w.server.row(item).outcome, "accepted");
});

it("an empty board says so", async () => {
  const w = CardsWorld.start();
  await w.showBoard();
  assert.ok(w.said().at(-1)?.startsWith("You have no tasks yet."));
});

it("the board says what is wrong when it cannot be read", async () => {
  const cases: [number, string][] = [
    [404, "The task board is not available yet."],
    [503, "I could not read your tasks just now."],
    [401, "rejected your linked key"],
  ];
  for (const [failure, said] of cases) {
    const w = CardsWorld.start();
    w.server.fail.set("list", failure);
    await w.showBoard();
    assert.ok(w.said().at(-1)?.includes(said), `${String(failure)}: ${String(w.said().at(-1))}`);
  }
});

it("the board is not there for a chat that is not with the assistant", async () => {
  // (that the router then starts a session's turn with "/board" is the router's: W4)
  const w = CardsWorld.start({ assistant: false });
  w.server.addItem(KEY, "x");
  await w.showBoard(); // asked for directly it says it is not there
  assert.equal(w.said().at(-1), "The task board is not available yet.");
  assert.deepEqual(
    w.server.calls.filter(([, path]) => path.startsWith("/v1/work-items")),
    [],
  );
});

it("a claw without the list shows the board as before", async () => {
  const w = CardsWorld.start();
  w.server.askedRoute = false;
  w.server.addItem(KEY, "Write the docs");
  await w.showBoard();
  const board = w.views()[0];
  assert.ok(board?.name === "board");
  assert.deepEqual(board.model.asked, []); // (no "Asked of others" part: the card draws one only for some)
  assert.equal(board.model.items.length, 1);
  w.server.items.clear();
  await w.showBoard();
  assert.ok(w.said().at(-1)?.startsWith("You have no tasks yet."));
});
