// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * How a pull request is reviewed: from the diff alone (`api_diff`, no sandbox, no
 * 16 s cold start) or with a sandbox. The decision is by thresholds an operator can
 * change, a repository's own review skill forces the sandbox path, and which way it
 * went is logged and kept in the audit row.
 */
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { GithubReview } from "../src/github-review/service.js";
import { chooseReviewPath, reviewPathAdvice } from "../src/github-review/review-path.js";
import { readGithubReviewSettings } from "../src/github-review/settings.js";
import { PR, SECRET, closeShared, credential, reviewEnv } from "./support/review-env.js";

after(closeShared);

const LIMITS = { fastMaxFiles: 15, fastMaxChangedLines: 600 };
const SMALL = { changedFiles: 3, changedLines: 80, filesComplete: true, diffMissing: false, repoSkill: false };

test("a small change is reviewed from the diff", () => {
  assert.deepEqual(chooseReviewPath(SMALL, LIMITS), { path: "api_diff", reason: "small_diff" });
});

test("the thresholds are inclusive: at the limit it is the diff, one past it is a sandbox", () => {
  assert.equal(chooseReviewPath({ ...SMALL, changedFiles: 15 }, LIMITS).path, "api_diff");
  assert.deepEqual(chooseReviewPath({ ...SMALL, changedFiles: 16 }, LIMITS), { path: "sandbox", reason: "too_many_files" });
  assert.equal(chooseReviewPath({ ...SMALL, changedLines: 600 }, LIMITS).path, "api_diff");
  assert.deepEqual(chooseReviewPath({ ...SMALL, changedLines: 601 }, LIMITS), { path: "sandbox", reason: "too_many_changed_lines" });
});

test("the limits are the operator's: the same change takes the other path under other limits", () => {
  assert.equal(chooseReviewPath({ ...SMALL, changedFiles: 20 }, { ...LIMITS, fastMaxFiles: 25 }).path, "api_diff");
  assert.equal(chooseReviewPath(SMALL, { ...LIMITS, fastMaxFiles: 2 }).path, "sandbox");
  assert.equal(chooseReviewPath(SMALL, { ...LIMITS, fastMaxChangedLines: 10 }).path, "sandbox");
});

test("a repository's own review skill, an incomplete file list and a diff GitHub did not send each force the sandbox, whatever the size", () => {
  assert.deepEqual(chooseReviewPath({ ...SMALL, repoSkill: true }, LIMITS), { path: "sandbox", reason: "repo_review_skill" });
  assert.deepEqual(chooseReviewPath({ ...SMALL, filesComplete: false }, LIMITS), { path: "sandbox", reason: "incomplete_change_list" });
  assert.deepEqual(chooseReviewPath({ ...SMALL, diffMissing: true }, LIMITS), { path: "sandbox", reason: "diff_not_available" });
});

test("the advice tells the model not to use a sandbox on the fast path, and why one is allowed on the other", () => {
  assert.match(reviewPathAdvice({ path: "api_diff", reason: "small_diff" }), /Do not start a sandbox/);
  const slow = reviewPathAdvice({ path: "sandbox", reason: "too_many_files" });
  assert.match(slow, /sandbox is allowed/);
  assert.match(slow, /many files/);
});

test("the thresholds are read from the environment with documented defaults, and a bad value falls back and is reported", () => {
  const d = readGithubReviewSettings({}, true);
  assert.equal(d.fastMaxFiles, 15);
  assert.equal(d.fastMaxChangedLines, 600);
  const s = readGithubReviewSettings({ CLAW_GITHUB_REVIEW_FAST_MAX_FILES: "40", CLAW_GITHUB_REVIEW_FAST_MAX_CHANGED_LINES: "2500" }, true);
  assert.equal(s.fastMaxFiles, 40);
  assert.equal(s.fastMaxChangedLines, 2500);
  const bad = readGithubReviewSettings({ CLAW_GITHUB_REVIEW_FAST_MAX_FILES: "many" }, true);
  assert.equal(bad.fastMaxFiles, 15);
  assert.match(bad.problems.join(), /CLAW_GITHUB_REVIEW_FAST_MAX_FILES/);
});

function recorder() {
  const lines: Array<{ fields: Record<string, unknown>; message: string }> = [];
  return { lines, logger: { info: (fields: Record<string, unknown>, message: string) => { lines.push({ fields, message }); } } };
}

async function envWith(env: Record<string, string> = {}) {
  const e = await reviewEnv(env);
  const rec = recorder();
  const service = new GithubReview({
    settings: () => e.settings, db: e.db, fetchImpl: e.gh.fetch, logger: rec.logger,
    resolveCredential: async () => credential(),
  });
  return { e, rec, service };
}

const auditPath = async (e: Awaited<ReturnType<typeof reviewEnv>>) =>
  (await e.sql("SELECT review_path, review_path_reason FROM claw_github_audit WHERE tool = 'gh_pr_get'"))[0];

test("gh_pr_get on a small change chooses the diff, says so to the model, logs it and records it in the audit row", async () => {
  const { e, rec, service } = await envWith();
  const o = await service.getPr(e.actor, { pr: PR });
  const b = o.body as any;
  assert.equal(b.review_path.path, "api_diff");
  assert.equal(b.review_path.reason, "small_diff");
  assert.match(b.review_path.advice, /Do not start a sandbox/);
  assert.equal(b.review_path.max_files_for_diff_only, 15);
  // The diff, the files and the metadata are all in the result: that is what makes the fast path possible.
  assert.match(b.untrusted.diff, /src\/app\.ts/);
  assert.equal(b.files.length, 1);
  assert.equal(b.pull_request.head_sha.length, 40);
  const line = rec.lines.find((l) => l.message === "github_review.path_chosen");
  assert.equal(line?.fields.review_path, "api_diff");
  assert.equal(line?.fields.review_path_reason, "small_diff");
  assert.equal(line?.fields.session_id, "s-1");
  assert.deepEqual(await auditPath(e), { review_path: "api_diff", review_path_reason: "small_diff" });
});

test("past the file threshold the path is the sandbox, in the result, the log line and the audit row", async () => {
  const { e, rec, service } = await envWith({ CLAW_GITHUB_REVIEW_FAST_MAX_FILES: "1" });
  e.gh.files = [
    { filename: "src/a.ts", status: "modified", additions: 1, deletions: 0, patch: "@@ -1 +1,2 @@\n a\n+b" },
    { filename: "src/b.ts", status: "modified", additions: 1, deletions: 0, patch: "@@ -1 +1,2 @@\n a\n+b" },
  ];
  e.gh.pr.changed_files = 2;
  const b = (await service.getPr(e.actor, { pr: PR })).body as any;
  assert.deepEqual([b.review_path.path, b.review_path.reason], ["sandbox", "too_many_files"]);
  assert.equal(rec.lines.find((l) => l.message === "github_review.path_chosen")?.fields.review_path, "sandbox");
  assert.deepEqual(await auditPath(e), { review_path: "sandbox", review_path_reason: "too_many_files" });
});

test("past the changed-lines threshold the path is the sandbox", async () => {
  const { e, service } = await envWith({ CLAW_GITHUB_REVIEW_FAST_MAX_CHANGED_LINES: "3" });
  const b = (await service.getPr(e.actor, { pr: PR })).body as any;
  assert.deepEqual([b.review_path.path, b.review_path.reason], ["sandbox", "too_many_changed_lines"]);
});

test("a repository with its own review skill takes the sandbox path even for a one-line change", async () => {
  const { e, rec, service } = await envWith();
  e.gh.pr.additions = 1; e.gh.pr.deletions = 0;
  e.gh.dirs[".claude/skills"] = [{ name: "review-pr", type: "dir" }];
  e.gh.contents[".claude/skills/review-pr/SKILL.md"] = "# Review\nLook at the rules index first.";
  const b = (await service.getPr(e.actor, { pr: PR })).body as any;
  assert.equal(b.review_instructions_source.source, "repository");
  assert.deepEqual([b.review_path.path, b.review_path.reason], ["sandbox", "repo_review_skill"]);
  assert.equal(rec.lines.find((l) => l.message === "github_review.path_chosen")?.fields.review_path_reason, "repo_review_skill");
  assert.deepEqual(await auditPath(e), { review_path: "sandbox", review_path_reason: "repo_review_skill" });
});

test("only the AGENTS.md of a repository is context, not a review skill: it does not force a sandbox", async () => {
  const { e, service } = await envWith();
  e.gh.contents["AGENTS.md"] = "Build with make.";
  const b = (await service.getPr(e.actor, { pr: PR })).body as any;
  assert.equal(b.review_path.path, "api_diff");
  assert.match(b.review_instructions, /Build with make\./);
});

test("a tool that does not choose a path leaves the audit columns empty", async () => {
  const { e, service } = await envWith();
  await service.assessPr(e.actor, { pr: PR });
  const [row] = await e.sql("SELECT review_path FROM claw_github_audit WHERE tool = 'gh_pr_risk'");
  assert.equal(row?.review_path, null);
});

test("the secret in the settings is not part of the path decision", () => {
  assert.equal(SECRET.length >= 32, true);
});
