// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { ClawAnswerInvalid, ClawError, ClawUnreachable, ReplayRefused } from "../claw/errors.js";
import { errorName } from "../errors.js";
import type { ClawSessionsPort } from "../ports/claw/sessions.js";
import type { Clock } from "../ports/clock.js";
import type { Logger } from "../ports/logger.js";
import { pyStr } from "../text/py-text.js";
import { withDeadline } from "./deadline.js";
import type { HistoryRow } from "./scene.js";

/**
 * The last events of a session, read with the person's own key, for a report: the scene's last turns, and the last
 * exchange a reporter chose to add. Never the whole history: an assistant session runs for weeks (one reached 33,196
 * events, 28.6 MB), so the replay asks for the tail alone and refuses a larger reply unread (an older Claw ignores
 * `tail`); when the replay cannot be used, the stream's history is read event by event and only its tail is kept.
 */

export const HISTORY_TAIL = 200;
export const HISTORY_MAX_BYTES = 4 * 1024 * 1024;
const STREAM_MS = 15_000;
/** The SSE frame that ends the replay of history (Claw's `routes/events.ts`). */
const HISTORY_COMPLETE = "historyComplete";

/** Why a session could not be read, as a report's scene says it: never a body or a message. */
export function whyNotRead(err: unknown): string {
  if (err instanceof ClawError) return `Claw status ${String(err.status)}`;
  return err instanceof Error && err.name === "TimeoutError" ? "timed out" : errorName(err);
}

/** What makes the replay unusable, so the stream is tried; a key Claw refuses is not tried again. */
function replayUnusable(err: unknown): boolean {
  if (err instanceof ClawError) return err.status !== 401 && err.status !== 403;
  return err instanceof ClawUnreachable || err instanceof ReplayRefused || err instanceof ClawAnswerInvalid;
}

export interface HistoryReader {
  readonly sessions: Pick<ClawSessionsPort, "events" | "stream">;
  readonly clock: Clock;
  readonly log: Logger;
}

export async function readHistory(reader: HistoryReader, key: string, sessionId: string): Promise<HistoryRow[]> {
  try {
    const rows = await reader.sessions.events(key, sessionId, { tail: HISTORY_TAIL, maxBytes: HISTORY_MAX_BYTES });
    return rows.map(rowOf);
  } catch (err) {
    if (!replayUnusable(err)) throw err;
    reader.log.info("feedback: the JSON replay was not used; reading the stream's history", {
      why: whyNotRead(err),
    });
  }
  return withDeadline(reader.clock, STREAM_MS, (signal) => streamTail(reader, key, sessionId, signal));
}

async function streamTail(reader: HistoryReader, key: string, sessionId: string, signal: AbortSignal) {
  const rows: HistoryRow[] = [];
  for await (const event of reader.sessions.stream(key, sessionId, undefined, signal)) {
    if (event.name === HISTORY_COMPLETE) break;
    rows.push({ event_id: event.id, event_type: event.name, data: event.data, created_at: null });
    if (rows.length > HISTORY_TAIL) rows.shift();
  }
  return rows;
}

function rowOf(row: Readonly<Record<string, unknown>>): HistoryRow {
  return {
    event_id: pyStr(row["event_id"]),
    event_type: pyStr(row["event_type"]),
    data: row["data"],
    created_at: row["created_at"],
  };
}
