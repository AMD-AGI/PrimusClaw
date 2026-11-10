// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What follows a review's turn, by how it ended (`test_github_review`): a key Claw did not take tells the asker alone how to get
 * out of it (and nothing is followed up); a turn that moved to the reviewer's item says nothing here; an answer in English gives
 * the reviewer the notice in English.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { ClawError } from "../../src/index.js";
import { githubWrite } from "../../src/turn/github-outcome.js";
import {
  ALICE,
  CONV,
  PR,
  groupMessage,
  reviewWorld,
  saidIn,
  type ReviewWorld,
} from "../../../../test-support/review-world.js";
import { confirmation } from "./held-world.js";

async function started(world: ReviewWorld, text = `请 {Bob} 帮我 review 合入 ${PR}`) {
  const message = groupMessage(text);
  const conversation = world.surface.conversation(message.conversation);
  await world.service.request({
    message,
    text: message.text,
    sender: ALICE,
    conversation,
    scope: CONV,
    lang: () => "zh",
  });
  const [turn] = world.started;
  assert.ok(turn);
  turn.review.sessionId = "sess-1";
  return { turn, conversation };
}

const merged = githubWrite("mcp__github-review__gh_pr_merge", '{"status":"merged"}');

for (const [code, dmSays] of [
  ["invalid_api_key", "may have expired or been deleted"],
  ["key_subject_mismatch", "belongs to a different Primus account"],
] as const) {
  test(`when claw does not take the askers key the asker is told alone (${code})`, async () => {
    const world = reviewWorld();
    world.claw.confirmations = [confirmation()];
    const { turn, conversation } = await started(world);
    await world.service.afterTurn(
      turn.review,
      "",
      { moved: false, refusal: { status: 401, code }, ranModel: "", wrote: [], prSummary: "" },
      conversation,
    );
    const dm = saidIn(world.surface, "personal:aad-a");
    assert.ok(dm.includes(dmSays) && dm.includes("/unlink") && dm.includes("/link CODE") && dm.includes(PR), dm);
    assert.equal(dm.includes("different Primus account"), code === "key_subject_mismatch");
    assert.ok(!saidIn(world.surface, CONV).includes("/unlink"));
    // (nothing ran: no held write is looked for, and the reviewer hears nothing)
    assert.deepEqual(
      world.claw.calls.filter((c) => c[0] === "confirmations"),
      [],
    );
    assert.equal(saidIn(world.surface, "personal:aad-b").includes("请我以你的名义"), false);
  });
}

test("a turn that moved to the reviewers item says nothing more here", async () => {
  const world = reviewWorld();
  world.claw.confirmations = [confirmation()];
  const { turn, conversation } = await started(world);
  const before = world.surface.outbox.length;
  await world.service.afterTurn(
    turn.review,
    "x\nVERDICT: CLEAN",
    { moved: true, refusal: null, ranModel: "", wrote: merged ? [[...merged]] : [], prSummary: "" },
    conversation,
  );
  assert.equal(world.surface.outbox.length, before);
  assert.deepEqual(world.store.reviewDelegation.reviewNotices(), []);
});

test("an answer in english gives the reviewer the notice in english", async () => {
  const world = reviewWorld();
  const { turn, conversation } = await started(world);
  await world.service.afterTurn(
    turn.review,
    "Nothing must be fixed.\nVERDICT: CLEAN",
    { moved: false, refusal: null, ranModel: "m-1", wrote: merged ? [[...merged]] : [], prSummary: "" },
    conversation,
  );
  const [notice = ""] = world.surface
    .of("personal:aad-b")
    .flatMap((r) => (r.op === "send" && r.message.body.type === "text" ? [r.message.body.text] : []))
    .filter((t) => t.includes("as you"));
  for (const expected of [
    "Alice asked me in the group chat Primus 运维群 to review and merge AMD-AGI/Hyperloom#12",
    "with your GitHub account I merged it",
    "Conclusion:\nNothing must be fixed.",
    "Your confirmation setting:",
  ]) {
    assert.ok(notice.includes(expected), `${expected} in ${notice}`);
  }
});

test("a merge the review made itself is audited as the asker's, with the reviewer's login", async () => {
  const world = reviewWorld();
  const { turn } = await started(world);
  const line = turn.turn.onGithubResult(["gh_pr_merge", "merged", ""], "m-1");
  assert.ok(line?.includes("已合入"), line ?? "");
  const [event, fields] = world.audits.find(([name]) => name === "pr_merged") ?? ["", {}];
  assert.equal(event, "pr_merged");
  assert.deepEqual(
    [fields.operation, fields.outcome, fields.aad_object_id, fields.repo, fields.pr_number, fields.github_login],
    ["pr_merge", "merged", "aad-a", "AMD-AGI/Hyperloom", 12, "bob-gh"],
  );
  assert.equal(world.audits.filter(([name]) => name === "pr_merged").length, 1);
});

test("asked in a 1:1 chat, the notice in english says so", async () => {
  const world = reviewWorld();
  const message = groupMessage(`请 Bob 帮我 review 合入 ${PR}`, ALICE, [], "d1", "personal");
  const conversation = world.surface.conversation(message.conversation);
  await world.service.request({
    message,
    text: message.text,
    sender: ALICE,
    conversation,
    scope: "",
    lang: () => "zh",
  });
  const [turn] = world.started;
  assert.ok(turn);
  turn.review.sessionId = "sess-1";
  await world.service.afterTurn(
    turn.review,
    "Nothing must be fixed.\nVERDICT: CLEAN",
    { moved: false, refusal: null, ranModel: "", wrote: merged ? [[...merged]] : [], prSummary: "" },
    conversation,
  );
  const bob = saidIn(world.surface, "personal:aad-b");
  assert.ok(bob.includes("Alice asked me in your 1:1 chat to review and merge AMD-AGI/Hyperloom#12"), bob);
});

test("held writes cannot be looked for without the askers token, and the reviewer is still told", async () => {
  const world = reviewWorld();
  world.claw.confirmations = [confirmation()];
  const { turn, conversation } = await started(world);
  world.bound.delete("aad-a"); // (her binding went while the review ran)
  await world.service.afterTurn(
    turn.review,
    "没有问题。\nVERDICT: CLEAN",
    { moved: false, refusal: null, ranModel: "", wrote: merged ? [[...merged]] : [], prSummary: "" },
    conversation,
  );
  assert.deepEqual(
    world.claw.calls.filter((c) => c[0] === "confirmations"),
    [],
  );
  assert.ok(saidIn(world.surface, "personal:aad-b").includes("请我以你的名义"));
});

test("held writes that cannot be read do not stop the notice", async () => {
  const world = reviewWorld();
  const { turn, conversation } = await started(world);
  const port = world.deps.claw.mergeConfirmations;
  (port as { pending: typeof port.pending }).pending = () => Promise.reject(new ClawError(503));
  await world.service.afterTurn(
    turn.review,
    "没有问题。\nVERDICT: CLEAN",
    { moved: false, refusal: null, ranModel: "", wrote: merged ? [[...merged]] : [], prSummary: "" },
    conversation,
  );
  assert.ok(saidIn(world.surface, "personal:aad-b").includes("请我以你的名义"));
  assert.equal(world.store.githubConfirmations.pendingGithubConfirmations("aad-b").length, 0);
});
