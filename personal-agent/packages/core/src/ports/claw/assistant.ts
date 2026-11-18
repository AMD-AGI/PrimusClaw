// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { JsonObject } from "../../json.js";
import type { ClawCredential } from "../../claw/credential.js";
import type { PullRef, ReviewStart } from "../../claw/model.js";

/** One pull request to review and the first message its session gets ("" Claw's own). */
export interface ReviewTarget {
  readonly pull: PullRef;
  readonly message: string;
}

/** A request for reviews (`POST /v1/assistant/reviews`); all of them start or none does. */
export interface StartReviews {
  /** The requester's own linked key, as the model key (not sent for a review asked of someone else). */
  readonly modelKey: string;
  readonly prs: readonly ReviewTarget[];
  readonly actingAs: string;
  readonly actingAsName: string;
  readonly reviewOnly: boolean;
  readonly model: string;
  /** A review asked of someone else: that person's exchanged token and own linked key. */
  readonly actingToken?: string;
  readonly actingKey?: string;
  /** The asker's own words, quoted to the reviewer as untrusted. */
  readonly requesterNote?: string;
  /** The handoff the assistant gave back, whose record says what the review may do. */
  readonly handoffId?: string;
}

/** Options of a message to the assistant. */
export interface AssistantMessageOptions {
  readonly modelKey?: string;
  /** The chat's `channel_context`. */
  readonly context?: Readonly<JsonObject>;
  /** The plugin id the web client names (`pluginId`). */
  readonly plugin?: number;
}

/** The person's assistant in Claw and what it does for them (`/v1/assistant/*`). */
export interface ClawAssistantPort {
  /** The key owner's assistant session, made on first use. ClawError(404): the assistant is off on this Claw. */
  session(key: ClawCredential): Promise<{ sessionId: string; created: boolean }>;
  /** Says `text` to the assistant as typed; its message id, or null when queued. The answer comes back as an event. */
  send(key: ClawCredential, sessionId: string, text: string, options?: AssistantMessageOptions): Promise<string | null>;
  /** The caller's brief, put together now: `{date, lang, sections, needs_you, text}`. */
  brief(key: ClawCredential, lang: string, timezone: string): Promise<JsonObject>;
  /** The person's answer to a held write the assistant put to them (`allow` or `deny`); exchanged token only. */
  decideConfirmation(token: ClawCredential, confirmationId: string, decision: string): Promise<JsonObject>;
  /** Reviews as `actingAs`, each a work item. ReviewsRefused: none started. ClawError(404): a Claw without the route. */
  startReviews(token: ClawCredential, request: StartReviews): Promise<ReviewStart[]>;
  /** Makes the key owner's watcher of `scope` observe it. */
  observeScope(key: ClawCredential, scope: string): Promise<JsonObject>;
  /** Hands one message of an observed place to the watcher. ClawError(429 observe_backlog): it is behind. */
  observe(key: ClawCredential, scope: string, content: string, messageId: string): Promise<JsonObject>;
  /** What the watcher of `scope` would have done, newest first ([] for a scope never watched). */
  observations(key: ClawCredential, scope: string, limit?: number): Promise<JsonObject[]>;
}
