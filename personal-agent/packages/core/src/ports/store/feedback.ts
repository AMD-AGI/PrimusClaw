// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Feedback (tables `feedback_reports`, `feedback_asks`, `feedback_offers`, `feedback_prompts`). A report is written
 * before anything is sent to GitHub, so one that cannot be delivered yet is never lost.
 */
import type { IssueRef } from "../../plugins/feedback-sink.js";

export interface FeedbackReport {
  readonly id: number;
  readonly userId: string;
  readonly scope: string;
  readonly sessionId: string;
  readonly text: string;
  readonly scene: string;
  readonly createdAt: number;
  /** 'pending' (not yet in GitHub) or 'filed'. */
  readonly state: "pending" | "filed" | (string & {});
  readonly issueNumber: number | null;
  readonly issueUrl: string;
  /** Filed as a comment on an earlier report's issue. */
  readonly asComment: boolean;
  readonly attempts: number;
  readonly nextAttemptAt: number;
  readonly lastError: string;
  readonly reporterName: string;
  readonly reporterEmail: string;
}

export interface NewFeedbackReport {
  readonly userId: string;
  readonly scope: string;
  readonly sessionId: string;
  readonly text: string;
  readonly scene: string;
  readonly reporterName?: string;
  readonly reporterEmail?: string;
}

export type FeedbackOfferState = "open" | "sending" | "done" | "declined" | (string & {});

export interface FeedbackOffer {
  readonly offerId: string;
  readonly userId: string;
  readonly issueNumber: number;
  readonly sessionId: string;
  readonly turnId: string;
  readonly createdAt: number;
  readonly state: FeedbackOfferState;
}

export interface FeedbackPrompt {
  readonly promptId: string;
  /** The person whose message went wrong: in a group, the only one who may press the button. */
  readonly userId: string;
  /** '' for the 1:1 chat, the conversation id for a group. */
  readonly scope: string;
  readonly createdAt: number;
}

export interface FeedbackRepository {
  /** Returns the new report's id. */
  addFeedbackReport(report: NewFeedbackReport): number;
  getFeedbackReport(reportId: number): FeedbackReport | null;
  /** The issue of the newest filed report of the same person, chat and session within FEEDBACK_DEDUPE_SECONDS. */
  feedbackTarget(report: FeedbackReport): IssueRef | null;
  markFeedbackFiled(reportId: number, issue: IssueRef, asComment: boolean): void;
  /** `error` is kept to 80 characters. */
  markFeedbackFailed(reportId: number, error: string, retryAt: number): void;
  /** Undelivered reports whose retry time has come, oldest first. */
  dueFeedback(limit: number): FeedbackReport[];
  pendingFeedbackCount(): number;
  /** A bare /feedback: the person's next message in this chat is the report. */
  openFeedbackAsk(userId: string, scope: string): void;
  /** True (and closed) when an unexpired ask is open. */
  takeFeedbackAsk(userId: string, scope: string): boolean;
  hasFeedbackAsk(userId: string, scope: string): boolean;
  addFeedbackOffer(userId: string, issueNumber: number, sessionId: string, turnId: string): string;
  getFeedbackOffer(offerId: string): FeedbackOffer | null;
  /** `onlyFrom` defaults to 'open'; null moves from any state. */
  moveFeedbackOffer(
    offerId: string,
    state: FeedbackOfferState,
    options?: { readonly onlyFrom?: FeedbackOfferState | null },
  ): boolean;
  /** A "Report a problem" button; its owner is kept here, not on the card. */
  addFeedbackPrompt(userId: string, scope: string): string;
  /** Null once older than FEEDBACK_PROMPT_TTL_SECONDS. */
  getFeedbackPrompt(promptId: string): FeedbackPrompt | null;
}
