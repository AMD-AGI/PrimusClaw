// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** GitHub review delegation: held writes, sessions that act as someone, followed reviews, rationed notices and the
 * reviewers a request waits for (tables `github_confirmations`, `acting_sessions`, `review_notices`, `asker_follows`,
 * `github_notices`, `review_onboarding`). */
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
  moveGithubConfirmation(
    confirmationId: string,
    state: ConfirmationState,
    options?: { readonly onlyFrom?: ConfirmationState },
  ): boolean;
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

/**
 * A review asked of someone who cannot be acted as yet (their Primus account, GitHub or standing authorization is
 * missing): kept so that each step they complete is followed by the next, and the asker is told once all are done.
 */
export interface ReviewOnboarding {
  readonly onboardingId: string;
  /** The reviewer. */
  readonly actorId: string;
  readonly requesterId: string;
  /** The pull requests, "owner/repo#n" joined by spaces in the order asked. */
  readonly pulls: string;
  /** What the request is started again from (who, where, the merge flag, the note). */
  readonly request: JsonObject;
  /** The rank of the last step the reviewer was told about (0: none). */
  readonly toldRank: number;
  /** The asker was told the reviewer is ready. */
  readonly done: boolean;
  readonly createdAt: number;
}

export interface ReviewDelegationRepository {
  /** A session that acts as another person (a review for a colleague). */
  noteActingSession(sessionId: string, requesterId: string, actorId: string): void;
  isActingSession(sessionId: string): boolean;
  /** The audit of the notice a reviewer is sent after something was left on GitHub as them. */
  noteReviewNotice(notice: ReviewNotice): void;
  /** In the order written. */
  reviewNotices(): ReviewNotice[];
  addAskerFollow(follow: {
    readonly itemId: string;
    readonly batchId: string;
    readonly review: JsonObject;
    readonly reference: JsonObject;
    readonly deadline: number;
  }): void;
  /** Oldest first. */
  askerFollows(): AskerFollow[];
  askerFollowSaid(itemId: string, said: string): void;
  askerFollowReviewerTold(itemId: string): void;
  dropAskerFollow(itemId: string): void;
  /** One notice of this kind per person per `interval` seconds. */
  claimGithubNotice(userId: string, kind: string, interval: number): boolean;
  releaseGithubNotice(userId: string, kind: string): void;
  /**
   * Keeps (or refreshes) what waits for `actorId` to finish their steps, one per reviewer, asker and pull requests: an
   * earlier one of the same three takes this id (a button sent for the earlier request no longer answers), this request
   * and told rank, and is owed to the asker again. Drops
   * those older than REVIEW_ONBOARDING_KEEP_SECONDS. The kept row.
   */
  saveReviewOnboarding(onboarding: {
    readonly onboardingId: string;
    readonly actorId: string;
    readonly requesterId: string;
    readonly pulls: string;
    readonly request: JsonObject;
    readonly toldRank: number;
  }): ReviewOnboarding;
  getReviewOnboarding(onboardingId: string): ReviewOnboarding | null;
  /** What still waits for this reviewer (the asker not yet told), oldest first. */
  openReviewOnboardings(actorId: string): ReviewOnboarding[];
  /** Every reviewer something still waits for. */
  onboardingReviewers(): string[];
  /** Raises the told rank of every open one of `actorId` below `rank`; true for the one caller that raised any. */
  claimOnboardingStep(actorId: string, rank: number): boolean;
  /** Undoes a claim whose step could not be said: this one back to `to` while it is open and still at `from`. */
  releaseOnboardingStep(onboardingId: string, from: number, to: number): void;
  /** Marks it done (the asker is to be told); true for the one caller that marked it. */
  finishReviewOnboarding(onboardingId: string): boolean;
  dropReviewOnboarding(onboardingId: string): void;
}
