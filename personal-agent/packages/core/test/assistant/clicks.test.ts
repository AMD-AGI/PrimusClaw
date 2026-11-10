// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { it } from "node:test";

import { workItem } from "../../../../test-support/assistant/work-items.js";
import { advanceSeconds } from "../../../../test-support/store.js";
import { NO_RETRY_SECONDS } from "../../src/assistant/board.js";
import { failureText, statusText } from "../../src/assistant/work-clicks.js";
import { ClawAnswerInvalid, ClawError, ClawUnreachable } from "../../src/claw/errors.js";
import { ALICE, clicksWorld, describe } from "./clicks-world.js";

const KEY = "ak-alice";

function cardFor(w: ReturnType<typeof clicksWorld>, itemId: string, canAccept = true, version = 1): string {
  return w.store.assistantCards.addAssistantCard(ALICE, itemId, version, canAccept);
}

it("accept is carried out once with the clickers key at the version shown", async () => {
  const w = clicksWorld();
  w.claw.add(workItem({ itemId: "it-1", seq: 2, resultVersion: 1 }));
  const card = cardFor(w, "it-1");
  const first = w.click({ primusclaw: "work", op: "accept", card });
  await w.handler.withCredential(first.route, KEY);
  assert.deepEqual(w.claw.calls, ["accept ak-alice it-1 v1"]);
  assert.equal(describe(first.settled[0]?.card), "view:workDone");
  assert.equal(first.settled[0]?.options?.fallback, "Accepted #2 Fix the flaky test (version 1).");
  const second = w.click({ primusclaw: "work", op: "accept", card });
  await w.handler.withCredential(second.route, KEY);
  assert.equal(second.settled[0]?.card, "That card was already used. Send /board to see where your tasks stand.");
  assert.equal(w.claw.calls.length, 1);
});

it("a card that is not the pressers or not recorded changes nothing", async () => {
  const w = clicksWorld();
  w.claw.add(workItem({ itemId: "it-1" }));
  const card = cardFor(w, "it-1");
  for (const [data, user] of [
    [{ primusclaw: "work", op: "accept", card }, "aad-b"],
    [{ primusclaw: "work", op: "accept", card: "forged" }, ALICE],
    [{ primusclaw: "work", op: "accept", card: cardFor(w, "it-1", false) }, ALICE],
    [{ primusclaw: "work", op: "dance", card }, ALICE],
  ] as const) {
    const { route, settled } = w.click(data, user);
    await w.handler.withCredential(route, KEY);
    assert.equal(settled[0]?.card, "That button is no longer valid. Send /board to see where your tasks stand.");
  }
  assert.deepEqual(w.claw.calls, []);
});

it("a newer result gets a card of its own and nothing is accepted", async () => {
  const w = clicksWorld();
  w.claw.add(workItem({ itemId: "it-1", resultVersion: 2 }));
  const { route, settled } = w.click({ primusclaw: "work", op: "accept", card: cardFor(w, "it-1", true, 1) });
  await w.handler.withCredential(route, KEY);
  assert.equal(
    settled[0]?.card,
    "The result was updated to version 2 after the card you pressed. The card below is for version 2.",
  );
  assert.deepEqual(w.sent(), ["view:workCard"]);
});

it("stop ends the work and says so and a review stop is said in both languages", async () => {
  const w = clicksWorld();
  w.claw.add(workItem({ itemId: "it-1", canAccept: false }));
  w.claw.add(workItem({ itemId: "rv-1", kind: "review", canAccept: false }));
  const stop = w.click({ primusclaw: "work", op: "stop", card: cardFor(w, "it-1", false) });
  await w.handler.withCredential(stop.route, KEY);
  assert.equal(stop.settled[0]?.options?.fallback, "Stopped #1 Fix the flaky test.");
  const review = w.click({ primusclaw: "work", op: "stop", card: cardFor(w, "rv-1", false) });
  await w.handler.withCredential(review.route, KEY);
  assert.equal(review.settled[0]?.options?.fallback, "已停止 #1 Fix the flaky test。 / Stopped.");
  assert.deepEqual(w.stopped, ["it-1", "rv-1"]);
  const again = w.click({ primusclaw: "work", op: "stop", card: cardFor(w, "rv-1", false) });
  await w.handler.withCredential(again.route, KEY);
  assert.equal(
    again.settled[0]?.card,
    "这个 review 已经结束了，不用再停。 / This review has already ended; there is nothing to stop.",
  );
});

it("a merge that cannot be stopped is said as it is and an ended card does not ask claw", async () => {
  const w = clicksWorld();
  w.claw.add(workItem({ itemId: "rv-1", kind: "review", canAccept: false, seq: 7, title: "Review #12" }));
  w.claw.stopRefusal.set("rv-1", "already_merged");
  const merged = w.click({ primusclaw: "work", op: "stop", card: cardFor(w, "rv-1", false) });
  await w.handler.withCredential(merged.route, KEY);
  assert.equal(
    merged.settled[0]?.card,
    "#7 Review #12 已经合入了，停不了；我不会自动撤回。 / It is merged already; I do not undo it.",
  );
  const ended = cardFor(w, "rv-1", false);
  w.store.assistantCards.endAssistantCard(ended, "已合入");
  const late = w.click({ primusclaw: "work", op: "stop", card: ended });
  await w.handler.withCredential(late.route, KEY);
  assert.equal(
    late.settled[0]?.card,
    "这个 review 已经结束了（已合入），不用再停。 / This review has already ended; there is nothing to stop.",
  );
  assert.equal(w.claw.calls.length, 1);
});

it("claw refusing or not answering offers the card again and a gone item ends it", async () => {
  const w = clicksWorld();
  w.claw.add(workItem({ itemId: "it-1" }));
  const card = cardFor(w, "it-1");
  w.claw.fail.set("accept", new ClawError(500));
  const refused = w.click({ primusclaw: "work", op: "accept", card });
  await w.handler.withCredential(refused.route, KEY);
  assert.equal(
    refused.settled[0]?.card,
    "PrimusClaw could not do that (error 500). The card below lets you try again in a moment.",
  );
  assert.deepEqual(w.sent(), ["view:workNote"]);
  w.claw.fail.set("accept", new ClawUnreachable("network", "accept"));
  const away = w.click({ primusclaw: "work", op: "accept", card });
  await w.handler.withCredential(away.route, KEY);
  assert.equal(away.settled[0]?.card, "I could not reach PrimusClaw. The card below lets you try again in a moment.");
  w.claw.fail.set("accept", new ClawError(404, '{"error":"not_found"}'));
  const gone = w.click({ primusclaw: "work", op: "accept", card });
  await w.handler.withCredential(gone.route, KEY);
  assert.equal(gone.settled[0]?.card, "I could not find that task any more. Send /board to see your tasks.");
  w.claw.fail.set("accept", new RangeError("bug"));
  const bug = w.click({ primusclaw: "work", op: "accept", card: cardFor(w, "it-1") });
  await assert.rejects(w.handler.withCredential(bug.route, KEY), RangeError);
});

/** The store's clock now, as Claw writes an item's `updatedAt` (a stop just now: its Retry has not expired). */
function justNow(w: { store: { now(): number } }): string {
  return new Date(w.store.now() * 1000).toISOString();
}

it("retry runs a task again and the board takes the place of the pressed one", async () => {
  const w = clicksWorld();
  w.claw.add(
    workItem({ itemId: "it-1", boardState: "done", outcome: "stopped", canAccept: false, updatedAt: justNow(w) }),
  );
  const { route, settled } = w.click({ primusclaw: "work", op: "retry", card: cardFor(w, "it-1", false) });
  await w.handler.withCredential(route, KEY);
  assert.equal(describe(settled[0]?.card), "view:board");
  assert.ok(settled[0]?.options?.fallback?.startsWith("已重新开始 #1 Fix the flaky test"));
  w.claw.retryRefusal = "too_many_active_items";
  const full = w.click({ primusclaw: "work", op: "retry", card: cardFor(w, "it-1", false) });
  await w.handler.withCredential(full.route, KEY);
  assert.ok(full.settled[0]?.options?.fallback?.includes("你进行中的任务已经到上限了"));
});

it("a claw without retry is not offered retry for a while", async () => {
  const w = clicksWorld();
  // (a failed task: it keeps its Retry however long it waits, where a stopped one's expires within the hour)
  w.claw.add(workItem({ itemId: "it-1", canAccept: false, lastReportKind: "failed" }));
  w.claw.fail.set("retry", new ClawError(404, "Not Found"));
  const { route, settled } = w.click({ primusclaw: "work", op: "retry", card: cardFor(w, "it-1", false) });
  await w.handler.withCredential(route, KEY);
  assert.equal(
    settled[0]?.options?.fallback,
    "这个版本的 PrimusClaw 还不能重试任务。 / This PrimusClaw cannot retry a task yet.",
  );
  assert.deepEqual(w.board.model(ALICE, [...w.claw.items.values()], []).retry, []);
  advanceSeconds(w.clock, NO_RETRY_SECONDS);
  assert.equal(w.board.model(ALICE, [...w.claw.items.values()], []).retry.length, 1);
  w.claw.fail.set("retry", new ClawUnreachable("timeout", "retry"));
  const away = w.click({ primusclaw: "work", op: "retry", card: cardFor(w, "it-1", false) });
  await w.handler.withCredential(away.route, KEY);
  assert.equal(away.settled[0]?.card, "I could not reach PrimusClaw. Press Retry again in a moment.");
  // the item read before a retry, in an answer this worker does not understand: as unreachable (Python's ValueError)
  w.claw.fail.set("item", new ClawAnswerInvalid("work item"));
  const unread = w.click({ primusclaw: "work", op: "retry", card: cardFor(w, "it-1", false) });
  await w.handler.withCredential(unread.route, KEY);
  assert.equal(unread.settled[0]?.card, "I could not reach PrimusClaw. Press Retry again in a moment.");
});

it("accept all takes each result at the version the board showed and says what was left", async () => {
  const w = clicksWorld();
  w.claw.add(workItem({ itemId: "a", seq: 1, title: "A" }));
  w.claw.add(workItem({ itemId: "b", seq: 2, title: "B", resultVersion: 2 }));
  const model = w.board.model(ALICE, [...w.claw.items.values()], []);
  assert.equal(model.accept.length, 2);
  const stale = cardFor(w, "b", true, 1);
  const { route, settled } = w.click({
    primusclaw: "work",
    op: "accept_all",
    cards: [model.accept[0], stale, "forged"],
  });
  await w.handler.withCredential(route, KEY);
  assert.equal(
    settled[0]?.options?.fallback,
    "已接受 1 项：#1 A。 另有 1 项没有接受（结果已更新或已处理），发 /board 看最新状态。",
  );
  const none = w.click({ primusclaw: "work", op: "accept_all", cards: ["forged"] });
  await w.handler.withCredential(none.route, KEY);
  assert.equal(none.settled[0]?.card, "That button is no longer valid. Send /board to see where your tasks stand.");
  const used = w.click({ primusclaw: "work", op: "accept_all", cards: [model.accept[0]] });
  await w.handler.withCredential(used.route, KEY);
  assert.equal(used.settled[0]?.card, "That card was already used. Send /board to see where your tasks stand.");
});

it("watching a pull request needs the person signed in and says when it was on already", async () => {
  const w = clicksWorld({ token: "idt-alice" });
  w.claw.add(workItem({ itemId: "it-1" }));
  w.claw.pullsOf.set("it-1", ["https://github.com/AMD-AGI/PrimusClaw/pull/12"]);
  const card = cardFor(w, "it-1");
  const on = w.click({ primusclaw: "work", op: "watch", card });
  await w.handler.withCredential(on.route, KEY);
  assert.ok(w.claw.calls.includes("watch idt-alice it-1 https://github.com/AMD-AGI/PrimusClaw/pull/12 true"));
  assert.equal(describe(on.settled[0]?.card), "view:workCard");
  assert.ok(
    on.settled[0]?.options?.fallback?.startsWith("已开启：https://github.com/AMD-AGI/PrimusClaw/pull/12 上的新评论"),
  );
  assert.equal(w.store.assistantCards.autoReply(ALICE, "it-1"), "https://github.com/AMD-AGI/PrimusClaw/pull/12");
  const again = w.click({ primusclaw: "work", op: "watch", card });
  await w.handler.withCredential(again.route, KEY);
  assert.ok(again.settled[0]?.options?.fallback?.includes("本来就开着"));
  const off = w.click({ primusclaw: "work", op: "unwatch", card });
  await w.handler.withCredential(off.route, KEY);
  assert.ok(off.settled[0]?.options?.fallback?.startsWith("已关闭：#1 Fix the flaky test 不再处理"));
  assert.equal(w.store.assistantCards.autoReply(ALICE, "it-1"), null);
  const already = w.click({ primusclaw: "work", op: "unwatch", card });
  await w.handler.withCredential(already.route, KEY);
  assert.ok(already.settled[0]?.options?.fallback?.includes("现在没有在自动处理 PR 评论"));
});

it("watching without a pull request or a binding or against a refusal says why", async () => {
  const w = clicksWorld();
  w.claw.add(workItem({ itemId: "it-1" }));
  const card = cardFor(w, "it-1");
  const noPull = w.click({ primusclaw: "work", op: "watch", card });
  await w.handler.withCredential(noPull.route, KEY);
  assert.ok(noPull.settled[0]?.options?.fallback?.includes("还没有交出 PR"));
  w.claw.pullsOf.set("it-1", ["https://github.com/o/r/pull/1"]);
  const unbound = w.click({ primusclaw: "work", op: "watch", card });
  await w.handler.withCredential(unbound.route, KEY);
  assert.ok(unbound.settled[0]?.options?.fallback?.startsWith("自动回复需要你本人登录确认"));
  const signedIn = clicksWorld({ token: "idt" });
  signedIn.claw.add(workItem({ itemId: "it-1", boardState: "done" }));
  signedIn.claw.pullsOf.set("it-1", ["https://github.com/o/r/pull/1"]);
  signedIn.claw.fail.set("watch", new ClawError(409));
  const full = signedIn.click({ primusclaw: "work", op: "watch", card: cardFor(signedIn, "it-1") });
  await signedIn.handler.withCredential(full.route, KEY);
  assert.equal(
    full.settled[0]?.card,
    "#1 Fix the flaky test 已经结束，或你同时关注的 PR 已经到上限了。 / The task has ended, or you watch as many pull requests as you may.",
  );
  signedIn.claw.fail.set("pulls", new ClawUnreachable("network", "pulls"));
  const away = signedIn.click({ primusclaw: "work", op: "watch", card: cardFor(signedIn, "it-1") });
  await signedIn.handler.withCredential(away.route, KEY);
  assert.equal(away.settled[0]?.card, "I could not reach PrimusClaw.");
});

it("a person with no linked key presses with their exchanged token", async () => {
  const w = clicksWorld({ token: "idt-alice" });
  w.claw.add(workItem({ itemId: "rv-1", kind: "review", canAccept: false }));
  const { route } = w.click({ primusclaw: "work", op: "stop", card: cardFor(w, "rv-1", false) });
  assert.equal(await w.handler.beforeCredential(route), true);
  assert.deepEqual(w.claw.calls, ["stop idt-alice rv-1"]);
  const unbound = clicksWorld();
  assert.equal(await unbound.handler.beforeCredential(unbound.click({ primusclaw: "work", op: "stop" }).route), false);
});

it("failure and status texts say where the item stands", () => {
  assert.equal(
    failureText(403, ""),
    "PrimusClaw rejected your linked key (it may have expired or been deleted). Send /unlink, then link again.",
  );
  assert.equal(
    failureText(503, "interrupt_not_recorded"),
    "The task is closed, but I could not stop its work just now.",
  );
  assert.equal(
    statusText(workItem({ itemId: "x", boardState: "done", outcome: "accepted" })),
    "#1 Fix the flaky test is already accepted.",
  );
  assert.equal(
    statusText(workItem({ itemId: "x", canAccept: false, pendingQuestion: "Which?" })),
    "#1 Fix the flaky test is waiting for you: Which?",
  );
  assert.equal(
    statusText(workItem({ itemId: "x", canAccept: false, boardState: "in_progress" })),
    "#1 Fix the flaky test is being worked on again. I will tell you when there is a new result.",
  );
});
