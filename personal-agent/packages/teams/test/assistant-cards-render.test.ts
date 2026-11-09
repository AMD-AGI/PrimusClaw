// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The card of a result that waits (Accept and Stop, version pinned), as Teams shows it (teams/tests/test_assistant_cards.py, the
 * tests that read the cards): the say planner, the proactive delivery and the presses as the worker wires them, against the
 * work-items Claw of the Python fake, every view drawn by the Teams renderers. Every press ends two ways: the pressed card is
 * replaced and the outcome is said in a new message (Teams on a phone does not redraw an edited card).
 */
import assert from "node:assert/strict";
import { it } from "node:test";

import { ClawUnreachable, type JsonObject } from "@primusclaw/personal-agent";

import { CardsWorld } from "../../../test-support/assistant/cards-world.js";
import { body, bodyText, opOf, render, str, titles, valid } from "../../../test-support/assistant/teams-cards.js";

const KEY = "ak-alice";

function world(): CardsWorld {
  return CardsWorld.start({ render });
}

/** A result that waits: the item is `ready` and Claw's `assistant.say` for it was delivered; its card's buttons. */
async function readyCard(
  w: CardsWorld,
  o: { title?: string; say?: string; version?: number } = {},
): Promise<{ item: string; buttons: JsonObject[] }> {
  const item = w.server.addItem(KEY, o.title ?? "Fix the flaky test", {
    board: "needs_you",
    last: "ready",
    version: o.version ?? 1,
  });
  assert.equal(
    await w.push(w.server.say(KEY, o.say ?? "Done: the test no longer flakes. PR #12 is open.", item)),
    "delivered",
  );
  return { item, buttons: w.buttons() };
}

/** The card an out message shows. */
function cardOf(w: CardsWorld, at: number): JsonObject {
  const out = w.sent()[at];
  assert.ok(out !== undefined, `nothing sent at ${String(at)}`);
  const card = render(out.message, out.op);
  assert.ok(card !== undefined, `no card at ${String(at)}`);
  return card;
}

function textOf(w: CardsWorld, at: number): string {
  const body = w.sent()[at]?.message.body;
  return body?.type === "text" ? body.text : body?.type === "rich" ? body.markdown : "";
}

it("a result that waits is a new card with accept for that version and stop", async () => {
  const w = world();
  const { item, buttons } = await readyCard(w, { version: 2 });
  const sent = w.sent();
  assert.deepEqual(
    sent.map((o) => o.op),
    ["send"],
  );
  const card = w.lastCard();
  valid(card);
  const words = bodyText(card);
  assert.ok(words.startsWith("⚠️ #1 Fix the flaky test"), words);
  assert.ok(words.includes("PR #12 is open") && words.includes("ask for changes"), words);
  assert.deepEqual(titles(buttons), ["Accept v2", "Stop"]);
  assert.equal(card["version"], "1.5");
  assert.ok((card["actions"] as JsonObject[]).length <= 3);
  for (const b of buttons) {
    // a button carries nothing but the id of the record the worker made: not the item, not the version
    const data = b["data"] as JsonObject;
    assert.deepEqual(Object.keys(data).sort(), ["card", "op", "primusclaw"]);
    assert.equal(data["primusclaw"], "work");
    assert.equal(b["type"], "Action.Execute");
  }
  const recorded = w.store.assistantCards.getAssistantCard(str(opOf(buttons, "accept")["card"]));
  assert.deepEqual(
    [recorded?.userId, recorded?.itemId, recorded?.version, recorded?.canAccept, recorded?.state],
    ["aad-a", item, 2, true, "open"],
  );
});

it("a long say about a result arrives whole and its card follows with the buttons", async () => {
  // A say longer than a card holds (WORK_TEXT_MAX) is never clipped: it arrives as a message, whole, and the card with Accept
  // and Stop follows it.
  const w = world();
  const say = "First line.\nSecond line.\n\nThird.\n" + "x".repeat(900);
  const { buttons } = await readyCard(w, { say });
  assert.deepEqual(new Set(buttons.map((b) => (b["data"] as JsonObject)["op"])), new Set(["accept", "stop"]));
  const said = w.texts().filter((t) => t.includes("First line."));
  assert.ok(said[0]?.includes("x".repeat(900)), "the whole say, as a message");
  assert.ok(!JSON.stringify(body(w.lastCard())).includes("x".repeat(100)), "not again in the card");
});

it("a say of many short lines is never clipped by the card layout", async () => {
  // A card lays every line out as a paragraph, which makes a reply of many short lines longer than it is: such a reply goes
  // as a message, whole, and the card follows (250 lines of one character: 499 characters, 997 laid out).
  const w = world();
  const say = Array.from({ length: 250 }, () => "x").join("\n");
  assert.ok(say.length <= 600);
  await readyCard(w, { say });
  const said = w.texts().filter((t) => (t.match(/x/g) ?? []).length >= 250);
  assert.ok(said.length > 0, "the whole reply, as a message");
  assert.ok((JSON.stringify(body(w.lastCard())).match(/x/g) ?? []).length < 50);
});

// --- Accept --------------------------------------------------------------------------------------------------------------------

it("accept accepts that version and says so in the card and in a new message", async () => {
  const w = world();
  const { item, buttons } = await readyCard(w);
  const before = w.mark();
  await w.click(opOf(buttons, "accept"));
  const row = w.server.row(item);
  assert.deepEqual([row.boardState, row.outcome, row.acceptedVersion], ["done", "accepted", 1]);
  assert.ok(
    w.server.calls.some(([m, p, u]) => m === "POST" && p === `/v1/work-items/${item}/accept` && u === "u-alice"),
  );
  const out = w.since(before);
  assert.deepEqual(
    out.map((o) => o.op),
    ["update", "send"],
  );
  assert.equal(out[0]?.id, "card-1");
  const edit = cardOf(w, before);
  assert.ok(bodyText(edit).includes("Accepted #1 Fix the flaky test"), bodyText(edit));
  assert.deepEqual(edit["actions"] ?? [], []);
  assert.equal(textOf(w, before + 1), "Accepted #1 Fix the flaky test (version 1).");
  assert.equal(w.store.assistantCards.getAssistantCard(str(opOf(buttons, "accept")["card"]))?.state, "done");
});

it("a result that moved on is not accepted and the card for the new one is a new message", async () => {
  // The card says v1; the worker has since made v2. Accept on the old card accepts nothing: the person has not seen v2.
  const w = world();
  const { item, buttons } = await readyCard(w);
  w.server.reopen(item); // the user asked for changes ...
  w.server.report(item, "ready", "Now with the changes"); // ... and the worker made a second result
  const before = w.mark();
  await w.click(opOf(buttons, "accept"));
  const row = w.server.row(item);
  assert.deepEqual([row.boardState, row.acceptedVersion, row.resultVersion], ["needs_you", null, 2]);
  const out = w.since(before);
  assert.deepEqual(
    out.map((o) => o.op),
    ["update", "send"],
  );
  assert.ok(bodyText(cardOf(w, before)).includes("The result was updated to version 2"));
  const card = cardOf(w, before + 1);
  valid(card);
  assert.deepEqual(titles(w.buttons(card)), ["Accept v2", "Stop"]);
  assert.ok(bodyText(card).includes("version 2"), bodyText(card));
  assert.ok(bodyText(card).includes("Now with the changes")); // what the new version is, from Claw's summary
  await w.click(opOf(w.buttons(card), "accept")); // and the new card accepts v2
  assert.deepEqual([w.server.row(item).outcome, w.server.row(item).acceptedVersion], ["accepted", 2]);
});

it("the old cards of one item cannot accept what they never showed", async () => {
  const w = world();
  const { item, buttons: first } = await readyCard(w);
  w.server.reopen(item);
  w.server.report(item, "ready", "second");
  assert.equal(await w.push(w.server.say(KEY, "second result", item)), "delivered");
  const second = w.buttons();
  assert.deepEqual(titles(second), ["Accept v2", "Stop"]);
  assert.notEqual(opOf(first, "accept")["card"], opOf(second, "accept")["card"]);
  await w.click(opOf(first, "accept"));
  assert.equal(w.server.row(item).boardState, "needs_you");
});

it("an item that is no longer acceptable says where it stands and nothing is accepted", async () => {
  const cases: [(w: CardsWorld, item: string) => void, string][] = [
    [
      (w, i) => {
        w.server.reopen(i);
      },
      "#1 Fix the flaky test is being worked on again. I will tell you when there is a new result.",
    ],
    [
      (w, i) => Object.assign(w.server.row(i), { boardState: "done", outcome: "stopped" }),
      "#1 Fix the flaky test is already stopped.",
    ],
    [
      (w, i) => Object.assign(w.server.row(i), { boardState: "done", outcome: "dropped" }),
      "#1 Fix the flaky test is already dropped.",
    ],
    [
      (w, i) => {
        w.server.report(i, "failed", "it broke");
      },
      "#1 Fix the flaky test is waiting for you.",
    ],
  ];
  for (const [arrange, reply] of cases) {
    const w = world();
    const { item, buttons } = await readyCard(w);
    arrange(w, item);
    const stateBefore = w.server.row(item).boardState;
    const before = w.mark();
    await w.click(opOf(buttons, "accept"));
    assert.equal(w.since(before).length, 2);
    assert.equal(textOf(w, before + 1), reply);
    assert.ok(bodyText(cardOf(w, before)).includes(reply));
    assert.equal(w.server.row(item).acceptedVersion, null);
    assert.equal(w.server.row(item).boardState, stateBefore);
  }
});

it("accept on a card that never had it is refused", async () => {
  const w = world();
  const item = w.server.addItem(KEY, "Migrate", {
    board: "needs_you",
    last: "waiting",
    question: "Which branch?",
    version: 1,
  });
  await w.showBoard();
  const buttons = w.buttons();
  assert.deepEqual(titles(buttons), ["Stop"]);
  await w.click({ ...(buttons[0]?.["data"] as JsonObject), op: "accept" });
  assert.ok(w.said().at(-1)?.includes("no longer valid"));
  assert.equal(w.server.row(item).boardState, "needs_you");
});

it("when claw cannot take it the card comes back as a new message that can be pressed", async () => {
  for (const failure of [500, 503, [502, "bad_gateway"] as const]) {
    const w = world();
    const { item, buttons } = await readyCard(w);
    w.server.fail.set("accept", failure);
    const before = w.mark();
    await w.click(opOf(buttons, "accept"));
    assert.equal(w.since(before).length, 2);
    const edit = cardOf(w, before);
    assert.ok(bodyText(edit).includes("The card below lets you try again"), bodyText(edit));
    assert.deepEqual(w.buttons(edit), []);
    const again = cardOf(w, before + 1);
    assert.ok(bodyText(again).includes("PrimusClaw could not do that"));
    assert.deepEqual(titles(w.buttons(again)), ["Accept v1", "Stop"]);
    assert.equal(w.server.row(item).boardState, "needs_you");
    w.server.fail.delete("accept");
    await w.click(opOf(w.buttons(again), "accept"));
    assert.equal(w.server.row(item).outcome, "accepted");
  }
});

it("when claw cannot be reached the card can be pressed again", async () => {
  const w = world();
  const { item, buttons } = await readyCard(w);
  w.server.fail.set("accept", new ClawUnreachable("network", "accept"));
  await w.click(opOf(buttons, "accept"));
  assert.ok(bodyText(w.lastCard()).includes("could not reach PrimusClaw"));
  assert.deepEqual(titles(w.buttons()), ["Accept v1", "Stop"]);
  w.server.fail.delete("accept");
  await w.click(opOf(w.buttons(), "accept"));
  assert.equal(w.server.row(item).outcome, "accepted");
});

// --- Stop ------------------------------------------------------------------------------------------------------------------------

it("stop closes the item stops its worker and says so twice", async () => {
  const w = world();
  const { item, buttons } = await readyCard(w);
  const before = w.mark();
  await w.click(opOf(buttons, "stop"));
  const row = w.server.row(item);
  assert.deepEqual([row.boardState, row.outcome], ["done", "stopped"]);
  assert.deepEqual(w.server.stoppedWorkers, [row.workerSessionId]);
  const out = w.since(before);
  assert.deepEqual(
    out.map((o) => o.op),
    ["update", "send"],
  );
  assert.ok(bodyText(cardOf(w, before)).includes("Stopped #1 Fix the flaky test"));
  assert.equal(textOf(w, before + 1), "Stopped #1 Fix the flaky test.");
});

it("a stop that closed the item but could not interrupt its worker can be pressed again", async () => {
  const w = world();
  const { item, buttons } = await readyCard(w);
  w.server.interruptFails = true;
  await w.click(opOf(buttons, "stop"));
  assert.equal(w.server.row(item).outcome, "stopped");
  assert.deepEqual(w.server.stoppedWorkers, []); // closed first, worker not yet stopped
  assert.ok(
    (w.said().at(-1) ?? "").includes("could not stop its work") ||
      bodyText(w.lastCard()).includes("could not stop its work"),
  );
  const again = w.lastCard();
  assert.deepEqual(titles(w.buttons(again)), ["Accept v1", "Stop"]);
  w.server.interruptFails = false;
  await w.click(opOf(w.buttons(again), "stop"));
  assert.deepEqual(w.server.stoppedWorkers, [w.server.row(item).workerSessionId]);
  assert.equal(w.said().at(-1), "Stopped #1 Fix the flaky test.");
});
