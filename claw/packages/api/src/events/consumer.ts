// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { js, sc, nc, jsm as _jsm, kvTombstones, EVENT_STREAM } from "../infra/nats.js";
import {
  cacheLiveAnswer, isKnownDeleted, liveAnswerIsFresh, rememberDeletedFromCleanupSubject,
  rememberSessionDeleted,
} from "../sessions/deleted-cache.js";
import { db, MarketplaceDb } from "../infra/db.js";
import {
  canViewPlugin,
  formatPluginRow,
  pluginSandboxImage,
} from "../marketplace/plugins.js";

import { buildMessages } from "../sessions/context-builder.js";
import { maybeExtractMemory, insertMemoryEntry, scanMemoryContent, maybeUpdateUserProfile } from "../memory/service.js";
import {
  saveSkill, recordSkillFeedback,
  selectSkillsForTask,
  addSkillFile, updateSkillFile, removeSkillFile,
  maybeRecordTaskPattern,
  checkProbationGraduation,
} from "../marketplace/skill-service.js";
import { enqueueEvolutionJob } from "../marketplace/evolve-worker.js";
import { callMemoryLLM } from "../llm/client.js";
import { CLAW_MEMORY_ENABLED, CLAW_SKILL_EVOLUTION_ENABLED } from "../config.js";
import { markChatRunRunning, closeChatRun, queuedMessageId } from "../tasks/chat-run.js";
import { dispatchPendingMessage, publishRefusedTurn } from "../tasks/pending-dispatch.js";
import { applySealedCredentials } from "../tasks/run-secrets.js";
import { randomUUID } from "node:crypto";
import pino from "pino";
import { estimateTokens } from "../shared/tokens.js";

const logger = pino({ name: "event-consumer" });

function asJsonObject(v: unknown): Record<string, unknown> | undefined {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  return undefined;
}

export { rememberSessionDeleted, rememberDeletedFromCleanupSubject };

/**
 * How long a delivery waits before asking the tombstone bucket again.
 *
 * A bare `nak()` is redelivery as soon as the server can manage it, which is the
 * wrong answer to a dependency that is down: the same message comes back, reads
 * the same unreachable bucket, and naks again as fast as the consume loop turns,
 * so the outage gets spent at the top of a spin loop adding load to the very
 * cluster that cannot answer. Nothing is gained by asking sooner, because the
 * bucket recovers on its own schedule rather than on the rate it is asked at --
 * and every other retry in this consumer already waits first.
 */
export const TOMBSTONE_UNKNOWN_NAK_MS = 5_000;

/**
 * Seam over the tombstone bucket.
 *
 * `kvTombstones` is a live binding on a module namespace, which is frozen, so
 * a test cannot substitute it. A plain object can be, and the indirection
 * costs one call on a path that is already about to do a network read.
 */
export const tombstoneReader = {
  async has(sessionId: string): Promise<boolean> {
    return !!(await kvTombstones.get(`deleted.${sessionId}`));
  },
};

/**
 * Whether this session has been deleted out from under the event.
 *
 * Deleting a session purges its event stream and then takes the row out of
 * reach, but that only covers what was in the stream at that moment. Anything
 * a Brain published concurrently -- and anything the consumer had already
 * pulled, or is redelivering after a nak -- arrives afterwards and is written
 * as though the session still existed, which puts conversation content back
 * under a session the user deleted.
 *
 * The tombstone is the same mark Brain's dispatcher consults, and its TTL is
 * sized to outlast both windows a message can reach a consumer from: the task
 * stream's redelivery budget, and -- the one that decides here -- the retention
 * of the event stream these very messages are pulled from, which is the longer
 * of the two on every configuration the delivery budget's clamp permits. So an
 * event the stream can still deliver still finds an answer, however far behind
 * this consumer has fallen. See `tombstoneTtlMs` in infra/nats.ts.
 *
 * A bucket that cannot be read answers `"unknown"` rather than either verdict.
 * Both verdicts would be wrong in a way that costs something: "deleted" discards
 * the events of live sessions for the duration of a NATS blip, and "not deleted"
 * writes conversation content back under a deleted session, which is the thing
 * this function exists to prevent. Since this is a JetStream delivery there is a
 * third answer available -- ask again later -- and the caller naks.
 */
export async function sessionWasDeleted(
  sessionId: string,
): Promise<boolean | "unknown"> {
  if (!sessionId) return false;
  if (isKnownDeleted(sessionId)) return true;
  if (liveAnswerIsFresh(sessionId)) return false;
  try {
    if (await tombstoneReader.has(sessionId)) {
      rememberSessionDeleted(sessionId);
      return true;
    }
  } catch (err) {
    logger.warn({ sessionId, err: (err as Error)?.message }, "event-consumer.tombstone_read_failed");
    return "unknown";
  }
  cacheLiveAnswer(sessionId);
  return false;
}

/** Generate event_id from JetStream stream sequence. */
function makeEventId(seq: unknown): string {
  if (typeof seq === "number" && Number.isFinite(seq)) return `claw-${seq}`;
  const s = String(seq ?? "");
  const m = s.match(/(\d+)$/);
  if (m) return `claw-${m[1]}`;
  return `claw-${randomUUID()}`;
}

/**
 * Whether this turn's completion has already been handled, under any delivery.
 *
 * The `processed_at` gate keys on the event id, which is derived from the
 * JetStream sequence, so it recognises redeliveries of one published message and
 * nothing else. Brain publishes the same completion more than once: a run picked
 * back up after being interrupted emits exec_complete again, under a new
 * sequence and therefore a new event id, which conflicts with nothing and is
 * handled from scratch. What that repeated is not only the conversation turn --
 * the queued message waiting behind this one was dispatched a second time as
 * well, as a second run.
 *
 * The message id is what stays the same across all of it, because it names the
 * user's message rather than the delivery. An event without one falls back to
 * the per-delivery gate: the answer here would be "some other completion of this
 * session was processed", which is true of nearly every event and would drop
 * real work.
 *
 * Only a row marked processed counts. An attempt that died half way through
 * leaves `processed_at` NULL deliberately, and the retry has to finish it.
 */
export async function completionAlreadyProcessed(
  sessionId: string,
  messageId: string,
): Promise<boolean> {
  if (!messageId) return false;
  const r = await db.query(
    `SELECT 1 FROM claw_session_events
      WHERE session_id = $1
        AND event = 'exec_complete'
        AND data->>'message_id' = $2
        AND processed_at IS NOT NULL
        AND deleted_at IS NULL
      LIMIT 1`,
    [sessionId, messageId],
  );
  return !!r.rowCount;
}

/**
 * Background durable consumer: listens to all events, persists to DB,
 * and triggers post-completion logic (save turns, summarize, pending messages).
 */
export async function startEventConsumer(): Promise<void> {
  const subject = "events.>";
  const consumerName = "api-consumer";
  const jsm = await nc.jetstreamManager();
  try {
    await jsm.consumers.add(EVENT_STREAM, {
      durable_name: consumerName,
      filter_subject: subject,
      deliver_policy: "new" as any,
      ack_policy: "explicit" as any,
    });
  } catch { /* consumer may already exist */ }

  // One-time migrations
  try {
    // 1. Normalize legacy event_ids (PRIMUS_CLAW_EVENTS-xxx, claw-evt-xxx, bare numbers)
    const migrated = await db.query(
      `UPDATE claw_session_events
       SET event_id = 'claw-' || regexp_replace(event_id, '^.*?(\\d+)$', '\\1')
       WHERE event_id !~ '^claw-\\d'
         AND event_id ~ '\\d+$'
         AND deleted_at IS NULL`,
    );
    if (migrated.rowCount) {
      logger.info({ count: migrated.rowCount }, "event-consumer.migrated_legacy_event_ids");
    }

    // 2. Replace UNIQUE(event_id) with UNIQUE(event_id, session_id) to prevent
    //    cross-session collisions when multiple sessions share stream seq space.
    //    Always ensure the composite index exists first, then drop old if present.
    await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS claw_session_events_event_session_idx ON claw_session_events (event_id, session_id)`);
    try {
      await db.query(`ALTER TABLE claw_session_events DROP CONSTRAINT IF EXISTS claw_session_events_event_id_key`);
      logger.info("event-consumer.dropped_old_unique_constraint");
    } catch { /* constraint may not exist */ }
  } catch (e) {
    logger.warn({ err: (e as Error).message }, "event-consumer.migration_failed");
  }

  const consumer = await js.consumers.get(EVENT_STREAM, consumerName);
  const iter = await consumer.consume();

  listenForCleanupNotices();
  logger.info({ subject, consumerName }, "event-consumer.started");

  for await (const msg of iter) {
    await consumeEventDelivery(msg);
  }
}

/**
 * Hear `cleanup.<sid>` the same way Brain does, and close the live-answer
 * window on this replica.
 *
 * The replica that committed the deletion remembers the id when it writes the
 * tombstone. Every other replica would otherwise keep admitting events for up
 * to ten seconds after a real read that said the session was alive -- and the
 * trailing `exec_complete` from the interrupt that this message causes lands
 * in that window. Core NATS, at-most-once: a missed notice only costs the
 * remaining TTL, which is how the cache behaved before this existed.
 */
function listenForCleanupNotices(): void {
  const sub = nc.subscribe("cleanup.>");
  (async () => {
    for await (const msg of sub) {
      rememberDeletedFromCleanupSubject(msg.subject);
    }
  })().catch((e) => {
    logger.error(
      { err: (e as Error)?.message ?? e },
      "event-consumer.cleanup_listener_died",
    );
  });
}

/**
 * One delivery: refuse a deleted session before any write, otherwise persist.
 *
 * Pulled out of the consume loop so the two properties the loop exists for --
 * the tombstone check sits in front of the INSERT, and a refusal acks rather
 * than naks -- can be pinned without a live JetStream iterator.
 */
export async function consumeEventDelivery(msg: {
  subject: string;
  data: Uint8Array;
  seq?: number;
  info?: { streamSequence?: number };
  ack: () => void;
  nak: (millis?: number) => void;
}): Promise<void> {
    // subject layout: "events.{sessionId}"
    const sessionId = msg.subject.split(".")[1];
    let event: Record<string, unknown>;
    try {
      const raw = sc.decode(msg.data).replace(/\u0000/g, "");
      event = JSON.parse(raw);
    } catch {
      msg.ack();
      return;
    }
    logger.info({ sessionId, type: event.type, seq: (msg as any).seq }, "event-consumer.msg_received");

    // Dropped rather than persisted: everything below writes conversation
    // content, and the session it belongs to is gone. Acked because there is
    // nothing to retry -- no later attempt will find the session again.
    //
    // An unreadable tombstone bucket is neither answer. Persisting on it would
    // put content back under a deleted session, and dropping on it would discard
    // a live session's events for the length of a NATS blip; a nak keeps both
    // properties by asking again once the bucket answers.
    const deleted = await sessionWasDeleted(sessionId);
    if (deleted === "unknown") {
      logger.warn({ sessionId, type: event.type }, "event-consumer.tombstone_unknown_nak");
      msg.nak(TOMBSTONE_UNKNOWN_NAK_MS);
      return;
    }
    if (deleted) {
      logger.info({ sessionId, type: event.type }, "event-consumer.dropped_deleted_session");
      msg.ack();
      return;
    }

    // Sub-agent events are now persisted so page reload can reconstruct
    // the full conversation including sub-agent cards. The frontend uses
    // subagent_id to group them into collapsible cards. Only skip
    // handleComplete processing (sub-agent events never trigger it).

    // v3.5 #1: persist event audit row independent of processing state.
    // The `processed_at` column is the actual idempotency gate for handleComplete.
    // Old design used the INSERT row count, which silently dropped handleComplete
    // on NATS retry whenever the row already existed (regardless of whether
    // handleComplete had succeeded). Now:
    //   - INSERT (or no-op on conflict) → row always exists for audit
    //   - SELECT processed_at → tells us whether handleComplete finished previously
    //   - run handleComplete only if processed_at IS NULL
    //   - on success → UPDATE processed_at = NOW() (durable "done" marker)
    //   - on failure → leave processed_at = NULL, nak retry will re-run
    // Fallback uses randomUUID() (not Date.now()) — high-throughput batches
    // produced multiple events per millisecond, and the timestamp fallback would
    // collide and silently drop legitimate events under ON CONFLICT DO NOTHING.
    const seq = (msg as any).seq ?? (msg as any).info?.streamSequence;
    const eventId = makeEventId(seq);
    let needsProcessing = true;
    let rowId: number | null = null;
    try {
      const insertResult = await db.query(
        "INSERT INTO claw_session_events (event_id, session_id, event, data) VALUES ($1, $2, $3, $4) ON CONFLICT (event_id, session_id) DO NOTHING RETURNING id",
        [eventId, sessionId, (event.type as string) || "message", event],
      );
      if (insertResult.rowCount && insertResult.rows[0]) {
        rowId = insertResult.rows[0].id;
        needsProcessing = true; // newly inserted, never processed
      } else {
        // Row exists from a prior attempt; check whether handleComplete finished.
        const existing = await db.query(
          "SELECT id, processed_at FROM claw_session_events WHERE event_id = $1 AND session_id = $2",
          [eventId, sessionId],
        );
        if (existing.rowCount && existing.rows[0]) {
          rowId = existing.rows[0].id;
          needsProcessing = existing.rows[0].processed_at === null;
        }
      }
    } catch (e: any) {
      const pgCode = e?.code || "";
      if (pgCode === "22P05" || pgCode === "22021") {
        logger.error({ err: e, sessionId, eventId }, "event-consumer.persist_poison_skipped");
        msg.ack();
      } else {
        logger.error({ err: e, sessionId }, "event-consumer.persist_failed");
        msg.nak(5000);
      }
      return;
    }

    // Handle completion — re-run on retry if the previous attempt didn't mark it done
    if (event.type === "exec_complete") {
      const messageId = typeof event.message_id === "string" ? event.message_id : "";
      try {
        // Two questions, because there are two ways the same completion arrives
        // twice: this delivery was processed before (its own row says so), or
        // the turn was published again and processed under a different row.
        const alreadyDone = !needsProcessing
          || await completionAlreadyProcessed(sessionId, messageId);
        if (alreadyDone) {
          logger.info({ sessionId, eventId, messageId }, "exec_complete.skipped_already_processed");
        } else {
          await handleComplete(sessionId, event, rowId);
        }
        // Marked either way: nothing is left for a retry of this row to do, and
        // a row left NULL says the opposite to anything reading for pending work.
        if (rowId !== null && needsProcessing) {
          await db.query(
            "UPDATE claw_session_events SET processed_at = NOW() WHERE id = $1",
            [rowId],
          );
        }
      } catch (e) {
        logger.error({ err: e, sessionId }, "event-consumer.complete_failed");
        msg.nak(10_000); // Retry complete handling later — processed_at stays NULL
        return;
      }
    } else if (event.type === "taskInterrupted" || event.type === "taskResumed") {
      // INV-8 (checkpoint-architecture-redesign §5.3): brain emits these
      // events whenever a task is SIGTERM'd or a redelivery picks one back
      // up. We mirror the lifecycle into claw_sessions.agent_status, using
      // claw_sessions.status_event_at as a monotonic wall-clock filter so
      // out-of-order delivery (e.g. taskResumed arriving before its
      // partner taskInterrupted) cannot resurrect a stale state.
      try {
        await handleStatusEvent(sessionId, event);
      } catch (e) {
        logger.error(
          { err: e, sessionId, type: event.type },
          "event-consumer.status_event_failed",
        );
        msg.nak(5_000);
        return;
      }
    } else if (event.type === "statusUpdate" && event.agentStatus === "running") {
      // Brain has a sandbox and is starting the engine, which is the first
      // moment the shadow row for this turn is running rather than being set
      // up. Best-effort: a row left describing itself as preparing is a
      // reporting inaccuracy, and this event is not worth redelivering over.
      await markChatRunRunning(sessionId);
    }

    msg.ack();
}

/**
 * Apply a brain-emitted lifecycle event to claw_sessions.agent_status,
 * gated by the monotonic status_event_at column added in migration 0042.
 *
 * The WHERE clause's `$2::bigint > COALESCE(status_event_at, 0)` check
 * makes the UPDATE a no-op when a later event (by wallclock_ms) has
 * already advanced the row — relevant when SIGTERM and a fast resume
 * race through NATS in the wrong order. Both branches set both fields
 * in one statement so partial writes are impossible.
 */
async function handleStatusEvent(
  sessionId: string,
  event: Record<string, unknown>,
): Promise<void> {
  const wall = Number(event.wallclock_ms);
  if (!Number.isFinite(wall) || wall <= 0) {
    logger.warn({ sessionId, type: event.type }, "status_event.bad_wallclock_skip");
    return;
  }
  const nextStatus = event.type === "taskInterrupted" ? "interrupted" : "running";
  const result = await db.query(
    `UPDATE claw_sessions
        SET agent_status = $3,
            status_event_at = $2,
            updated_at = NOW()
      WHERE session_id = $1
        AND deleted_at IS NULL
        AND ($2::bigint > COALESCE(status_event_at, 0))`,
    [sessionId, wall, nextStatus],
  );
  if (result.rowCount === 0) {
    logger.info(
      { sessionId, type: event.type, wallclock_ms: wall },
      "status_event.stale_or_missing_session_skip",
    );
  } else {
    logger.info(
      { sessionId, type: event.type, agent_status: nextStatus, wallclock_ms: wall },
      "status_event.applied",
    );
  }
}

/**
 * Write the conversation turns a finished run produced.
 *
 * Persisted whenever the run produced *anything* worth replaying — including
 * hard failures, because losing history on failure means the next user
 * message hits the LLM with an empty context and either re-does completed
 * work or hallucinates tool calls against "empty input". Fallback content
 * strings below cover the three cases where final_text is absent:
 *   - user interrupt   → "[Interrupted by user]"
 *   - agent_error      → "[Task failed: <reason>]"
 *   - everything else  → "" (legacy behavior, preserved for clean exits)
 * Reproduced by session 6a6d48d1: 88 turns completed, mid-stream RST on turn 83
 * → failed=true → 0 rows in claw_conversation_turns, all of the agent's work
 * invisible to the next turn.
 *
 * Written at most once per turn, whatever happens upstream. The caller skips a
 * completion it can see was handled before; this is the half of that which does
 * not depend on seeing it, and it is the half that matters, because these rows
 * are the conversation -- duplicated, the user reads their own message twice and
 * so does every prompt built from the history afterwards.
 */
export async function recordCompletionTurns(
  sessionId: string,
  event: Record<string, unknown>,
  messageId: string | null,
): Promise<void> {
  const { final_text, failed, prompt, interrupted, failure_reason } = event as any;
  if (!final_text && !interrupted && !failed) return;

  const lastIdx = (await db.query(
    "SELECT COALESCE(MAX(turn_index), 0) as max FROM claw_conversation_turns WHERE session_id = $1 AND deleted_at IS NULL",
    [sessionId],
  )).rows[0].max;

  // ON CONFLICT DO NOTHING is the backstop rather than the mechanism: the
  // caller's check already skips a completion handled earlier, and this catches
  // what that check cannot -- two deliveries of one turn handled at the same
  // moment, neither able to see a processed_at the other has not written yet.
  // Untargeted on purpose: the index it has to catch is partial, and naming it
  // would mean repeating its predicate here for the two to stay in step.
  if (prompt) {
    await db.query(
      "INSERT INTO claw_conversation_turns (session_id, turn_index, role, content, token_count, message_id) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
      [sessionId, lastIdx + 1, "user", prompt, estimateTokens(prompt), messageId],
    );
  }

  // Extract tool calls from current run's events only
  const lastCompleteId = (await db.query(
    "SELECT id FROM claw_session_events WHERE session_id = $1 AND deleted_at IS NULL AND event = 'exec_complete' ORDER BY id DESC LIMIT 1 OFFSET 1",
    [sessionId],
  )).rows[0]?.id || 0;

  const events = (await db.query(
    "SELECT data FROM claw_session_events WHERE session_id = $1 AND deleted_at IS NULL AND id > $2 ORDER BY id",
    [sessionId, lastCompleteId],
  )).rows.map((r: any) => r.data);
  const toolCalls = events.filter((e: any) => e.type === "toolUsed" && e.status === "start");
  // Strip full_output from tool results before storing in conversation_turns —
  // full_output (up to 50KB) is kept in claw_session_events for audit/tracing,
  // but must NOT enter the LLM context window (built from conversation_turns).
  const toolResults = events
    .filter((e: any) => e.type === "toolUsed" && e.status === "success")
    .map((e: any) => { const { full_output, ...rest } = e; return rest; });

  // final_text fallback when interrupted/failed with no body — keep history
  // intact so the next user turn has something to anchor against.
  const assistantContent = final_text
    || (interrupted ? "[Interrupted by user]" : "")
    || (failed ? `[Task failed: ${failure_reason || "unknown"}]` : "");
  await db.query(
    "INSERT INTO claw_conversation_turns (session_id, turn_index, role, content, tool_calls, tool_results, token_count, message_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING",
    [sessionId, lastIdx + 2, "assistant", assistantContent, JSON.stringify(toolCalls), JSON.stringify(toolResults), estimateTokens(assistantContent), messageId],
  );
}

/**
 * Hand the conversation back, if this was the last run occupying it.
 *
 * `agent_status` is the gate: while it reads `running` every further message
 * parks in `claw_pending_messages`, and clearing it admits the next turn. It
 * used to be cleared unconditionally by any `exec_complete`, which is only
 * correct while a session can carry one run at a time.
 *
 * It cannot. `interruptUnstartedChatRuns` cancels a queued doorbell row and
 * publishes a terminal event for it; this then opened the gate over whatever
 * else the session still had executing. The case that hurts is a fat run,
 * whose stop is a core-NATS interrupt that a worker not yet subscribed never
 * hears: the run carries on, the gate is open, and the next message dispatches
 * on top of it. Scoping the Stop statement itself was half the fix -- it stops
 * closing that row -- and this is the other half.
 *
 * `queued` counts as occupying, for the same reason it does in
 * `reapStuckSessions`: the turn is waiting, not finished. Neither state can
 * wedge the gate. `reapExpiredQueuedRuns` bounds the first at
 * `RUN_QUEUE_MAX_SEC` and releases the session on its way out, and
 * `reapStuckSessions` is the backstop for everything else.
 *
 * The message-id exclusion is belt and braces. Callers close this turn's row
 * first, so it is already terminal and cannot match; the exclusion matters
 * only when that close found nothing, which is the one case where trusting row
 * state alone would gate the session for ever.
 */
export async function releaseSessionGateIfLastRun(
  sessionId: string,
  messageId: string | null,
  failed: boolean,
): Promise<boolean> {
  const r = await db.query(
    `UPDATE claw_sessions
        SET agent_status = $1, updated_at = NOW()
      WHERE session_id = $2
        AND deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM claw_tasks t
           WHERE t.session_id = $2
             AND t.origin = 'chat'
             AND t.status IN ('queued','preparing','running','cancelling')
             AND t.metadata->>'message_id' IS DISTINCT FROM $3
        )`,
    [failed ? "failed" : "idle", sessionId, messageId],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Put the pending row's sealed credentials on the task, or end that turn.
 *
 * A blob that will not open is permanent for the row that carries it, and the
 * throw used to escape `handleComplete`: the event was naked with
 * `processed_at` still null and redelivered every ten seconds, failing
 * identically, so one unreadable row wedged the drain for every session behind
 * it. Ended the way an admission refusal is instead -- the reader is told, the
 * queue entry goes -- because no retry can make the ciphertext readable.
 *
 * @returns whether the task is safe to dispatch.
 */
export async function applyPendingCredentials(
  task: Record<string, unknown>,
  pending: { id: number | string; content?: string; credentials_blob?: unknown },
  who: { sessionId: string; userId: string; messageId: string },
): Promise<boolean> {
  try {
    applySealedCredentials(task, pending.credentials_blob);
    return true;
  } catch (err) {
    logger.error({ err, sessionId: who.sessionId, pendingId: pending.id }, "pending.credentials_unreadable");
    try {
      await publishRefusedTurn({
        sessionId: who.sessionId,
        pendingId: pending.id,
        userId: who.userId,
        messageId: who.messageId,
        prompt: pending.content ?? "",
      } as never, "credentials_unreadable");
      await db.query("DELETE FROM claw_pending_messages WHERE id = $1", [pending.id]);
    } catch (cleanupErr) {
      logger.error({ err: cleanupErr, sessionId: who.sessionId, pendingId: pending.id }, "pending.abandon_failed");
    }
    return false;
  }
}

async function handleComplete(sessionId: string, event: Record<string, unknown>, eventRowId?: number | null): Promise<void> {
  const { failed, user_id, interrupted, failure_reason } = event as any;
  const userId: string = user_id || "default";
  // Null rather than "" when absent: the unique index over the turns is partial
  // on this column, so an empty string would put every turn of every caller that
  // sends no message id into one index entry and let the first one written
  // suppress the rest.
  const messageId: string | null = typeof (event as any).message_id === "string"
    && (event as any).message_id
    ? (event as any).message_id
    : null;

  // 1. Close this turn's shadow row, saying how the run that was occupying the
  // session ended.
  //
  // Before the gate, not after, because the gate now asks whether anything is
  // still occupying the session and this row is the obvious wrong answer to
  // that question. `closeChatRun` is safe to run first: with no message id it
  // only closes a row that is the single open one, so it cannot take a
  // concurrent run's row with it.
  await closeChatRun(
    sessionId,
    messageId ?? undefined,
    interrupted ? "cancelled" : failed ? "failed" : "completed",
    failed ? String(failure_reason ?? "agent_error") : undefined,
  );

  // 2. Hand the conversation back -- but only if this was the last run on it.
  //
  // The column is the gate: while it reads `running` every further message
  // parks in `claw_pending_messages`, and clearing it admits the next turn. It
  // used to clear unconditionally on any `exec_complete`, which is wrong as
  // soon as a session can carry more than one run. `interruptUnstartedChatRuns`
  // makes that ordinary: cancelling a queued doorbell row publishes a terminal
  // event for that row, and this statement then opened the gate over whatever
  // else was still executing -- including a fat run whose own interrupt went
  // out on core NATS and may never have been heard. The next message dispatched
  // on top of a live run.
  //
  // `queued` counts as occupying for the same reason it does in
  // `reapStuckSessions`: the turn is waiting, not finished. Neither state can
  // wedge the gate -- `reapExpiredQueuedRuns` bounds the first at
  // `RUN_QUEUE_MAX_SEC` and releases the session itself, and `reapStuckSessions`
  // is the backstop for the rest.
  //
  // The message-id exclusion is belt and braces. After the close above this
  // turn's row is terminal and cannot match anyway; it matters only if that
  // close found nothing, which is the one case where trusting the row state
  // alone would leave the session gated for ever.
  const gateOpened = await releaseSessionGateIfLastRun(sessionId, messageId, Boolean(failed));

  // 3. Save conversation turns.
  await recordCompletionTurns(sessionId, event, messageId);

  // 4. Process explicit save_memory events (from Brain's save_memory tool).
  // Gated by CLAW_MEMORY_ENABLED. When OFF: drop the payload, warn for audit.
  // Brain's save_memory tool stays in the schema, so the LLM may still call it;
  // this is the silent-discard contract documented in the feature flag.
  let explicitMemorySaved = false;
  const memoriesToSave = (event as any).memories_to_save || [];
  if (!CLAW_MEMORY_ENABLED) {
    if (memoriesToSave.length) {
      logger.warn({ sessionId, count: memoriesToSave.length }, "memory.write_skipped_flag_off");
    }
  } else {
    for (const mem of memoriesToSave) {
      const blocked = scanMemoryContent(mem.content);
      if (blocked) { logger.warn({ reason: blocked }, "memory.blocked"); continue; }
      try {
        await insertMemoryEntry(userId, { ...mem, sourceSession: sessionId, sourceType: "explicit" });
        explicitMemorySaved = true;
      } catch (err) {
        logger.error({ err, sessionId }, "memory.save_failed");
      }
    }
    if (explicitMemorySaved) {
      maybeUpdateUserProfile(userId).catch(err =>
        logger.error({ err, userId }, "memory.profile_update_failed"));
    }
  }

  // 4 + 4.5. Skill writes (save_skill tool, skill_file mutations).
  // Gated by CLAW_SKILL_EVOLUTION_ENABLED. When OFF: drop, warn for audit.
  const skillsToSave = (event as any).skills_to_save || [];
  const skillFileMutations = (event as any).skill_file_mutations || [];
  if (!CLAW_SKILL_EVOLUTION_ENABLED) {
    if (skillsToSave.length || skillFileMutations.length) {
      logger.warn({
        sessionId,
        skills: skillsToSave.length,
        mutations: skillFileMutations.length,
      }, "skill.write_skipped_flag_off");
    }
  } else {
    // 4. Process explicit save_skill events (from Brain's save_skill tool).
    // Skills saved via tool are user-vouched, so source='manual' (skip probation).
    for (const skill of skillsToSave) {
      const blocked = scanMemoryContent(skill.content, 5000);
      if (blocked) { logger.warn({ reason: blocked }, "skill.blocked"); continue; }
      try {
        await saveSkill(skill.skill_name, userId, skill.content, "manual", sessionId, skill.description || "");
        logger.info({ skillName: skill.skill_name, sessionId }, "skill.saved");

        // Sub-files passed in the same save_skill call (rare path; usually they come via mutations)
        for (const f of skill.files || []) {
          const r = await addSkillFile(userId, skill.skill_name, {
            file_path: f.path, content: f.content, is_binary: f.is_binary,
          });
          if (!r.ok) logger.warn({ skill: skill.skill_name, path: f.path, err: r.error }, "skill_file.inline_save_failed");
        }
      } catch (err) {
        logger.error({ err, sessionId }, "skill.save_failed");
      }
    }

    // 4.5. Process sub-file mutations (E2: add/update/remove_skill_file)
    for (const m of skillFileMutations) {
      try {
        let r;
        if (m.action === "add") {
          r = await addSkillFile(userId, m.skill_name, { file_path: m.file_path, content: m.content || "", is_binary: m.is_binary });
        } else if (m.action === "update") {
          r = await updateSkillFile(userId, m.skill_name, { file_path: m.file_path, content: m.content || "", is_binary: m.is_binary });
        } else if (m.action === "remove") {
          r = await removeSkillFile(userId, m.skill_name, m.file_path);
        } else {
          logger.warn({ action: m.action }, "skill_file.unknown_action");
          continue;
        }
        if (r.ok) {
          logger.info({ skill: m.skill_name, action: m.action, path: m.file_path }, "skill_file.mutation_applied");
        } else {
          logger.warn({ skill: m.skill_name, action: m.action, path: m.file_path, err: r.error }, "skill_file.mutation_failed");
        }
      } catch (err) {
        logger.error({ err, skill: m.skill_name, action: m.action }, "skill_file.mutation_error");
      }
    }
  }

  // 5. Check pending messages (synchronous — must not be delayed by LLM calls).
  //    pending_messages has no soft-delete; queue consumption is hard delete by design.
  //
  //    Only when step 2 actually opened the gate. The two steps used to agree
  //    for free: the release was unconditional, so reaching here meant the
  //    session was free by construction. Making the release conditional --
  //    which it must be, now that a session can carry more than one run --
  //    split them apart, and this step kept draining regardless.
  //
  //    That is how a cancelled doorbell starts a second concurrent turn: Stop
  //    cancels a queued row while a fat run is still executing, the cancelled
  //    row publishes its own terminal event, step 2 correctly holds the gate
  //    shut for the run that is still going, and this step dispatched the next
  //    parked message straight on top of it. `dispatchPendingMessage` ends by
  //    setting `agent_status = 'running'`, which it already was, so the overlap
  //    left no trace: two agent loops on one session and workspace, and a gate
  //    reading exactly what it read before.
  //
  //    A false here is not a dropped message. The run still occupying the
  //    session publishes its own completion, and that event drains this queue.
  if (!gateOpened) {
    logger.info({ sessionId, messageId }, "chat.pending_drain_deferred_session_busy");
  }
  const pending = !gateOpened ? undefined : (await db.query(
    "SELECT id, content, user_id, plugin_id, tool_ids, workspace_id, platform_key, llm_api_key, credentials_blob, image, resources, timeout, user_env, session_env, topology FROM claw_pending_messages WHERE session_id = $1 ORDER BY created_at LIMIT 1",
    [sessionId],
  )).rows[0];

  if (pending) {
    const pendingUserId = pending.user_id || userId;
    const history = await buildMessages(sessionId, pending.content, pendingUserId);

    // Load local active skills (with sub-files) so the queued message keeps skill context
    let pendingSkills: Record<string, { content: string; enabled: boolean; version?: number; description?: string; files?: Array<{ path: string; content: string; is_binary?: boolean }> }> | undefined;
    try {
      const activeSkills = await selectSkillsForTask(pendingUserId, pending.content || "");
      pendingSkills = {};
      for (const [name, bundle] of Object.entries(activeSkills)) {
        pendingSkills[name] = {
          content: bundle.content,
          description: bundle.description,
          enabled: true,
          version: bundle.version,
          files: bundle.files,
        };
      }
      if (!Object.keys(pendingSkills).length) pendingSkills = undefined;
    } catch {
      pendingSkills = undefined;
    }

    const rawTools = pending.tool_ids;
    const toolIds: number[] = Array.isArray(rawTools)
      ? rawTools.map((x) => Number(x)).filter((n) => Number.isFinite(n))
      : [];
    const pid = pending.plugin_id;
    const pluginId =
      pid !== undefined && pid !== null && pid !== "" ? Number(pid) : undefined;
    const wsidRaw = pending.workspace_id;
    const workspaceId =
      typeof wsidRaw === "string" && wsidRaw.trim() !== "" ? wsidRaw.trim() : undefined;

    // Default resource row for cpu/memory/gpu/ephemeralStorage + image.
    const defaultResourceRow = await MarketplaceDb.resourceFirstByType("default");
    const defaultResource = asJsonObject(defaultResourceRow?.resource);
    const defaultImage = String(defaultResourceRow?.image ?? "").trim() || undefined;
    let pluginImage: string | undefined;
    let pluginResource: Record<string, unknown> | undefined;
    if (pluginId !== undefined && Number.isFinite(pluginId)) {
      try {
        const pluginRow = await MarketplaceDb.pluginGetById(pluginId, false);
        if (pluginRow && canViewPlugin(pluginRow, pendingUserId, false)) {
          const formatted = await formatPluginRow(pluginRow, true);
          const imageFromPlugin = pluginSandboxImage(formatted.images);
          if (imageFromPlugin) pluginImage = imageFromPlugin;
          const resourceFromPlugin = asJsonObject(formatted.resource);
          if (resourceFromPlugin) pluginResource = resourceFromPlugin;
        }
      } catch (err) {
        logger.warn({ err, sessionId, pluginId }, "pending.plugin_resource_resolve_failed");
      }
    }
    const requestImage =
      typeof pending.image === "string" && pending.image.trim() !== "" ? pending.image.trim() : undefined;
    // claw_pending_messages.resources column stores the request body's
    // `resource` (object) field; the column name is preserved unchanged.
    const requestResource = asJsonObject(pending.resources);
    const pendingTimeoutNum =
      pending.timeout !== undefined && pending.timeout !== null ? Number(pending.timeout) : NaN;
    const pendingTimeout = Number.isFinite(pendingTimeoutNum) ? Math.trunc(pendingTimeoutNum) : undefined;
    // Resolution chain: pending row > plugin row > DB default (resources table).
    const finalSandboxImage = requestImage || pluginImage || defaultImage;
    const finalResources = requestResource || pluginResource || defaultResource || {};

    // Same pairing as routes/sessions.ts immediate dispatch: tool_ids vs plugin_id (XOR at runtime; both keys for compat).
    // user_env snapshot frozen on the row at POST /messages time (see
    // routes/sessions.ts). Forward verbatim to Brain via ExecuteRequest.user_env.
    const pendingUserEnv =
      pending.user_env && typeof pending.user_env === "object" && !Array.isArray(pending.user_env)
        ? (pending.user_env as Record<string, string>)
        : undefined;
    const pendingSessionEnv =
      pending.session_env && typeof pending.session_env === "object" && !Array.isArray(pending.session_env)
        ? (pending.session_env as Record<string, string>)
        : undefined;
    const pendingMessageId = queuedMessageId(pending.id as number);
    const task: Record<string, unknown> = {
      session_id: sessionId,
      message_id: pendingMessageId,
      prompt: pending.content,
      history,
      user_id: pendingUserId,
      llm_api_key: typeof pending.llm_api_key === "string" ? pending.llm_api_key : "",
      platform_key: typeof pending.platform_key === "string" ? pending.platform_key : "",
      skills: pendingSkills,
      tool_ids: toolIds.length ? toolIds : undefined,
      plugin_id: pluginId !== undefined && Number.isFinite(pluginId) ? pluginId : undefined,
      workspace_id: workspaceId,
      sandbox_image: finalSandboxImage,
      resources: finalResources,
      timeout: pendingTimeout,
      user_env: pendingUserEnv && Object.keys(pendingUserEnv).length ? pendingUserEnv : undefined,
      session_env: pendingSessionEnv && Object.keys(pendingSessionEnv).length ? pendingSessionEnv : undefined,
      topology: asJsonObject(pending.topology),
    };
    const credentialsReadable = await applyPendingCredentials(task, pending, {
      sessionId, userId: pendingUserId, messageId: pendingMessageId,
    });
    // A queued turn is a run like any other, so it gets the same row, lease and
    // workspace binding the immediate path gives one. Without them a replayed
    // turn is invisible to lease-based recovery: its worker can die and no
    // sweep reclaims it, because there is no row saying it was ever owned.
    if (credentialsReadable) await dispatchPendingMessage({
      sessionId,
      pendingId: pending.id,
      userId: pendingUserId,
      messageId: pendingMessageId,
      prompt: pending.content,
      workspaceId,
      pluginId: pluginId !== undefined && Number.isFinite(pluginId) ? pluginId : undefined,
      sandboxImage: finalSandboxImage,
      task,
    });
  }

  // 6. Record skill effectiveness feedback (synchronous DB update, no LLM).
  //    Score: failed = -1, mixed quality = 0, clean success = +1.
  //
  //    Gated by CLAW_SKILL_EVOLUTION_ENABLED — when OFF, no feedback is
  //    recorded and probation skills don't graduate. selected_skills/skills_used
  //    on the event are also harmless to ignore because selectSkillsForTask
  //    already returns {} upstream.
  if (CLAW_SKILL_EVOLUTION_ENABLED) {
    //    Attribution rules (revised after the "no-disk-write" optimization broke
    //    the simple selected ∩ used model):
    //
    //      - skills WITH sub-files: must be both SELECTED and runtime-USED
    //        (cat .skills/NAME/SKILL.md or its sub-files). The agent has to
    //        actually load the supporting files for "used" to be a real signal.
    //      - skills WITHOUT sub-files: SELECTED is enough. SKILL.md is already
    //        inlined into the prompt; we don't write it to disk anymore, so the
    //        agent has no .skills/NAME/SKILL.md to cat — it physically cannot
    //        produce a runtime-used signal even when actively following the skill.
    //
    //    Multi-skill runs now record feedback for every primary skill (was:
    //    only single-skill runs). Same score per skill — imperfect attribution
    //    but vastly better than discarding the signal entirely.
    const skillsUsed = (event as any).skills_used || {};
    const selectedSkills = (event as any).selected_skills || [];
    const selectedList = Array.isArray(selectedSkills) ? (selectedSkills as string[]) : [];

    let primarySkills: string[] = [];
    let hasSubfiles = new Set<string>();
    if (selectedList.length) {
      const subfileRows = (await db.query(
        `SELECT DISTINCT s.skill_name
         FROM claw_skills s
         JOIN claw_skill_files f ON f.skill_id = s.id
         WHERE s.user_id = $1 AND s.skill_name = ANY($2)
           AND s.deleted_at IS NULL
           AND s.status IN ('active', 'probation')`,
        [userId, selectedList]
      )).rows;
      hasSubfiles = new Set(subfileRows.map((r: any) => r.skill_name));

      primarySkills = selectedList.filter(name => {
        if (!hasSubfiles.has(name)) return true;       // no sub-files → trust selection
        return !!skillsUsed[name];                     // has sub-files → require runtime read
      });
    }

    // Backfill skills_used for inline-only skills (no sub-files) so downstream
    // queries (shouldEvolveSkill, getSkillStats) can match them via the same
    // (data->'skills_used'->>name)::int = version pattern without SQL changes.
    // Use the current active version so version-scoped queries stay accurate.
    let skillsUsedPatched = false;
    const inlineSkills = selectedList.filter(n => !skillsUsed[n] && !hasSubfiles.has(n));
    if (inlineSkills.length) {
      const versionRows = (await db.query(
        `SELECT skill_name, version FROM claw_skills
         WHERE user_id = $1 AND skill_name = ANY($2)
           AND status = 'active' AND deleted_at IS NULL`,
        [userId, inlineSkills]
      )).rows;
      const versionMap = new Map(versionRows.map((r: any) => [r.skill_name, r.version]));
      for (const name of inlineSkills) {
        skillsUsed[name] = versionMap.get(name) ?? 1;
        skillsUsedPatched = true;
      }
    }
    if (skillsUsedPatched) {
      (event as any).skills_used = skillsUsed;
      if (eventRowId) {
        await db.query(`UPDATE claw_session_events SET data = $1 WHERE id = $2`, [event, eventRowId]);
      }
    }

    if (primarySkills.length >= 1) {
      const eventFailed = !!(event as any).failed;
      const turns = Number((event as any).turns) || 0;
      const errorCount = Number((event as any).error_count) || 0;
      let score: number;
      if (eventFailed) score = -1;
      else if (errorCount > 5 || turns > 25) score = 0;
      else score = 1;
      try {
        for (const name of primarySkills) {
          await recordSkillFeedback(userId, [name], score);
          await checkProbationGraduation(userId, name);
        }
      } catch (err) {
        logger.error({ err, sessionId }, "skill.feedback_failed");
      }
    }
  }

  // 7a. Best-effort background tasks (setImmediate fire-and-forget).
  //     These produce signal but losing one occurrence is acceptable —
  //     summary/memory will be regenerated on the next exec_complete, and
  //     pattern occurrences accumulate over many sessions.
  //     Memory extraction gated by CLAW_MEMORY_ENABLED; pattern recording
  //     gated by CLAW_SKILL_EVOLUTION_ENABLED. Summary stays unconditional.
  setImmediate(() => {
    maybeSummarize(sessionId, userId).catch(err =>
      logger.error({ err, sessionId }, "summarize_failed"));
    if (CLAW_MEMORY_ENABLED && !explicitMemorySaved) {
      maybeExtractMemory(sessionId, userId).catch(err =>
        logger.error({ err, sessionId }, "memory.extraction_failed"));
    }
    if (CLAW_SKILL_EVOLUTION_ENABLED) {
      maybeRecordTaskPattern(sessionId, userId, event).catch(err =>
        logger.error({ err, sessionId }, "skill.pattern_record_failed"));
    }
  });

  // 7b. Durable evolution job — replaces the old setImmediate(maybeEvolveSkill).
  //     Skill evolution is the highest-value background task and the most
  //     expensive to lose (LLM-decided multi-mutation batches), so it goes
  //     into a real DB-backed queue. marketplace/evolve-worker.ts polls and runs jobs
  //     with retries and crash recovery. Gated by CLAW_SKILL_EVOLUTION_ENABLED.
  if (CLAW_SKILL_EVOLUTION_ENABLED) {
    try {
      await enqueueEvolutionJob(sessionId, userId, event as Record<string, unknown>);
    } catch (err) {
      logger.error({ err, sessionId }, "evolve.enqueue_failed");
    }
  }

  logger.info({ sessionId, failed, userId }, "exec_complete.handled");
}

const SUMMARIZE_THRESHOLD = 80_000;
const KEEP_RECENT = 50_000;

async function maybeSummarize(sessionId: string, userId: string): Promise<void> {
  const totalTokens = (await db.query(
    "SELECT COALESCE(SUM(token_count), 0) as total FROM claw_conversation_turns WHERE session_id = $1 AND deleted_at IS NULL",
    [sessionId],
  )).rows[0].total;

  if (totalTokens < SUMMARIZE_THRESHOLD) return;

  // Find split point
  const turns = (await db.query(
    "SELECT turn_index, token_count FROM claw_conversation_turns WHERE session_id = $1 AND deleted_at IS NULL ORDER BY turn_index DESC",
    [sessionId],
  )).rows;

  let keep = 0, splitIdx = (turns[0]?.turn_index || 0) + 1;
  for (const t of turns) {
    keep += t.token_count || 0;
    if (keep > KEEP_RECENT) { splitIdx = t.turn_index; break; }
  }

  const toSummarize = (await db.query(
    "SELECT role, content FROM claw_conversation_turns WHERE session_id = $1 AND deleted_at IS NULL AND turn_index < $2 ORDER BY turn_index",
    [sessionId, splitIdx],
  )).rows;

  if (!toSummarize.length) return;

  // LLM-powered summarization with fallback to concatenation
  let summary: string;
  try {
    const conversationText = toSummarize
      .map((t: any) => `${t.role}: ${(t.content || "").slice(0, 500)}`)
      .join("\n");
    const result = await callMemoryLLM<{ summary: string }>(
      userId,
      `Summarize the following conversation into a concise summary (max 500 words). Focus on: key decisions made, problems solved, important context established, and any unresolved issues.\n\nConversation:\n{conversation}\n\nReturn JSON: { "summary": "..." }`,
      { conversation: conversationText },
    );
    summary = result.summary;
  } catch (err) {
    logger.warn({ err, sessionId }, "summarize.llm_fallback");
    summary = toSummarize.map((t: any) => `${t.role}: ${(t.content || "").slice(0, 300)}`).join("\n");
  }

  await db.query(
    `INSERT INTO claw_session_summaries (session_id, summary, summarized_up_to, token_count)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (session_id) DO UPDATE SET summary=$2, summarized_up_to=$3, token_count=$4, updated_at=NOW()`,
    [sessionId, summary, splitIdx, estimateTokens(summary)],
  );

  logger.info({ sessionId, splitIdx, summaryLen: summary.length }, "summarized");
}
