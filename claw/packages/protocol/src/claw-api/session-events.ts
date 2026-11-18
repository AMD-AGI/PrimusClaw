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
