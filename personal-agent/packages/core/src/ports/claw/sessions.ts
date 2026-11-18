// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { JsonObject } from "../../json.js";
import type { ClawCredential } from "../../claw/credential.js";
import type { PullRef, SseEvent } from "../../claw/model.js";

/** What a new session is made with (`POST /v1/sessions`). */
export interface NewSession {
  /** The first message; also the session's name (its first 50 characters). */
  readonly text: string;
  readonly idempotencyKey: string;
  /** The git repository the session is bound to (`config.repo`); `branch` "" takes the remote's default. */
  readonly repo?: { readonly url: string; readonly branch: string };
  /** The user the session's GitHub review tools act for (`config.acting_as`); needs an exchanged token, never an `ak-` key. */
  readonly actingAs?: string;
  /** The one pull request such a session's review tools may touch (`config.review_target`). */
  readonly reviewTarget?: PullRef;
  /** The requester's own linked key, sent as `x-api-key` next to an exchanged token (never next to an `ak-` key). */
  readonly modelKey?: string;
  /** The model its turns ask for; "" leaves the configured default (or Claw's). */
  readonly model?: string;
  /** `config.review_only`: Claw refuses a merge in that session. */
  readonly reviewOnly?: boolean;
  /** false: the session is made with no message (`text` is only its name) and `messageId` is "". Default true. */
  readonly withMessage?: boolean;
  /**
   * The short name of the chat app the message came through (`SurfaceCaps.shortName`), which the headings of what the
   * worker appends to it carry ("## Teams reply style ..."); without it they name none.
   */
  readonly channel?: string;
  /** Other people read the session (a group chat): `config.memory = "off"`. */
  readonly shared?: boolean;
}

/** One file put into a session's workspace. */
export interface UploadFile {
  readonly name: string;
  readonly content: Uint8Array;
  readonly mediaType: string;
}

/** Options of a message into a session. */
export interface SendOptions {
  /** See `NewSession.modelKey`. */
  readonly modelKey?: string;
  /** See `NewSession.channel`. */
  readonly channel?: string;
  /** The session acts as a user: the message goes as the text alone, without plugin or appended rules. */
  readonly acting?: boolean;
}

/**
 * Claw sessions: making them, writing into them and reading them back
 * (`/v1/sessions/*`, `/v1/chat/sessions/:id/messages`).
 */
export interface ClawSessionsPort {
  /** Throws ClawError(401) when Claw does not accept the key. */
  checkKey(key: ClawCredential): Promise<void>;
  /** A new session; its first message's id ("" when made without one). */
  create(key: ClawCredential, session: NewSession): Promise<{ sessionId: string; messageId: string }>;
  /**
   * Puts files in the session's workspace under `.uploads/<folder>/` (kept 7 days): the paths the agent finds them at,
   * and the names Claw did not take.
   */
  uploadFiles(
    key: ClawCredential,
    sessionId: string,
    folder: string,
    files: readonly UploadFile[],
  ): Promise<{ paths: string[]; refused: string[] }>;
  /** Pins an existing session to `model` (`PATCH /v1/sessions/:id`). */
  setModel(key: ClawCredential, sessionId: string, model: string): Promise<void>;
  /** Sends `text`; its message id, or null when Claw queued it behind a turn still running. */
  sendMessage(key: ClawCredential, sessionId: string, text: string, options?: SendOptions): Promise<string | null>;
  /** Whether a turn holds the session, and that turn's message id when Claw says it. */
  turn(key: ClawCredential, sessionId: string): Promise<{ running: boolean; messageId: string | null }>;
  /**
   * The session's stored events as rows `{event_id, event_type, data, created_at}`, oldest first (`?mode=replay`).
   * `tail`: only the last `tail`. `maxBytes`: a larger reply is refused (ReplayRefused) before it is held whole.
   */
  events(key: ClawCredential, sessionId: string, options?: { tail?: number; maxBytes?: number }): Promise<JsonObject[]>;
  /** The id of the session's newest stored event (null: none), read bounded. */
  lastEventId(key: ClawCredential, sessionId: string): Promise<string | null>;
  /**
   * What the session changed in its sandbox (`GET /v1/sessions/:id/changes`), as Claw answers it; the whole call is
   * bounded by `timeoutMs` (ClawUnreachable "timeout") and a reply larger than the limit is refused (ReplayRefused).
   */
  changes(key: ClawCredential, sessionId: string, timeoutMs: number): Promise<unknown>;
  /** Where the user downloads a file the agent delivered (null when Claw is not reached over https). */
  deliveryLink(sessionId: string, deliveryId: string): string | null;
  /** Ends the running turn. */
  interrupt(key: ClawCredential, sessionId: string): Promise<void>;
  /** The answer to an approval card of the session's model (`messageType: decision`). */
  decide(
    key: ClawCredential,
    sessionId: string,
    toolUseId: string,
    action: string,
    options?: { acting?: boolean },
  ): Promise<void>;
  /** The answer to a question card (`messageType: answer`): {question id: answer} and the ids left blank. */
  answer(
    key: ClawCredential,
    sessionId: string,
    toolUseId: string,
    answers: Readonly<Record<string, string>>,
    skipped: readonly string[],
    options?: { acting?: boolean },
  ): Promise<void>;
  /** The key owner's thumbs up or down on one answer of their session (a second vote replaces the first). */
  vote(key: ClawCredential, sessionId: string, messageId: string, vote: "up" | "down", reason?: string): Promise<void>;
  /**
   * The session's SSE stream: history first (ended by `historyComplete`), then live events. `onOpen` is called once Claw has
   * answered the request (its status), before any event: from then on, what the session says reaches this stream.
   */
  stream(
    key: ClawCredential,
    sessionId: string,
    after?: string,
    signal?: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<SseEvent>;
}
