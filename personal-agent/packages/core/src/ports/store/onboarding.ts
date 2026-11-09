// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Group onboarding of a member who has not linked yet (tables `onboarding_cards`, `onboarding_dms`,
 * `pending_requests`). */
import type { JsonObject } from "./json.js";

export interface OnboardingCard {
  readonly promptId: string;
  /** The member the card is for: the only one who may press its button. */
  readonly userId: string;
  /** The group chat's conversation id. */
  readonly scope: string;
  /** Their channel id (what a mention and a 1:1 conversation need). */
  readonly channelUserId: string;
  readonly name: string;
  readonly createdAt: number;
}

export interface PendingRequest {
  readonly userId: string;
  /** The group chat the request was made in. */
  readonly scope: string;
  readonly messageId: string;
  readonly text: string;
  /** Where to post in that chat. */
  readonly reference: JsonObject;
  readonly createdAt: number;
  /** The message(s) it quoted, as text for the model. */
  readonly quote: string;
  /** What it said with the addresses behind its links; '' when that is `text`. */
  readonly sent: string;
}

export type NewPendingRequest = Omit<PendingRequest, "createdAt" | "quote" | "sent"> & {
  readonly quote?: string;
  readonly sent?: string;
};

export interface OnboardingRepository {
  /** One card per person per group per day: the new card's id, or null when one went out within the day. */
  claimOnboardingCard(
    userId: string,
    scope: string,
    member: { readonly channelUserId: string; readonly name: string },
  ): string | null;
  /** The claimed card never reached the chat: the allowance is not spent. */
  releaseOnboardingCard(promptId: string): void;
  getOnboardingCard(promptId: string): OnboardingCard | null;
  /** One proactive DM per person per day. */
  claimOnboardingDm(userId: string): boolean;
  releaseOnboardingDm(userId: string): void;
  /** Kept for PENDING_REQUEST_TTL_SECONDS; a newer request replaces it. */
  savePendingRequest(request: NewPendingRequest): void;
  /** Once: gone after this call; null when none or expired. */
  takePendingRequest(userId: string): PendingRequest | null;
}
