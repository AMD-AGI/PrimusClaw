// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The final Claw contract (`test_github_review`'s queue and gate tests): a merge can be queued, and the gates name why they
 * refused. A queued merge is never told as merged, each refusal is one clear line to the reviewer and one to the group, and a
 * held review is never queued.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { REVIEW_ITEM, decisions, groupText, held, press, row } from "./held-world.js";
import type { ReviewWorld } from "../../../../test-support/review-world.js";

const QUEUED = {
  status: "queued",
  queue_entry_id: "MQE_kwDO",
  queue_position: 3,
  queue_state: "AWAITING_CHECKS",
  url: "https://github.com/AMD-AGI/Hyperloom/pull/12",
};

/** Bob allows the held write and Claw answers `answer`: what replaces the card, and what the group heard. */
async function allow(world: ReviewWorld, answer: Record<string, unknown>): Promise<[string, string]> {
  world.claw.decision = answer as never;
  const settled = await press(world, "allow");
  return [settled.at(-1)?.text ?? "", groupText(world)];
}

test("a merge that went into the merge queue is told as queued with its place and never as merged", async () => {
  const world = await held();
  const [card, group] = await allow(world, QUEUED);
  assert.ok(card.includes("Queued AMD-AGI/Hyperloom#12 for merge (position 3, state AWAITING_CHECKS)"), card);
  assert.ok(card.includes("not merged yet") && !card.includes("Merged") && !card.includes("was not merged"), card);
  assert.ok(group.includes("已加入合并队列（第 3 位，状态 AWAITING_CHECKS）") && group.includes("尚未合入"), group);
  assert.ok(group.includes("已确认") && !group.includes("已合入") && !group.includes("没有合入"), group);
  assert.equal(row(world)?.state, "done");
  assert.deepEqual(decisions(world), [["tok-aad-b", "cf-1", "allow"]]);
});

for (const [name, changes, cardHas, groupHas] of [
  ["both", {}, "for merge (position 3, state AWAITING_CHECKS).", "（第 3 位，状态 AWAITING_CHECKS）"],
  [
    "nothing",
    { queue_position: null, queue_state: null },
    "for merge. It is not merged yet",
    "已加入合并队列，尚未合入",
  ],
  ["zero", { queue_position: 0, queue_state: null }, "for merge. It is not merged yet", "已加入合并队列，尚未合入"],
  ["bool", { queue_position: true, queue_state: null }, "for merge. It is not merged yet", "已加入合并队列，尚未合入"],
  ["text", { queue_position: "3", queue_state: null }, "for merge. It is not merged yet", "已加入合并队列，尚未合入"],
  [
    "state not a word",
    { queue_position: null, queue_state: "awaiting checks; open https://evil.test" },
    "for merge. It is not merged yet",
    "已加入合并队列，尚未合入",
  ],
  ["position only", { queue_state: null }, "for merge (position 3).", "（第 3 位）"],
] as const) {
  test(`a queued merge never claims a place the answer did not give (${name})`, async () => {
    const world = await held();
    const [card, group] = await allow(world, { ...QUEUED, ...changes });
    assert.ok(card.includes(cardHas) && group.includes(groupHas), `${card} / ${group}`);
    assert.ok(!(card + group).includes("evil.test") && !card.includes("Merged") && !group.includes("已合入"));
  });
}

test("a queued answer that also says wrote is still a queued merge not an uncertain one", async () => {
  const world = await held();
  const [card, group] = await allow(world, { ...QUEUED, wrote: true });
  assert.ok(card.includes("Queued AMD-AGI/Hyperloom#12") && group.includes("已加入合并队列"), card);
  assert.ok(!card.includes("cannot say") && !group.includes("结果不确定"));
});

test("queued is a merges word a held review is not queued", async () => {
  const world = await held(REVIEW_ITEM);
  const [card, group] = await allow(world, QUEUED);
  assert.ok(card.includes("was not posted") && !card.includes("Queued"), card);
  assert.ok(group.includes("没有发布") && !group.includes("合并队列"), group);
});

const REFUSALS = [
  [
    "cannot_approve_own_pull_request",
    "was written by your own GitHub account",
    "nothing was merged",
    "自己的账号提交的",
    "没有合入",
  ],
  [
    "acting_login_unknown",
    "does not know the GitHub login of your account",
    "nothing was merged",
    "没有 Bob 的 GitHub 用户名",
    "没有合入",
  ],
  [
    "delegation_off",
    "Auto-merge is off for your GitHub account",
    "/github auto-merge on",
    "Bob 已关闭自动合入",
    "/github auto-merge on",
  ],
  [
    "review_target_mismatch",
    "bound to another pull request than AMD-AGI/Hyperloom#12",
    "Ask for a new review",
    "绑定的不是 AMD-AGI/Hyperloom#12",
    "请重新发起",
  ],
  [
    "enqueue_refused",
    "GitHub refused to put AMD-AGI/Hyperloom#12 in the merge queue",
    "not queued or merged",
    "拒绝把 AMD-AGI/Hyperloom#12 加入合并队列",
    "没有排队也没有合入",
  ],
  [
    "enqueue_unconfirmed",
    "did not confirm that AMD-AGI/Hyperloom#12 is in the merge queue",
    "not known to be queued or merged",
    "没有确认 AMD-AGI/Hyperloom#12 已进入合并队列",
    "是否排队、是否合入都不确定",
  ],
  [
    "github_workflow_scope_missing",
    "GitHub refused to merge AMD-AGI/Hyperloom#12: it changes CI workflow files",
    "Please merge it by hand on GitHub.",
    "AMD-AGI/Hyperloom#12 改了 CI workflow 文件",
    "请在 GitHub 上手动合入。",
  ],
] as const;

for (const [reason, cardA, cardB, groupA, groupB] of REFUSALS) {
  test(`each refusal of the gates is one clear line to the reviewer and one to the group (${reason})`, async () => {
    const world = await held();
    const [card, group] = await allow(world, { status: "refused", reason });
    assert.ok(card.includes(cardA) && card.includes(cardB), card);
    assert.ok(group.includes(groupA) && group.includes(groupB), group);
    assert.ok(!card.includes(`was not merged: ${reason}`) && !group.includes(reason));
    assert.ok(!card.includes("Merged") && !group.includes("已合入") && !card.includes("Queued"));
    assert.ok(!group.includes("已加入合并队列") && !card.includes("\n") && !group.includes("\n")); // one line each
    assert.equal(row(world)?.state, "done");
  });
}

for (const [reason, cardHas, groupHas] of [
  ["cannot_approve_own_pull_request", "cannot be approved with it", "不能用同一个账号批准，没有发布"],
  ["acting_login_unknown", "nothing was posted", "没有发布"],
  ["delegation_off", "nothing was posted", "没有发布"],
  [
    "review_target_mismatch",
    "bound to another pull request than AMD-AGI/Hyperloom#12",
    "没有对 AMD-AGI/Hyperloom#12 做任何事",
  ],
] as const) {
  test(`a held review refused for the same reasons says what was not posted and never talks of a merge (${reason})`, async () => {
    const world = await held(REVIEW_ITEM);
    const [card, group] = await allow(world, { status: "refused", reason });
    assert.ok(card.includes(cardHas) && group.includes(groupHas), `${card} / ${group}`);
    assert.ok(!card.includes("merged") && !group.replace("自动合入", "").includes("合入"), `${card} / ${group}`);
    assert.equal(row(world)?.state, "done");
  });
}

test("a queue refusal after the approval says so and carries githubs reason without markup", async () => {
  const world = await held();
  const message =
    "GitHub refused to put the pull request in the merge queue: Pull request is not mergeable `rm -rf` [x](evil). " +
    "A review, an approval or a merge was already sent to GitHub in this try, so this confirmation is closed; look at the " +
    "pull request before asking again.";
  const [card, group] = await allow(world, { status: "refused", reason: "enqueue_refused", wrote: true, message });
  assert.ok(card.includes("(Pull request is not mergeable rm -rf x evil)"), card);
  assert.ok(card.includes("so it was not queued or merged"), card);
  assert.ok(card.includes("the approval may already be on the pull request") && !card.includes("cannot say"), card);
  assert.ok(group.includes("（Pull request is not mergeable") && group.includes("批准可能已经留在 PR 上"), group);
  assert.ok(!group.includes("结果不确定"));
  // no markup, and Claw's trailer is not repeated
  assert.ok(!card.includes("`rm") && !card.includes("](") && !(card + group).includes("A review, an approval"));
});

test("a merge refused for the missing workflow scope after the approval is known not merged and never says bind again", async () => {
  // (GitHub answers 403 to a merge of a pull request that changes `.github/workflows/*` with a token without the `workflow`
  // scope, after the approval was written: known not merged, and binding again does not add the scope)
  const world = await held();
  const [card, group] = await allow(world, {
    status: "refused",
    reason: "github_workflow_scope_missing",
    wrote: true,
    message: "GitHub refused the merge: this pull request changes CI workflow files (.github/workflows/) ...",
  });
  assert.ok(card.includes("it was not merged. Please merge it by hand on GitHub"), card);
  assert.ok(card.includes("the approval may already be on the pull request") && !card.includes("cannot say"), card);
  assert.ok(
    group.includes("需要 GitHub 的 workflow 权限") &&
      group.includes("批准可能已经留在 PR 上") &&
      !group.includes("结果不确定"),
    group,
  );
  assert.ok(!card.includes("bind") && !group.includes("绑定"), `${card} / ${group}`);
});

test("a queue refusal without githubs words still says it was not queued", async () => {
  const world = await held();
  const [card, group] = await allow(world, {
    status: "refused",
    reason: "enqueue_refused",
    message: "something else entirely",
  });
  assert.ok(
    card.includes("GitHub refused to put AMD-AGI/Hyperloom#12 in the merge queue, so it was not queued or merged."),
    card,
  );
  assert.ok(!card.includes("approval may") && !group.includes("（"), group);
});

test("an unconfirmed queue is not reported either way and the row is closed", async () => {
  const world = await held();
  const [card, group] = await allow(world, { status: "refused", reason: "enqueue_unconfirmed", wrote: true });
  assert.ok(card.includes("not known to be queued or merged") && card.includes("Look at the pull request"), card);
  assert.ok(!card.includes("Queued") && !group.includes("已加入合并队列"));
  assert.ok(group.includes("是否排队、是否合入都不确定"), group);
  assert.equal(row(world)?.state, "done");
});

for (const [answer, cardHas, groupHas] of [
  [{ status: "refused", reason: "some_future_gate" }, "was not merged: some_future_gate", "没有合入：some_future_gate"],
  [{ status: "refused", reason: "some_future_gate", wrote: true }, "I cannot say it was not merged", "结果不确定"],
] as const) {
  test(`a reason the worker has no line for keeps the generic line and the wrote caution (wrote: ${String("wrote" in answer)})`, async () => {
    const world = await held();
    const [card, group] = await allow(world, answer);
    assert.ok(card.includes(cardHas) && group.includes(groupHas), `${card} / ${group}`);
  });
}

test("the prompt tells the model a queued merge is not merged and names the refusals to say in one line", async () => {
  const world = await held();
  const prompt = world.started[0]?.prompt ?? "";
  assert.ok(prompt.includes("gh_pr_merge answers `queued`") && prompt.includes("never say it is merged"));
  assert.ok(prompt.includes("`queue_position`"));
  for (const reason of [
    "delegation_off",
    "cannot_approve_own_pull_request",
    "acting_login_unknown",
    "enqueue_refused",
    "enqueue_unconfirmed",
    "review_target_mismatch",
  ]) {
    assert.ok(prompt.includes(`\`${reason}\``), reason);
  }
  assert.ok(prompt.includes("merged, queued, or why not"));
  const marker = "say in one plain line which it was, in words and not as the code, and that nothing was merged.";
  const at = prompt.indexOf(marker);
  assert.ok(at >= 0);
  const [before, after] = [prompt.slice(0, at), prompt.slice(at + marker.length)];
  assert.ok(!before.includes("`enqueue_unconfirmed`") && after.includes("`enqueue_unconfirmed`"));
  assert.ok(after.includes("not known whether it is queued") && after.includes("never that it is not"));
  assert.ok(
    !prompt.includes("only comment") &&
      !prompt.includes("未开启自动合入") &&
      !prompt.includes("has not turned auto-merge on"),
  );
});
