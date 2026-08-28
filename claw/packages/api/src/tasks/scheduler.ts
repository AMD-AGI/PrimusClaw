// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Task scheduler (task-design.md §13).
 *
 * Periodically:
 *
 *   1. Promote ready `waiting_deps` rows to `queued` (deps all completed).
 *   2. Cascade-fail children of failed parents (`on_failure='cascade_fail'`).
 *   3. Pick up to `MAX_DISPATCH_PER_TICK` queued tasks and call `dispatchTask`.
 *   4. Aggregate virtual DAG root status (`__dag_root__` row) when all
 *      execution peers have reached a terminal state.
 *
 * Concurrency model:
 *
 *   - One scheduler tick at a time per API replica. Across replicas Postgres
 *     UPDATE...RETURNING acts as the lock; whoever wins the CAS owns the
 *     transition.
 *   - Tick interval defaults to 2s and is configurable through
 *     `TASK_SCHEDULER_TICK_MS`.
 */
import { db } from "../infra/db.js";
import pino from "pino";
import { dispatchTask } from "./dispatcher.js";
import { listDownstream, transitionStatus, updateTask } from "./db.js";
import type { ClawTaskRow, TaskStatus } from "./types.js";

const logger = pino({ name: "task-scheduler" });

const TICK_MS = Number(process.env.TASK_SCHEDULER_TICK_MS || 2000);
const MAX_DISPATCH_PER_TICK = Number(process.env.TASK_SCHEDULER_MAX_DISPATCH || 8);
const DISPATCH_TIMEOUT_MS = Number(process.env.TASK_SCHEDULER_DISPATCH_TIMEOUT_MS || 30_000);

let stopped = false;
let timer: NodeJS.Timeout | null = null;

/**
 * Promote `waiting_deps` rows whose every dep is `completed` to `queued`.
 * Returns the number of promoted rows; useful in tests.
 */
export async function promoteReadyTasks(): Promise<number> {
  const r = await db.query(
    `UPDATE claw_tasks t
     SET status = 'queued', queued_at = NOW()
     WHERE t.status = 'waiting_deps'
       AND NOT EXISTS (
         SELECT 1 FROM unnest(t.depends_on) dep
         JOIN claw_tasks p ON p.task_id = dep
         WHERE p.status <> 'completed'
       )
     RETURNING task_id`,
  );
  return r.rowCount ?? 0;
}

/**
 * Cascade-fail children of failed tasks whose `on_failure='cascade_fail'`.
 * We rely on `claw_tasks.metadata.derived.on_failure` (filled at expansion).
 */
export async function cascadeFailures(): Promise<number> {
  // Find failed tasks whose downstream rows still wait on them.
  const failed = await db.query(
    `SELECT task_id FROM claw_tasks
     WHERE status = 'failed' AND completed_at > NOW() - INTERVAL '5 minutes'`,
  );
  let cascaded = 0;
  for (const row of failed.rows as Array<{ task_id: string }>) {
    const downs = await listDownstream(row.task_id);
    if (downs.length === 0) continue;
    const r = await db.query(
      `UPDATE claw_tasks
       SET status = 'failed', failure_reason = 'deps_failed',
           error_message = $1, completed_at = NOW()
       WHERE task_id = ANY($2)
         AND status IN ('waiting_deps','waiting_external','queued')
         AND COALESCE(metadata->'derived'->>'on_failure','cascade_fail') = 'cascade_fail'`,
      [`upstream ${row.task_id} failed`, downs],
    );
    cascaded += r.rowCount ?? 0;
  }
  return cascaded;
}

/** Aggregate virtual DAG root state when peers all terminal. */
export async function aggregateDagRoots(): Promise<number> {
  const r = await db.query(
    `SELECT root.task_id AS root_id,
            BOOL_AND(peer.status IN ('completed','failed','cancelled')) AS done,
            BOOL_AND(peer.status = 'completed') AS all_ok,
            BOOL_OR(peer.status = 'cancelled')  AS any_cancel,
            BOOL_OR(peer.status = 'failed')     AS any_fail
     FROM claw_tasks root
     JOIN claw_tasks peer
       ON peer.dag_root_task_id = root.task_id
      AND peer.dag_node_id <> '__dag_root__'
     WHERE root.dag_node_id = '__dag_root__'
       AND root.status = 'running'
     GROUP BY root.task_id`,
  );
  let updated = 0;
  for (const row of r.rows as Array<{ root_id: string; done: boolean; all_ok: boolean; any_cancel: boolean; any_fail: boolean }>) {
    if (!row.done) continue;
    const next: TaskStatus = row.any_cancel ? "cancelled" : row.any_fail ? "failed" : "completed";
    const updatedRow = await transitionStatus(row.root_id, ["running"], next, {
      failure_reason: next === "failed" ? "deps_failed" : null,
    });
    if (updatedRow) updated++;
  }
  return updated;
}

async function pickQueuedTasks(limit: number): Promise<ClawTaskRow[]> {
  // Chat doorbell rows sit at `queued` until a Brain claims them. This loop
  // is the DAG publisher: if it takes those rows it CAS-es them to
  // `preparing` and puts a fat execute request on the same durable, which is
  // how a full replica ended up holding work that was supposed to wait on
  // the row.
  const r = await db.query(
    `SELECT * FROM claw_tasks
     WHERE status = 'queued' AND executor = 'brain'
       AND origin IS DISTINCT FROM 'chat'
     ORDER BY priority DESC, queued_at ASC NULLS LAST
     LIMIT $1`,
    [limit],
  );
  return r.rows as ClawTaskRow[];
}

/**
 * Dispatch one queued task without letting a hung publish/render path stall the
 * scheduler loop forever. The underlying `dispatchTask` also has per-stage
 * timeouts; this outer guard protects the scheduler itself.
 */
async function dispatchWithTimeout(task: ClawTaskRow): Promise<void> {
  const started = Date.now();
  logger.info(
    { taskId: task.task_id, dag_id: task.dag_id, dag_node_id: task.dag_node_id, mode: task.mode },
    "scheduler.dispatch.begin",
  );
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`dispatch timed out after ${DISPATCH_TIMEOUT_MS}ms`)),
      DISPATCH_TIMEOUT_MS,
    );
  });
  try {
    const result = await Promise.race([dispatchTask(task.task_id), timeout]);
    logger.info(
      { taskId: task.task_id, ok: result.ok, reason: result.reason, elapsedMs: Date.now() - started },
      "scheduler.dispatch.done",
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error({ taskId: task.task_id, err: msg, elapsedMs: Date.now() - started }, "scheduler.dispatch.timeout");
    await transitionStatus(task.task_id, ["preparing"], "failed", {
      failure_reason: "dispatch_timeout",
      error_message: msg,
    });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function schedulerTick(): Promise<void> {
  try {
    await promoteReadyTasks();
    await cascadeFailures();
    await aggregateDagRoots();
    const queued = await pickQueuedTasks(MAX_DISPATCH_PER_TICK);
    // Dispatch in parallel within a tick. Each dispatch is independently
    // bounded by `dispatchWithTimeout`, so a single hang cannot stall the
    // tick — but successful dispatches happen concurrently so high-fan-out
    // DAG instances do not get serialised at MAX_DISPATCH_PER_TICK × stage.
    await Promise.allSettled(queued.map((t) => dispatchWithTimeout(t)));
  } catch (e) {
    logger.error({ err: (e as Error).message }, "scheduler.tick_failed");
  }
}

export function startScheduler(): void {
  if (timer) return;
  stopped = false;
  const loop = async () => {
    if (stopped) return;
    await schedulerTick();
    if (!stopped) timer = setTimeout(loop, TICK_MS);
  };
  void loop();
  logger.info({ tickMs: TICK_MS, maxPerTick: MAX_DISPATCH_PER_TICK }, "scheduler.started");
}

export function stopScheduler(): void {
  stopped = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

// Re-export for testability.
export { updateTask };
