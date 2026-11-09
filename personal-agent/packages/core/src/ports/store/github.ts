// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** GitHub review delegation: held writes, sessions that act as someone, followed reviews and rationed notices
 * (tables `github_confirmations`, `acting_sessions`, `review_notices`, `asker_follows`, `github_notices`). */
import type { JsonObject } from "./json.js";

export type ConfirmationState = "pending" | "sending" | "done" | (string & {});

/** A write that waits for the person the review acts for. A click is checked against this row, never the card. */
export interface GithubConfirmation {
  /** Claw's id. */
  readonly confirmationId: string;
  readonly sessionId: string;
  /** The only person who may answer. */
  readonly actorId: string;
  readonly requesterId: string;
  readonly repo: string;
  readonly pr: number;
  readonly reference: JsonObject;
  readonly expiresAt: number;
  readonly state: ConfirmationState;
  readonly createdAt: number;
  /** 'merge', or 'review'. */
  readonly kind: string;
  /** Of a review: APPROVE, REQUEST_CHANGES or COMMENT; '' for a merge. */
  readonly event: string;
}

export type NewGithubConfirmation = Omit<GithubConfirmation, "state" | "createdAt" | "kind" | "event"> & {
  readonly kind?: string;
  readonly event?: string;
};

export interface GithubConfirmationRepository {
  /** False when it is already recorded (the same one is never sent twice). */
  addGithubConfirmation(confirmation: NewGithubConfirmation): boolean;
  getGithubConfirmation(confirmationId: string): GithubConfirmation | null;
  /** Still waiting for this person's answer, oldest first. */
  pendingGithubConfirmations(actorId: string): GithubConfirmation[];
  /** False when it was not in `onlyFrom` (default 'pending'). */
  moveGithubConfirmation(confirmationId: string, state: ConfirmationState, options?: { readonly onlyFrom?: ConfirmationState }): boolean;
  /** The card could not be sent: a pending row goes. */
  forgetGithubConfirmation(confirmationId: string): void;
}

export interface ReviewNotice {
  readonly sessionId: string;
  readonly actorId: string;
  readonly requesterId: string;
  readonly pull: string;
  readonly delivered: boolean;
  readonly reason: string;
}

export interface AskerFollow {
  readonly itemId: string;
  readonly batchId: string;
  readonly review: unknown;
  readonly reference: unknown;
  readonly said: string;
  readonly reviewerTold: boolean;
  readonly deadline: number;
}

export interface ReviewDelegationRepository {
  /** A session that acts as another person (a review for a colleague). */
  noteActingSession(sessionId: string, requesterId: string, actorId: string): void;
  isActingSession(sessionId: string): boolean;
  /** The audit of the notice a reviewer is sent after something was left on GitHub as them. */
  noteReviewNotice(notice: ReviewNotice): void;
  /** In the order written. */
  reviewNotices(): ReviewNotice[];
  addAskerFollow(follow: { readonly itemId: string; readonly batchId: string; readonly review: JsonObject; readonly reference: JsonObject; readonly deadline: number }): void;
  /** Oldest first. */
  askerFollows(): AskerFollow[];
  askerFollowSaid(itemId: string, said: string): void;
  askerFollowReviewerTold(itemId: string): void;
  dropAskerFollow(itemId: string): void;
  /** One notice of this kind per person per `interval` seconds. */
  claimGithubNotice(userId: string, kind: string, interval: number): boolean;
  releaseGithubNotice(userId: string, kind: string): void;
}
