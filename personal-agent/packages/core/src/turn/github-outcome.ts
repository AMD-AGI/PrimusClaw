// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a finished call of Claw's GitHub write tools (gh_review_submit, gh_pr_merge) did, read from its toolUsed event's
 * `description` (the tool's JSON answer, cut at 2000 characters, so it is searched rather than parsed).
 */

import { clipPrSummary } from "./upstream.js";

const GITHUB_WRITE_TOOLS: ReadonlySet<string> = new Set(["gh_review_submit", "gh_pr_merge"]);
const WROTE_STATUSES: ReadonlySet<string> = new Set(["submitted", "merged", "queued"]);
const TOOL_DONE: ReadonlySet<string> = new Set(["success", "error"]);
const STATUS = /"status"\s*:\s*"([a-z_]+)"/;
const CODE = /"(?:error|code|reason)"\s*:\s*"([a-z_]+)"/;
const EVENT = /"event"\s*:\s*"(APPROVE|REQUEST_CHANGES|COMMENT)"/;
const WROTE = /"wrote"\s*:\s*true/;
const COMMENTS = /"comments"\s*:\s*(\d{1,4})\b/;
const PR_SUMMARY_FIELD = /"pr_summary"\s*:\s*("(?:[^"\\]|\\.)*")/;

/** (tool, status, review event): one call's outcome. */
export type GithubOutcome = readonly [tool: string, status: string, event: string];

function writeToolOf(tool: string): string | undefined {
  const name = tool.split("__").at(-1) ?? tool;
  return GITHUB_WRITE_TOOLS.has(name) ? name : undefined;
}

function described(description: unknown): string {
  return typeof description === "string" ? description : description ? String(description) : "";
}

/**
 * What a finished call left on GitHub: (tool, status, review event) for a review posted, a merge or a place in the merge
 * queue, or a try that says it already wrote (`wrote: true`); undefined for anything that left nothing.
 */
export function githubWrite(tool: string, description: unknown): GithubOutcome | undefined {
  const name = writeToolOf(tool);
  if (!name) return undefined;
  const text = described(description);
  const status = STATUS.exec(text)?.[1];
  if (status && (WROTE_STATUSES.has(status) || WROTE.test(text))) return [name, status, EVENT.exec(text)?.[1] ?? ""];
  return undefined;
}

/** How many inline comments a review gh_review_submit posted carried (`"comments": N`); 0 when it does not say. */
export function reviewComments(description: unknown): number {
  const found = COMMENTS.exec(described(description))?.[1];
  return found ? Number.parseInt(found, 10) : 0;
}

/** The sentence of what the pull request does that a write call gave (`"pr_summary"`), clipped as shown; '' for none. */
export function githubPrSummary(tool: string, description: unknown): string {
  if (!writeToolOf(tool)) return "";
  const found = PR_SUMMARY_FIELD.exec(described(description))?.[1];
  if (!found) return "";
  try {
    return clipPrSummary(JSON.parse(found));
  } catch {
    return "";
  }
}

/**
 * How a finished call came out, whatever it was: (tool, status, review event) with the `status` of its answer, or "error"
 * when the call failed and its answer says no status. Undefined for any other tool, and for a call not finished.
 */
export function githubResult(tool: string, status: string, description: unknown): GithubOutcome | undefined {
  const name = writeToolOf(tool);
  if (!name || !TOOL_DONE.has(status)) return undefined;
  const text = described(description);
  const found = STATUS.exec(text)?.[1] ?? CODE.exec(text)?.[1];
  return [name, found ?? "error", EVENT.exec(text)?.[1] ?? ""];
}
