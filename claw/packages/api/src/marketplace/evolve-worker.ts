// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { db } from "../infra/db.js";
import { maybeEvolveSkill } from "./skill-service.js";
import pino from "pino";

const logger = pino({ name: "evolve-worker" });

const POLL_INTERVAL_MS = 30_000;
const BATCH_SIZE = 5;
const MAX_ATTEMPTS = 3;
/** Jobs stuck in 'running' longer than this are reset to 'pending' on the next
 *  poll. Should be longer than the worst-case maybeEvolveSkill latency
 *  (~1-2 LLM calls + verifier batch + transactional apply), with margin. */
const STALE_RUNNING_MS = 5 * 60_000;

/**
 * Enqueue an evolution job. Called from event-consumer when handleComplete
 * finishes — replaces the old `setImmediate(maybeEvolveSkill)` fire-and-forget
 * pattern with a durable hand-off.
 *
 * The full event payload is stored so the worker doesn't need to reconstruct
 * it from claw_session_events (would race with soft-delete) and so a future
 * worker restart sees exactly what the producer saw.
 */
export async function enqueueEvolutionJob(
  sessionId: string,
  userId: string,
  event: Record<string, unknown>,
): Promise<void> {
  await db.query(
    `INSERT INTO claw_evolution_jobs (session_id, user_id, event_data) VALUES ($1, $2, $3::jsonb)`,
    [sessionId, userId, JSON.stringify(event)]
  );
}

/**
 * Atomically claim the next batch of pending jobs. Uses FOR UPDATE SKIP LOCKED
 * so multiple API pods can run a worker each without stepping on each other —
 * each pod's claim sees a different non-overlapping slice.
 */
async function claimBatch(): Promise<Array<{ id: string; session_id: string; user_id: string; event_data: any; attempts: number }>> {
  const rows = (await db.query(`
    UPDATE claw_evolution_jobs
    SET status = 'running', started_at = NOW(), attempts = attempts + 1
    WHERE id = ANY (
      SELECT id FROM claw_evolution_jobs
      WHERE status = 'pending'
      ORDER BY created_at ASC
      LIMIT $1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, session_id, user_id, event_data, attempts
  `, [BATCH_SIZE])).rows;
  return rows;
}

/**
 * Reset jobs that have been 'running' for too long back to 'pending' so they
 * can be retried. Catches the case where the worker process died mid-job.
 */
async function reapStaleRunning(): Promise<number> {
  const result = await db.query(
    `UPDATE claw_evolution_jobs
     SET status = 'pending', started_at = NULL,
         last_error = COALESCE(last_error, '') || ' [reaped: stale running]'
     WHERE status = 'running'
       AND started_at < NOW() - INTERVAL '${Math.floor(STALE_RUNNING_MS / 1000)} seconds'`
  );
  return result.rowCount ?? 0;
}

async function processOne(job: { id: string; session_id: string; user_id: string; event_data: any; attempts: number }): Promise<void> {
  try {
    await maybeEvolveSkill(job.session_id, job.user_id, job.event_data);
    await db.query(
      `UPDATE claw_evolution_jobs SET status = 'done', finished_at = NOW() WHERE id = $1`,
      [job.id]
    );
    logger.info({ jobId: job.id, sessionId: job.session_id, userId: job.user_id }, "evolve.job_done");
  } catch (err: any) {
    const errMsg = (err?.message || String(err)).slice(0, 1000);
    if (job.attempts >= MAX_ATTEMPTS) {
      await db.query(
        `UPDATE claw_evolution_jobs SET status = 'failed', finished_at = NOW(), last_error = $1 WHERE id = $2`,
        [errMsg, job.id]
      );
      logger.error({ jobId: job.id, sessionId: job.session_id, attempts: job.attempts, errMsg }, "evolve.job_failed_permanent");
    } else {
      // Reset to pending for retry on next poll. Keep attempts counter.
      await db.query(
        `UPDATE claw_evolution_jobs SET status = 'pending', started_at = NULL, last_error = $1 WHERE id = $2`,
        [errMsg, job.id]
      );
      logger.warn({ jobId: job.id, sessionId: job.session_id, attempts: job.attempts, errMsg }, "evolve.job_retry");
    }
  }
}

let pollTimer: NodeJS.Timeout | null = null;
let inFlight = false;

async function tick(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const reaped = await reapStaleRunning();
    if (reaped) logger.warn({ reaped }, "evolve.stale_running_reset");

    const batch = await claimBatch();
    if (!batch.length) return;
    logger.info({ count: batch.length }, "evolve.batch_claimed");
    // Process sequentially within this tick to bound concurrent LLM calls.
    // Cross-pod parallelism comes from each pod claiming a non-overlapping
    // slice via SKIP LOCKED.
    for (const job of batch) {
      await processOne(job);
    }
  } catch (err) {
    logger.error({ err }, "evolve.tick_failed");
  } finally {
    inFlight = false;
  }
}

export function startEvolveWorker(): void {
  if (pollTimer) return;
  // Kick off first tick after a short delay so DB migrations finish first.
  setTimeout(() => {
    tick().catch(err => logger.error({ err }, "evolve.first_tick_failed"));
    pollTimer = setInterval(() => {
      tick().catch(err => logger.error({ err }, "evolve.tick_failed"));
    }, POLL_INTERVAL_MS);
  }, 5_000);
  logger.info({ intervalMs: POLL_INTERVAL_MS, batchSize: BATCH_SIZE }, "evolve-worker.started");
}

export function stopEvolveWorker(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
