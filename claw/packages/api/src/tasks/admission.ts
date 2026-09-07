// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Whether a new run may start, wait, or must be refused.
 *
 * Fleet-wide, not per tenant: `claw_tasks` carries no owner column. Only runs
 * are keyed by run-tree root; sandboxes and GPU nodes count per row. A zero
 * ceiling is not enforced; soft queues the row, hard rejects the create.
 */

import pino from "pino";
import type { PoolClient } from "pg";

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
import { PG_INT4_MAX } from "@claw/utils";

import { db, type StatementRunner } from "../infra/db.js";
import { metrics } from "../infra/metrics.js";
import type { ClawTaskRow } from "./types.js";

const logger = pino({ name: "admission" });

// `waiting_external` is committed: a parked row keeps its sandbox, so a ceiling
// that cannot see it meters capacity the fleet has already spent.
const OCCUPYING = [
  "queued", "preparing", "running", "cancelling", "waiting_external",
] as const;
const EXECUTING = ["preparing", "running", "cancelling"] as const;

export const ADMISSION_REJECT_REASONS = [
  "runs_hard_limit",
  "sandboxes_hard_limit",
  "gpu_nodes_hard_limit",
  "tree_nodes_exceeded",
  "tree_depth_exceeded",
] as const;

export type AdmissionRejectReason = (typeof ADMISSION_REJECT_REASONS)[number];

export type AdmissionDecision =
  | { kind: "admit" }
  | { kind: "queue"; position: number }
  | { kind: "reject"; reason: AdmissionRejectReason };

export interface AdmissionAsk {
  origin: "chat" | "task" | "dag_node" | "a2a";
  newRunRoots: 0 | 1;
  sandboxes: number;
  gpuNodes: number;
  treeRootId?: string | null;
  treeNodeCount?: number;
  treeDepth?: number;
}

/** A refusal a caller answers with, rather than throws. */
export interface AdmissionRefusal {
  admitted: false;
  reason: string;
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
 * `waiting_external` is committed but not executing; `waiting_deps` is neither,
 * or one 100-node DAG would refuse the whole fleet at creation.
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
  const hard = hardOverflow(usage, ask, limits);
  if (hard) return { kind: "reject", reason: hard };
  if (softOverflow(usage, ask, limits)) {
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
): AdmissionRejectReason | null {
  if (overLimit(limits.hardRuns, usage.runRoots)) return "runs_hard_limit";
  if (ask.sandboxes > 0 && overLimit(limits.hardSandboxes, usage.sandboxes)) {
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
  client?: StatementRunner,
  limits: AdmitLimits = envAdmitLimits(),
): Promise<AdmissionRejectReason | null> {
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
  // A veto, not a decision. A rising share of refusals landing here rather than
  // pre-insert is what creates racing for the last slot looks like.
  const reason = taskId
    ? firstAheadRefusal(await loadUsageAhead(taskId, client), ask, limits)
    : hardExceededByUsage(await loadUsage(client), ask, limits);
  if (reason) metrics.onAdmissionRejected(ask.origin, "post_insert", reason);
  return reason;
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
): AdmissionRejectReason | null {
  // `>=` rather than `>`: the ceiling counts rows, and if it is already full
  // of rows older than this one then this one is the overflow.
  if (limits.hardRuns > 0 && ahead.runRoots >= limits.hardRuns) return "runs_hard_limit";
  if (ask.sandboxes > 0 && limits.hardSandboxes > 0
      && ahead.sandboxes + ask.sandboxes > limits.hardSandboxes) {
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
export async function loadUsageAhead(
  taskId: string,
  client?: StatementRunner,
): Promise<UsageAhead> {
  const r = await (client ?? db).query(
    `WITH self AS (
       SELECT created_at, task_id FROM claw_tasks WHERE task_id = $2
     )
     SELECT
       COUNT(DISTINCT COALESCE(t.dag_root_task_id, t.task_id))::int AS run_roots,
       COUNT(*) FILTER (WHERE ${SANDBOX_ROW_SQL.replace(/\b(sandbox_spec|metadata)\b/g, "t.$1")})::int
         AS sandboxes,
       LEAST(COALESCE(SUM(
         CASE WHEN jsonb_typeof(t.input->'topology'->'nodes') = 'number'
              THEN LEAST((t.input->'topology'->>'nodes')::numeric, ${PG_INT4_MAX})
              ELSE 0 END
       ), 0), ${PG_INT4_MAX})::int AS gpu_nodes
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

/**
 * Count every terminal answer of the decision below, throws included: without an
 * error value a partial outage drops failed creates from every rollout ratio's
 * denominator, and the fleet reads healthier the worse it gets.
 */
export async function decideAdmission(
  ask: AdmissionAsk,
  client?: StatementRunner,
  limits: AdmitLimits = envAdmitLimits(),
): Promise<AdmissionDecision> {
  let decision: AdmissionDecision;
  try {
    decision = await decideAdmissionUncounted(ask, client, limits);
  } catch (err) {
    metrics.onAdmissionDecision(ask.origin, "error");
    throw err;
  }
  metrics.onAdmissionDecision(ask.origin, decision.kind);
  if (decision.kind === "reject") {
    metrics.onAdmissionRejected(ask.origin, "pre_insert", decision.reason);
  }
  return decision;
}

async function decideAdmissionUncounted(
  ask: AdmissionAsk,
  client: StatementRunner | undefined,
  limits: AdmitLimits,
): Promise<AdmissionDecision> {
  const treeReject = treeCapReason(ask, limits);
  if (treeReject) return { kind: "reject", reason: treeReject };

  // Every ceiling off is the default, and it is also the shape of a fleet that
  // has decided not to meter this. `loadUsage` is a full scan of the
  // non-terminal half of `claw_tasks` with four aggregates over it, and it ran
  // on every dispatch to compute numbers that nothing then compared against.
  // `hardLimitAfterInsert` already returned early on the same test.
  if (!anyCeilingSet(limits)) return { kind: "admit" };

  const usage = await loadUsage(client);
  const preview = decideFromUsage(usage, ask, 0, limits);
  if (preview.kind === "reject") {
    logger.info({ ...ask, ...usage, reason: preview.reason }, "admission.rejected");
    return preview;
  }
  if (preview.kind === "queue") {
    const position = (await queueLength(client)) + 1;
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

function treeCapReason(ask: AdmissionAsk, limits: AdmitLimits): AdmissionRejectReason | null {
  if (limits.treeMaxNodes > 0 && (ask.treeNodeCount ?? 1) > limits.treeMaxNodes) {
    return "tree_nodes_exceeded";
  }
  if (limits.treeMaxDepth > 0 && (ask.treeDepth ?? 1) > limits.treeMaxDepth) {
    return "tree_depth_exceeded";
  }
  return null;
}

export function hardOverflow(
  usage: AdmissionUsage,
  ask: AdmissionAsk,
  limits: AdmitLimits,
): AdmissionRejectReason | null {
  if (overLimit(limits.hardRuns, usage.runRoots + ask.newRunRoots)) return "runs_hard_limit";
  if (ask.sandboxes > 0 && overLimit(limits.hardSandboxes, usage.sandboxes + ask.sandboxes)) {
    return "sandboxes_hard_limit";
  }
  if (ask.gpuNodes > 0 && overLimit(limits.hardGpuNodes, usage.gpuNodes + ask.gpuNodes)) {
    return "gpu_nodes_hard_limit";
  }
  return null;
}

export function softOverflow(
  usage: AdmissionUsage,
  ask: AdmissionAsk,
  limits: AdmitLimits,
): boolean {
  if (overLimit(limits.softRuns, usage.executingRoots + ask.newRunRoots)) return true;
  if (ask.sandboxes > 0
      && overLimit(limits.softSandboxes, usage.executingSandboxes + ask.sandboxes)) {
    return true;
  }
  if (ask.gpuNodes > 0 && overLimit(limits.softGpuNodes, usage.executingGpuNodes + ask.gpuNodes)) {
    return true;
  }
  return false;
}

function overLimit(limit: number, next: number): boolean {
  return limit > 0 && next > limit;
}

/** Narrower than the decision's population on purpose: a chat caller's own position. */
async function queueLength(client?: StatementRunner): Promise<number> {
  const r = await (client ?? db).query(
    `SELECT COUNT(*)::int AS n FROM claw_tasks
      WHERE status = 'queued'
        AND executor = 'brain'
        AND origin = 'chat'
        AND metadata->>'dispatch' = 'doorbell'`,
  );
  return Number(r.rows[0]?.n ?? 0);
}

const SANDBOX_ROW_SQL = `sandbox_spec IS NOT NULL AND sandbox_spec::text <> '"none"'
             OR COALESCE(metadata->>'sandbox_image','') <> ''`;

/**
 * `claw_tasks.input` holds caller JSON verbatim, so `1e30` passes the type guard
 * and overflows `int4`, aborting the aggregate and refusing every later
 * admission. `COALESCE` around the `SUM` because `LEAST` ignores NULL and would
 * read an empty set as the cap.
 */
function gpuSumSql(statusParam: string): string {
  return `LEAST(COALESCE(SUM(
         CASE
           WHEN status = ANY(${statusParam}::text[])
            AND jsonb_typeof(input->'topology'->'nodes') = 'number'
           THEN LEAST((input->'topology'->>'nodes')::numeric, ${PG_INT4_MAX})
           ELSE 0
         END
       ), 0), ${PG_INT4_MAX})::int`;
}

interface UsageRow {
  run_roots?: number; executing_roots?: number;
  sandboxes?: number; executing_sandboxes?: number;
  gpu_nodes?: number; executing_gpu_nodes?: number;
}

function usageFromRow(row: UsageRow): AdmissionUsage {
  return {
    runRoots: Number(row.run_roots ?? 0),
    executingRoots: Number(row.executing_roots ?? 0),
    sandboxes: Number(row.sandboxes ?? 0),
    executingSandboxes: Number(row.executing_sandboxes ?? 0),
    gpuNodes: Number(row.gpu_nodes ?? 0),
    executingGpuNodes: Number(row.executing_gpu_nodes ?? 0),
  };
}

export async function loadUsage(client?: StatementRunner): Promise<AdmissionUsage> {
  const r = await (client ?? db).query(
    `SELECT
       COUNT(DISTINCT COALESCE(dag_root_task_id, task_id))
         FILTER (WHERE status = ANY($1::text[]))::int AS run_roots,
       COUNT(DISTINCT COALESCE(dag_root_task_id, task_id))
         FILTER (WHERE status = ANY($2::text[]))::int AS executing_roots,
       COUNT(*) FILTER (WHERE status = ANY($1::text[]) AND (${SANDBOX_ROW_SQL}))::int
         AS sandboxes,
       COUNT(*) FILTER (WHERE status = ANY($2::text[]) AND (${SANDBOX_ROW_SQL}))::int
         AS executing_sandboxes,
       ${gpuSumSql("$1")} AS gpu_nodes,
       ${gpuSumSql("$2")} AS executing_gpu_nodes
     FROM claw_tasks
     WHERE executor = 'brain'
       AND status = ANY($1::text[])`,
    [OCCUPYING, EXECUTING],
  );
  return usageFromRow((r.rows[0] ?? {}) as UsageRow);
}

/**
 * Fleet-wide serialisation of the decide-then-write critical section. Shares a
 * namespace with the ids in `infra/db.ts`; never reuse it. The ordinal recheck
 * sheds excess only when both racers see each other, which commit order
 * inverting creation order defeats.
 */
export const ADMISSION_LOCK_KEY = 8_264_179_233_003;

export function anyAdmissionCeilingSet(limits: AdmitLimits): boolean {
  return anyCeilingSet(limits) || limits.treeMaxNodes > 0 || limits.treeMaxDepth > 0;
}

/** The `soft*` half, so a hard-only fleet does no drain query. */
export function anySoftCeilingSet(limits: AdmitLimits): boolean {
  return limits.softRuns > 0 || limits.softSandboxes > 0 || limits.softGpuNodes > 0;
}

/**
 * Take the admission lock on a transaction the caller owns. Must be the first
 * statement after `BEGIN`: every path taking both this and a `claw_sessions`
 * row lock takes this one first, or two requests holding one each deadlock.
 */
export async function acquireAdmissionLock(client: StatementRunner): Promise<void> {
  if (!anyAdmissionCeilingSet(envAdmitLimits())) return;
  await client.query("SELECT pg_advisory_xact_lock($1)", [ADMISSION_LOCK_KEY]);
}

// Nothing rolls a metric back, so one emitted inside a transaction that then
// fails reports work the fleet never did.
export type AfterCommit = (effect: () => void) => void;

export const runImmediately: AfterCommit = (effect) => effect();

/**
 * Run `fn` inside a transaction holding the admission lock, and commit.
 *
 * The transaction is opened whether or not a ceiling is metered: callers write
 * a session and the row that references it under this hold, and atomicity
 * between the two cannot depend on how the fleet is configured. Only the
 * advisory lock is conditional -- an unmetered fleet serialises no decision.
 */
export async function withOwnedAdmissionLock<T>(
  fn: (client: PoolClient, afterCommit: AfterCommit) => Promise<T>,
): Promise<T> {
  const client = await db.pool.connect();
  const effects: Array<() => void> = [];
  try {
    await client.query("BEGIN");
    try {
      await acquireAdmissionLock(client);
      const result = await fn(client, (effect) => effects.push(effect));
      await client.query("COMMIT");
      for (const effect of effects) effect();
      return result;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => { /* the throw below is the report */ });
      throw err;
    }
  } finally {
    client.release();
  }
}

// Unlike {@link withOwnedAdmissionLock} the caller decides the outcome:
// `commit: false` rolls the preparation back with the refusal.
export async function withAdmissionTransaction<T>(
  fn: (client: PoolClient, afterCommit: AfterCommit) => Promise<{ commit: boolean; value: T }>,
): Promise<T> {
  const client = await db.pool.connect();
  const effects: Array<() => void> = [];
  try {
    await client.query("BEGIN");
    await acquireAdmissionLock(client);
    const { commit, value } = await fn(client, (effect) => effects.push(effect));
    await client.query(commit ? "COMMIT" : "ROLLBACK");
    if (commit) for (const effect of effects) effect();
    return value;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => { /* the throw below is the report */ });
    throw err;
  } finally {
    client.release();
  }
}

export interface UsageWithRoots {
  usage: AdmissionUsage;
  roots: Set<string>;
}

/**
 * Totals and root set from a single statement, and therefore a single snapshot.
 *
 * Two statements take two READ COMMITTED snapshots, so a root that commits its
 * terminal transition between them leaves a reduced total against a root set
 * that still lists it, and two roots are promoted where one was allowed. The
 * advisory lock does not cover it: a run finishing takes no admission lock.
 */
export async function loadUsageWithRoots(
  scope: "occupying" | "executing",
  client?: StatementRunner,
): Promise<UsageWithRoots> {
  const scopeStatuses = scope === "executing" ? EXECUTING : OCCUPYING;
  const r = await (client ?? db).query(
    `SELECT
       COUNT(DISTINCT COALESCE(dag_root_task_id, task_id))
         FILTER (WHERE status = ANY($1::text[]))::int AS run_roots,
       COUNT(DISTINCT COALESCE(dag_root_task_id, task_id))
         FILTER (WHERE status = ANY($2::text[]))::int AS executing_roots,
       COUNT(*) FILTER (WHERE status = ANY($1::text[]) AND (${SANDBOX_ROW_SQL}))::int
         AS sandboxes,
       COUNT(*) FILTER (WHERE status = ANY($2::text[]) AND (${SANDBOX_ROW_SQL}))::int
         AS executing_sandboxes,
       ${gpuSumSql("$1")} AS gpu_nodes,
       ${gpuSumSql("$2")} AS executing_gpu_nodes,
       COALESCE(
         array_agg(DISTINCT COALESCE(dag_root_task_id, task_id))
           FILTER (WHERE status = ANY($3::text[])),
         '{}'
       ) AS scope_roots
     FROM claw_tasks
     WHERE executor = 'brain'
       AND status = ANY($1::text[])`,
    [OCCUPYING, EXECUTING, scopeStatuses],
  );
  const row = (r.rows[0] ?? {}) as UsageRow & { scope_roots?: string[] };
  return { usage: usageFromRow(row), roots: new Set(row.scope_roots ?? []) };
}

/**
 * @param countedRoots the roots already counted in the set being drained; a
 *   candidate whose root is in it adds none.
 */
export function askFromRow(row: ClawTaskRow, countedRoots: Set<string>): AdmissionAsk {
  const root = row.dag_root_task_id ?? row.task_id;
  return {
    origin: row.origin ?? "task",
    newRunRoots: countedRoots.has(root) ? 0 : 1,
    sandboxes: rowWantsSandbox(row) ? 1 : 0,
    gpuNodes: rowGpuNodes(row),
  };
}

/** Mirrors `SANDBOX_ROW_SQL`, which is the count this ask is tested against. */
function rowWantsSandbox(row: ClawTaskRow): boolean {
  const spec = row.sandbox_spec;
  if (spec != null && JSON.stringify(spec) !== '"none"') return true;
  return String(row.metadata?.sandbox_image ?? "") !== "";
}

// The SQL's `jsonb_typeof(...) = 'number'` guard, in TypeScript: an ask that
// counts what the aggregate does not is an ask compared against nothing.
function rowGpuNodes(row: ClawTaskRow): number {
  const topology = (row.input as { topology?: { nodes?: unknown } } | null)?.topology;
  const nodes = topology?.nodes;
  if (typeof nodes !== "number" || !Number.isInteger(nodes) || nodes <= 0) return 0;
  return Math.min(nodes, PG_INT4_MAX);
}

/**
 * Fold an accepted candidate's demand into the running snapshot: without it a
 * batch each of whose rows fits is dispatched collectively over the ceiling.
 * Adding the root is what makes two siblings in one batch count once.
 */
export function chargeAccepted(
  usage: AdmissionUsage,
  ask: AdmissionAsk,
  root: string,
  roots: Set<string>,
): void {
  usage.runRoots += ask.newRunRoots;
  usage.executingRoots += ask.newRunRoots;
  usage.sandboxes += ask.sandboxes;
  usage.executingSandboxes += ask.sandboxes;
  usage.gpuNodes += ask.gpuNodes;
  usage.executingGpuNodes += ask.gpuNodes;
  roots.add(root);
}

export interface FillOptions<T> {
  /** One priority-ordered page, excluding the ids already passed over. */
  page: (skip: string[]) => Promise<T[]>;
  /** Whether this candidate fits; charging the snapshot is the caller's. */
  fits: (row: T) => boolean;
  /** How many rows the caller can use. */
  want: number;
  idOf: (row: T) => string;
}

/**
 * Page candidates in priority order until `want` fit or a page comes back short.
 *
 * Deliberately does not stop on a saturated dimension: demand is optional per
 * dimension, so a row asking for no sandbox fits a fleet with no sandbox
 * headroom, and a pre-limited window would never reach it.
 */
export async function fillWithinCeiling<T>(opts: FillOptions<T>): Promise<T[]> {
  const accepted: T[] = [];
  const skip: string[] = [];
  while (accepted.length < opts.want) {
    const rows = await opts.page(skip);
    if (!rows.length) break;
    for (const row of rows) {
      if (accepted.length >= opts.want) break;
      if (opts.fits(row)) accepted.push(row);
      skip.push(opts.idOf(row));
    }
    if (rows.length < opts.want) break;
  }
  return accepted;
}

/**
 * Reserve accepted rows on the transaction that counted the headroom: a commit
 * first releases the lock before the CAS, and a second connection blocks on the
 * rows this one holds.
 */
export async function reserveForExecution<T>(
  client: StatementRunner,
  accepted: readonly ClawTaskRow[],
  reserve: (row: ClawTaskRow, client: StatementRunner) => Promise<T | null>,
): Promise<T[]> {
  const reserved: T[] = [];
  for (const row of accepted) {
    const result = await reserve(row, client);
    if (result !== null) reserved.push(result);
  }
  return reserved;
}

/**
 * Whether the soft ceiling declines to hand this row to a worker right now.
 * Only a `queued` row is gated: `preparing` is already inside `EXECUTING`, so
 * blocking a re-claim would strand work a holder gave back.
 */
export async function deferQueuedBySoftCeiling(
  taskId: string,
  client?: StatementRunner,
): Promise<boolean> {
  const limits = envAdmitLimits();
  if (!anySoftCeilingSet(limits)) return false;
  const r = await (client ?? db).query(
    "SELECT * FROM claw_tasks WHERE task_id = $1 AND status = 'queued'",
    [taskId],
  );
  const row = r.rows[0] as ClawTaskRow | undefined;
  if (!row) return false;
  const { usage, roots } = await loadUsageWithRoots("executing", client);
  return softOverflow(usage, askFromRow(row, roots), limits);
}

/** The structural shape of a session tree, over `claw_sessions` alone. */
export interface SessionTreeShape {
  rootId: string;
  nodeCount: number;
  depth: number;
}

/**
 * Walk a session's tree structurally. Counting active task rows would bound
 * nothing: a caller grows past the ceiling by idling each child in turn.
 */
export async function sessionTreeShape(
  sessionId: string,
  client?: StatementRunner,
): Promise<SessionTreeShape> {
  const r = await (client ?? db).query(
    `WITH RECURSIVE up AS (
       SELECT session_id, parent_session_id, 1 AS depth
         FROM claw_sessions WHERE session_id = $1 AND deleted_at IS NULL
       UNION ALL
       SELECT p.session_id, p.parent_session_id, up.depth + 1
         FROM claw_sessions p JOIN up ON p.session_id = up.parent_session_id
        WHERE p.deleted_at IS NULL
     ),
     top AS (SELECT session_id, depth FROM up ORDER BY depth DESC LIMIT 1),
     down AS (
       SELECT session_id FROM top
       UNION ALL
       SELECT c.session_id
         FROM claw_sessions c JOIN down ON c.parent_session_id = down.session_id
        WHERE c.deleted_at IS NULL
     )
     SELECT (SELECT session_id FROM top) AS root_id,
            (SELECT depth FROM top) AS depth,
            (SELECT COUNT(*)::int FROM down) AS node_count`,
    [sessionId],
  );
  const row = (r.rows[0] ?? {}) as { root_id?: string; depth?: number; node_count?: number };
  return {
    rootId: row.root_id ?? sessionId,
    nodeCount: Number(row.node_count ?? 1),
    depth: Number(row.depth ?? 1),
  };
}
