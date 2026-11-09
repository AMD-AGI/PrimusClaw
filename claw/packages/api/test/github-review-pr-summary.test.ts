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
    assert.equal(await latestPrSummary(e.db, e.actor.sessionId, "AMD-AGI/demo", 7), "Adds a summary line to the review card.");
    assert.equal(await latestPrSummary(e.db, "another-session", "AMD-AGI/demo", 7), null);
  });

  test("a review without one answers as it always did, and nothing is read for it", async () => {
    await e.service.getPr(e.actor, { pr: PR });
    const o = await e.service.submitReview(e.actor, { pr: PR, head_sha: HEAD, event: "COMMENT", body: "Looks fine.", risk_judgement: LOW });
    assert.equal(o.isError, false, o.text);
    assert.equal("pr_summary" in o.body, false);
    assert.equal(await latestPrSummary(e.db, e.actor.sessionId, "AMD-AGI/demo", 7), null);
  });

  test("a merge held for the acting user keeps the sentence its call gave, for the card that asks them", async () => {
    await e.service.getPr(e.actor, { pr: PR });
    const held = await e.service.mergePr(e.actor, {
      pr: PR, head_sha: HEAD, risk_judgement: { level: "high", reason: "a person should look at this" }, pr_summary: "修改合并队列的重试逻辑",
    });
    assert.equal(held.body.status, "confirmation_required", held.text);
    assert.equal(held.body.pr_summary, "修改合并队列的重试逻辑");
    assert.equal(await latestPrSummary(e.db, e.actor.sessionId, "AMD-AGI/demo", 7), "修改合并队列的重试逻辑");
  });

  test("a refused call never lends its sentence: not one refused at its checks, not one on a pull request the session is not bound to", async () => {
    await e.service.getPr(e.actor, { pr: PR });
    const ok = await e.service.submitReview(e.actor, { pr: PR, head_sha: HEAD, event: "COMMENT", body: "Looks fine.", risk_judgement: LOW, pr_summary: "the real one" });
    assert.equal(ok.isError, false, ok.text);
    // Refused on the same pull request (a bad event), after the first: audited with its sentence, and not read.
    const bad = await e.service.submitReview(e.actor, { pr: PR, head_sha: HEAD, event: "NOPE", body: "x", pr_summary: "refused, same pull request" });
    assert.equal(bad.isError, true);
    // A session bound to this pull request, asked about another one (an instruction injected through the diff, say): refused.
    const bound = { ...e.actor, reviewTarget: { owner: "AMD-AGI", repo: "demo", number: 7 } };
    const other = await e.service.submitReview(bound, { pr: "AMD-AGI/demo#8", head_sha: HEAD, event: "COMMENT", body: "x", pr_summary: "another pull request" });
    assert.equal(other.isError, true);
    assert.equal(other.body.reason ?? other.body.error ?? other.body.code, "review_target_mismatch", other.text);
    const rows = await e.sql("SELECT arguments->>'pr_summary' AS s, result FROM claw_github_audit WHERE arguments ? 'pr_summary' ORDER BY id");
    assert.deepEqual(rows.map((r) => [r.s, r.result]), [["the real one", "ok"], ["refused, same pull request", "refused"], ["another pull request", "refused"]],
      "all three were audited with their sentence");
    assert.equal(await latestPrSummary(e.db, e.actor.sessionId, "AMD-AGI/demo", 7), "the real one");
    assert.equal(await latestPrSummary(e.db, e.actor.sessionId, "amd-agi/DEMO", 7), "the real one", "the repository's case does not matter");
    assert.equal(await latestPrSummary(e.db, e.actor.sessionId, "AMD-AGI/demo", 8), null);
  });

  test("a session that acted on two pull requests has each one's own sentence", async () => {
    const insert = (pr: number, summary: string, result = "ok") => e.sql(
      `INSERT INTO claw_github_audit (requester_user_id, actor_user_id, session_id, repo, pr, tool, result, detail, arguments)
       VALUES ('u-alice', 'u-bob', 's-9', 'AMD-AGI/demo', $1, 'gh_pr_merge', $2, 'confirmation_required', $3::jsonb)`,
      [pr, result, JSON.stringify({ pr_summary: summary })]);
    await insert(1, "Adds X");
    await insert(2, "Fixes Y");
    assert.equal(await latestPrSummary(e.db, "s-9", "AMD-AGI/demo", 1), "Adds X");
    assert.equal(await latestPrSummary(e.db, "s-9", "AMD-AGI/demo", 2), "Fixes Y");
    assert.equal(await latestPrSummary(e.db, "s-9", "AMD-AGI/other", 1), null);
    for (const bad of [undefined, null, "", 1] as unknown[]) assert.equal(await latestPrSummary(e.db, "s-9", bad, 1), null);
    assert.equal(await latestPrSummary(e.db, "s-9", "AMD-AGI/demo", "1"), null);
  });
});
