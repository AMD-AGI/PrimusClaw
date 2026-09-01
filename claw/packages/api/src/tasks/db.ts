// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Thin DB helpers for `claw_tasks` / `claw_task_edges` / `claw_batches`.
 * No business logic; scheduler / dispatcher / sweeper consume these.
 */
import { db } from "../infra/db.js";
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
       CASE WHEN $26::text IN ('queued','preparing') THEN NOW() END,
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
 * Transition a task into the given terminal / non-terminal status. The
 * `expected` filter avoids races where two workers try to flip the same row.
 */
export async function transitionStatus(
  taskId: string,
  expected: TaskStatus[],
  next: TaskStatus,
  extra: Record<string, unknown> = {},
): Promise<ClawTaskRow | null> {
  const sets: string[] = ["status = $1"];
  const values: unknown[] = [next];
  let i = 2;
  for (const [k, v] of Object.entries(extra)) {
    sets.push(`${k} = $${i++}`);
    values.push(v);
  }
  // `waiting_external` re-stamps for the same reason `queued` does: the column
  // is "waiting since", and the reaper that reads it next measures from here.
  //
  // Without this, `reapWaitExternal` counts a row's external-call budget from
  // the moment the row was created. That was invisible while `insertTask` left
  // `queued_at` null -- these rows simply never matched -- and became reachable
  // when the insert started stamping it for the doorbell queue. A task that
  // runs for forty minutes and then makes its first external call was failed as
  // `external_timeout` the instant it parked, having waited no time at all.
  if (next === "queued" || next === "waiting_external") sets.push("queued_at = NOW()");
  if (next === "preparing" || next === "running") {
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
  if (next === "completed" || next === "failed" || next === "cancelled") {
    sets.push("completed_at = NOW()");
  }
  values.push(taskId);
  values.push(expected);
  const r = await db.query(
    `UPDATE claw_tasks SET ${sets.join(", ")}
     WHERE task_id = $${i++} AND status = ANY($${i})
     RETURNING *`,
    values,
  );
  return (r.rowCount ?? 0) > 0 ? (r.rows[0] as ClawTaskRow) : null;
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
