// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the turn engine needs from the world: narrow views of the ports other lines own (W0: Conversation, Clock, Logger,
 * ModelRefusalPolicy; W2: ClawPort). Nothing here knows Teams, HTTP or a card's JSON.
 */

import type { Clock } from "../ports/clock.js";
import type { Conversation, FetchedFile, OutMessage } from "../ports/surface.js";
import type { SseEvent } from "./upstream.js";

/** Monotonic seconds of `clock`: the unit the turn's intervals are written in. */
export function nowSeconds(clock: Clock): number {
  return clock.monotonicMs() / 1000;
}

/** Sleep `seconds` of `clock`; rejects with the signal's reason when it is aborted. */
export function sleepSeconds(clock: Clock, seconds: number, signal?: AbortSignal): Promise<void> {
  return clock.sleep(seconds * 1000, signal);
}

/** A message as it will be published, built before the publish so it can be recorded first (an approval card). */
export interface Envelope {
  readonly body: Readonly<Record<string, unknown>>;
}

/**
 * The conversation the turn answers in: the Conversation port, and the two calls that let an approval card be recorded
 * (as published, byte for byte) before it is sent. INTERIM until W0 adds them to Conversation.
 */
export interface TurnSurface extends Pick<Conversation, "typing" | "send" | "post" | "update" | "delete" | "openStream"> {
  outgoing(message: OutMessage): Envelope;
  deliver(envelope: Envelope): Promise<void>;
}

// --- Claw (the turn's subset of W2's ClawPort) ----------------------------------------------------------------------

export interface CreateSessionOptions {
  readonly repo?: readonly [url: string, branch: string];
  readonly actingAs?: string;
  readonly reviewTarget?: readonly [owner: string, repo: string, number: number];
  readonly modelKey?: string;
  readonly model?: string;
  readonly reviewOnly?: boolean;
  readonly withMessage?: boolean;
  readonly shared?: boolean;
}

export interface SendOptions {
  readonly modelKey?: string;
  readonly acting?: boolean;
}

/** One stored event of a replay: `{event_id, event_type, data}`. */
export interface ReplayRow {
  readonly event_id?: unknown;
  readonly event_type?: unknown;
  readonly data?: unknown;
}

/** A file as Claw takes it: its name, bytes and media type. */
export interface UploadFile extends FetchedFile {
  readonly mediaType: string;
}

/** The turn's subset of the Claw port. Errors: ClawError (an error status), ClawUnreachable, ClawReplyInvalid. */
export interface TurnClaw {
  createSession(
    key: string,
    text: string,
    idempotencyKey: string,
    options: CreateSessionOptions,
  ): Promise<readonly [string, string | undefined]>;
  /** The message's id, or undefined when Claw queued it behind a turn still running. */
  sendMessage(key: string, sessionId: string, text: string, options: SendOptions): Promise<string | undefined>;
  setSessionModel(key: string, sessionId: string, model: string): Promise<void>;
  /** The id of the session's newest stored event (undefined: none). */
  lastEventId(key: string, sessionId: string): Promise<string | undefined>;
  /** (running, the id of the turn holding the session). */
  sessionTurn(key: string, sessionId: string): Promise<readonly [boolean, string | undefined]>;
  /** The session's SSE stream: history first, then live events. It ends (or rejects) when `signal` is aborted. */
  stream(key: string, sessionId: string, options: { after?: string; signal?: AbortSignal }): AsyncIterable<SseEvent>;
  /** Puts files in the session's workspace; (the paths the agent finds them at, the names Claw did not take). */
  uploadFiles(
    key: string,
    sessionId: string,
    folder: string,
    files: readonly UploadFile[],
  ): Promise<readonly [string[], string[]]>;
  /** The session's stored events, oldest first; `tail`: only the last ones; refused past `maxBytes`. */
  sessionEvents(
    key: string,
    sessionId: string,
    options: { tail?: number; maxBytes?: number },
  ): Promise<readonly ReplayRow[]>;
  /** Where the user downloads a delivered file; undefined when Claw is not reached over https. */
  deliveryLink(sessionId: string, deliveryId: string): string | undefined;
  /** Claw's raw answer to `GET /v1/sessions/<id>/changes`, read within `timeoutSeconds`. */
  sessionChanges(key: string, sessionId: string, timeoutSeconds: number): Promise<unknown>;
}
