// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The sentence of what a pull request does is taken only from what the review and merge tools answered
 * (`githubPrSummary`, Python `github_review.github_pr_summary`), never from a read such as `gh_pr_get`, nor from an answer
 * that is cut off or has none.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { githubPrSummary } from "../../src/turn/github-outcome.js";

const ZH = "给代审结论卡加一句话，概述这个 PR 做了什么";
const EN = "Adds a one-sentence summary of what the pull request does to the review conclusion card.";

test("a tool answer gives it only for the review and merge tools", () => {
  const answer = JSON.stringify({ status: "submitted", pr_summary: ZH, review_id: 7 });
  assert.equal(githubPrSummary("mcp__github-review__gh_review_submit", answer), ZH);
  assert.equal(
    githubPrSummary("mcp__github-review__gh_pr_merge", JSON.stringify({ status: "merged", pr_summary: EN })),
    EN,
  );
  assert.equal(githubPrSummary("mcp__github-review__gh_pr_get", answer), ""); // (a read, not a write)
  assert.equal(
    githubPrSummary("mcp__github-review__gh_review_submit", '{"status": "submitted", "pr_summary": "cut of'),
    "",
  );
  assert.equal(githubPrSummary("mcp__github-review__gh_review_submit", '{"status": "submitted"}'), "");
});
