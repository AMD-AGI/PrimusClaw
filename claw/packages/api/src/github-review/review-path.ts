// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * How a pull request is reviewed: from the diff GitHub returns (`api_diff`), or
 * with a sandbox (`sandbox`).
 *
 * A sandbox costs a cold start (about 16 s) and is not needed to judge a small
 * change that touches no code: documentation, configuration, tests. Every other
 * change needs one, because a diff alone shows what changed and not who depends on
 * it: the review must check the pull request out, read the callers of what changed
 * and run the tests closest to it. So the sandbox path is taken when a non-test
 * source file changes, when the change is large, when the diff is not all there,
 * or when the repository has a review skill of its own, which may call scripts.
 * The sandbox is never started by this: Brain opens one only when a turn uses a
 * sandbox tool, so the decision is an instruction to the model plus a record of
 * which way it went (a log line and the audit row), made by thresholds an operator
 * can change.
 */
import type { GithubReviewSettings } from "./settings.js";

export type ReviewPath = "api_diff" | "sandbox";

export interface ReviewPathInput {
  changedFiles: number;
  changedLines: number;
  /** Every changed file was listed. */
  filesComplete: boolean;
  /** Some changed file came without a diff: a binary, a rename, or one too large for GitHub to send (risk.ts `diffNotSent`). */
  diffMissing: boolean;
  /** The repository has a review skill of its own, which may use scripts. */
  repoSkill: boolean;
  /** The paths of the changed files (a renamed file by its new path). */
  paths: readonly string[];
}

export interface ReviewPathChoice {
  path: ReviewPath;
  /** One of: `small_diff`, `repo_review_skill`, `incomplete_change_list`, `diff_not_available`, `too_many_files`, `too_many_changed_lines`, `source_change`. */
  reason: string;
}

export function chooseReviewPath(
  input: ReviewPathInput, limits: Pick<GithubReviewSettings, "fastMaxFiles" | "fastMaxChangedLines">,
): ReviewPathChoice {
  if (input.repoSkill) return { path: "sandbox", reason: "repo_review_skill" };
  if (!input.filesComplete) return { path: "sandbox", reason: "incomplete_change_list" };
  if (input.diffMissing) return { path: "sandbox", reason: "diff_not_available" };
  if (input.changedFiles > limits.fastMaxFiles) return { path: "sandbox", reason: "too_many_files" };
  if (input.changedLines > limits.fastMaxChangedLines) return { path: "sandbox", reason: "too_many_changed_lines" };
  if (input.paths.some(isNonTestSource)) return { path: "sandbox", reason: "source_change" };
  return { path: "api_diff", reason: "small_diff" };
}

/** Files a program is built from or runs, by extension: code, shell, SQL (a migration is code), interface schemas. */
const SOURCE_EXT = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|kts|scala|c|cc|cpp|cxx|h|hh|hpp|cu|cs|rb|php|swift|m|mm|sh|bash|zsh|ps1|sql|lua|pl|ex|exs|erl|hs|ml|clj|dart|vue|svelte|proto|thrift|graphql|gql)$/i;
/** A test by where it lives or how it is named, in the conventions of the languages above. */
const TEST_DIR = /(?:^|\/)(?:tests?|__tests__|__mocks__|spec|specs|testdata|test-?fixtures|fixtures|e2e|[^/]+\.Tests?)\//i;
const TEST_NAME = /(?:[._-](?:test|spec)\.[^/]+|_test\.go|(?:^|\/)test_[^/]+\.py|_test\.py|Tests?\.(?:java|kt|cs|swift))$/;

/** A changed file whose change can break what runs: source code that is not a test. */
export function isNonTestSource(path: string): boolean {
  return SOURCE_EXT.test(path) && !TEST_DIR.test(path) && !TEST_NAME.test(path);
}

/** What the model is told about the path, in the `gh_pr_get` result. */
export function reviewPathAdvice(choice: ReviewPathChoice): string {
  if (choice.path === "api_diff") {
    return "This change touches no source code and is small: review it from the diff and the files in this result. Do not start a sandbox and do not call bash, file or task tools: they add a slow cold start and this change does not need them.";
  }
  const why: Record<string, string> = {
    repo_review_skill: "the repository has its own review skill, which may use scripts",
    incomplete_change_list: "the list of changed files is incomplete",
    diff_not_available: "GitHub did not send the diff of some files",
    too_many_files: "the change touches many files",
    too_many_changed_lines: "the change is large",
    source_change: "the change touches source code",
  };
  return `This review must use a sandbox because ${why[choice.reason] ?? choice.reason}. `
    + "Run the sandbox_recipe below (anonymous, pinned to the head_sha), then read the callers of what changed, build what the tests closest to the change need (the documented way, only what is missing) and run them. "
    + "Never give the sandbox a GitHub credential: comments, approvals and merges go through the tools.";
}
