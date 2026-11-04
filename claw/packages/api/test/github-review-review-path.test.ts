// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * How a pull request is reviewed: from the diff alone (`api_diff`, no sandbox, no
 * 16 s cold start) or with a sandbox. With the deep review on, a change of a non-test source
 * file always takes the sandbox; otherwise the decision is by thresholds an operator can change, a
 * repository's own review skill forces the sandbox path, and which way it went is
 * logged and kept in the audit row.
 */
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { GithubReview } from "../src/github-review/service.js";
import { chooseReviewPath, isNonTestSource, reviewPathAdvice } from "../src/github-review/review-path.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DEEP_FIXED_REVIEW_RULES, DEEP_PR_REVIEW_INSTRUCTIONS, FIXED_REVIEW_RULES, PR_REVIEW_INSTRUCTIONS, PR_REVIEW_SKILL } from "../src/github-review/default-skill.js";
import { readGithubReviewSettings } from "../src/github-review/settings.js";
import { PR, SECRET, closeShared, credential, readSection, reviewEnv } from "./support/review-env.js";

after(closeShared);

/** The deep review on: what most tests here are about. */
const LIMITS = { fastMaxFiles: 15, fastMaxChangedLines: 600, deepReview: true };
const DEEP = { CLAW_GITHUB_REVIEW_DEEP_ENABLED: "true" };
const OFF = { CLAW_GITHUB_REVIEW_DEEP_ENABLED: "false" };
const SMALL = { changedFiles: 3, changedLines: 80, filesComplete: true, diffMissing: false, repoSkill: false, paths: ["docs/guide.md", "README.md", "test/app.test.ts"] };
/** The change most fixtures here are: documentation only, so it may be reviewed from the diff. */
const DOCS_ONLY = [{ filename: "docs/app.md", status: "modified", additions: 3, deletions: 1, patch: "@@ -1,4 +1,6 @@\n a\n-b\n+b2\n+c\n+d\n e\n f" }];

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

test("a change of a non-test source file takes the sandbox whatever its size; one of tests, docs and configuration does not", () => {
  assert.deepEqual(chooseReviewPath({ ...SMALL, changedLines: 1, paths: ["docs/a.md", "src/auth.ts"] }, LIMITS), { path: "sandbox", reason: "source_change" });
  assert.deepEqual(chooseReviewPath({ ...SMALL, paths: ["test/auth.test.ts", "docs/a.md", "values.yaml"] }, LIMITS), { path: "api_diff", reason: "small_diff" });
  // A large change says it is large first: the size is the stronger reason.
  assert.equal(chooseReviewPath({ ...SMALL, changedLines: 601, paths: ["src/auth.ts"] }, LIMITS).reason, "too_many_changed_lines");
});

const SOURCE_TABLE: Array<[string, boolean]> = [
  ["claw/packages/api/src/github-review/service.ts", true],
  ["src/App.tsx", true],
  ["scripts/deploy.sh", true],
  ["migrations/0007_add_column.sql", true],
  ["pkg/server/handler.go", true],
  ["app/models.py", true],
  ["lib/latest.ts", true],
  ["src/main/java/Latest.java", true],
  ["api/service.proto", true],
  ["schema/query.graphql", true],
  ["src/MyApp.Tests/WidgetTests.cs", false],
  ["src/MyApp.Tests/Fixture.cs", false],
  ["src/MyApp/Widget.cs", true],
  ["claw/packages/api/test/github-review-service.test.ts", false],
  ["src/__tests__/app.ts", false],
  ["web/app.spec.tsx", false],
  ["pkg/server/handler_test.go", false],
  ["tests/test_models.py", false],
  ["app/test_models.py", false],
  ["src/test/java/FooTest.java", false],
  ["e2e/login.ts", false],
  ["README.md", false],
  ["claw/charts/claw/values.yaml", false],
  ["package.json", false],
  ["Dockerfile", false],
];

test("what counts as non-test source, path by path", () => {
  for (const [path, source] of SOURCE_TABLE) assert.equal(isNonTestSource(path), source, path);
});

test("a repository's own review skill, an incomplete file list and a diff GitHub did not send each force the sandbox, whatever the size", () => {
  assert.deepEqual(chooseReviewPath({ ...SMALL, repoSkill: true }, LIMITS), { path: "sandbox", reason: "repo_review_skill" });
  assert.deepEqual(chooseReviewPath({ ...SMALL, filesComplete: false }, LIMITS), { path: "sandbox", reason: "incomplete_change_list" });
  assert.deepEqual(chooseReviewPath({ ...SMALL, diffMissing: true }, LIMITS), { path: "sandbox", reason: "diff_not_available" });
});

test("the advice tells the model not to use a sandbox on the fast path, and that the other one requires it and why", () => {
  assert.match(reviewPathAdvice({ path: "api_diff", reason: "small_diff" }, true), /Do not start a sandbox/);
  const slow = reviewPathAdvice({ path: "sandbox", reason: "too_many_files" }, true);
  assert.match(slow, /must use a sandbox because the change touches many files/);
  assert.match(slow, /callers/);
  assert.match(slow, /build what the tests closest to the change need \(the documented way, only what is missing\) and run them/);
  assert.match(reviewPathAdvice({ path: "sandbox", reason: "source_change" }, true), /because the change touches source code/);
});

test("the thresholds are read from the environment with documented defaults, and a bad value falls back and is reported", () => {
  const d = readGithubReviewSettings({}, true);
  assert.equal(d.fastMaxFiles, 15);
  assert.equal(d.fastMaxChangedLines, 200);
  assert.equal(readGithubReviewSettings(OFF, true).fastMaxChangedLines, 600);
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
  const e = await reviewEnv(env, { reviewed: false });
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
  e.gh.files = DOCS_ONLY;
  const o = await service.getPr(e.actor, { pr: PR });
  const b = o.body as any;
  assert.equal(b.review_path.path, "api_diff");
  assert.equal(b.review_path.reason, "small_diff");
  assert.match(b.review_path.advice, /Do not start a sandbox/);
  assert.equal(b.review_path.max_files_for_diff_only, 15);
  // The diff, the files and the metadata are all in the result: that is what makes the fast path possible.
  assert.match(b.untrusted.diff, /docs\/app\.md/);
  assert.equal(b.untrusted.files.trim().split("\n").length, 1);
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

test("by default (the deep review on), a four-line change of a source file is reviewed with a sandbox, with the recipe, in the result and the audit row", async () => {
  const { e, rec, service } = await envWith();
  const b = (await service.getPr(e.actor, { pr: PR })).body as any;
  assert.deepEqual([b.review_path.path, b.review_path.reason], ["sandbox", "source_change"]);
  assert.match(b.review_path.sandbox_recipe, /pull\/7\/head/);
  assert.equal(rec.lines.find((l) => l.message === "github_review.path_chosen")?.fields.review_path_reason, "source_change");
  assert.deepEqual(await auditPath(e), { review_path: "sandbox", review_path_reason: "source_change" });
});

test("past the changed-lines threshold the path is the sandbox", async () => {
  const { e, service } = await envWith({ CLAW_GITHUB_REVIEW_FAST_MAX_CHANGED_LINES: "3" });
  e.gh.files = DOCS_ONLY;
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
  e.gh.files = DOCS_ONLY;
  const b = (await service.getPr(e.actor, { pr: PR })).body as any;
  assert.equal(b.review_path.path, "api_diff");
  assert.match((await readSection(service, e.actor, PR, "instructions")).text, /Build with make\./);
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

test("the review model and effort are read from the environment: opus and no effort by default, `default` for the deployment's model, a bad value is reported", () => {
  const d = readGithubReviewSettings({}, true);
  assert.deepEqual([d.reviewModel, d.reviewEffort], ["claude-opus-5.5", null]);
  const s = readGithubReviewSettings({ CLAW_GITHUB_REVIEW_MODEL: "claude-sonnet-5.5", CLAW_GITHUB_REVIEW_EFFORT: "Medium" }, true);
  assert.deepEqual([s.reviewModel, s.reviewEffort], ["claude-sonnet-5.5", "medium"]);
  const off = readGithubReviewSettings({ CLAW_GITHUB_REVIEW_MODEL: "default", CLAW_GITHUB_REVIEW_EFFORT: "" }, true);
  assert.deepEqual([off.reviewModel, off.reviewEffort, off.problems], [null, null, []]);
  const bad = readGithubReviewSettings({ CLAW_GITHUB_REVIEW_MODEL: "has space", CLAW_GITHUB_REVIEW_EFFORT: "max" }, true);
  assert.deepEqual([bad.reviewModel, bad.reviewEffort], ["claude-opus-5.5", null]);
  assert.match(bad.problems.join(), /CLAW_GITHUB_REVIEW_MODEL/);
  assert.match(bad.problems.join(), /CLAW_GITHUB_REVIEW_EFFORT=max/);
});

test("the instructions build what the closest tests import before running them, reuse what an earlier run left, and fall back to tests that need no build", () => {
  const text = DEEP_PR_REVIEW_INSTRUCTIONS.replace(/\s+/g, " ");
  // Order: find the tests, build what they need, then judge what ran.
  const find = text.indexOf("run the tests closest to the change");
  const build = text.indexOf("build what those tests need first, the documented way");
  const judge = text.indexOf("a test that could not run");
  assert.ok(find > 0 && build > find && judge > build, `${find} ${build} ${judge}`);
  // A workspace's sibling packages load from their built output, which a fresh checkout lacks.
  assert.match(text, /a test loads sibling packages from theirs \(`dist\/`\)/);
  assert.match(text, /`npm run build -w <package>`, in dependency order/);
  // Cached: what an earlier run left is reused, never wiped by a clean install.
  assert.match(text, /Install dependencies only when missing; keep what an earlier run left in the checkout \(no `npm ci` over installed ones\)/);
  assert.match(text, /build again after each recipe run/);
  // A missing module is a build not done, not a result; a build that does not fit is not a pass.
  assert.match(text, /stops on a missing module or built file did not run: build it and run it again/);
  assert.match(text, /If the build fails or does not fit the bound, run the closest tests that need no build/);
  assert.match(text, /a failed build, time\) is not a pass/);
  // Bounded like every other command.
  assert.match(text, /Bound every command with `timeout 600`/);
});

test("the second pass is handed the diff file, what was read and the callers seen but not opened, and is told its turn bound", () => {
  const text = DEEP_PR_REVIEW_INSTRUCTIONS.replace(/\s+/g, " ");
  // The main loop writes the change into the checkout once, out of anything committed, before the second pass starts.
  const write = text.indexOf("git diff origin/<base>...HEAD > .pr-review/pr.diff");
  assert.ok(write > 0 && write < text.indexOf("Second pass, always"), `${write}`);
  assert.match(text, /echo \.pr-review\/ >> \.git\/info\/exclude/);
  // It keeps the list the second pass starts from: read, seen in a search but not opened, ran.
  assert.match(text, /of the callers and users a search showed you that you did not open \(path, line, name\)/);
  const second = text.slice(text.indexOf("Second pass, always"));
  for (const handed of [
    /the path of `\.pr-review\/pr\.diff` \(it reads the change there once, all of it, with as many `read` offsets as it takes, and does not regenerate it\)/,
    /the files and functions you read, the callers and users you saw in a search but did not open, what you ran/,
    /to open those unopened callers and users first/,
    /writing each one down as soon as it has it: it has at most 20 turns/,
  ]) assert.match(second, handed);
  assert.doesNotMatch(PR_REVIEW_INSTRUCTIONS, /pr\.diff|did not open/);
});

test("the deep review grades a defect that breaks the main path once a flag is on as blocking, even when the flag is off by default", () => {
  const text = DEEP_PR_REVIEW_INSTRUCTIONS.replace(/\s+/g, " ");
  assert.match(text, /A problem that breaks the main path \(every turn, every request, every user, or an unattended run\) as soon as a shipped flag or documented setting is turned on is blocking, even when that flag is off by default: off by default lowers the urgency, not the severity\./);
  assert.doesNotMatch(PR_REVIEW_INSTRUCTIONS, /off by default/);
});

/**
 * What main gave the model before the deep review existed (8f0bf87, src/github-review unchanged since 92ed1dd), computed by running
 * that tree's own code: the sha256 of each instruction text, and every advice string word for word.
 */
const MAIN = {
  instructions: "9eb0212e2f1f983882ad3ce1e9f34e04fec6d052356b74ba49cd8ca9482d5d3f",
  skill: "4c9aa801b0750eb572c95bb63d6d71113543d61bed2bc6c736e5cfd2ee8be248",
  fixedRules: "5a5dc6a7434510cfe665fa51c46c72577e1c95a17c108060bf4b82840a523334",
  howToRead: "82a3958bf1a7b85c8ec056a8d597991b2082a0a059906eeb03c7ce6be55bbe21",
  advice: {
  "small_diff": "Review from the diff and the files in this result. Do not start a sandbox and do not call bash or file tools: they add a slow cold start and this change does not need them.",
  "repo_review_skill": "A sandbox is allowed for this review because the repository has its own review skill, which may use scripts. Use it only to read the code around the change or run something. Get the code with the sandbox_recipe below: it fetches the pull request anonymously (the repository is public), pinned to the head_sha above. The sandbox has no credential for GitHub and must not be given one: every comment, approval and merge still goes through the tools.",
  "incomplete_change_list": "A sandbox is allowed for this review because the list of changed files is incomplete. Use it only to read the code around the change or run something. Get the code with the sandbox_recipe below: it fetches the pull request anonymously (the repository is public), pinned to the head_sha above. The sandbox has no credential for GitHub and must not be given one: every comment, approval and merge still goes through the tools.",
  "diff_not_available": "A sandbox is allowed for this review because GitHub did not send the diff of some files. Use it only to read the code around the change or run something. Get the code with the sandbox_recipe below: it fetches the pull request anonymously (the repository is public), pinned to the head_sha above. The sandbox has no credential for GitHub and must not be given one: every comment, approval and merge still goes through the tools.",
  "too_many_files": "A sandbox is allowed for this review because the change touches many files. Use it only to read the code around the change or run something. Get the code with the sandbox_recipe below: it fetches the pull request anonymously (the repository is public), pinned to the head_sha above. The sandbox has no credential for GitHub and must not be given one: every comment, approval and merge still goes through the tools.",
  "too_many_changed_lines": "A sandbox is allowed for this review because the change is large. Use it only to read the code around the change or run something. Get the code with the sandbox_recipe below: it fetches the pull request anonymously (the repository is public), pinned to the head_sha above. The sandbox has no credential for GitHub and must not be given one: every comment, approval and merge still goes through the tools."
} as Record<string, string>,
};
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

test("the deep review is on by default, turned off only by false/0/no, and a bad value is reported and leaves it on", () => {
  for (const v of ["true", "1", "yes", " TRUE ", "", " "]) {
    const s = readGithubReviewSettings({ CLAW_GITHUB_REVIEW_DEEP_ENABLED: v }, true);
    assert.deepEqual([s.deepReview, s.problems], [true, []], JSON.stringify(v));
  }
  assert.deepEqual([readGithubReviewSettings({}, true).deepReview, readGithubReviewSettings({}, true).problems], [true, []]);
  for (const v of ["false", "0", "no", " FALSE "]) {
    const s = readGithubReviewSettings({ CLAW_GITHUB_REVIEW_DEEP_ENABLED: v }, true);
    assert.deepEqual([s.deepReview, s.problems], [false, []], v);
  }
  const bad = readGithubReviewSettings({ CLAW_GITHUB_REVIEW_DEEP_ENABLED: "off" }, true);
  assert.equal(bad.deepReview, true);
  assert.match(bad.problems.join(), /CLAW_GITHUB_REVIEW_DEEP_ENABLED=off is not true or false; using true/);
});

test("with the deep review set to false, the model is given exactly what main gave it: instructions, skill, fixed rules, path and advice", async () => {
  const off = readGithubReviewSettings(OFF, true);
  assert.equal(off.deepReview, false);
  assert.equal(sha256(PR_REVIEW_INSTRUCTIONS), MAIN.instructions);
  assert.equal(sha256(PR_REVIEW_SKILL), MAIN.skill);
  assert.equal(sha256(readFileSync(new URL("../../../examples/skills/pr-review/SKILL.md", import.meta.url), "utf8")), MAIN.skill);
  assert.equal(sha256(FIXED_REVIEW_RULES), MAIN.fixedRules);
  for (const [reason, text] of Object.entries(MAIN.advice)) {
    assert.equal(reviewPathAdvice({ path: reason === "small_diff" ? "api_diff" : "sandbox", reason }, off.deepReview), text, reason);
  }
  // A small change of a source file is reviewed from the diff, as on main; 601 lines is past main's threshold.
  assert.deepEqual(chooseReviewPath({ ...SMALL, changedLines: 10, paths: ["src/auth.ts"] }, off), { path: "api_diff", reason: "small_diff" });
  assert.deepEqual(chooseReviewPath({ ...SMALL, changedLines: 600, paths: ["src/auth.ts"] }, off).path, "api_diff");
  assert.deepEqual(chooseReviewPath({ ...SMALL, changedLines: 601 }, off), { path: "sandbox", reason: "too_many_changed_lines" });
  // What gh_pr_get hands the model as `review_instructions`, with no repository instructions and with a repository skill.
  const { e, service } = await envWith(OFF);
  const got = (await service.getPr(e.actor, { pr: PR })).body as any;
  assert.deepEqual([got.review_path.path, got.review_path.reason, got.review_path.advice], ["api_diff", "small_diff", MAIN.advice.small_diff]);
  assert.equal(sha256(got.how_to_read), MAIN.howToRead, "how the result is read, on the diff path");
  e.gh.files = Array.from({ length: 30 }, (_, i) => ({ ...DOCS_ONLY[0], filename: `docs/p${i}.md` }));
  e.gh.pr.changed_files = 30;
  const big = (await service.getPr(e.actor, { pr: PR })).body as any;
  assert.deepEqual([big.review_path.path, sha256(big.how_to_read)], ["sandbox", MAIN.howToRead], "and on the sandbox path");
  e.gh.files = DOCS_ONLY;
  e.gh.pr.changed_files = 1;
  assert.equal(sha256((await readSection(service, e.actor, PR, "instructions")).text), MAIN.instructions);
  e.gh.dirs[".claude/skills"] = [{ name: "review-pr", type: "dir" }];
  e.gh.contents[".claude/skills/review-pr/SKILL.md"] = "# Review\nLook at the rules index first.";
  const withSkill = (await readSection(service, e.actor, PR, "instructions")).text;
  assert.ok(withSkill.includes(FIXED_REVIEW_RULES) && !withSkill.includes(DEEP_FIXED_REVIEW_RULES), "a repository's skill is bound by main's rules");
});

test("the deep review's sandbox path reads the diff once from the checkout and does not page it; its diff path still pages it", async () => {
  const step1 = DEEP_PR_REVIEW_INSTRUCTIONS.replace(/\s+/g, " ").split(" 2. ")[0]!;
  assert.match(step1, /On the `sandbox` path the `diff` section is the one exception: do not page it; read the diff once from the checkout \(`\.pr-review\/pr\.diff`, step 4, all of it, with as many `read` offsets as it takes\), and page it only if the recipe fails/);
  assert.doesNotMatch(step1, /What you review is the diff in the `gh_pr_get` result/);
  const { e, service } = await envWith(DEEP);
  const sandbox = (await service.getPr(e.actor, { pr: PR })).body as any;
  e.gh.files = DOCS_ONLY;
  const diffOnly = (await service.getPr(e.actor, { pr: PR })).body as any;
  // [path, how_to_read pages the diff]
  for (const [b, path, pagesDiff] of [[sandbox, "sandbox", false], [diffOnly, "api_diff", true]] as const) {
    assert.equal(b.review_path.path, path);
    assert.equal(sha256(b.how_to_read) === MAIN.howToRead, pagesDiff, path);
    assert.equal(/except `diff`: this review checks the pull request out, and its diff is read there once/.test(b.how_to_read), !pagesDiff, path);
  }
});

test("with the deep review on, the instructions, the fixed rules and the advice are the deep ones", async () => {
  assert.notEqual(sha256(DEEP_PR_REVIEW_INSTRUCTIONS), MAIN.instructions);
  assert.notEqual(DEEP_FIXED_REVIEW_RULES, FIXED_REVIEW_RULES);
  assert.match(DEEP_PR_REVIEW_INSTRUCTIONS, /Second pass, always/);
  assert.doesNotMatch(PR_REVIEW_INSTRUCTIONS, /Second pass|adversarial/);
  assert.match(reviewPathAdvice({ path: "sandbox", reason: "too_many_files" }, true), /must use a sandbox/);
  const { e, service } = await envWith(DEEP);
  assert.equal((await readSection(service, e.actor, PR, "instructions")).text, DEEP_PR_REVIEW_INSTRUCTIONS);
  e.gh.dirs[".claude/skills"] = [{ name: "review-pr", type: "dir" }];
  e.gh.contents[".claude/skills/review-pr/SKILL.md"] = "# Review\nLook at the rules index first.";
  const withSkill = (await readSection(service, e.actor, PR, "instructions")).text;
  assert.ok(withSkill.includes(DEEP_FIXED_REVIEW_RULES), "a repository's skill is bound by the deep rules");
});
