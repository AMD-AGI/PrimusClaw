// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The board's own buttons (Accept all, Retry), "Auto-reply to PR comments" under a result's card, and what `/board` puts to the
 * person for an agent on their machine (teams/tests/test_board_retry_accept_all.py and test_board_remote_ask.py, the tests that
 * read no card's words): against the work-items Claw of the Python fake. A press carries what the board's or the card's button
 * carries: the ids of the cards the worker recorded for it. The tests that read the cards are in
 * teams/test/assistant-cards-render-board.test.ts.
 */
import assert from "node:assert/strict";
import { it } from "node:test";

import { ALICE, BOB, CardsWorld } from "../../../../test-support/assistant/cards-world.js";
import { boardText } from "../../src/locales/assistant-board.js";
import { workClickText } from "../../src/locales/work-clicks.js";
import type { JsonObject } from "../../src/json.js";
import type { TokenExchange } from "../../src/plugins/token-exchange.js";
import { err, ok } from "../../src/result.js";

const KEY = "ak-alice";
const PULL = "https://github.com/acme/app/pull/12";
const SID = "5e55a5e5-0000-4000-8000-000000000001";
const CLAUDE_OPTIONS = [
  { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
  { optionId: "allow-with-updates", name: "Allow and update my settings", kind: "allow_always" },
  { optionId: "reject", name: "Reject", kind: "reject_once" },
];

/** Alice is bound at the identity service; anyone else is not. */
const exchange: TokenExchange = {
  enabled: true,
  tokenFor: (userId) => Promise.resolve(userId === ALICE ? ok("tok-alice") : err({ kind: "not_bound" as const })),
  bindingRequest: () => Promise.resolve(err({ kind: "exchange_unavailable" as const })),
  invalidate: () => undefined,
};

/** The last board view sent or edited in. */
function lastBoard(w: CardsWorld) {
  const board = [...w.views()].reverse().find((v) => v.name === "board");
  assert.ok(board?.name === "board", "no board");
  return board.model;
}

function textOf(w: CardsWorld, at: number): string {
  const body = w.sent()[at]?.message.body;
  return body?.type === "text" ? body.text : "";
}

function acceptAll(cards: readonly string[]): JsonObject {
  return { primusclaw: "work", op: "accept_all", cards: [...cards] };
}

function retry(card: string): JsonObject {
  return { primusclaw: "work", op: "retry", card };
}

function acceptCalls(w: CardsWorld): number {
  return w.server.calls.filter(([, path]) => path.endsWith("/accept")).length;
}

it("one result is no accept all and no failed task is no retry", async () => {
  const w = CardsWorld.start();
  w.server.addItem(KEY, "Fix A", { board: "needs_you", last: "ready", version: 1 });
  w.server.addItem(KEY, "Run", { board: "in_progress", last: "progress" });
  await w.showBoard();
  const board = lastBoard(w);
  assert.deepEqual([board.accept, board.retry], [[], []]); // (no buttons on the board)
});

it("accept all accepts what the board showed and nothing newer", async () => {
  const w = CardsWorld.start();
  const s = w.server;
  const a = s.addItem(KEY, "Fix A", { board: "needs_you", last: "ready", version: 1 });
  const b = s.addItem(KEY, "Fix B", { board: "needs_you", last: "ready", version: 1 });
  await w.showBoard();
  const pressed = acceptAll(lastBoard(w).accept);
  s.report(b, "ready", "a newer result"); // B moved on to v2 after the board was drawn: v2 was never shown
  const before = w.mark();
  await w.click(pressed);
  assert.deepEqual([s.row(a).outcome, s.row(a).acceptedVersion], ["accepted", 1]);
  assert.deepEqual([s.row(b).boardState, s.row(b).acceptedVersion], ["needs_you", null]);
  const out = w.since(before);
  assert.deepEqual(
    out.map((o) => o.op),
    ["update", "send"],
  ); // the board as it is now, and the outcome said
  assert.equal(out[0]?.message.body.type === "view" && out[0].message.body.view.name, "board");
  const said = textOf(w, before + 1);
  assert.ok(said.includes("已接受 1 项：#1 Fix A") && said.includes("另有 1 项没有接受"), said);
  // Pressed again: every card it names is used, so Claw is not asked.
  const calls = acceptCalls(w);
  await w.click(pressed);
  assert.equal(acceptCalls(w), calls);
});

it("accept all with cards of someone else does nothing", async () => {
  const w = CardsWorld.start();
  w.link(BOB);
  w.server.addItem(KEY, "Fix A", { board: "needs_you", last: "ready", version: 1 });
  w.server.addItem(KEY, "Fix B", { board: "needs_you", last: "ready", version: 1 });
  await w.showBoard();
  await w.click(acceptAll(lastBoard(w).accept), { user: BOB });
  assert.ok([...w.server.items.values()].every((i) => i.boardState === "needs_you"));
  assert.equal(acceptCalls(w), 0);
});

it("retry runs a failed task again once", async () => {
  const w = CardsWorld.start();
  const failed = w.server.addItem(KEY, "Build", { board: "needs_you", last: "failed" });
  await w.showBoard();
  const [shown] = lastBoard(w).retry;
  assert.ok(shown !== undefined);
  const before = w.mark();
  await w.click(retry(shown.cardId));
  assert.deepEqual(w.server.retried, [failed]);
  assert.equal(w.server.row(failed).boardState, "in_progress");
  assert.ok(textOf(w, w.sent().length - 1).includes("已重新开始 #1 Build"), String(w.since(before).length));
  await w.click(retry(shown.cardId)); // a second press: the card is used, Claw is not asked again
  assert.deepEqual(w.server.retried, [failed]);
});

it("retry of a stopped task with no slot left says why and changes nothing", async () => {
  const w = CardsWorld.start();
  const s = w.server;
  s.maxActive = 1;
  const stopped = s.addItem(KEY, "Deploy", { board: "done", outcome: "stopped" });
  s.addItem(KEY, "Running", { board: "in_progress", last: "progress" });
  await w.showBoard();
  const [shown] = lastBoard(w).retry;
  assert.ok(shown !== undefined);
  await w.click(retry(shown.cardId));
  assert.deepEqual(s.retried, []);
  assert.equal(s.row(stopped).outcome, "stopped");
  assert.ok(textOf(w, w.sent().length - 1).includes("进行中的任务已经到上限"));
});

it("retry on a claw without it says so", async () => {
  const w = CardsWorld.start();
  w.server.addItem(KEY, "Build", { board: "needs_you", last: "failed" });
  await w.showBoard();
  const [shown] = lastBoard(w).retry;
  assert.ok(shown !== undefined);
  w.server.fail.set("retry", 404); // (a Claw before retry: the route itself is not there)
  const before = w.mark();
  await w.click(retry(shown.cardId));
  assert.equal(textOf(w, w.sent().length - 1), workClickText.in("en").noRetry);
  const edited = w.since(before)[0]?.message.body;
  assert.ok(edited?.type === "view" && edited.view.name === "board");
  assert.deepEqual(edited.view.model.retry, []); // the board, without Retry
  await w.showBoard(); // and it offers none for a while: nobody presses a button that cannot work
  assert.deepEqual(lastBoard(w).retry, []);
  w.advance(6 * 3600 + 1);
  await w.showBoard();
  assert.notDeepEqual(lastBoard(w).retry, []);
});

/** A result whose say names a pull request: its card's id. */
async function prCard(w: CardsWorld, say = `Done: PR #12 is open, ${PULL}.`): Promise<{ item: string; card: string }> {
  const item = w.server.addItem(KEY, "Fix the flaky test", { board: "needs_you", last: "ready", version: 1 });
  assert.equal(await w.push(w.server.say(KEY, say, item)), "delivered");
  const view = w.views().at(-1);
  assert.ok(view?.name === "workCard");
  assert.equal(view.model.watch, true); // (its card offers to watch it)
  return { item, card: view.model.cardId };
}

it("watch without a reported pull request or without sign in subscribes nothing", async () => {
  const signedIn = CardsWorld.start({ exchange });
  signedIn.server.attendedTokens = new Set(["tok-alice"]);
  const first = await prCard(signedIn);
  await signedIn.click({ primusclaw: "work", op: "watch", card: first.card }); // Claw has no pull request on record for it
  assert.deepEqual(signedIn.server.subscriptions, []);
  assert.equal(signedIn.texts().at(-1), workClickText.in("en").noPull({ label: "#1 Fix the flaky test" }));
  const w = CardsWorld.start(); // no identity service: a linked key is never used for it
  const { item, card } = await prCard(w);
  w.server.reported.set(item, [PULL]);
  await w.click({ primusclaw: "work", op: "watch", card });
  assert.deepEqual(w.server.subscriptions, []);
  assert.equal(w.texts().at(-1), workClickText.in("en").watchNeedsSignIn);
});

it("turn off auto reply on someone elses card does nothing", async () => {
  const w = CardsWorld.start({ exchange });
  w.server.attendedTokens = new Set(["tok-alice"]);
  const { item } = await prCard(w);
  w.server.reported.set(item, [PULL]);
  await w.click({ primusclaw: "work", op: "unwatch", card: "forged" });
  assert.deepEqual(w.server.watchEnded, []);
  assert.equal(w.texts().at(-1), boardText.in("en").cardGone);
});

it("a watch the item started with replies off is turned on and said so not as on already", async () => {
  // Claw watches a pull request an item's brief names from the start, with replies off; the press turns them on.
  const w = CardsWorld.start({ exchange });
  w.server.attendedTokens = new Set(["tok-alice"]);
  const { item, card } = await prCard(w);
  w.server.reported.set(item, [PULL]);
  w.server.subscriptions.push({ itemId: item, pr: PULL, reply: false, token: KEY });
  const before = w.mark();
  await w.click({ primusclaw: "work", op: "watch", card });
  assert.equal(w.server.subscriptions[0]?.reply, true);
  assert.equal(w.server.subscriptions.length, 1);
  const said = textOf(w, before + 1);
  assert.ok(
    said.startsWith(`已开启：${PULL} 上的新评论会自动交给 #1 Fix the flaky test 处理，并以你的身份直接回复`),
    said,
  );
  assert.ok(!said.includes("本来就开着"));
});

// --- test_board_remote_ask.py ----------------------------------------------------------------------------------------------------

function waitingItem(w: CardsWorld, action = "act-1"): string {
  return w.server.addItem(KEY, "dev-pod claude：跑 make test", {
    board: "needs_you",
    last: "waiting",
    question: "等你批准：Run make test",
    kind: "remote",
    params: { session_id: SID, waiting: [action], machine: "dev-pod", agent_id: "claude" },
  });
}

function permission(w: CardsWorld, userId: string, actionId: string, tool: string, expiresAt: number): void {
  w.store.remotePermissions.saveRemotePermission({
    userId,
    sessionId: SID,
    actionId,
    tool,
    options: CLAUDE_OPTIONS,
    expiresAt,
  });
}

it("the board puts a waiting request to the person with its own buttons", async () => {
  // (the approval card itself, its words and its buttons, is the remote agents' view: W6b)
  const w = CardsWorld.start();
  permission(w, ALICE, "act-1", "Run make test", w.store.now() + 600);
  waitingItem(w);
  await w.showBoard();
  assert.equal(w.asks.length, 1);
  const [ask] = w.asks;
  assert.deepEqual(
    (ask?.options as { optionId: string }[]).map((o) => o.optionId),
    ["allow-once", "allow-with-updates", "reject"],
  );
  assert.deepEqual([ask?.sessionId, ask?.ask["action_id"], ask?.ask["tool"]], [SID, "act-1", "Run make test"]);
  assert.deepEqual([ask?.machine, ask?.agent, ask?.about], ["dev-pod", "claude", "#1 dev-pod claude：跑 make test"]);
  assert.equal(w.views().filter((v) => v.name === "workCard").length, 0); // its card, in the place of the item's own
});

it("a request answered run out or never shown here leaves the items own card", async () => {
  const w = CardsWorld.start();
  waitingItem(w, "act-never-shown");
  permission(w, ALICE, "act-answered", "Edit a.go", w.store.now() + 600);
  w.store.remotePermissions.closeRemotePermission(SID, "act-answered", "decided");
  waitingItem(w, "act-answered");
  permission(w, ALICE, "act-old", "Edit b.go", w.store.now() - 1);
  waitingItem(w, "act-old");
  permission(w, BOB, "act-bobs", "Edit c.go", w.store.now() + 600);
  waitingItem(w, "act-bobs");
  await w.showBoard();
  assert.deepEqual(w.asks, []);
  const own = w.views().filter((v) => v.name === "workCard" && v.model.text.includes("等你批准"));
  assert.ok(own.length >= 4, String(own.length));
});
