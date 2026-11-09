// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The turn engine and the answer's views (the Python worker's turn.py and the answer/progress/plan part of render.py):
 * submit a message to Claw, follow the session's stream, show progress, answer. Exported as the `turn` namespace.
 */

export {
  answerParts,
  deepLink,
  MAX_ANSWER_CHARS,
  MAX_ANSWER_MESSAGES,
  replyParts,
  wholeParts,
} from "./answer-parts.js";
export {
  type Changes,
  type FileChange,
  parseChanges,
  type RepoChanges,
  repoName,
  totalAdditions,
  totalDeletions,
  totalFiles,
} from "./changes.js";
export { clip, plain, SUMMARY_MAX, TITLE_MAX } from "./clip.js";
export {
  assistantDeliveries,
  DELIVERIES_MAX,
  type Delivery,
  deliveryLine,
  deliveryOf,
  INLINE_IMAGE_MAX_BYTES,
  sizeText,
} from "./deliveries.js";
export {
  type TurnContext,
  type TurnDeps,
  type TurnHooks,
  type TurnRecord,
  type TurnRequest,
  type TurnStyle,
  newRecord,
} from "./engine/context.js";
export { stillRunningText, TURN_DEADLINE_SECONDS } from "./engine/outcome.js";
export { runTurn, type TurnControls } from "./engine/run-turn.js";
export { filesNote, failedFilesLine, shownName, uploadFolder } from "./files.js";
export { type GithubOutcome, githubPrSummary, githubResult, githubWrite, reviewComments } from "./github-outcome.js";
export { lastAnswer, LAST_ANSWER_TAIL, type LastAnswerDeps } from "./last-answer.js";
export { LIVE_HEADER, LIVE_HEADERS, LiveView } from "./live-view.js";
export { planText, type Todo, todosOf } from "./plan.js";
export type { TurnClaw, TurnSurface } from "./ports.js";
export { StatusMessage } from "./progress/status-message.js";
export type { Step } from "./step.js";
export { TurnState } from "./turn-state.js";
export { type ChangesModel, type DeliveryModel, viewMessage } from "./views.js";
