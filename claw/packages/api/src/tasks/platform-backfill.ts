// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Asking the platform why a run died, for the runs nobody was left to ask.
 *
 * Brain reads this itself when a sandbox dies under a live run. The case it
 * cannot cover is the common one: a node reclaim takes the sandbox and the Brain
 * worker together, so no callback is ever sent and the row is closed minutes
 * later by the sweeper -- with `brain_timeout`, which says only that nobody
 * reported back. That is exactly the run whose ending matters most to name, and
 * it is the one arriving with nothing on it.
 *
 * So the sweeper asks on the run's behalf. Late, but not too late: SaFE serves a
 * pod's account of its own ending from the pod, and the sweep runs within a
 * minute of the timeout, while a garbage collector works in tens of minutes.
 * When the pod is already gone the read returns nothing and the row keeps its
 * honest "we do not know" rather than gaining a guess.
 *
 * Best-effort throughout. Nothing here may fail a sweep: the sweep's job is to
 * stop rows being stuck, and a SaFE that is down must not prevent that.
 */
import pino from "pino";
import { platformFactsFromWorkloadDetail } from "@claw/protocol";
import { db } from "../infra/db.js";
import { SAFE_API_URL } from "../config.js";

const logger = pino({ name: "platform-backfill" });

/** One GET each, capped: this runs inside the sweeper tick. */
const FETCH_TIMEOUT_MS = 10_000;
/**
 * How many rows one sweep will ask about.
 *
 * A reclaim takes a whole node, so these arrive in batches -- one per run that
 * was on it. The cap keeps a bad node from turning one tick into hundreds of
 * serial SaFE calls; what it drops is the tail of a batch whose head already
 * named the same node, so the answer is rarely lost, only its per-row copy.
 */
const MAX_PER_SWEEP = 50;
/** Concurrent reads. Small: SaFE is shared, and nothing here is urgent. */
const CONCURRENCY = 5;

export interface SweptRow {
  task_id: string;
  session_id: string | null;
  sandbox_workload_id?: string | null;
}

async function platformKeyForSession(sessionId: string | null): Promise<string> {
  if (!sessionId) return "";
  const r = await db.query(
    "SELECT config FROM claw_sessions WHERE session_id = $1",
    [sessionId],
  );
  if (r.rowCount === 0) return "";
  const cfg = (r.rows[0].config ?? {}) as Record<string, unknown>;
  return typeof cfg.platform_key === "string" ? cfg.platform_key : "";
}

async function readAndStore(row: SweptRow): Promise<boolean> {
  const workloadId = row.sandbox_workload_id;
  if (!workloadId || !SAFE_API_URL) return false;
  const apiKey = await platformKeyForSession(row.session_id).catch(() => "");
  if (!apiKey) return false;

  let detail: Record<string, unknown>;
  try {
    const resp = await fetch(`${SAFE_API_URL}/api/v1/workloads/${workloadId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) return false;
    detail = (await resp.json()) as Record<string, unknown>;
  } catch (err) {
    logger.warn({ err, workloadId }, "platform_backfill.read_failed");
    return false;
  }

  const facts = platformFactsFromWorkloadDetail(detail);
  if (!facts) return false;

  // Guarded on the columns still being empty rather than on the read being new:
  // a late callback from a Brain that survived after all is the better source,
  // and it may land between the sweep's UPDATE and this one.
  const r = await db.query(
    `UPDATE claw_tasks
        SET platform_message         = COALESCE(NULLIF(platform_message, ''), $2),
            platform_node            = COALESCE(NULLIF(platform_node, ''), $3),
            platform_container_reason= COALESCE(NULLIF(platform_container_reason, ''), $4),
            platform_exit_code       = COALESCE(platform_exit_code, $5)
      WHERE task_id = $1
        AND platform_message IS NULL
        AND platform_kill_reason IS NULL`,
    [row.task_id, facts.message || null, facts.node || null,
      facts.containerReason || null, facts.exitCode],
  );
  if (r.rowCount) {
    logger.info(
      { taskId: row.task_id, workloadId, node: facts.node, reason: facts.containerReason },
      "platform_backfill.recorded",
    );
  }
  return Boolean(r.rowCount);
}

/**
 * Record what the platform says about each swept row that had a sandbox.
 *
 * Returns how many rows gained facts. Never throws: a caller is a sweeper arm
 * that has already closed these rows, and the close must stand whatever SaFE
 * does.
 */
export async function backfillPlatformFacts(rows: SweptRow[]): Promise<number> {
  const withWorkload = rows.filter((r) => r.sandbox_workload_id);
  const targets = withWorkload.slice(0, MAX_PER_SWEEP);
  if (targets.length === 0) return 0;
  if (withWorkload.length > MAX_PER_SWEEP) {
    // The overflow is not lost, only deferred: the rows are already terminal
    // and the sweeper's UPDATE cannot select them again, so before this they
    // were dropped in memory and no path ever revisited them -- a reap of 200
    // left 150 runs permanently without a platform account. drainPending picks
    // them up on later ticks by looking for exactly the state they are left
    // in: a workload id recorded and no facts against it.
    logger.warn(
      { swept: rows.length, asked: MAX_PER_SWEEP, deferred: withWorkload.length - MAX_PER_SWEEP },
      "platform_backfill.capped",
    );
  }

  let recorded = 0;
  const queue = [...targets];
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const row = queue.shift();
      if (!row) return;
      const ok = await readAndStore(row).catch((err) => {
        logger.warn({ err, taskId: row.task_id }, "platform_backfill.failed");
        return false;
      });
      if (ok) recorded++;
    }
  });
  await Promise.all(workers);
  return recorded;
}

/**
 * Work down the backlog the per-sweep cap leaves behind.
 *
 * Selected by outcome rather than by remembering a list: a row that has a
 * workload id and no facts is one nobody has answered for yet, whether it was
 * capped, raced, or failed its first read. Terminal rows only, so this cannot
 * touch a run still in flight, and the same NULL guards on the write mean a
 * late Brain callback still wins.
 *
 * Bounded per tick for the same reason the sweep is: this runs inside the
 * sweeper's tick and talks to SaFE one workload at a time.
 */
export async function drainPendingPlatformFacts(): Promise<number> {
  const r = await db.query(
    `SELECT task_id, session_id, sandbox_workload_id
       FROM claw_tasks
      WHERE status IN ('completed', 'failed', 'cancelled')
        AND sandbox_workload_id IS NOT NULL
        AND sandbox_workload_id <> ''
        AND platform_message IS NULL
        AND platform_kill_reason IS NULL
        AND completed_at > NOW() - INTERVAL '1 hour'
      ORDER BY completed_at ASC, task_id ASC
      LIMIT $1`,
    [MAX_PER_SWEEP],
  );
  if (!r.rowCount) return 0;
  return await backfillPlatformFacts(r.rows as SweptRow[]);
}
