// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Thin DB helpers for `claw_tasks` / `claw_task_edges` / `claw_batches`.
 * No business logic; scheduler / dispatcher / sweeper consume these.
 */
import { db, type Querier } from "../infra/db.js";
import type { PoolClient } from "pg";
import type { ClawTaskRow, TaskStatus } from "./types.js";
import {
  deadlineAtInsertSql, deadlineStampSql, RUN_BUDGET_DEFAULT_SEC, type RunOrigin,
} from "./run-budget.js";

export async function getTask(taskId: string): Promise<ClawTaskRow | null> {
  const r = await db.query(`SELECT * FROM claw_tasks WHERE task_id = $1`, [taskId]);
  return (r.rowCount ?? 0) > 0 ? (r.rows[0] as ClawTaskRow) : null;
}

export async function listTasksByDag(dagRootTaskId: string): Promise<ClawTaskRow[]> {
  const r = await db.query(
    `SELECT * FROM claw_tasks WHERE dag_root_task_id = $1 ORDER BY created_at ASC`,
    [dagRootTaskId],
  );
  return r.rows as ClawTaskRow[];
}

export interface InsertTaskParams {
  task_id: string;
  session_id: string;
  parent_task_id?: string | null;
  batch_id?: string | null;
  dag_id?: string | null;
  dag_node_id?: string | null;
  dag_root_task_id?: string | null;
  plugin_id?: number | null;
  name: string;
  input?: Record<string, unknown>;
  prompt?: string | null;
  script?: unknown[] | null;
  depends_on?: string[];
  priority?: number;
  executor?: string;
  mode?: string;
  model?: string | null;
  tools_allowlist?: unknown[];
  skills?: unknown[];
  rules_text?: string | null;
  agent_hooks?: Record<string, unknown>;
  sandbox_spec?: unknown;
  callback_url?: string | null;
  backend_mcp_url?: string | null;
  internal_token_hash?: string | null;
  status: TaskStatus;
  metadata?: Record<string, unknown>;
  /** What produced this run. See {@link RunOrigin}. */
  origin?: RunOrigin;
  /** Which workspace the run's files live in, so ownership is recorded not guessed. */
  workspace_id?: string | null;
  workspace_throwaway?: boolean;
}

/**
 * Write a new task row.
 *
 * A row inserted at `preparing` gets `started_at` and `deadline_at` here,
 * because that status means the execution message is going out now and nothing
 * will transition the row into it later -- so the stamps `transitionStatus`
 * would have applied never happen, and every rule keyed on those columns skips
 * the row silently. That is the shape a fat chat run has.
 *
 * A doorbell opens at `queued` and must not take an execution deadline yet:
 * queue wait is judged from `queued_at` + `RUN_QUEUE_MAX_SEC`, and claim
 * stamps `deadline_at` when a worker actually starts.
 *
 * Only `preparing` gets `started_at`. The virtual DAG root is inserted at
 * `running` and is never dispatched to a worker (`executor='dag'`);
 * `reapStuckDagRoots` judges it against its children. Giving it a `started_at`
 * would also offer it to the stale reaper's never-claimed arm, which would
 * close a healthy graph an hour in.
 */
export async function insertTask(
  p: InsertTaskParams,
  client?: PoolClient,
): Promise<ClawTaskRow> {
  const r = await (client ?? db).query(
    `INSERT INTO claw_tasks (
       task_id, session_id, parent_task_id, batch_id,
       dag_id, dag_node_id, dag_root_task_id, plugin_id,
       name, input, prompt, script, depends_on, priority,
       executor, mode, model, tools_allowlist, skills, rules_text, agent_hooks,
       sandbox_spec, callback_url, backend_mcp_url, internal_token_hash,
       status, metadata, origin, workspace_id, workspace_throwaway, queued_at, started_at, deadline_at
     ) VALUES (
       $1, $2, $3, $4,
       $5, $6, $7, $8,
       $9, $10::jsonb, $11, $12::jsonb, $13, $14,
       $15, $16, $17, $18::jsonb, $19::jsonb, $20, $21::jsonb,
       $22::jsonb, $23, $24, $25,
       $26, $27::jsonb, $28, $29, $32,
       CASE WHEN $26::text IN ('queued','preparing') THEN clock_timestamp() END,
       CASE WHEN $26::text = 'preparing' THEN NOW() END,
       CASE WHEN $26::text = 'preparing' THEN ${deadlineAtInsertSql({
         metadataParam: 27, originParam: 28, dagRootParam: 7, chatParam: 30, dagParam: 31,
       })} END
     ) RETURNING *`,
    [
      p.task_id,
      p.session_id,
      p.parent_task_id ?? null,
      p.batch_id ?? null,
      p.dag_id ?? null,
      p.dag_node_id ?? null,
      p.dag_root_task_id ?? null,
      p.plugin_id ?? null,
      p.name,
      JSON.stringify(p.input ?? {}),
      p.prompt ?? null,
      p.script === undefined ? null : JSON.stringify(p.script),
      p.depends_on ?? [],
      p.priority ?? 0,
      p.executor ?? "brain",
      p.mode ?? "llm",
      p.model ?? null,
      JSON.stringify(p.tools_allowlist ?? []),
      JSON.stringify(p.skills ?? []),
      p.rules_text ?? null,
      JSON.stringify(p.agent_hooks ?? {}),
      p.sandbox_spec === undefined ? null : JSON.stringify(p.sandbox_spec),
      p.callback_url ?? null,
      p.backend_mcp_url ?? null,
      p.internal_token_hash ?? null,
      p.status,
      JSON.stringify(p.metadata ?? {}),
      p.origin ?? null,
      p.workspace_id ?? null,
      RUN_BUDGET_DEFAULT_SEC.chat,
      RUN_BUDGET_DEFAULT_SEC.dag_node,
      p.workspace_throwaway ?? false,
    ],
  );
  return r.rows[0] as ClawTaskRow;
}

export async function insertEdge(
  dagRootTaskId: string,
  fromTaskId: string,
  toTaskId: string,
  client?: PoolClient,
): Promise<void> {
  await (client ?? db).query(
    `INSERT INTO claw_task_edges (dag_root_task_id, from_task_id, to_task_id)
     VALUES ($1, $2, $3) ON CONFLICT (from_task_id, to_task_id) DO NOTHING`,
    [dagRootTaskId, fromTaskId, toTaskId],
  );
}

/**
 * Patch task fields. JSON fields are stringified by the caller.
 *
 * Not a way to change `status`. Every status change has to be a compare-and-set
 * against the statuses it is legal to arrive from, because more than one actor
 * can be touching a row at once -- a sweeper deciding it is stale, a late
 * `agent_done` from a run that has since been cancelled, a redelivered
 * execution message. An unconditional write from here would win those races
 * silently and, being unconditional, would also skip the timestamps and the
 * deadline that a transition is supposed to stamp alongside the status.
 *
 * No caller passes one today. The throw is here so that the first one to try
 * finds out immediately rather than by way of a row that went backwards.
 */
export async function updateTask(
  taskId: string,
  patch: Record<string, unknown>,
): Promise<ClawTaskRow | null> {
  if ("status" in patch) {
    throw new Error(
      "updateTask cannot write status; use transitionStatus so the change is a CAS",
    );
  }
  const keys = Object.keys(patch);
  if (keys.length === 0) return getTask(taskId);
  const sets: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  for (const k of keys) {
    values.push(patch[k]);
    sets.push(`${k} = $${i++}`);
  }
  values.push(taskId);
  const r = await db.query(
    `UPDATE claw_tasks SET ${sets.join(", ")} WHERE task_id = $${i} RETURNING *`,
    values,
  );
  return (r.rowCount ?? 0) > 0 ? (r.rows[0] as ClawTaskRow) : null;
}

/**
 * Every SET expression reads the pre-UPDATE row, so this banks the segment the
 * re-stamp beside it erases, the `queued -> queued` requeue included. And
 * `clock_timestamp()`: a transaction that opened before the row was queued would
 * measure a negative interval and clamp a real wait to nothing.
 */
const QUEUE_ACCRUAL_SQL = `queued_ms_accrued = queued_ms_accrued
      + CASE WHEN status = 'queued'
             THEN GREATEST(0, EXTRACT(EPOCH FROM (clock_timestamp() - queued_at)) * 1000)::bigint
             ELSE 0 END`;

/** A status, or the expression a reaper picks one with per row: splitting such
 *  a reaper into two passes would let a row move between them. */
export type NextStatus = TaskStatus | { sql: string; terminal: true };

// Written as a literal rather than bound, so the statement stays greppable;
// checked at runtime because a literal is only safe while it is one of these.
const WRITABLE_STATUSES = new Set<string>([
  "waiting_deps", "waiting_external", "queued", "preparing", "running",
  "cancelling", "completed", "failed", "cancelled",
]);

export interface StatusTransition {
  expected?: TaskStatus[];
  /** `metadata` is merged into rather than replacing what the row holds. */
  extra?: Record<string, unknown>;
  /** Raw SET fragments, for assignments a column/value pair cannot express.
   *  Their `$n` placeholders index `params`, exactly as `where`'s do. */
  setSql?: string[];
  /** Replaces the `task_id = $n` match entirely, for the cascades that move many
   *  rows. Spliced verbatim: it carries its own parameters via `params`. */
  where?: string;
  params?: unknown[];
  query?: Querier;
  returning?: string;
}

/**
 * The one statement in this codebase that writes `claw_tasks.status`, because
 * the accrual above rides on every status change: a writer issuing its own
 * UPDATE silently drops that run's queued segment.
 */
export async function applyTaskStatusTransition(
  next: NextStatus,
  opts: StatusTransition = {},
): Promise<ClawTaskRow[]> {
  const chosen = typeof next === "string" ? next : null;
  if (chosen && !WRITABLE_STATUSES.has(chosen)) {
    throw new Error(`applyTaskStatusTransition: refusing unknown status '${chosen}'`);
  }
  const statusSql = chosen ? `'${chosen}'` : (next as { sql: string }).sql;
  const sets: string[] = [QUEUE_ACCRUAL_SQL];
  const values: unknown[] = [];
  let i = 1;
  for (const [k, v] of Object.entries(opts.extra ?? {})) {
    sets.push(k === "metadata"
      ? `metadata = COALESCE(metadata, '{}'::jsonb) || $${i++}::jsonb`
      : `${k} = $${i++}`);
    values.push(v);
  }
  // `waiting_external` re-stamps for the same reason `queued` does: the column
  // is "waiting since", and the reaper that reads it next measures from here.
  if (chosen === "queued" || chosen === "waiting_external") {
    sets.push("queued_at = clock_timestamp()");
  }
  if (chosen === "preparing" || chosen === "running") {
    // COALESCE for the same reason as the deadline below: a row passes through
    // preparing on its way to running, and `started_at` is meant to be when
    // work on it began, not when it last changed status. Overwriting it would
    // also hand the sweeper's legacy `started_at + timeout` fallback a fresh
    // clock every transition.
    sets.push("started_at = COALESCE(started_at, NOW())");
    // Stamped in the same statement as started_at, so the budget cannot drift
    // from the moment the run actually began burning. COALESCE inside the SQL
    // keeps preparing → running from handing out a second budget.
    sets.push(deadlineStampSql(i, i + 1));
    values.push(RUN_BUDGET_DEFAULT_SEC.chat, RUN_BUDGET_DEFAULT_SEC.dag_node);
    i += 2;
  }
  if (!chosen || chosen === "completed" || chosen === "failed" || chosen === "cancelled") {
    sets.push("completed_at = NOW()");
  }
  const query = opts.query ?? db.query;
  // Caller-supplied SQL numbers its parameters from 1; they land after this
  // function's own, so both fragments are shifted by the same offset.
  const shift = (sql: string) => sql.replace(/\$(\d+)/g, (_m, n) => `$${Number(n) + i - 1}`);
  sets.push(...(opts.setSql ?? []).map(shift));
  const returning = `*${opts.returning ? `, ${opts.returning}` : ""}`;
  if (opts.where) {
    const r = await query(
      `UPDATE claw_tasks SET status = ${statusSql}, ${sets.join(", ")}`
      + ` WHERE ${shift(opts.where)} RETURNING ${returning}`,
      [...values, ...(opts.params ?? [])],
    );
    return r.rows as ClawTaskRow[];
  }
  const [taskId] = opts.params ?? [];
  values.push(taskId);
  const idParam = i++;
  const predicate = opts.expected
    ? `task_id = $${idParam} AND status = ANY($${i})`
    : `task_id = $${idParam}`;
  if (opts.expected) values.push(opts.expected);
  const r = await query(
    `UPDATE claw_tasks SET status = ${statusSql}, ${sets.join(", ")}`
    + ` WHERE ${predicate} RETURNING ${returning}`,
    values,
  );
  return r.rows as ClawTaskRow[];
}

/** The single-row form. `expected` is the CAS two workers race through. */
export async function transitionStatus(
  taskId: string,
  expected: TaskStatus[],
  next: TaskStatus,
  extra: Record<string, unknown> = {},
  query: Querier = db.query,
): Promise<ClawTaskRow | null> {
  const rows = await applyTaskStatusTransition(next, {
    expected, extra, params: [taskId], query,
  });
  return rows[0] ?? null;
}

/** Find tasks that depend on `taskId` (forward edges). */
export async function listDownstream(taskId: string): Promise<string[]> {
  const r = await db.query(
    `SELECT to_task_id FROM claw_task_edges WHERE from_task_id = $1`,
    [taskId],
  );
  return r.rows.map((row: { to_task_id: string }) => row.to_task_id);
}

export async function readyToQueue(taskId: string): Promise<boolean> {
  const r = await db.query(
    `SELECT t.depends_on FROM claw_tasks t WHERE t.task_id = $1`,
    [taskId],
  );
  if (r.rowCount === 0) return false;
  const deps = (r.rows[0].depends_on as string[]) ?? [];
  if (deps.length === 0) return true;
  const completed = await db.query(
    `SELECT COUNT(*)::int AS c FROM claw_tasks WHERE task_id = ANY($1) AND status = 'completed'`,
    [deps],
  );
  return Number(completed.rows[0].c) === deps.length;
}

export async function listExecutionPeers(dagRootTaskId: string): Promise<ClawTaskRow[]> {
  const r = await db.query(
    `SELECT * FROM claw_tasks WHERE dag_root_task_id = $1 AND dag_node_id <> '__dag_root__'`,
    [dagRootTaskId],
  );
  return r.rows as ClawTaskRow[];
}
