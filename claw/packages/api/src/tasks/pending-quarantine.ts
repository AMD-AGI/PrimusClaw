// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Isolating a queued message that cannot be sent.
 *
 * `claw_pending_messages` is FIFO per session and a drain takes only the oldest
 * row. A drain that throws leaves that row where it is, for the next completion
 * or the next sweeper tick to try again, with no limit. That is right for a
 * failure that clears -- a publish during a NATS failover, a lock wait -- and is
 * the whole outage for one that does not: the same message is retried for ever
 * and every later message on its session waits behind it, while the session
 * itself looks idle.
 *
 * So each failed attempt is counted on the row, and a row that has failed
 * `PENDING_DRAIN_MAX_FAILURES` times over at least
 * `PENDING_DRAIN_FAILURE_WINDOW_SEC` is moved, in one statement, from the queue
 * into `claw_pending_messages_quarantine`. Both bounds, because either alone is
 * wrong: a count alone quarantines a good message during a short outage, since
 * completions and sweeper ticks arrive seconds apart; a window alone gives a
 * message that fails once a day five more days at the head of the queue.
 *
 * Nothing is dropped. The quarantine keeps the message text, who sent it and
 * why it failed; the session is told, in the turn the message would have been,
 * that it was not sent and can be sent again; and the drain goes straight on to
 * the next message, because `withPendingDrainClaim` drains again whenever the
 * session is still free and something is still queued.
 *
 * Order is kept for everything that is still queued: only the head is ever
 * moved, and only after it has had its attempts.
 */

import pino from "pino";

import { envInt } from "../config.js";
import { db, PENDING_QUARANTINE_TABLE } from "../infra/db.js";
import { metrics } from "../infra/metrics.js";
import { completionAlreadyPublished } from "../events/store.js";
import { queuedMessageId } from "./chat-run.js";
import { PENDING_DRAIN_QUARANTINED, publishRefusedTurn } from "./pending-dispatch.js";

const logger = pino({ name: "pending-quarantine" });

/** Failed attempts a queued message is given before it can be quarantined. */
export const PENDING_DRAIN_MAX_FAILURES = envInt("PENDING_DRAIN_MAX_FAILURES", 5, { min: 2 });

/**
 * How long a message must have been failing before it can be quarantined, from
 * its first failed attempt. Ten minutes outlasts a NATS failover or a database
 * restart, which are what the retry is for.
 */
export const PENDING_DRAIN_FAILURE_WINDOW_SEC = envInt("PENDING_DRAIN_FAILURE_WINDOW_SEC", 600, { min: 0 });

/** Attempts at telling the session, after the first, before the notice is given up on. */
const NOTICE_MAX_ATTEMPTS = 10;

/** How long a claimed notice is left to the replica that claimed it. */
const NOTICE_CLAIM_SEC = 60;

/** How long a quarantined message is kept. The session's deletion removes it sooner. */
export const PENDING_QUARANTINE_RETENTION_DAYS = envInt("PENDING_QUARANTINE_RETENTION_DAYS", 30, { min: 1 });

/**
 * The prompt the notice carries, at most. The notice is the turn the message
 * would have been, so it carries the text the user sent; but a message can be
 * unsendable because of its size, and a notice that fails for the same reason
 * would never be delivered. The full text stays in the quarantine row.
 */
const NOTICE_PROMPT_MAX_CHARS = 32_000;

/** Seam over the event publish, so a test can see the notice and fail it. */
export const pendingQuarantinePorts = {
  publishRefusedTurn,
};

/** The queue row a drain was working on when it failed. */
export interface FailedPendingRow {
  sessionId: string;
  pendingId: number;
  userId: string;
  /** The message text: used to keep it out of the error recorded, never logged. */
  content: string;
}

/**
 * The error, as recorded on the row and in the log: its kind and the start of
 * its message, and never the queued text. An error that quotes the message --
 * a parser's complaint, a driver echoing a value -- is recorded by kind alone.
 */
export function drainErrorSummary(err: unknown, content: string): string {
  const e = err as { name?: unknown; code?: unknown; message?: unknown } | null | undefined;
  const kind = [typeof e?.name === "string" ? e.name : "Error", e?.code !== undefined ? String(e.code) : ""]
    .filter(Boolean).join(":");
  const message = String(typeof e?.message === "string" ? e.message : err ?? "").slice(0, 200);
  const probe = content.trim().slice(0, 24);
  if (probe.length >= 4 && message.includes(probe)) return `${kind}: (message withheld: it quotes the queued text)`;
  return `${kind}: ${message}`;
}

/**
 * Count a failed attempt on the queue row, and quarantine the row once it has
 * had its attempts.
 *
 * @returns `"quarantined"` when the row has left the queue, so the caller goes
 *          on to the next message instead of failing; `"retry"` when it is
 *          still queued for the next attempt.
 */
export async function recordPendingDrainFailure(
  row: FailedPendingRow,
  err: unknown,
): Promise<"quarantined" | "retry"> {
  metrics.onPendingDrainFailure();
  const error = drainErrorSummary(err, row.content);
  let counted: { drain_failures: number; window_spent: boolean } | undefined;
  try {
    counted = (await db.query(
      `UPDATE claw_pending_messages
          SET drain_failures = drain_failures + 1,
              drain_first_failed_at = COALESCE(drain_first_failed_at, NOW()),
              drain_last_error = $2
        WHERE id = $1
        RETURNING drain_failures,
                  drain_first_failed_at <= NOW() - make_interval(secs => $3) AS window_spent`,
      [row.pendingId, error, PENDING_DRAIN_FAILURE_WINDOW_SEC],
    )).rows[0] as typeof counted;
  } catch (countErr) {
    // The retry the caller falls back to is the behaviour before this module:
    // a counter that cannot be written must not turn a failed send into a lost one.
    logger.warn(
      { err: String(countErr), sessionId: row.sessionId, pendingId: row.pendingId, error },
      "pending.drain_failure_uncounted",
    );
    return "retry";
  }
  if (!counted) return "retry"; // another drain already took the row
  const failures = Number(counted.drain_failures);
  logger.warn(
    { sessionId: row.sessionId, pendingId: row.pendingId, failures, error },
    "pending.drain_failed",
  );
  if (failures < PENDING_DRAIN_MAX_FAILURES || counted.window_spent !== true) return "retry";
  return (await quarantinePendingMessage(row)) ? "quarantined" : "retry";
}

/**
 * Move the row out of the queue and tell the session.
 *
 * The move is one statement, so the row is in exactly one of the two tables at
 * every instant, and only the drain whose DELETE took it goes on to the notice:
 * a second drain of the same row moves nothing and says nothing.
 *
 * Not while a run this row reserved is still open. Such a run may yet deliver
 * the message (`recordedHandoffState` in tasks/pending-dispatch.ts calls it
 * "unsettled"), and the next drain settles it the ordinary way; quarantining
 * under it would end a turn that is about to run.
 *
 * @returns whether the row left the queue.
 */
async function quarantinePendingMessage(row: FailedPendingRow): Promise<boolean> {
  const messageId = queuedMessageId(row.pendingId);
  let moved: { attempts: number; last_error: string | null; queued_for_sec: number } | undefined;
  try {
    moved = await moveToQuarantine(row.pendingId, messageId);
  } catch (err) {
    // The row is still queued, which is where a failed move must leave it: the
    // next attempt is counted again and tries the move again.
    logger.warn(
      { err: String(err), sessionId: row.sessionId, pendingId: row.pendingId },
      "pending.quarantine_move_failed",
    );
    return false;
  }
  if (!moved) {
    logger.warn({ sessionId: row.sessionId, pendingId: row.pendingId }, "pending.quarantine_deferred");
    return false;
  }
  metrics.onPendingQuarantined();
  // The durable record is the row; this line is for whoever is paged. It names
  // the message and why it failed, and never what it said.
  logger.error(
    {
      sessionId: row.sessionId, pendingId: row.pendingId, messageId,
      attempts: moved.attempts, queuedForSec: moved.queued_for_sec, error: moved.last_error,
    },
    "pending.drain_quarantined",
  );
  await noticeQuarantined({
    id: row.pendingId, session_id: row.sessionId, user_id: row.userId, message_id: messageId,
    content: row.content,
  });
  return true;
}

/** The move itself: one statement, so the row is in exactly one of the two tables. */
async function moveToQuarantine(
  pendingId: number,
  messageId: string,
): Promise<{ attempts: number; last_error: string | null; queued_for_sec: number } | undefined> {
  return (await db.query(
    `WITH moved AS (
       DELETE FROM claw_pending_messages p
        WHERE p.id = $1
          AND NOT EXISTS (
            SELECT 1 FROM claw_tasks t
             WHERE t.task_id = p.dispatch_task_id
               AND t.status IN ('queued','preparing','running','cancelling'))
       RETURNING p.id, p.session_id, p.user_id, p.content, p.created_at,
                 p.drain_first_failed_at, p.drain_failures, p.drain_last_error
     )
     INSERT INTO ${PENDING_QUARANTINE_TABLE}
       (id, session_id, user_id, message_id, content, queued_at, first_failed_at, attempts, last_error)
     SELECT id, session_id, user_id, $2, content, created_at, drain_first_failed_at, drain_failures, drain_last_error
       FROM moved
     ON CONFLICT (id) DO NOTHING
     RETURNING id, attempts, last_error, EXTRACT(EPOCH FROM (NOW() - queued_at))::int AS queued_for_sec`,
    [pendingId, messageId],
  )).rows[0] as { attempts: number; last_error: string | null; queued_for_sec: number } | undefined;
}

interface QuarantinedRow {
  id: number;
  session_id: string;
  user_id: string | null;
  message_id: string;
  content: string;
}

/**
 * Tell the session its message was not sent: the turn the message would have
 * been, ended the way a refused queued turn ends (`publishRefusedTurn`), so the
 * user sees their message and the reply that says it can be sent again.
 *
 * Once. A completion already recorded for this message id is a notice already
 * given -- by an earlier attempt whose stamp below was lost -- and is stamped
 * rather than sent again. A notice that cannot be published now is left
 * unstamped for `retryQuarantineNotices`.
 */
async function noticeQuarantined(row: QuarantinedRow): Promise<boolean> {
  try {
    if (!await completionAlreadyPublished(row.session_id, row.message_id)) {
      const prompt = row.content.length > NOTICE_PROMPT_MAX_CHARS
        ? `${row.content.slice(0, NOTICE_PROMPT_MAX_CHARS)}\n[...]`
        : row.content;
      await pendingQuarantinePorts.publishRefusedTurn({
        sessionId: row.session_id,
        pendingId: row.id,
        userId: row.user_id ?? "default",
        messageId: row.message_id,
        prompt,
        task: {},
      }, PENDING_DRAIN_QUARANTINED);
    }
    await db.query(
      `UPDATE ${PENDING_QUARANTINE_TABLE} SET notified_at = NOW() WHERE id = $1 AND notified_at IS NULL`,
      [row.id],
    );
    return true;
  } catch (err) {
    logger.warn(
      { err: String(err), sessionId: row.session_id, pendingId: row.id },
      "pending.quarantine_notice_failed",
    );
    return false;
  }
}

/**
 * Give the notices that could not be published when their message was
 * quarantined another try, a bounded number of times.
 *
 * Every replica's sweeper runs this, so a notice is claimed before it is sent:
 * the claim is a time on the row that keeps the others off it for a minute,
 * and the completion check in `noticeQuarantined` covers the replica whose
 * stamp was lost after its publish went out.
 */
export async function retryQuarantineNotices(limit = 20): Promise<number> {
  const claimed = (await db.query(
    `UPDATE ${PENDING_QUARANTINE_TABLE} q
        SET notice_attempts = notice_attempts + 1, notice_claimed_at = NOW()
      WHERE q.id IN (
        SELECT id FROM ${PENDING_QUARANTINE_TABLE}
         WHERE notified_at IS NULL
           AND notice_attempts < $1
           AND COALESCE(notice_claimed_at, quarantined_at) <= NOW() - make_interval(secs => $2)
         ORDER BY quarantined_at
         LIMIT $3
         FOR UPDATE SKIP LOCKED)
      RETURNING q.id, q.session_id, q.user_id, q.message_id, q.content, q.notice_attempts`,
    [NOTICE_MAX_ATTEMPTS, NOTICE_CLAIM_SEC, limit],
  )).rows as Array<QuarantinedRow & { notice_attempts: number }>;
  let sent = 0;
  for (const row of claimed) {
    if (await noticeQuarantined(row)) sent += 1;
    else if (row.notice_attempts >= NOTICE_MAX_ATTEMPTS) {
      logger.error(
        { sessionId: row.session_id, pendingId: row.id, attempts: row.notice_attempts },
        "pending.quarantine_notice_abandoned",
      );
    }
  }
  return sent;
}

/** Drop quarantined messages past their retention. */
export async function pruneQuarantinedMessages(): Promise<number> {
  const r = await db.query(
    `DELETE FROM ${PENDING_QUARANTINE_TABLE}
      WHERE quarantined_at < NOW() - make_interval(days => $1)`,
    [PENDING_QUARANTINE_RETENTION_DAYS],
  );
  return r.rowCount ?? 0;
}

/** Publish the queue's state as gauges: the longest failing streak, and the oldest message's age. */
export async function observePendingQueue(): Promise<{ consecutiveFailures: number; oldestAgeSeconds: number }> {
  const r = (await db.query(
    `SELECT COALESCE(MAX(drain_failures), 0)::int AS failures,
            COALESCE(EXTRACT(EPOCH FROM (NOW() - MIN(created_at))), 0)::float8 AS oldest
       FROM claw_pending_messages`,
  )).rows[0] as { failures?: number; oldest?: number } | undefined;
  const state = {
    consecutiveFailures: Number(r?.failures ?? 0),
    oldestAgeSeconds: Number(r?.oldest ?? 0),
  };
  metrics.setPendingQueueState(state.consecutiveFailures, state.oldestAgeSeconds);
  return state;
}
