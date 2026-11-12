// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A session's event stream as the Claw HTTP API serves it: `GET /v1/chat/sessions/:id/messages` as SSE, and the same
 * history as JSON with `?mode=replay`.
 *
 * Types and constants only. The API builds these in `packages/api/src/routes/events.ts`.
 */

/**
 * The SSE event that ends the replayed history and starts the live stream. It carries no `id:`, so it never moves a
 * client's Last-Event-ID.
 */
export const HISTORY_COMPLETE_EVENT = "historyComplete";

/** The `data:` of the `historyComplete` frame. */
export interface HistoryCompleteData {
  type: typeof HISTORY_COMPLETE_EVENT;
  /** The events the history sent. */
  count: number;
  /** Older events were not sent; `?history=all`, or `?mode=replay` with `after`/`tail`, reads them. */
  has_more: boolean;
}

/** One stored event of `?mode=replay`, oldest first: the row the SSE stream sends as `id:` and `data:`. */
export interface SessionReplayRow<Time = string> {
  event_id: string;
  /** The stored event's name; `data.type` says what it is to a client. */
  event_type: string;
  /** The event, redacted as the stream sends it. */
  data: unknown;
  created_at: Time;
}

/** `?mode=replay` with `tail`, `limit` or `after`: one window of the history, and whether more remains past its cut. */
export interface SessionReplayWindow<Time = string> {
  ok: true;
  data: Array<SessionReplayRow<Time>>;
  has_more: boolean;
}

/**
 * The model's own text while it is written: one `assistantTextDelta` per piece, from the model's first token on, before the
 * turn's `AssistantMessage` carries the whole text. Live only: the API forwards it to whoever follows the session and stores
 * none of it, so a replayed history has the `AssistantMessage` alone.
 *
 * A client appends each `delta` to the text named by `text_id`, in `seq` order, and replaces that text with the block of the
 * `AssistantMessage` whose `text_id` names it when that arrives. A client that does not know the event keeps working as before:
 * the `AssistantMessage` is unchanged. Top-level run only (a sub-agent's text is its parent's to report), and not for an
 * assistant router turn, whose text streams as its say's (`toolTextDelta`).
 */
export const ASSISTANT_TEXT_DELTA_EVENT = "assistantTextDelta";

/** The `data:` of an `assistantTextDelta` frame. */
export interface AssistantTextDeltaData {
  type: typeof ASSISTANT_TEXT_DELTA_EVENT;
  /** One text block of one model call. Every delta of the block carries it; so does the `AssistantMessage` that ends it. */
  text_id: string;
  /** 0, 1, 2, ... per `text_id`: the order the deltas are appended in. */
  seq: number;
  /** The text written since the previous delta of this `text_id`. */
  delta: string;
  /** The loop's turn the text belongs to. */
  turn: number;
  /** The run (`ExecuteRequest.message_id`), as on every event of the run. */
  message_id?: string;
}

/**
 * Text streamed as `assistantTextDelta` that is not going to be the turn's: the model call that wrote it failed and is made
 * again (`reason: "retry"`), and the retry streams under new ids. A client drops what it showed under `text_id`. Live only.
 */
export const ASSISTANT_TEXT_VOID_EVENT = "assistantTextVoid";

/** The `data:` of an `assistantTextVoid` frame. */
export interface AssistantTextVoidData {
  type: typeof ASSISTANT_TEXT_VOID_EVENT;
  text_id: string;
  reason: "retry";
  message_id?: string;
}
