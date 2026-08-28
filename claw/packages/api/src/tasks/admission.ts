// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Whether a new run may start, wait, or must be refused.
 *
 * Counted by run-tree root so a tenant cannot multiply a quota by nesting.
 * A dimension whose ceiling is zero is not enforced. Soft means the row sits
 * at `queued` for claim-next; hard means the create is rejected.
 */

import pino from "pino";

import {
  ADMIT_HARD_GPU_NODES,
  ADMIT_HARD_RUNS,
  ADMIT_HARD_SANDBOXES,
  ADMIT_SOFT_GPU_NODES,
  ADMIT_SOFT_RUNS,
  ADMIT_SOFT_SANDBOXES,
  ADMIT_TREE_MAX_DEPTH,
  ADMIT_TREE_MAX_NODES,
} from "../config.js";
import { db } from "../infra/db.js";

const logger = pino({ name: "admission" });

const OCCUPYING = ["queued", "preparing", "running", "cancelling"] as const;
const EXECUTING = ["preparing", "running", "cancelling"] as const;

export type AdmissionDecision =
  | { kind: "admit" }
  | { kind: "queue"; position: number }
  | { kind: "reject"; reason: string };

export interface AdmissionAsk {
  origin: "chat" | "task" | "dag_node";
  wantsSandbox: boolean;
  gpuNodes: number;
  treeRootId?: string | null;
  treeNodeCount?: number;
  treeDepth?: number;
}

/**
 * Two counts per dimension, for the same reason runs already had two.
 *
 * A hard ceiling is about what the fleet has committed to, so it counts
 * everything `OCCUPYING` -- a queued run is going to want its sandbox, and a
 * limit that ignores the backlog is a limit the backlog walks straight
 * through. A soft ceiling is about what is running now, because its answer is
 * "wait", and making a run wait behind rows that are themselves waiting is how
 * a queue stops draining.
 *
 * `runRoots` / `executingRoots` were already this pair. Sandboxes and GPU
 * nodes only had the executing half, which is what made the post-insert hard
 * recheck unable to see the row it had just written: that row is `queued`, and
 * `queued` was not in the count.
 *
 * The GPU count tests `jsonb_typeof(... ->'nodes') = 'number'` rather than
 * casting whatever is there. `claw_tasks.input` is not all ours: the task API
 * writes a caller's JSON into it verbatim, and these aggregates scan every
 * `executor = 'brain'` row regardless of origin. A single task carrying
 * `{"topology":{"nodes":"x"}}` therefore used to abort the whole statement
 * with `invalid input syntax for type integer` -- and since admission runs
 * before the insert on every chat dispatch, one such row refused every turn in
 * the fleet for as long as it stayed queued. Checking the type first counts
 * what is countable and ignores the rest, which is also the right answer for a
 * row whose topology means nothing to us.
 */
export interface AdmissionUsage {
  /** Run-tree roots in any occupying state, including `queued`. */
  runRoots: number;
  /** Run-tree roots actually executing. */
  executingRoots: number;
  /** Sandboxes committed to, including those a queued run will need. */
  sandboxes: number;
  /** Sandboxes belonging to runs that are executing now. */
  executingSandboxes: number;
  /** GPU nodes committed to, including those a queued run will need. */
  gpuNodes: number;
  /** GPU nodes belonging to runs that are executing now. */
  executingGpuNodes: number;
}

export interface AdmitLimits {
  softRuns: number;
  hardRuns: number;
  softSandboxes: number;
  hardSandboxes: number;
  softGpuNodes: number;
  hardGpuNodes: number;
  treeMaxNodes: number;
  treeMaxDepth: number;
}

export function envAdmitLimits(): AdmitLimits {
  return {
    softRuns: ADMIT_SOFT_RUNS,
    hardRuns: ADMIT_HARD_RUNS,
    softSandboxes: ADMIT_SOFT_SANDBOXES,
    hardSandboxes: ADMIT_HARD_SANDBOXES,
    softGpuNodes: ADMIT_SOFT_GPU_NODES,
    hardGpuNodes: ADMIT_HARD_GPU_NODES,
    treeMaxNodes: ADMIT_TREE_MAX_NODES,
    treeMaxDepth: ADMIT_TREE_MAX_DEPTH,
  };
}

export function decideFromUsage(
  usage: AdmissionUsage,
  ask: AdmissionAsk,
  queuedCount: number,
  limits: AdmitLimits,
): AdmissionDecision {
  const treeReject = treeCapReason(ask, limits);
  if (treeReject) return { kind: "reject", reason: treeReject };
  const hard = firstHardRefusal(usage, ask, limits);
  if (hard) return { kind: "reject", reason: hard };
  if (firstSoftOverflow(usage, ask, limits)) {
    return { kind: "queue", position: queuedCount + 1 };
  }
  return { kind: "admit" };
}

/**
 * True when the fleet is past a hard ceiling, counting the row already written.
 *
 * No `+ 1` anywhere: this runs after the insert, so every occupying count
 * already contains this run. That was true of `runRoots` from the start and
 * false of the other two until they learned to count `queued` -- which made
 * this function re-read the same numbers `decideAdmission` had just seen and
 * agree with itself, closing nothing. The race it is here for is two creates
 * that both cleared the pre-insert check against the same free slot; only a
 * read that sees both rows can catch it, and only if both rows are counted.
 */
export function hardExceededByUsage(
  usage: AdmissionUsage,
  ask: AdmissionAsk,
  limits: AdmitLimits,
): string | null {
  if (overLimit(limits.hardRuns, usage.runRoots)) return "runs_hard_limit";
  if (ask.wantsSandbox && overLimit(limits.hardSandboxes, usage.sandboxes)) {
    return "sandboxes_hard_limit";
  }
  if (ask.gpuNodes > 0 && overLimit(limits.hardGpuNodes, usage.gpuNodes)) {
    return "gpu_nodes_hard_limit";
  }
  return null;
}

export async function hardLimitAfterInsert(
  ask: AdmissionAsk,
  taskId?: string,
): Promise<string | null> {
  const limits = envAdmitLimits();
  if (limits.hardRuns <= 0 && limits.hardSandboxes <= 0 && limits.hardGpuNodes <= 0) {
    return null;
  }
  // Ordinal when the caller names its row, absolute otherwise. Comparing the
  // total against the ceiling has no tie-break: two creates that both cleared
  // the pre-insert check and both inserted each read the same over-limit total
  // and both refuse, so a race for one free slot loses both runs instead of
  // the excess. Counting only the rows that were there first makes the
  // decision this row's own -- the ones inside the ceiling keep it, the ones
  // past it are shed.
  if (taskId) {
    return firstAheadRefusal(await loadUsageAhead(taskId), ask, limits);
  }
  return hardExceededByUsage(await loadUsage(), ask, limits);
}

/** Occupying work that was already there when this row was written. */
export interface UsageAhead {
  runRoots: number;
  sandboxes: number;
  gpuNodes: number;
}

export function firstAheadRefusal(
  ahead: UsageAhead,
  ask: AdmissionAsk,
  limits: AdmitLimits,
): string | null {
  // `>=` rather than `>`: the ceiling counts rows, and if it is already full
  // of rows older than this one then this one is the overflow.
  if (limits.hardRuns > 0 && ahead.runRoots >= limits.hardRuns) return "runs_hard_limit";
  if (ask.wantsSandbox && limits.hardSandboxes > 0 && ahead.sandboxes >= limits.hardSandboxes) {
    return "sandboxes_hard_limit";
  }
  if (ask.gpuNodes > 0 && limits.hardGpuNodes > 0
      && ahead.gpuNodes + ask.gpuNodes > limits.hardGpuNodes) {
    return "gpu_nodes_hard_limit";
  }
  return null;
}

/**
 * The same three counts, restricted to rows that precede this one.
 *
 * Ordered by `created_at` with `task_id` as the tie-break, because two rows
 * written in the same millisecond still need a total order for exactly one of
 * them to win.
 *
 * A row that is gone yields zeros rather than an absence: the CTE is empty, so
 * the cross join has nothing to aggregate and the counts come back at zero,
 * which refuses nothing. That is the right answer -- somebody else already
 * closed the row -- and it is why there is no null case to handle.
 */
export async function loadUsageAhead(taskId: string): Promise<UsageAhead> {
  const r = await db.query(
    `WITH self AS (
       SELECT created_at, task_id FROM claw_tasks WHERE task_id = $2
     )
     SELECT
       COUNT(DISTINCT COALESCE(t.dag_root_task_id, t.task_id))::int AS run_roots,
       COUNT(*) FILTER (
         WHERE t.sandbox_spec IS NOT NULL AND t.sandbox_spec::text <> '"none"'
            OR COALESCE(t.metadata->>'sandbox_image','') <> ''
       )::int AS sandboxes,
       COALESCE(SUM(
         CASE WHEN jsonb_typeof(t.input->'topology'->'nodes') = 'number'
              THEN COALESCE((t.input->'topology'->>'nodes')::int, 0) ELSE 0 END
       ), 0)::int AS gpu_nodes
     FROM claw_tasks t, self
      WHERE t.executor = 'brain'
        AND t.status = ANY($1::text[])
        AND t.task_id <> self.task_id
        AND (t.created_at, t.task_id) < (self.created_at, self.task_id)`,
    [OCCUPYING, taskId],
  );
  const row = (r.rows[0] ?? {}) as { run_roots?: number; sandboxes?: number; gpu_nodes?: number };
  return {
    runRoots: Number(row.run_roots ?? 0),
    sandboxes: Number(row.sandboxes ?? 0),
    gpuNodes: Number(row.gpu_nodes ?? 0),
  };
}

export async function decideAdmission(ask: AdmissionAsk): Promise<AdmissionDecision> {
  const limits = envAdmitLimits();
  const treeReject = treeCapReason(ask, limits);
  if (treeReject) return { kind: "reject", reason: treeReject };

  // Every ceiling off is the default, and it is also the shape of a fleet that
  // has decided not to meter this. `loadUsage` is a full scan of the
  // non-terminal half of `claw_tasks` with four aggregates over it, and it ran
  // on every dispatch to compute numbers that nothing then compared against.
  // `hardLimitAfterInsert` already returned early on the same test.
  if (!anyCeilingSet(limits)) return { kind: "admit" };

  const usage = await loadUsage();
  const preview = decideFromUsage(usage, ask, 0, limits);
  if (preview.kind === "reject") {
    logger.info({ ...ask, ...usage, reason: preview.reason }, "admission.rejected");
    return preview;
  }
  if (preview.kind === "queue") {
    const position = (await queueLength()) + 1;
    logger.info({ ...ask, ...usage, position }, "admission.queued");
    return { kind: "queue", position };
  }
  return preview;
}

/** Whether any dimension is metered at all. A fleet with none skips the scan. */
function anyCeilingSet(limits: AdmitLimits): boolean {
  return limits.softRuns > 0 || limits.hardRuns > 0
    || limits.softSandboxes > 0 || limits.hardSandboxes > 0
    || limits.softGpuNodes > 0 || limits.hardGpuNodes > 0;
}

function treeCapReason(ask: AdmissionAsk, limits: AdmitLimits): string | null {
  if (limits.treeMaxNodes > 0 && (ask.treeNodeCount ?? 1) > limits.treeMaxNodes) {
    return "tree_nodes_exceeded";
  }
  if (limits.treeMaxDepth > 0 && (ask.treeDepth ?? 1) > limits.treeMaxDepth) {
    return "tree_depth_exceeded";
  }
  return null;
}

function firstHardRefusal(
  usage: AdmissionUsage,
  ask: AdmissionAsk,
  limits: AdmitLimits,
): string | null {
  if (overLimit(limits.hardRuns, usage.runRoots + 1)) return "runs_hard_limit";
  if (ask.wantsSandbox && overLimit(limits.hardSandboxes, usage.sandboxes + 1)) {
    return "sandboxes_hard_limit";
  }
  if (ask.gpuNodes > 0 && overLimit(limits.hardGpuNodes, usage.gpuNodes + ask.gpuNodes)) {
    return "gpu_nodes_hard_limit";
  }
  return null;
}

function firstSoftOverflow(
  usage: AdmissionUsage,
  ask: AdmissionAsk,
  limits: AdmitLimits,
): boolean {
  if (overLimit(limits.softRuns, usage.executingRoots + 1)) return true;
  if (ask.wantsSandbox && overLimit(limits.softSandboxes, usage.executingSandboxes + 1)) return true;
  if (ask.gpuNodes > 0 && overLimit(limits.softGpuNodes, usage.executingGpuNodes + ask.gpuNodes)) {
    return true;
  }
  return false;
}

function overLimit(limit: number, next: number): boolean {
  return limit > 0 && next > limit;
}

async function queueLength(): Promise<number> {
  const r = await db.query(
    `SELECT COUNT(*)::int AS n FROM claw_tasks
      WHERE status = 'queued'
        AND executor = 'brain'
        AND origin = 'chat'
        AND metadata->>'dispatch' = 'doorbell'`,
  );
  return Number(r.rows[0]?.n ?? 0);
}

export async function loadUsage(): Promise<AdmissionUsage> {
  const r = await db.query(
    `SELECT
       COUNT(DISTINCT COALESCE(dag_root_task_id, task_id))
         FILTER (WHERE status = ANY($1::text[]))::int AS run_roots,
       COUNT(DISTINCT COALESCE(dag_root_task_id, task_id))
         FILTER (WHERE status = ANY($2::text[]))::int AS executing_roots,
       COUNT(*) FILTER (
         WHERE status = ANY($1::text[])
           AND (
             sandbox_spec IS NOT NULL AND sandbox_spec::text <> '"none"'
             OR COALESCE(metadata->>'sandbox_image','') <> ''
           )
       )::int AS sandboxes,
       COUNT(*) FILTER (
         WHERE status = ANY($2::text[])
           AND (
             sandbox_spec IS NOT NULL AND sandbox_spec::text <> '"none"'
             OR COALESCE(metadata->>'sandbox_image','') <> ''
           )
       )::int AS executing_sandboxes,
       COALESCE(SUM(
         CASE
           WHEN status = ANY($1::text[])
            AND jsonb_typeof(input->'topology'->'nodes') = 'number'
           THEN COALESCE((input->'topology'->>'nodes')::int, 0)
           ELSE 0
         END
       ), 0)::int AS gpu_nodes,
       COALESCE(SUM(
         CASE
           WHEN status = ANY($2::text[])
            AND jsonb_typeof(input->'topology'->'nodes') = 'number'
           THEN COALESCE((input->'topology'->>'nodes')::int, 0)
           ELSE 0
         END
       ), 0)::int AS executing_gpu_nodes
     FROM claw_tasks
     WHERE executor = 'brain'
       AND status = ANY($1::text[])`,
    [OCCUPYING, EXECUTING],
  );
  const row = (r.rows[0] ?? {}) as {
    run_roots?: number; executing_roots?: number;
    sandboxes?: number; executing_sandboxes?: number;
    gpu_nodes?: number; executing_gpu_nodes?: number;
  };
  return {
    runRoots: Number(row.run_roots ?? 0),
    executingRoots: Number(row.executing_roots ?? 0),
    sandboxes: Number(row.sandboxes ?? 0),
    executingSandboxes: Number(row.executing_sandboxes ?? 0),
    gpuNodes: Number(row.gpu_nodes ?? 0),
    executingGpuNodes: Number(row.executing_gpu_nodes ?? 0),
  };
}
