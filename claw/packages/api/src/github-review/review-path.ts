// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * How a pull request is reviewed: from the diff GitHub returns (`api_diff`), or
 * with a sandbox (`sandbox`).
 *
 * A sandbox costs a cold start (about 16 s) and is not needed to judge a small
 * change whose diff is all there is to read. It is wanted when the review has to
 * look at the code around the change, run something, or follow the repository's
 * own review skill, which may call scripts. The sandbox is never started by this:
 * Brain opens one only when a turn uses a sandbox tool, so the decision is
 * advice to the model plus a record of which way it went (a log line and the
 * audit row), made by thresholds an operator can change.
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
}

export interface ReviewPathChoice {
  path: ReviewPath;
  /** One of: `small_diff`, `repo_review_skill`, `incomplete_change_list`, `diff_not_available`, `too_many_files`, `too_many_changed_lines`. */
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
  return { path: "api_diff", reason: "small_diff" };
}

/** What the model is told about the path, in the `gh_pr_get` result. */
export function reviewPathAdvice(choice: ReviewPathChoice): string {
  if (choice.path === "api_diff") {
    return "Review from the diff and the files in this result. Do not start a sandbox and do not call bash or file tools: they add a slow cold start and this change does not need them.";
  }
  const why: Record<string, string> = {
    repo_review_skill: "the repository has its own review skill, which may use scripts",
    incomplete_change_list: "the list of changed files is incomplete",
    diff_not_available: "GitHub did not send the diff of some files",
    too_many_files: "the change touches many files",
    too_many_changed_lines: "the change is large",
  };
  return `A sandbox is allowed for this review because ${why[choice.reason] ?? choice.reason}. Use it only to read the code around the change or run something. `
    + "Get the code with the sandbox_recipe below: it fetches the pull request anonymously (the repository is public), pinned to the head_sha above. "
    + "The sandbox has no credential for GitHub and must not be given one: every comment, approval and merge still goes through the tools.";
}
