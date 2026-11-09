// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the review session is asked to write, and how its answer reaches the group (`test_github_review`'s prompt and shaper
 * tests): plain natural words, never a tool's name or state; a name or state the model writes anyway is said in plain words, in
 * the language of the answer, and a finding about the code is left as it is; the summary is clipped and masked.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { shapeGroupAnswer } from "../../src/review/receipt.js";
import {
  ALICE,
  CONV,
  PR,
  TOKEN,
  groupMessage,
  reviewWorld,
  type ReviewWorld,
} from "../../../../test-support/review-world.js";
import { cpLength } from "../../src/text/py-text.js";

async function prompt(world: ReviewWorld = reviewWorld()): Promise<string> {
  const message = groupMessage(`请 {Bob} 帮我 review 合入 ${PR}`);
  await world.service.request({
    message,
    text: message.text,
    sender: ALICE,
    conversation: world.surface.conversation(message.conversation),
    scope: CONV,
    lang: () => "zh",
  });
  return world.started[0]?.prompt ?? "";
}

test("the prompt never offers the comment only way out", async () => {
  const text = await prompt();
  assert.ok(
    !text.includes("only comment") &&
      !text.includes("未开启自动合入") &&
      !text.includes("has not turned auto-merge on"),
  );
});

test("the prompt asks for plain natural words and forbids tool names and states", async () => {
  const text = await prompt();
  const final = text.slice(text.indexOf("Write the final answer"));
  assert.ok(final.includes("never write the name of a tool or of one of its states"), final);
  for (const raw of [
    "gh_pr_get",
    "gh_pr_risk",
    "gh_review_submit",
    "gh_pr_merge",
    "dry_run",
    "confirmation_required",
  ]) {
    assert.ok(final.includes(raw), raw); // each is named in that sentence, as a thing not to say
  }
  for (const word of ["批准", "合入", "评论", "等确认", "演练模式（写入关闭，GitHub 上没有发生任何事）"]) {
    assert.ok(final.includes(word), word);
  }
  // A dry run is told to the model in its own paragraph, so the plain sentence has something to say.
  assert.ok(text.includes("If a tool answers `dry_run`") && text.includes("nothing happened on GitHub"));
  assert.ok(final.includes("natural wording") && final.includes("没有逐行评论"));
  assert.ok(!text.toLowerCase().includes("inline"));
});

const DRY_RUN_ANSWER =
  "没有发现必须修复的问题。gh_review_submit 和 `gh_pr_merge` 都返回了 dry_run：写入关闭，没有实际发布。\n" +
  "需要 Bob 的 confirmation_required 之后才能继续。\nVERDICT: CLEAN";

test("a tool name or state in the answer reaches the group in plain words", async () => {
  const world = reviewWorld();
  await prompt(world);
  const text = world.started[0]?.turn.shapeAnswer(DRY_RUN_ANSWER, "", "", [], 0, "") ?? "";
  for (const raw of ["gh_review_submit", "gh_pr_merge", "dry_run", "confirmation_required", "VERDICT"]) {
    assert.ok(!text.includes(raw), raw);
  }
  assert.ok(
    text.includes("没有发现必须修复的问题") && text.includes("演练模式（写入关闭，GitHub 上没有发生任何事）"),
    text,
  );
  assert.ok(text.includes("合入") && text.includes("等确认"), text);
});

test("the shaper names things in the language of the answer and leaves findings alone", () => {
  const zh = shapeGroupAnswer(DRY_RUN_ANSWER);
  assert.ok(!zh.includes("gh_review_submit") && !zh.includes("`gh_pr_merge`") && !zh.includes("`"), zh);
  assert.ok(zh.includes("提交评审 和 合入 都返回了 演练模式（写入关闭，GitHub 上没有发生任何事）"), zh);
  const en = shapeGroupAnswer(
    "Nothing to fix. gh_pr_merge answered `dry_run` and `confirmation_required` came back for the review.\nVERDICT: CLEAN",
  );
  assert.equal(
    en,
    "Nothing to fix. merging answered practice mode (writes are off, nothing happened on GitHub) and waiting for confirmation " +
      "came back for the review.",
  );
  // A finding is about the code under review, which may itself be about these words: it is quoted as it is.
  const finding =
    "- claw/packages/api/src/github-review/service.ts:920 `dry_run` is set before the gate is read, so gh_pr_merge answers early.";
  const kept = shapeGroupAnswer(`发现 1 个问题。\n${finding}\n已评论，gh_pr_merge 没有执行。\nVERDICT: BLOCKING`);
  assert.ok(kept.includes(finding) && kept.includes("已评论，合入 没有执行。"), kept);
  // A word that merely contains one is not one: no half-rewritten identifiers.
  assert.equal(shapeGroupAnswer("see my_dry_run_flag and dry_runner"), "see my_dry_run_flag and dry_runner");
  assert.equal(shapeGroupAnswer("没有逐行评论，已批准。"), "没有逐行评论，已批准。");
});

// (masking a credential is the channel's, on every message it sends: teams/src/activity/redact-activity.ts)
test("the group summary is at most 1200 characters", async () => {
  const world = reviewWorld();
  await prompt(world);
  const text =
    world.started[0]?.turn.shapeAnswer(`${"问题 ".repeat(700)} token ${TOKEN}\nVERDICT: BLOCKING`, "", "", [], 0, "") ??
    "";
  assert.ok(cpLength(text) < 1500, String(cpLength(text)));
  assert.ok(text.includes("... (shortened)"), text.slice(-80));
});
