// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * How a review asked of someone else goes, told to its asker (`test_review_progress`): what is news for the asker is said in the
 * chat where they asked, one message for what a request's reviews have new together, and each followed item is kept in the store
 * so a restart loses none of it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { own } from "../../src/own.js";
import type { AskerView, Conversation, ConversationRef, OutMessage } from "../../src/index.js";
import { progressWords, viewStage } from "../../src/review/progress.js";
import { reviewTurn } from "../../src/review/review-turn.js";
import { GithubReview } from "../../src/review/service/github-review.js";
import { SeededRandom } from "../../../../test-support/random.js";
import {
  ALICE_DM,
  PR,
  handBack,
  handoffEvent,
  handoffWorld,
  saidIn,
  settleFollows,
  type HandoffWorld,
} from "../../../../test-support/review-world.js";

const PR2 = "AMD-AGI/Hyperloom#13";
const PR3 = "AMD-AGI/Primus#3";
const LINK: Record<string, string> = {
  [PR]: "https://github.com/AMD-AGI/Hyperloom/pull/12",
  [PR2]: "https://github.com/AMD-AGI/Hyperloom/pull/13",
  [PR3]: "https://github.com/AMD-AGI/Primus/pull/3",
};

/** A review whose approval is posted and whose merge waits for Bob (Claw's view for the asker). */
function held(pr: string, more: Record<string, unknown> = {}): Record<string, unknown> {
  return { status: "waiting_for_reviewer", prUrl: own(LINK, pr), verdict: "approve", merged: false, ...more };
}

const done = (pr: string, verdict: string, merged: boolean) => ({
  status: "done",
  prUrl: own(LINK, pr),
  verdict,
  merged,
});

function texts(world: HandoffWorld): string[] {
  return world.surface
    .of(ALICE_DM)
    .flatMap((r) => ("message" in r && r.message.body.type === "text" ? [r.message.body.text] : []));
}

function summaries(world: HandoffWorld): string[] {
  return texts(world).filter((t) => t.includes("代审") && (t.includes("进度") || t.includes("（Bob 代审）")));
}

/** Alice's chat refuses the sends `refuse` picks (Teams said no). */
function failSends(world: HandoffWorld, refuse: (text: string) => boolean): void {
  const surface = world.surface;
  const open = surface.conversation.bind(surface);
  surface.conversation = (ref: ConversationRef): Conversation => {
    const conversation = open(ref);
    if (ref.id !== ALICE_DM) return conversation;
    const send = conversation.send.bind(conversation);
    conversation.send = (message: OutMessage) =>
      refuse(message.body.type === "text" ? message.body.text : "")
        ? Promise.reject(new Error("Teams said no"))
        : send(message);
    return conversation;
  };
}

const follows = (world: HandoffWorld) => world.store.reviewDelegation.askerFollows();

test("handed over reviews tell the asker the conclusion while the merge waits for the reviewer", async () => {
  const world = handoffWorld();
  [PR, PR2, PR3].forEach((pr, n) => world.claw.views.set(`item-${String(n + 1)}`, held(pr)));
  assert.deepEqual(await handBack(world, handoffEvent({ prs: [PR, PR2, PR3] })), ["delivered"]);
  const [summary = "", ...more] = summaries(world);
  assert.equal(more.length, 0);
  assert.ok(summary.startsWith("Bob 代审进度（3 个 PR：3 个有结论，0 个已结束）："), summary);
  const lines = summary.split("\n");
  for (const pr of [PR, PR2, PR3]) {
    const line = `- ${pr}：结论：批准，合入在等 Bob 确认  ${own(LINK, pr) ?? ""}`;
    assert.ok(
      lines.some((l) => l === line),
      summary,
    );
  }
  // Bob: once for each, each with the card that answers it
  assert.equal(saidIn(world.surface, "personal:aad-b").split("在等你确认").length - 1, 3);
});

test("a requests conclusions come in one message and what changes later in another", async () => {
  const world = handoffWorld();
  const running = { status: "in_progress", prUrl: "" };
  world.claw.views.set("item-1", [running, held(PR)]);
  world.claw.views.set("item-2", [done(PR2, "request_changes", false)]);
  world.claw.views.set("item-3", [running, running, running, running, running, running, done(PR3, "approve", true)]);
  await handBack(world, handoffEvent({ prs: [PR, PR2, PR3] }));
  const [first = "", second = "", ...more] = summaries(world);
  assert.equal(more.length, 0);
  assert.ok(first.includes("（3 个 PR：2 个有结论，1 个已结束）") && first.includes(`还在 review：${PR3}`), first);
  assert.ok(
    first.includes(`- ${PR}：结论：批准，合入在等 Bob 确认`) && first.includes(`- ${PR2}：结论：要求修改，没有合入`),
  );
  assert.ok(
    second.includes("（3 个 PR：3 个有结论，2 个已结束）") && second.includes(`- ${PR3}：结论：批准，已合入`),
    second,
  );
  assert.ok(!second.includes(PR2) && !second.includes(`- ${PR}：`));
  assert.deepEqual(
    follows(world).map((r) => r.itemId),
    ["item-1"],
  ); // only the open one
});

test("a failed review says so and how to try again", async () => {
  const world = handoffWorld();
  world.claw.views.set("item-1", {
    status: "waiting_for_reviewer",
    prUrl: LINK[PR],
    verdict: "",
    merged: false,
    waitingFor: "failed",
  });
  await handBack(world, handoffEvent());
  const [summary = ""] = summaries(world);
  assert.ok(
    summary.includes(`${PR}（Bob 代审）：这次代审没有完成（失败），没有合入。要重试，在这里说「重新 review ${PR}」`),
    summary,
  );
  assert.ok(!saidIn(world.surface, "personal:aad-b").includes("在等你确认")); // (a failure is not Bob's to confirm)
});

test("what the review found is said in a line", async () => {
  const world = handoffWorld();
  world.claw.views.set("item-1", {
    ...done(PR, "request_changes", false),
    findings: 2,
    note: `Blocking:  the lock is\n taken twice ${"x".repeat(300)}`,
  });
  await handBack(world, handoffEvent());
  const [summary = ""] = summaries(world);
  assert.ok(
    summary.includes("结论：要求修改，没有合入；2 个待处理的问题，如：Blocking: the lock is taken twice x"),
    summary,
  );
  assert.ok(!summary.includes("x".repeat(200)));
});

test("the same news is said once", async () => {
  const world = handoffWorld();
  world.claw.views.set("item-1", [held(PR), held(PR), held(PR), done(PR, "approve", true)]);
  await handBack(world, handoffEvent());
  const said = summaries(world);
  assert.equal(said.length, 2);
  assert.ok(said[0]?.includes("合入在等 Bob 确认") && said[1]?.includes("结论：批准，已合入"));
  assert.deepEqual(follows(world), []); // (told its end: no longer kept)
});

test("a restart follows on from what was said and never says it again", async () => {
  const world = handoffWorld();
  world.claw.views.set("item-1", held(PR));
  world.action.take("aad-a", handoffEvent());
  await world.action.idle();
  for (let i = 0; i < 6; i += 1) await world.clock.advance(30_000);
  assert.equal(summaries(world).length, 1);
  const [row] = follows(world);
  assert.ok(row?.said.startsWith("wait:approve") && row.reviewerTold);
  assert.ok(!JSON.stringify(row).includes("tok") && !JSON.stringify(row).includes("ak-"));

  // the worker restarts: the old one's follow is gone with it, and a new one reads the store
  const fresh = new GithubReview(world.deps, new SeededRandom(7), () => Promise.resolve());
  world.claw.views.set("item-1", [held(PR), done(PR, "approve", true)]);
  assert.equal(fresh.resume(), 1);
  for (let i = 0; i < 6; i += 1) await world.clock.advance(30_000);
  await fresh.idle();
  const said = summaries(world);
  assert.ok(said.length >= 2 && said.at(-1)?.includes(`${PR}（Bob 代审）：结论：批准，已合入`), said.join("\n"));
  assert.deepEqual(follows(world), []);
  // (Bob was told before the restart: not again)
  assert.equal(saidIn(world.surface, "personal:aad-b").split("在等你确认").length - 1, 1);
});

const view = (fields: Partial<AskerView>): AskerView => ({
  itemId: "i",
  status: "",
  prUrl: "",
  verdict: "",
  merged: false,
  waitingFor: "",
  findings: null,
  note: "",
  prSummary: "",
  ...fields,
});

test("progress words", () => {
  const review = reviewTurn({
    requesterId: "aad-a",
    requesterName: "Alice",
    actorId: "aad-b",
    actorUserId: "u-bob",
    actorName: "Bob",
    actorChannelId: "29:b",
    pull: { owner: "AMD-AGI", repo: "Hyperloom", number: 12 },
  });
  const cases: [Partial<AskerView>, string][] = [
    [
      { status: "waiting_for_reviewer", verdict: "approve", waitingFor: "confirm_merge" },
      "结论：批准，合入在等 Bob 确认",
    ],
    [{ status: "waiting_for_reviewer", verdict: "", waitingFor: "confirm_review" }, "还没有结论，提交前在等 Bob 确认"],
    [
      { status: "waiting_for_reviewer", verdict: "request_changes", waitingFor: "reviewer" },
      "结论：要求修改，在等 Bob 处理",
    ],
    [{ status: "waiting_for_reviewer", verdict: "approve" }, "结论：批准，在等 Bob 处理"], // (its merge was not held)
    [{ status: "in_progress", verdict: "comment" }, "结论：评论"],
    [{ status: "done", verdict: "approve", merged: true, findings: 0 }, "结论：批准，已合入；没有提出待改的问题"],
    [{ status: "stopped", verdict: "" }, "已停止，没有合入"],
  ];
  for (const [fields, words] of cases) assert.equal(progressWords(review, view(fields)), words, JSON.stringify(fields));
});

test("nothing is news while it is being reviewed", () => {
  assert.equal(viewStage(view({ status: "in_progress" })), "");
  assert.notEqual(viewStage(view({ status: "in_progress", verdict: "approve" })), "");
});

test("a round that fails does not end the follow", async () => {
  const world = handoffWorld();
  world.claw.views.set("item-1", held(PR));
  const port = world.deps.claw.workItems;
  const real = port.requesterView.bind(port);
  let calls = 0;
  (port as { requesterView: typeof port.requesterView }).requesterView = (token, itemId) => {
    calls += 1;
    if (calls === 1) return Promise.reject(new RangeError("boom"));
    return real(token, itemId);
  };
  await handBack(world, handoffEvent());
  const [summary = ""] = summaries(world);
  assert.ok(summary.includes("合入在等 Bob 确认") && calls >= 2, summary);
});

test("what is said is recorded before it is sent and put back when the send fails", async () => {
  const world = handoffWorld();
  world.claw.views.set("item-1", held(PR));
  const seen: string[] = [];
  failSends(world, (text) => {
    if (!text.includes("（Bob 代审）")) return false;
    seen.push(follows(world)[0]?.said ?? "");
    return seen.length === 1;
  });
  await handBack(world, handoffEvent());
  assert.equal(seen.length, 2);
  assert.ok(seen.every((s) => s.startsWith("wait:approve"))); // recorded before each send
  assert.equal(summaries(world).length, 1);
});

test("at the deadline held news is said and the follow goes only once the asker is told", async () => {
  const world = handoffWorld();
  world.claw.views.set("item-1", held(PR));
  world.claw.views.set("item-2", { status: "in_progress", prUrl: "" });
  const rows: number[] = [];
  let sends = 0;
  failSends(world, (text) => {
    if (!text.includes("代审")) return false;
    sends += 1;
    rows.push(follows(world).length);
    return text.includes("还有") && sends === 2;
  });
  world.action.take("aad-a", handoffEvent({ prs: [PR, PR2] }));
  await world.action.idle();
  // (one read, then the day is over; the news is held: the other review is still being made)
  await settleFollows(world, 40, 12 * 3600_000 + 1000);
  const said = texts(world);
  assert.ok(
    said.some((t) => t.includes(`- ${PR}：结论：批准，合入在等 Bob 确认`)),
    said.join("\n"),
  );
  assert.ok(
    said.some((t) => t.includes("Bob 的代审还有 2 个没有结束")),
    said.join("\n"),
  );
  assert.deepEqual(rows, [2, 2, 2]);
  assert.deepEqual(follows(world), []);
});

test("the end of the last review is said again until it is sent", async () => {
  const world = handoffWorld();
  world.claw.views.set("item-1", done(PR, "approve", true));
  let sends = 0;
  failSends(world, (text) => {
    if (!text.includes("（Bob 代审）")) return false;
    sends += 1;
    return sends <= 2;
  });
  await handBack(world, handoffEvent());
  const [summary = ""] = summaries(world);
  assert.ok(summary.includes("结论：批准，已合入"), summary);
  assert.equal(sends, 3);
  assert.deepEqual(follows(world), []);
});
