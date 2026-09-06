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
import { db, type StatementRunner } from "../infra/db.js";
import pino from "pino";
import {
  anySoftCeilingSet, askFromRow, chargeAccepted, envAdmitLimits, fillWithinCeiling,
  hardOverflow, loadUsageWithRoots, reserveForExecution, softOverflow,
  withOwnedAdmissionLock, type AdmissionUsage,
} from "./admission.js";
import { dispatchPreparedRow, dispatchTask } from "./dispatcher.js";
import { listDownstream, transitionStatus, updateTask } from "./db.js";
import type { ClawTaskRow, TaskStatus } from "./types.js";

const logger = pino({ name: "task-scheduler" });

const TICK_MS = Number(process.env.TASK_SCHEDULER_TICK_MS || 2000);
const MAX_DISPATCH_PER_TICK = Number(process.env.TASK_SCHEDULER_MAX_DISPATCH || 8);
const DISPATCH_TIMEOUT_MS = Number(process.env.TASK_SCHEDULER_DISPATCH_TIMEOUT_MS || 30_000);
/** How many ready rows one promotion pass considers, paging past those that do not fit. */
const MAX_PROMOTE_PAGE = Number(process.env.TASK_SCHEDULER_MAX_PROMOTE || 64);

let stopped = false;
let timer: NodeJS.Timeout | null = null;

const READY_PREDICATE_SQL = `status = 'waiting_deps'
       AND NOT EXISTS (
         SELECT 1 FROM unnest(depends_on) dep
         JOIN claw_tasks p ON p.task_id = dep
         WHERE p.status <> 'completed'
       )`;

async function readyCandidates(
  client: StatementRunner,
  skip: string[],
  limit: number,
): Promise<ClawTaskRow[]> {
  const r = await client.query(
    `SELECT * FROM claw_tasks
      WHERE ${READY_PREDICATE_SQL}
        AND NOT (task_id = ANY($1::text[]))
      ORDER BY priority DESC, created_at ASC
      LIMIT $2
      FOR UPDATE SKIP LOCKED`,
    [skip, limit],
  );
  return r.rows as ClawTaskRow[];
}

/**
 * Greedily accept ready rows while cumulative demand stays under every ceiling.
 *
 * A row-count `LIMIT` cannot express this: one row may request many GPU nodes,
 * and run-root headroom is a third dimension a row limit does not bound at all.
 * Pure, so the accounting is testable without a database.
 */
export function acceptWithinHardHeadroom(
  candidates: readonly ClawTaskRow[],
  usage: AdmissionUsage,
  roots: Set<string>,
): ClawTaskRow[] {
  const limits = envAdmitLimits();
  const accepted: ClawTaskRow[] = [];
  for (const row of candidates) {
    const ask = askFromRow(row, roots);
    if (hardOverflow(usage, ask, limits)) continue;
    chargeAccepted(usage, ask, row.dag_root_task_id ?? row.task_id, roots);
    accepted.push(row);
  }
  return accepted;
}

/**
 * Promote `waiting_deps` rows whose every dep is `completed` to `queued`.
 *
 * Entry into the committed set for a row whose graph was admitted at expansion,
 * so a hard ceiling defers rather than refuses: a mid-flight node destroying
 * completed upstream work to reclaim capacity the graph was already granted is
 * the failure this shape avoids. Rows not accepted are reconsidered next tick.
 *
 * @returns the number of promoted rows; useful in tests.
 */
export async function promoteReadyTasks(): Promise<number> {
  const limits = envAdmitLimits();
  if (limits.hardRuns <= 0 && limits.hardSandboxes <= 0 && limits.hardGpuNodes <= 0) {
    const r = await db.query(
      `UPDATE claw_tasks
       SET status = 'queued', queued_at = NOW()
       WHERE ${READY_PREDICATE_SQL}
       RETURNING task_id`,
    );
    return r.rowCount ?? 0;
  }
  return await withOwnedAdmissionLock(async (client) => {
    const { usage, roots } = await loadUsageWithRoots("occupying", client);
    const accepted = await fillWithinCeiling<ClawTaskRow>({
      page: (skip) => readyCandidates(client, skip, MAX_PROMOTE_PAGE),
      fits: () => true,
      want: MAX_PROMOTE_PAGE,
      idOf: (row) => row.task_id,
    });
    const admitted = acceptWithinHardHeadroom(accepted, usage, roots);
    if (!admitted.length) return 0;
    // The readiness predicate is repeated in the write: the advisory lock
    // serialises admission decisions, not the whole task lifecycle, so
    // `cascadeFailures` and cancellation may have failed one of these rows
    // since it was selected, and an unconditional UPDATE would resurrect it.
    const r = await client.query(
      `UPDATE claw_tasks
       SET status = 'queued', queued_at = NOW()
       WHERE task_id = ANY($1::text[])
         AND ${READY_PREDICATE_SQL}
       RETURNING task_id`,
      [admitted.map((row) => row.task_id)],
    );
    return r.rowCount ?? 0;
  });
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

async function pickQueuedTasks(
  limit: number,
  skip: string[] = [],
  client?: StatementRunner,
): Promise<ClawTaskRow[]> {
  // Chat doorbell rows sit at `queued` until a Brain claims them. This loop
  // is the DAG publisher: if it takes those rows it CAS-es them to
  // `preparing` and puts a fat execute request on the same durable, which is
  // how a full replica ended up holding work that was supposed to wait on
  // the row.
  const r = await (client ?? db).query(
    `SELECT * FROM claw_tasks
     WHERE status = 'queued' AND executor = 'brain'
       AND origin IS DISTINCT FROM 'chat'
       AND NOT (task_id = ANY($2::text[]))
     ORDER BY priority DESC, queued_at ASC NULLS LAST
     LIMIT $1`,
    [limit, skip],
  );
  return r.rows as ClawTaskRow[];
}

/**
 * Dispatch one queued task without letting a hung publish/render path stall the
 * scheduler loop forever. The underlying `dispatchTask` also has per-stage
 * timeouts; this outer guard protects the scheduler itself.
 */
async function dispatchWithTimeout(task: ClawTaskRow): Promise<void> {
  await withDispatchTimeout(task, () => dispatchTask(task.task_id));
}

/** The reserved row's half: the CAS already ran on the admission transaction. */
async function dispatchPreparedWithTimeout(task: ClawTaskRow): Promise<void> {
  await withDispatchTimeout(task, () => dispatchPreparedRow(task));
}

async function withDispatchTimeout(
  task: ClawTaskRow,
  run: () => Promise<{ ok: boolean; reason?: string }>,
): Promise<void> {
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
    const result = await Promise.race([run(), timeout]);
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

/**
 * Select and reserve queued rows the executing set still has room for.
 *
 * The usage read, the selection and the `queued → preparing` reservation are
 * one transaction on one connection: a snapshot followed by an unlocked CAS is
 * not a ceiling, every replica's tick otherwise admitting a full batch against
 * the same free slot.
 */
async function reserveQueuedTasks(limit: number): Promise<ClawTaskRow[]> {
  const limits = envAdmitLimits();
  if (!anySoftCeilingSet(limits)) return [];
  return await withOwnedAdmissionLock(async (client) => {
    const { usage, roots } = await loadUsageWithRoots("executing", client);
    const accepted = await fillWithinCeiling<ClawTaskRow>({
      page: (skip) => pickQueuedTasks(limit, skip, client),
      fits: (row) => {
        const ask = askFromRow(row, roots);
        if (softOverflow(usage, ask, limits)) return false;
        chargeAccepted(usage, ask, row.dag_root_task_id ?? row.task_id, roots);
        return true;
      },
      want: limit,
      idOf: (row) => row.task_id,
    });
    return await reserveForExecution(
      client,
      accepted,
      (row, c) => transitionStatus(row.task_id, ["queued"], "preparing", {}, c),
    );
  });
}

export async function schedulerTick(): Promise<void> {
  try {
    await promoteReadyTasks();
    await cascadeFailures();
    await aggregateDagRoots();
    // Dispatch in parallel within a tick. Each dispatch is independently
    // bounded by `dispatchWithTimeout`, so a single hang cannot stall the
    // tick — but successful dispatches happen concurrently so high-fan-out
    // DAG instances do not get serialised at MAX_DISPATCH_PER_TICK × stage.
    if (anySoftCeilingSet(envAdmitLimits())) {
      // Already `preparing`, and reserved before the lock was released: the
      // render and publish stages take seconds and the slot they will use is
      // taken, so they deliberately run outside the transaction.
      const reserved = await reserveQueuedTasks(MAX_DISPATCH_PER_TICK);
      await Promise.allSettled(reserved.map((t) => dispatchPreparedWithTimeout(t)));
      return;
    }
    const queued = await pickQueuedTasks(MAX_DISPATCH_PER_TICK);
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
