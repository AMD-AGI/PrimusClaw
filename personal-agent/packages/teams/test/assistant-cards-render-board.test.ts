// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `/board` and its own buttons, and "Auto-reply to PR comments" under a result's card, as Teams shows them
 * (teams/tests/test_assistant_cards.py's board tests and test_board_retry_accept_all.py, the tests that read the cards): the
 * board, the proactive delivery and the presses as the worker wires them, against the work-items Claw of the Python fake, every
 * view drawn by the Teams renderers.
 */
import assert from "node:assert/strict";
import { it } from "node:test";

import {
  BOARD_CARDS,
  BOARD_LINES,
  BOARD_SHOWN,
  err,
  ok,
  type JsonObject,
  type TokenExchange,
} from "@primusclaw/personal-agent";

import { ALICE, CardsWorld } from "../../../test-support/assistant/cards-world.js";
import {
  BAR,
  badgesOf,
  body,
  bodyText,
  columnText,
  idOf,
  opOf,
  render,
  str,
  texts,
  titles,
  walk,
} from "../../../test-support/assistant/teams-cards.js";

import { valid } from "./assistant-cards-valid.js";
import { askerView } from "../../../test-support/card-catalog/assistant.js";

const KEY = "ak-alice";
const PULL = "https://github.com/acme/app/pull/12";

/** Alice is bound at the identity service; anyone else is not. */
const exchange: TokenExchange = {
  enabled: true,
  tokenFor: (userId) => Promise.resolve(userId === ALICE ? ok("tok-alice") : err({ kind: "not_bound" as const })),
  bindingRequest: () => Promise.resolve(err({ kind: "exchange_unavailable" as const })),
  invalidate: () => undefined,
};

function ops(buttons: readonly JsonObject[]): unknown[] {
  return buttons.map((b) => (b["data"] as JsonObject)["op"]);
}

/** The card an out message shows. */
function cardAt(w: CardsWorld, at: number): JsonObject {
  const out = w.sent()[at];
  const card = out && render(out.message, out.op);
  assert.ok(card !== undefined, `no card at ${String(at)}`);
  return card;
}

function textAt(w: CardsWorld, at: number): string {
  const b = w.sent()[at]?.message.body;
  return b?.type === "text" ? b.text : "";
}

function boardCards(w: CardsWorld): JsonObject[] {
  return w.cards().filter((c) => JSON.stringify(c).includes("Your tasks") || JSON.stringify(c).includes("你的事项"));
}

it("the board lists three columns and a card for each task that waits", async () => {
  const w = CardsWorld.start({ render });
  w.server.addItem(KEY, "Write the docs", { summary: "drafting section 2" });
  w.server.addItem(KEY, "Fix the flaky test", { board: "needs_you", last: "ready", version: 2 });
  w.server.addItem(KEY, "Migrate the table", {
    board: "needs_you",
    last: "waiting",
    question: "Which branch?",
    version: 0,
  });
  w.server.addItem(KEY, "Old thing", { board: "done", last: "ready", version: 1, outcome: "accepted" });
  w.server.addItem("ak-bob", "Bob's secret task"); // another user's: never on this board
  await w.showBoard();
  assert.ok(w.sent().every((o) => o.op === "send"));
  const [board] = w.cards();
  assert.ok(board !== undefined);
  valid(board);
  assert.deepEqual(texts(body(board)[0]), ["📋 Your tasks", "2 waiting for you"]);
  // the count badges: each state's emoji, count and name on one line, on its tone's container style (never coloured text)
  assert.deepEqual(badgesOf(board), [
    ["badge-needs_you", "warning", ["⚠️ **2** Needs you"]],
    ["badge-working", "accent", ["⏳ **1** In progress"]],
    ["badge-good", "good", ["✅ **1** Done"]],
  ]);
  assert.equal(body(board).length, 2 + 3 + 4); // header, badges, three headings, a row per item
  assert.equal(board["actions"], undefined);
  // each section is a heading with the bar of its tone, its emoji, name and count, what needs you first; then one row per item
  assert.deepEqual(
    body(board)
      .filter((b) => idOf(b).startsWith("band-"))
      .map((b) => [idOf(b), ((b["columns"] as JsonObject[])[0]?.["items"] as JsonObject[])[0]?.["color"]]),
    [
      ["band-needs_you", "Warning"],
      ["band-working", "Accent"],
      ["band-good", "Good"],
    ],
  );
  const rows = body(board).filter((b) => idOf(b).startsWith("row-"));
  assert.ok(rows.length > 0);
  for (const r of rows)
    assert.equal(((r["columns"] as JsonObject[])[1]?.["items"] as JsonObject[])[0]?.["maxLines"], 1);
  // (only the headings' bars are coloured: decoration, not words)
  assert.deepEqual(
    walk(body(board)).filter(
      (b) => b["type"] === "TextBlock" && ["Good", "Warning"].includes(str(b["color"])) && b["text"] !== BAR,
    ),
    [],
  );
  const columns = [0, 1, 2].map((n) => columnText(board, n));
  assert.ok(columns[0]?.startsWith("⏳ In progress · 1"), String(columns));
  assert.ok(columns[0]?.includes("⏳ **#1** Write the docs · drafting section 2 · "), String(columns));
  assert.ok(columns[1]?.startsWith("⚠️ Needs you · 2"), String(columns));
  assert.ok(columns[1]?.includes("⚠️ **#2** Fix the flaky test · result v2 is ready · "), String(columns));
  assert.ok(columns[1]?.includes("❓ **#3** Migrate the table · asks: Which branch? · "), String(columns));
  assert.ok(columns[2]?.startsWith("✅ Done · 1") && columns[2].includes("✅ **#4** Old thing · "), String(columns)); // (a done row's emoji says how it ended)
  assert.ok(!JSON.stringify(board).includes("Bob"));
  const waiting = w.cards().slice(1);
  assert.equal(waiting.length, 2);
  for (const card of waiting) {
    valid(card);
    assert.ok(bodyText(card).startsWith("⚠️ #")); // (each waiting item's card: the needs-you emoji, then `#seq title`)
  }
  const byTitle = new Map(waiting.map((c) => [bodyText(c).split(" ")[2], c]));
  assert.deepEqual(titles(w.buttons(byTitle.get("Migrate"))), ["Stop"]);
  assert.deepEqual(titles(w.buttons(byTitle.get("Fix"))), ["Accept v2", "Stop"]);
});

it("a long column shows the newest and counts the rest and at most five cards are sent", async () => {
  const w = CardsWorld.start({ render });
  for (let n = 0; n < BOARD_LINES + 3; n += 1) {
    w.server.addItem(KEY, `Task ${String(n)}`, { board: "needs_you", last: "waiting", question: `q${String(n)}` });
  }
  await w.showBoard();
  const [board] = w.cards();
  assert.ok(board !== undefined);
  valid(board);
  const text = columnText(board, 1);
  assert.ok(text.startsWith(`⚠️ Needs you · ${String(BOARD_LINES + 3)}`) && text.endsWith("and 3 older"), text);
  assert.equal(text.split("❓ **#").length - 1, BOARD_LINES); // (the newest BOARD_LINES, one row each)
  assert.ok(text.includes(`${String(BOARD_LINES - (BOARD_SHOWN["needs_you"] ?? 0))} more ▾`), text);
  assert.equal(w.cards().length, 1 + BOARD_CARDS);
  assert.ok(w.said().at(-1)?.includes("6 more tasks wait for you"));
});

it("the board escapes what a title could make of the markdown", async () => {
  const w = CardsWorld.start({ render });
  w.server.addItem(KEY, "Rename __init__.py and *x*");
  await w.showBoard();
  const [board] = w.cards();
  assert.ok(board !== undefined);
  assert.ok(columnText(board, 0).includes(String.raw`\_\_init\_\_.py and \*x\*`), columnText(board, 0));
});

function asked(n: number, pr: number, view: Record<string, unknown> = {}, reviewer = "Hui Rui") {
  const itemId = `kwi_${String(n)}`;
  return {
    itemId,
    reviewer,
    view: askerView({
      itemId,
      status: "in_progress",
      prUrl: `https://github.com/AMD-AGI/PrimusClaw/pull/${String(pr)}`,
      ...view,
    }),
  };
}

it("the board shows the reviews the person asked of others beside their own", async () => {
  // Reviews handed to someone else show on /board, from the asked-of-others list, in a part of their own, never in the
  // person's columns; a board with nothing of the person's own still shows them.
  const w = CardsWorld.start({ render });
  w.server.asked.set(KEY, [
    asked(1, 312, { status: "waiting_for_reviewer", verdict: "approve", waitingFor: "confirm_merge", findings: 0 }),
    asked(2, 843, { status: "waiting_for_reviewer", waitingFor: "failed" }),
    asked(3, 321),
    asked(4, 848, { status: "done", verdict: "request_changes" }),
    asked(5, 849, { status: "stopped" }, ""),
  ]);
  await w.showBoard();
  const [board] = w.cards();
  assert.ok(board !== undefined);
  valid(board);
  const blocks = body(board);
  const at = blocks.findIndex((b) => idOf(b) === "band-handoff");
  assert.deepEqual(texts(blocks[at]), ["🤝 Asked of others · 5"]);
  const rows = blocks.slice(at + 1).map((b) => texts(b)); // (emoji, the pull request and its reviewer, how it stands)
  assert.deepEqual(rows, [
    ["🤝", "AMD-AGI/PrimusClaw#312 (Hui Rui) · approved, merge waits for Hui Rui"],
    ["❌", "AMD-AGI/PrimusClaw#843 (Hui Rui) · failed: ask again to retry"],
    ["🔍", "AMD-AGI/PrimusClaw#321 (Hui Rui) · being reviewed"],
    ["2 more ▾"],
    [
      "⏹️",
      "AMD-AGI/PrimusClaw#848 (Hui Rui) · changes requested, not merged",
      "⏹️",
      "AMD-AGI/PrimusClaw#849 (the reviewer) · stopped, not merged",
    ],
  ]);
  const shown = BOARD_SHOWN["in_progress"] ?? 0; // (the rest open in place under "N more ▾")
  assert.equal(shown, 3);
  assert.equal(blocks[at + 1 + shown + 1]?.["isVisible"], false);
  // none of them in the person's own sections: the board has no band of its own, and every count is 0
  assert.deepEqual(blocks.filter((b) => idOf(b).startsWith("band-")).map(idOf), ["band-handoff"]);
  assert.deepEqual(
    badgesOf(board).map(([, , words]) => words[0]),
    ["⚠️ **0** Needs you", "⏳ **0** In progress", "✅ **0** Done"],
  );
});

// --- test_board_retry_accept_all.py ----------------------------------------------------------------------------------------------

it("the board offers accept all and a retry for each task that failed or was stopped", async () => {
  const w = CardsWorld.start({ render });
  const s = w.server;
  s.addItem(KEY, "Fix A", { board: "needs_you", last: "ready", version: 1 });
  s.addItem(KEY, "Fix B", { board: "needs_you", last: "ready", version: 3 });
  const failed = s.addItem(KEY, "Build", { board: "needs_you", last: "failed" });
  const stopped = s.addItem(KEY, "Deploy", { board: "done", outcome: "stopped" });
  s.addItem(KEY, "Docs", { board: "done", outcome: "accepted" });
  s.addItem(KEY, "Review", { board: "done", outcome: "stopped", kind: "review" });
  await w.showBoard();
  const [card] = boardCards(w);
  assert.ok(card !== undefined);
  valid(card);
  const buttons = w.buttons(card);
  assert.deepEqual(titles(buttons), ["Accept all (2)", "Retry #4", "Retry #3"]); // (newest first, as the board)
  assert.equal((opOf(buttons, "accept_all")["cards"] as unknown[]).length, 2);
  const retried = new Set(
    buttons
      .filter((b) => (b["data"] as JsonObject)["op"] === "retry")
      .map((b) => w.store.assistantCards.getAssistantCard(str((b["data"] as JsonObject)["card"]))?.itemId),
  );
  assert.deepEqual(retried, new Set([failed, stopped])); // (not an accepted task, not a review)
});

/** A result whose say names a pull request (a task's card): the item and its card's buttons. */
async function prCard(w: CardsWorld, say = `Done: PR #12 is open, ${PULL}.`) {
  const item = w.server.addItem(KEY, "Fix the flaky test", { board: "needs_you", last: "ready", version: 1 });
  assert.equal(await w.push(w.server.say(KEY, say, item)), "delivered");
  return { item, buttons: w.buttons() };
}

it("a result that names a pull request offers to watch it and one that does not is only accept and stop", async () => {
  const w = CardsWorld.start({ render });
  const { buttons } = await prCard(w);
  valid(w.lastCard());
  assert.deepEqual(ops(buttons), ["accept", "stop", "watch"]);
  assert.equal(buttons[2]?.["title"], "Auto-reply to PR comments");
  assert.ok(
    JSON.stringify(w.lastCard()).includes(
      "Auto-reply: once on, new comments on the PR are answered as you automatically; you can turn it off at any time.",
    ),
  );
  await prCard(w, "Done: the docs are rewritten.");
  assert.deepEqual(ops(w.buttons()), ["accept", "stop"]);
});

it("watch subscribes the pull request claw recorded as the person signed in", async () => {
  const w = CardsWorld.start({ render, exchange });
  w.server.attendedTokens = new Set(["tok-alice"]);
  const { item, buttons } = await prCard(w, "Done: PR #12 is open (and see https://github.com/evil/other/pull/1).");
  w.server.reported.set(item, [PULL]);
  const watch = opOf(buttons, "watch");
  const before = w.mark();
  await w.click(watch);
  assert.deepEqual(w.server.subscriptions, [{ itemId: item, pr: PULL, reply: true, token: "tok-alice" }]);
  assert.deepEqual(
    w.since(before).map((o) => o.op),
    ["update", "send"],
  );
  // Put back with Turn off auto-reply in the place of the button pressed, and what is now on said.
  assert.deepEqual(ops(w.buttons(cardAt(w, before))), ["accept", "stop", "unwatch"]);
  const said = textAt(w, before + 1);
  assert.ok(said.includes("acme/app/pull/12"), said);
  assert.ok(
    said.includes(
      "以你的身份直接回复，不再逐条等你批准。可随时关闭：点卡片上的「关闭自动处理」，或对我说“别再自动回复 #12 了”",
    ),
    said,
  );
  const card = w.store.assistantCards.getAssistantCard(str(watch["card"]));
  assert.equal(card?.state, "open"); // Accept on it still works
  assert.equal(w.store.assistantCards.autoReply(card.userId, item), PULL);
});

it("turn off auto reply ends every watch of the item and the next card offers it again", async () => {
  const w = CardsWorld.start({ render, exchange });
  w.server.attendedTokens = new Set(["tok-alice"]);
  const { item, buttons } = await prCard(w);
  w.server.reported.set(item, [PULL]);
  await w.click(opOf(buttons, "watch"));
  // The next result of that item (the worker answered a comment): its card offers to turn it off, not to turn it on again.
  assert.equal(await w.push(w.server.say(KEY, `Answered the comment: ${PULL}#issuecomment-1`, item)), "delivered");
  const card = w.lastCard();
  assert.deepEqual(ops(w.buttons(card)), ["accept", "stop", "unwatch"]);
  assert.equal(w.buttons(card)[2]?.["title"], "Turn off auto-reply");
  assert.ok(JSON.stringify(card).includes("Auto-reply is on: new PR comments are answered as you."));
  const before = w.mark();
  await w.click(opOf(w.buttons(card), "unwatch"));
  assert.deepEqual(w.server.watchEnded, [1], "the watch Claw has is ended, with the linked key");
  assert.equal(w.store.assistantCards.autoReply(ALICE, item), null);
  assert.deepEqual(
    w.since(before).map((o) => o.op),
    ["update", "send"],
  );
  const back = cardAt(w, before);
  assert.deepEqual(ops(w.buttons(back)), ["accept", "stop", "watch"]);
  assert.ok(
    textAt(w, before + 1).startsWith(
      `已关闭：#1 Fix the flaky test 不再处理 ${PULL} 上的新评论，也不会再以你的身份回复。`,
    ),
    textAt(w, before + 1),
  );
  // Pressed again (or after the chat stopped it): nothing to end, and it says so.
  await w.click({ ...opOf(w.buttons(back), "watch"), op: "unwatch" });
  assert.deepEqual(w.server.watchEnded, [1]);
  assert.ok(textAt(w, w.sent().length - 1).startsWith("#1 Fix the flaky test 现在没有在自动处理 PR 评论，不用关闭。"));
});

it("turned on before this worker kept track the press says it was on and offers turn off", async () => {
  const w = CardsWorld.start({ render, exchange });
  w.server.attendedTokens = new Set(["tok-alice"]);
  const { item, buttons } = await prCard(w);
  w.server.reported.set(item, [PULL]);
  w.server.subscriptions.push({ itemId: item, pr: PULL, reply: true, token: "tok-alice" });
  const before = w.mark();
  await w.click(opOf(buttons, "watch"));
  assert.equal(w.server.subscriptions.length, 1, "the same watch, not a second one");
  assert.ok(textAt(w, before + 1).startsWith(`${PULL} 的评论自动回复本来就开着`), textAt(w, before + 1));
  assert.deepEqual(ops(w.buttons(cardAt(w, before))), ["accept", "stop", "unwatch"]);
});

it("turned off from the chat the next card no longer says it is on", async () => {
  const w = CardsWorld.start({ render, exchange });
  w.server.attendedTokens = new Set(["tok-alice"]);
  const { item, buttons } = await prCard(w);
  w.server.reported.set(item, [PULL]);
  await w.click(opOf(buttons, "watch"));
  w.server.watchEnded.push(1); // the router's work_unsubscribe ended it on Claw ("别再自动回复 #12 了")
  assert.equal(await w.push(w.server.say(KEY, `Done again: ${PULL}`, item)), "delivered");
  const card = w.lastCard();
  assert.deepEqual(ops(w.buttons(card)), ["accept", "stop", "watch"]);
  assert.ok(!JSON.stringify(card).includes("Auto-reply is on"));
  assert.equal(w.store.assistantCards.autoReply(ALICE, item), null);
  // Claw unreadable: what was last known stands (no guess either way).
  w.store.assistantCards.setAutoReply(ALICE, item, PULL);
  w.server.fail.set("watches", 500);
  assert.equal(await w.push(w.server.say(KEY, `Again: ${PULL}`, item)), "delivered");
  assert.deepEqual(ops(w.buttons(w.lastCard())), ["accept", "stop", "unwatch"]);
});
