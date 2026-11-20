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
import { EVENT_STREAM_DUPLICATE_WINDOW_MS, natsUnreachable, publishCertainlyFailed } from "../infra/nats.js";
import { completionAlreadyPublished } from "../events/store.js";
import { queuedMessageId } from "./chat-run.js";
import { PENDING_DRAIN_QUARANTINED, publishRefusedTurn } from "./pending-dispatch.js";
import { RunCredentialFault } from "./run-secrets.js";

const logger = pino({ name: "pending-quarantine" });

/** Failed attempts a queued message is given before it can be quarantined. */
export const PENDING_DRAIN_MAX_FAILURES = envInt("PENDING_DRAIN_MAX_FAILURES", 5, { min: 2 });

/**
 * How long a message must have been failing before it can be quarantined, from
 * its first failed attempt. Ten minutes outlasts a NATS failover or a database
 * restart, which are what the retry is for.
 */
export const PENDING_DRAIN_FAILURE_WINDOW_SEC = envInt("PENDING_DRAIN_FAILURE_WINDOW_SEC", 600, { min: 0 });

/**
 * Attempts at telling the session, after the first, before the notice is given
 * up on. An attempt NATS refused because no stream answered is not one of
 * them: it stored nothing and says nothing about the notice, so a notice
 * outlasts a NATS outage of any length and is given once NATS is back.
 */
const NOTICE_MAX_ATTEMPTS = 10;

/** How long a claimed notice is left to the replica that claimed it. */
const NOTICE_CLAIM_SEC = 60;

/**
 * How long a notice may still be retried once an attempt at it may have stored
 * an event it did not record: half the event stream's duplicate window.
 *
 * Each event of a notice goes out under a stable id, and a retry is safe only
 * while the stream still remembers the copy an earlier attempt may have stored
 * without being acknowledged; past the window the same id is stored again and
 * the user is told twice. Every such copy is published at or after the start
 * of the attempt that sent it (`notice_unsure_since`), so a retry that starts
 * within this horizon of it reaches the stream well inside the window of that
 * copy, with the other half left for a slow publish. The ten attempts a minute
 * apart fit inside it; a notice still unsent past it is given up on rather than
 * risk the second copy.
 *
 * A notice no attempt could have stored anything of -- every failure certain,
 * a refused publish or a failure before the first publish -- has no copy for a
 * late retry to repeat, so the horizon does not apply to it: it is retried
 * until it is given, however long NATS is away.
 */
export const QUARANTINE_NOTICE_RETRY_HORIZON_SEC = Math.floor(EVENT_STREAM_DUPLICATE_WINDOW_MS / 2_000);

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
  if (natsUnreachable(err)) {
    // Not counted. While NATS is away every queued message fails this way and
    // every one is sent once it is back, so the failure says nothing about this
    // message; counted, a NATS outage longer than the window would quarantine
    // good messages that the queue used to hold and send. The error is still
    // recorded on the row, for whoever is looking at a stalled queue.
    await db.query(
      "UPDATE claw_pending_messages SET drain_last_error = $2 WHERE id = $1",
      [row.pendingId, error],
    ).catch(() => {});
    logger.warn(
      { sessionId: row.sessionId, pendingId: row.pendingId, error },
      "pending.drain_failed_nats_unreachable",
    );
    return "retry";
  }
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
  // Credentials that did not open on any attempt end as the refusal they are.
  const reason = err instanceof RunCredentialFault ? CREDENTIALS_UNREADABLE : PENDING_DRAIN_QUARANTINED;
  return (await quarantinePendingMessage(row, reason)) ? "quarantined" : "retry";
}

/** Why a queued message whose sealed credentials will not open is refused. */
export const CREDENTIALS_UNREADABLE = "credentials_unreadable";

/**
 * Quarantine a queued message that can never be sent, at once, and tell the
 * session: a sealed-credentials blob no replica can open
 * (`RunCredentialFault.permanent`) is permanent for the row that carries it, so
 * no count or window is waited for. One that may open elsewhere is not brought
 * here; it fails its drain and is counted like any other.
 *
 * The same move and the same notice as a message that ran out of attempts, so
 * the same guarantees hold: the row leaves the queue in one statement, the
 * quarantine counter sees it, and the notice is given once and retried by the
 * sweeper if it cannot be published now.
 *
 * @throws when the row could not be moved -- the statement failed, or a run the
 *         row reserved is still open -- so the caller's drain fails the way any
 *         failed drain does, is counted on the row and is retried.
 */
export async function quarantineUnsendablePending(
  row: FailedPendingRow,
  err: unknown,
  failureReason: string,
): Promise<void> {
  const error = drainErrorSummary(err, row.content);
  const messageId = queuedMessageId(row.pendingId);
  const moved = await moveToQuarantine(row.pendingId, messageId, { error, failureReason });
  if (!moved) {
    throw Object.assign(
      new Error(`queued message ${row.pendingId} is unsendable (${failureReason}) and its reserved run is still open`),
      { code: "QUARANTINE_DEFERRED" },
    );
  }
  // Counted here only once the row has moved: a throw above is counted by the
  // caller's drain, as every failed drain is, and must not be counted twice.
  metrics.onPendingDrainFailure();
  await afterQuarantine(row, messageId, moved, failureReason);
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
async function quarantinePendingMessage(row: FailedPendingRow, failureReason: string): Promise<boolean> {
  const messageId = queuedMessageId(row.pendingId);
  let moved: MovedRow | undefined;
  try {
    moved = await moveToQuarantine(row.pendingId, messageId, undefined, failureReason);
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
  await afterQuarantine(row, messageId, moved, failureReason);
  return true;
}

/** What follows a move that took the row: the counter, the page, and the notice. */
async function afterQuarantine(
  row: FailedPendingRow,
  messageId: string,
  moved: MovedRow,
  failureReason: string,
): Promise<void> {
  metrics.onPendingQuarantined();
  // The durable record is the row; this line is for whoever is paged. It names
  // the message and why it failed, and never what it said.
  logger.error(
    {
      sessionId: row.sessionId, pendingId: row.pendingId, messageId,
      attempts: moved.attempts, queuedForSec: moved.queued_for_sec, error: moved.last_error,
      failureReason,
    },
    "pending.drain_quarantined",
  );
  const quarantined: QuarantinedRow = {
    id: row.pendingId, session_id: row.sessionId, user_id: row.userId, message_id: messageId,
    content: row.content, notice_events: 0, failure_reason: failureReason,
  };
  await settleNoticeAttempt(quarantined, moved.notice_started_at, await noticeQuarantined(quarantined));
}

type MovedRow = {
  attempts: number;
  last_error: string | null;
  queued_for_sec: number;
  /** The first notice attempt, begun by the move itself: its token for `settleNoticeAttempt`. */
  notice_started_at: string;
};

/**
 * The move itself: one statement, so the row is in exactly one of the two tables.
 *
 * `immediate` is the failure that quarantines without waiting for its bounds:
 * it is counted as one more attempt and recorded as the last error, since the
 * row's own counters have not seen it.
 */
async function moveToQuarantine(
  pendingId: number,
  messageId: string,
  immediate?: { error: string; failureReason: string },
  failureReason = immediate?.failureReason ?? PENDING_DRAIN_QUARANTINED,
): Promise<MovedRow | undefined> {
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
       (id, session_id, user_id, message_id, content, queued_at, first_failed_at, attempts, last_error,
        failure_reason, notice_started_at)
     SELECT id, session_id, user_id, $2, content, created_at, COALESCE(drain_first_failed_at, NOW()),
            drain_failures + $3, COALESCE($4, drain_last_error), $5, NOW()
       FROM moved
     ON CONFLICT (id) DO NOTHING
     RETURNING id, attempts, last_error, EXTRACT(EPOCH FROM (NOW() - queued_at))::int AS queued_for_sec,
               notice_started_at::text AS notice_started_at`,
    [pendingId, messageId, immediate ? 1 : 0, immediate?.error ?? null, failureReason],
  )).rows[0] as MovedRow | undefined;
}

interface QuarantinedRow {
  id: number;
  session_id: string;
  user_id: string | null;
  message_id: string;
  content: string;
  /** Events of the notice already published; a retry resumes after them. */
  notice_events: number;
  /** The refusal the notice is; null on a row written before the column existed. */
  failure_reason: string | null;
}

/**
 * How a notice attempt ended.
 *
 * `sent`: the session has been told. `refused`: NATS answered that no stream
 * is there to take it, so nothing of this attempt was stored. `certain`: it
 * failed, and nothing it may have stored is missing from `notice_events`.
 * `unsure`: an event of it may be on the stream without being recorded, so a
 * retry is safe only inside the stream's duplicate window.
 */
type NoticeOutcome = "sent" | "refused" | "certain" | "unsure";

/**
 * Tell the session its message was not sent: the turn the message would have
 * been, ended the way a refused queued turn ends (`publishRefusedTurn`), so the
 * user sees their message and the reply that says it can be sent again.
 *
 * Once. The notice is three events published in turn, and an attempt can fail
 * after the first or second is out; so each event is recorded on the row as it
 * goes (`notice_events`) and a retry publishes only the ones still missing,
 * each under a stable id the event stream deduplicates on, for the publish
 * that went out but was not recorded. The stream remembers an id only for its
 * duplicate window, so once an attempt may have left such a copy, retries stop
 * at `QUARANTINE_NOTICE_RETRY_HORIZON_SEC` after it, well inside the window. A
 * completion already recorded for this message id is a notice already given --
 * by an earlier attempt whose stamp below was lost -- and is stamped rather
 * than sent again. A notice that cannot be published now is left unstamped for
 * `retryQuarantineNotices`.
 */
async function noticeQuarantined(row: QuarantinedRow): Promise<NoticeOutcome> {
  // Where the attempt is when it fails. Before the first publish and after the
  // last record nothing unrecorded can be on the stream; a publish the server
  // certainly refused stored nothing; anything else may have.
  let stage: "before" | "publishing" | "recording" | "stamping" = "before";
  try {
    if (!await completionAlreadyPublished(row.session_id, row.message_id)) {
      const prompt = row.content.length > NOTICE_PROMPT_MAX_CHARS
        ? `${row.content.slice(0, NOTICE_PROMPT_MAX_CHARS)}\n[...]`
        : row.content;
      stage = "publishing";
      await pendingQuarantinePorts.publishRefusedTurn({
        sessionId: row.session_id,
        pendingId: row.id,
        userId: row.user_id ?? "default",
        messageId: row.message_id,
        prompt,
        task: {},
      }, row.failure_reason ?? PENDING_DRAIN_QUARANTINED, undefined, {
        published: Number(row.notice_events ?? 0),
        dedupeKey: `${PENDING_QUARANTINE_TABLE}:${row.id}`,
        async record(count: number): Promise<void> {
          stage = "recording";
          await db.query(
            `UPDATE ${PENDING_QUARANTINE_TABLE} SET notice_events = GREATEST(notice_events, $2) WHERE id = $1`,
            [row.id, count],
          );
          stage = "publishing";
        },
      });
    }
    stage = "stamping";
    await db.query(
      `UPDATE ${PENDING_QUARANTINE_TABLE} SET notified_at = NOW() WHERE id = $1 AND notified_at IS NULL`,
      [row.id],
    );
    return "sent";
  } catch (err) {
    const outcome: NoticeOutcome = stage === "before" || stage === "stamping"
      ? "certain"
      : stage === "publishing" && publishCertainlyFailed(err)
        ? (natsUnreachable(err) ? "refused" : "certain")
        : "unsure";
    logger.warn(
      { err: String(err), sessionId: row.session_id, pendingId: row.id, outcome },
      "pending.quarantine_notice_failed",
    );
    return outcome;
  }
}

/**
 * Record how a notice attempt ended, on the attempt it was: a replica that took
 * the notice over while this attempt was slow has begun its own, and this one's
 * outcome is no longer the row's to record.
 *
 * An attempt whose outcome is never recorded here -- its replica died, or this
 * statement failed -- is read by the next claim as one that may have stored an
 * event (`notice_started_at` is still set), which is the safe reading.
 */
async function settleNoticeAttempt(row: QuarantinedRow, startedAt: string, outcome: NoticeOutcome): Promise<void> {
  try {
    await db.query(
      `UPDATE ${PENDING_QUARANTINE_TABLE}
          SET notice_started_at = NULL,
              notice_attempts = CASE WHEN $3 = 'refused' THEN GREATEST(notice_attempts - 1, 0)
                                     ELSE notice_attempts END,
              notice_unsure_since = CASE WHEN $3 = 'unsure'
                                         THEN COALESCE(notice_unsure_since, notice_started_at)
                                         ELSE notice_unsure_since END
        WHERE id = $1 AND notice_started_at = $2::timestamptz`,
      [row.id, startedAt, outcome],
    );
  } catch (err) {
    logger.warn(
      { err: String(err), sessionId: row.session_id, pendingId: row.id, outcome },
      "pending.quarantine_notice_unsettled",
    );
  }
}

/**
 * Give the notices that could not be published when their message was
 * quarantined another try.
 *
 * A bounded number of times, not counting attempts NATS refused outright; and,
 * once an attempt may have stored an event it did not record, only within
 * `QUARANTINE_NOTICE_RETRY_HORIZON_SEC` of that attempt, the span the event
 * stream's duplicate window covers. A notice past either bound is marked given
 * up on and logged, never published. A notice no attempt could have stored
 * anything of is retried for as long as it takes.
 *
 * Every replica's sweeper runs this, so a notice is claimed before it is sent:
 * the claim is a time on the row that keeps the others off it for a minute,
 * and the completion check in `noticeQuarantined` covers the replica whose
 * stamp was lost after its publish went out. A claim that finds an earlier
 * attempt still marked as started -- its replica died, or its outcome was never
 * recorded -- takes that attempt as one that may have stored an event.
 */
export async function retryQuarantineNotices(limit = 20): Promise<number> {
  // Past the horizon a retry could store a second copy of an event the stream
  // has forgotten, so the notice is given up on instead, and said so.
  const expired = (await db.query(
    `UPDATE ${PENDING_QUARANTINE_TABLE}
        SET notice_attempts = GREATEST(notice_attempts, $1)
      WHERE notified_at IS NULL
        AND notice_attempts < $1
        AND COALESCE(notice_claimed_at, quarantined_at) <= NOW() - make_interval(secs => $3)
        AND COALESCE(notice_unsure_since, notice_started_at) <= NOW() - make_interval(secs => $2)
      RETURNING id, session_id, notice_attempts, notice_events`,
    [NOTICE_MAX_ATTEMPTS, QUARANTINE_NOTICE_RETRY_HORIZON_SEC, NOTICE_CLAIM_SEC],
  )).rows as Array<{ id: number; session_id: string; notice_attempts: number; notice_events: number }>;
  for (const row of expired) {
    logger.error(
      {
        sessionId: row.session_id, pendingId: row.id, noticeEvents: row.notice_events,
        horizonSec: QUARANTINE_NOTICE_RETRY_HORIZON_SEC,
      },
      "pending.quarantine_notice_abandoned",
    );
  }
  const claimed = (await db.query(
    `UPDATE ${PENDING_QUARANTINE_TABLE} q
        SET notice_attempts = notice_attempts + 1, notice_claimed_at = NOW(),
            notice_unsure_since = COALESCE(notice_unsure_since, notice_started_at),
            notice_started_at = NOW()
      WHERE q.id IN (
        SELECT id FROM ${PENDING_QUARANTINE_TABLE}
         WHERE notified_at IS NULL
           AND notice_attempts < $1
           AND COALESCE(notice_claimed_at, quarantined_at) <= NOW() - make_interval(secs => $2)
           AND COALESCE(notice_unsure_since, notice_started_at, NOW()) > NOW() - make_interval(secs => $4)
         ORDER BY quarantined_at
         LIMIT $3
         FOR UPDATE SKIP LOCKED)
      RETURNING q.id, q.session_id, q.user_id, q.message_id, q.content, q.notice_attempts,
                q.notice_events, q.failure_reason, q.notice_started_at::text AS notice_started_at`,
    [NOTICE_MAX_ATTEMPTS, NOTICE_CLAIM_SEC, limit, QUARANTINE_NOTICE_RETRY_HORIZON_SEC],
  )).rows as Array<QuarantinedRow & { notice_attempts: number; notice_started_at: string }>;
  let sent = 0;
  for (const row of claimed) {
    const outcome = await noticeQuarantined(row);
    await settleNoticeAttempt(row, row.notice_started_at, outcome);
    if (outcome === "sent") sent += 1;
    else if (outcome !== "refused" && row.notice_attempts >= NOTICE_MAX_ATTEMPTS) {
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
