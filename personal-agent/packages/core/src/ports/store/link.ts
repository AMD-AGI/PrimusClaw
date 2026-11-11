// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Account links: the SaFE key a person linked from the console with a short `/link` code (tables `links`,
 * `pending_keys`, `link_attempts`). Keys are encrypted at rest; codes are kept only as a keyed hash.
 */

/** How many wrong `/link` codes are allowed in `windowSeconds`: per person, and of all people together. */
export interface LinkLimits {
  readonly perUser: number;
  readonly global: number;
  readonly windowSeconds: number;
}

/**
 * The answer to a typed code: `invalid` is one answer for wrong, expired and used codes; `limited` (this person has too
 * many wrong codes in the window) and `global_limit` (everyone together has) refuse even a correct code.
 */
export type RedeemOutcome = "ok" | "invalid" | "limited" | "global_limit";

export interface LinkRepository {
  /** Hold a key the console just minted under a fresh code and return the code. Nothing a chat sends can create one. */
  stashPending(key: string): string;
  /** How long a wrong code counts against its person and everyone. */
  readonly linkWindowSeconds: number;
  /** Bind the pending key of `code` to the person who typed it. Spaces are ignored and case does not matter. */
  redeemPending(userId: string, name: string, code: string, activityId?: string): RedeemOutcome;
  /** Delete the pending keys nobody redeemed in time and return them, so the caller can revoke them. */
  takeExpiredPending(): string[];
  /** The key of exactly this person; there is no fallback to any other key. */
  getKey(userId: string): string | null;
  /** Forget the person's link and everything kept for them that a key is needed for. */
  unlink(userId: string): void;
  /** The Claw user id of the account the person is linked to. */
  setClawUserId(userId: string, clawUserId: string): void;
  /** Linked before the Claw user id was kept (or the lookup failed at link time). */
  needsClawUserId(userId: string): boolean;
  /**
   * The link's Claw user id; for a person with no link, the one kept for their binding at the identity service (their
   * chats run on exchanged tokens). The assistant reaches either by it.
   */
  clawUserIdOf(userId: string): string | null;
  /**
   * A person with no link, bound at the identity service: the Claw user id kept for them, and whether it was read with
   * `credential` (the token they write with now); null when none is kept.
   */
  boundClawUser(userId: string, credential: string): { clawUserId: string; current: boolean } | null;
  /**
   * Keep the Claw user id read with `credential` for a bound person with no link. When it names another account than the
   * one kept, their subscription (made with the earlier account's token) is forgotten, to be made again with this one.
   */
  setBoundClawUser(userId: string, clawUserId: string, credential: string): void;
  /** A person with no link is no longer bound: forget their kept Claw user id and their subscription. */
  forgetBound(userId: string): void;
  /** Every linked person, in a stable order. */
  linkedUsers(): string[];
  userForClawUser(clawUserId: string): string | null;
  /** Every person whose link records this Claw user (one, normally). */
  usersForClawUser(clawUserId: string): string[];
}
