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
export { failedLine, isShell, Label, labelFor, lookupLabel, skillInCommand } from "./step-labels.js";
export { planText, type Todo, todosOf } from "./plan.js";
export type { TurnClaw, TurnSurface } from "./ports.js";
export {
  StatusMessage,
  type StatusOptions,
  turnStatusMessage,
  type TurnStatusOptions,
} from "./progress/status-message.js";
export {
  defaultStreamFinish,
  type LiveViewLike,
  type StatusPolicy,
  STREAM_TEXT_MAX,
  type StreamFinish,
  type StreamFinishInput,
  TurnStatusPolicy,
} from "./progress/status-policy.js";
export type { Step } from "./step.js";
export { TurnState } from "./turn-state.js";
export { type ChangesModel, type DeliveryModel, viewMessage } from "./views.js";
export { type ReviewTurnOptions, type TurnApprovals, TurnEngine, type TurnEngineDeps } from "./runner.js";
export {
  OFFER_KEEP_SECONDS,
  type Offer,
  STOP_CARD_DELAY_SECONDS,
  STOP_KINDS,
  StopButtons,
  type StopButtonsDeps,
  type StopKind,
  stopMessage,
  type StopModel,
} from "./stop-buttons.js";
export { stopText } from "../locales/turn.js";
