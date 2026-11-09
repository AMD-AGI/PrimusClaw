// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { JsonObject } from "../../json.js";
import type { ClawCredential } from "../../claw/credential.js";
import type { GithubConnection, MemoryState } from "../../claw/model.js";
import type { NotificationSubscription } from "../../protocol.js";

/** The person's own settings in Claw: memory, models, the assistant's model choice, GitHub. */
export interface ClawSettingsPort {
  /** Memory on or off, whether Claw has it, and up to `limit` remembered items (profile entries left out). */
  memory(key: ClawCredential, limit?: number): Promise<MemoryState>;
  /** Turns memory on or off; what Claw answers. */
  setMemory(key: ClawCredential, enabled: boolean): Promise<{ enabled: boolean; available: boolean }>;
  /** The models the key's owner may use. ClawError when Claw cannot say (never an empty list for that). */
  models(key: ClawCredential): Promise<string[]>;
  /** The assistant's model settings, or null for a Claw without model choice (404). */
  assistantSettings(token: ClawCredential): Promise<JsonObject | null>;
  /** `high_risk_confirm` or `fully_auto` ("" not said). */
  reviewMode(token: ClawCredential): Promise<string>;
  setReviewMode(token: ClawCredential, mode: string): Promise<void>;
  /** Which GitHub token Claw would use for them, or null for a Claw without the answer (404). */
  githubConnection(token: ClawCredential): Promise<GithubConnection | null>;
}

/** A notification subscription as Claw lists it; the signing secret only on the answer that made it. */
export type ClawSubscription = Partial<NotificationSubscription> & { readonly secret?: string } & JsonObject;

/** Notification subscriptions (`/v1/notification-subscriptions`). ClawError(404): notifications are off on Claw. */
export interface ClawNotificationsPort {
  list(key: ClawCredential): Promise<ClawSubscription[]>;
  /** Subscribes the key's owner at `url`; the reply carries the signing secret, once. Empty lists: Claw's defaults. */
  create(
    key: ClawCredential,
    url: string,
    eventTypes?: readonly string[],
    sources?: readonly string[],
  ): Promise<ClawSubscription>;
  /** Changes which events (and, given, which sources) a subscription gets; `enable` turns it on again. */
  updateTypes(
    key: ClawCredential,
    subscriptionId: string,
    eventTypes: readonly string[],
    options?: { enable?: boolean; sources?: readonly string[] },
  ): Promise<ClawSubscription>;
  delete(key: ClawCredential, subscriptionId: string): Promise<void>;
}

/** What a scheduled trigger is made or changed with. `action` "brief": the assistant says the brief, no run. */
export interface TriggerInput {
  readonly name: string;
  readonly prompt: string;
  readonly schedule: string;
  readonly timezone: string;
  readonly action?: string;
}

/** The caller's own scheduled triggers (`/v1/triggers`), passed on as Claw answers them. */
export interface ClawTriggersPort {
  list(key: ClawCredential): Promise<JsonObject[]>;
  create(key: ClawCredential, trigger: TriggerInput): Promise<JsonObject>;
  /** `action` is not sent on a change. */
  update(key: ClawCredential, triggerId: string, trigger: TriggerInput): Promise<JsonObject>;
  delete(key: ClawCredential, triggerId: string): Promise<void>;
}

/** Held high-risk merges of GitHub reviews (`/v1/github-review/confirmations`). */
export interface ClawMergeConfirmationsPort {
  /** The merges this session waits on someone to confirm. ClawError(404): the review feature is off. */
  pending(key: ClawCredential, sessionId: string): Promise<JsonObject[]>;
  /** The answer of the user the review acts for (`allow` | `deny`); exchanged token only. `{status, reason, merge_sha}`. */
  decide(token: ClawCredential, confirmationId: string, decision: string): Promise<JsonObject>;
}
