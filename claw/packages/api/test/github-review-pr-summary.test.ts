// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The one sentence of what a pull request does (`pr_summary`), which the review session gives with gh_review_submit or gh_pr_merge:
 * how it is clipped (one line, masked, about 80 Chinese or 160 English characters), that the tools' answers carry it next to their
 * status, and that the audit keeps it for the requester's view and the acting user's confirmation. Against PGlite and the fake GitHub.
 */
import assert from "node:assert/strict";
import test, { after, afterEach, beforeEach, describe } from "node:test";
import { clipPrSummary, latestPrSummary, PR_SUMMARY_MAX_CJK, PR_SUMMARY_MAX_OTHER } from "../src/github-review/pr-summary.js";
import { summarise } from "../src/github-review/service.js";
import { HEAD } from "./support/fake-github.js";
import { PR, closeShared, reviewEnv, type ReviewEnv } from "./support/review-env.js";

const chars = (s: string | null): number => Array.from(s ?? "").length;

describe("pr_summary clipping", () => {
  test("nothing that is not a non-empty string is a summary", () => {
    for (const v of [undefined, null, 3, {}, ["a"], "", "   \n\t "]) assert.equal(clipPrSummary(v), null, JSON.stringify(v));
  });

  test("one line, as written, when it fits: Chinese and English", () => {
    assert.equal(clipPrSummary("  给代审结论卡加一句话，\n 概述 PR 做了什么。 "), "给代审结论卡加一句话， 概述 PR 做了什么。");
    assert.equal(clipPrSummary("Adds a one-line summary of the pull request to the review card."), "Adds a one-line summary of the pull request to the review card.");
  });

  test("a long one is cut: at 80 characters when it is Chinese, at 160 otherwise, ending in an ellipsis", () => {
    const zh = clipPrSummary("把代审结论卡上的说明改成一句话".repeat(10));
    assert.equal(chars(zh), PR_SUMMARY_MAX_CJK);
    assert.ok(zh?.endsWith("…"));
    const en = clipPrSummary("Adds a summary line ".repeat(20));
    assert.equal(chars(en), PR_SUMMARY_MAX_OTHER);
    assert.ok(en?.endsWith("…") && !en.includes(" …"), en ?? "");
    // Exactly at the limit is kept whole.
    assert.equal(clipPrSummary("中".repeat(PR_SUMMARY_MAX_CJK)), "中".repeat(PR_SUMMARY_MAX_CJK));
    assert.equal(clipPrSummary("a".repeat(PR_SUMMARY_MAX_OTHER)), "a".repeat(PR_SUMMARY_MAX_OTHER));
    // Mostly English with a Chinese word is held to the Chinese limit (the card's line is as wide either way).
    assert.equal(chars(clipPrSummary("修复 " + "the queue ".repeat(20))), PR_SUMMARY_MAX_CJK);
    // A character outside the basic plane is never split.
    assert.equal(chars(clipPrSummary("𠀀".repeat(100))), PR_SUMMARY_MAX_CJK);
  });

  test("a credential in it is masked", () => {
    const secret = "ghp_" + "A1b2C3d4E5".repeat(4);
    const out = clipPrSummary(`Rotates the token ${secret} used by CI`);
    assert.ok(out && !out.includes(secret), out ?? "");
  });

  test("the audit keeps it clipped, and the review's text still only as its size", () => {
    const a = summarise({ body: "x".repeat(50), pr_summary: "说明".repeat(100), event: "APPROVE" });
    assert.equal(a.body, "[50 characters]");
    assert.equal(chars(a.pr_summary as string), PR_SUMMARY_MAX_CJK);
    assert.equal(summarise({ pr_summary: "  " }).pr_summary, null);
  });
});

describe("pr_summary through the tools", () => {
  let e: ReviewEnv;
  beforeEach(async () => { e = await reviewEnv(); });
  afterEach(async () => { await e.close(); });
  after(closeShared);
  const LOW = { level: "low", reason: "an ordinary change" };

  test("a review's answer carries the sentence next to its status; the audit has it for the requester's view", async () => {
    await e.service.getPr(e.actor, { pr: PR });
    const o = await e.service.submitReview(e.actor, {
      pr: PR, head_sha: HEAD, event: "COMMENT", body: "Looks fine.", risk_judgement: LOW, pr_summary: "Adds\na summary line to the review card.",
    });
    assert.equal(o.isError, false, o.text);
    assert.equal(o.body.status, "submitted");
    assert.equal(o.body.pr_summary, "Adds a summary line to the review card.");
    assert.deepEqual(Object.keys(o.body).slice(0, 2), ["status", "pr_summary"], "first, so that an answer cut for display keeps it");
    assert.equal(await latestPrSummary(e.db, e.actor.sessionId), "Adds a summary line to the review card.");
    assert.equal(await latestPrSummary(e.db, "another-session"), null);
  });

  test("a review without one answers as it always did, and nothing is read for it", async () => {
    await e.service.getPr(e.actor, { pr: PR });
    const o = await e.service.submitReview(e.actor, { pr: PR, head_sha: HEAD, event: "COMMENT", body: "Looks fine.", risk_judgement: LOW });
    assert.equal(o.isError, false, o.text);
    assert.equal("pr_summary" in o.body, false);
    assert.equal(await latestPrSummary(e.db, e.actor.sessionId), null);
  });

  test("a merge held for the acting user keeps the sentence its call gave, for the card that asks them", async () => {
    await e.service.getPr(e.actor, { pr: PR });
    const held = await e.service.mergePr(e.actor, {
      pr: PR, head_sha: HEAD, risk_judgement: { level: "high", reason: "a person should look at this" }, pr_summary: "修改合并队列的重试逻辑",
    });
    assert.equal(held.body.status, "confirmation_required", held.text);
    assert.equal(held.body.pr_summary, "修改合并队列的重试逻辑");
    assert.equal(await latestPrSummary(e.db, e.actor.sessionId), "修改合并队列的重试逻辑");
  });
});
