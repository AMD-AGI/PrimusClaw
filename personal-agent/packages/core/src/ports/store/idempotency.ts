// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Work done at most once: activity ids and Claw events (tables `processed`, `event_claims`). */

export type EventClaim =
  { readonly state: "claimed"; readonly holder: string } | { readonly state: "done" | "busy"; readonly holder: "" };

export interface IdempotencyRepository {
  /** Marks `activityId` processed; true only for the one caller that marked it. */
  claimProcessed(activityId: string): boolean;
  /** Claim a Claw event for sending; of any number of copies on the same store, one is sent. */
  claimEvent(key: string): EventClaim;
  /** The event reached the chat: every later copy is a duplicate for PROCESSED_TTL_SECONDS. */
  finishEvent(key: string): void;
  /** The send failed or was put off: only the claim `holder` took is let go. */
  releaseEvent(key: string, holder: string): void;
  seen(activityId: string): boolean;
  /** Also prunes expired processed ids, pending requests and delivered reports. */
  markProcessed(activityId: string): void;
}
