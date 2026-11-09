// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The GitHub review delegation: a colleague reviews (and, when it is safe, merges) a public pull request as the person who
 * was named for it, on that person's own GitHub account, which only Claw's restricted review tools use on the server.
 */
export * from "./views.js";
export { REVIEW_MODE_NAMES, isReviewMode, type ReviewMode } from "./review-turn.js";
export { INTENT_PROMPT, MODE_PROMPT } from "../locales/review-github.js";
export { connectionsText, UNKNOWN, type ConnectionsInput } from "./connect/connections.js";
export { GithubReview } from "./service/github-review.js";
export type {
  ReviewDeps,
  ReviewHost,
  StartReviewTurn,
  RunningTurn,
  ReviewSlots,
  Guard,
  Audit,
  FollowWire,
  RestoreRef,
} from "./service/deps.js";
export { parseReviewHandoff, REVIEW_HANDOFF, type ReviewHandoff } from "./handoff.js";
export type { ReviewTurn } from "./review-turn.js";
