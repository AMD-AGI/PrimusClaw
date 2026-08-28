// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `claw_tasks` row shape -- matches `db.ts` column list one-to-one.
 *
 * JSONB columns are typed loosely (`Record<string, unknown>` / `unknown[]`)
 * because PostgreSQL hands them to us already-parsed; the callers cast to
 * a tighter type at use-site.
 */
export type TaskStatus =
  | "waiting_deps"
  | "waiting_external"
  | "queued"
  | "preparing"
  | "running"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled";

export interface ClawTaskRow {
  task_id: string;
  session_id: string;
  parent_task_id: string | null;
  batch_id: string | null;
  dag_id: string | null;
  dag_node_id: string | null;
  dag_root_task_id: string | null;
  plugin_id: number | null;
  name: string;
  input: Record<string, unknown>;
  prompt: string | null;
  script: unknown[] | null;
  depends_on: string[];
  priority: number;
  executor: string;
  mode: string;
  model: string | null;
  tools_allowlist: unknown[];
  skills: unknown[];
  rules_text: string | null;
  agent_hooks: Record<string, unknown>;
  sandbox_spec: unknown;
  callback_url: string | null;
  backend_mcp_url: string | null;
  internal_token_hash: string | null;
  brain_id: string | null;
  sandbox_workload_id: string | null;
  status: TaskStatus;
  failure_reason: string | null;
  error_message: string | null;
  output: string | null;
  artifacts: unknown[];
  captures: Record<string, string>;
  tool_stats: Record<string, unknown> | null;
  token_usage: Record<string, unknown> | null;
  turns: number | null;
  metadata: Record<string, unknown>;
  /** What produced this run. Null on rows that predate the column. */
  origin: "chat" | "task" | "dag_node" | null;
  created_at: string;
  queued_at: string | null;
  started_at: string | null;
  /** When this run's active budget runs out. Null on rows that predate the column. */
  deadline_at: string | null;
  completed_at: string | null;
  /** How many times a worker has claimed this doorbell row. */
  claim_count?: number;
}

/** Failure reason vocabulary recognised across the system (task-design.md §5). */
export type FailureReason =
  | "deps_failed"
  | "external_timeout"
  | "sandbox_create_failed"
  | "sandbox_died"
  | "sandbox_handle_missing"
  | "brain_timeout"
  | "agent_error"
  // No agent ran: the run could not be told which files it writes, so it was
  // refused rather than dispatched onto a gate key that lets siblings over one
  // directory overwrite each other. Distinct from `agent_error` because the
  // cause is on this side and the remedy is different.
  | "workspace_bind_failed"
  | "script_step_failed"
  | "dag_validation_failed"
  /** Holder settled a claimed doorbell without completing it (`term()`, not a deleted session). */
  | "claim_abandoned"
  /** Claimed chat run that promised a workspace binding and did not have one. */
  | "workspace_unbound"
  | string; // plugin-defined codes are also accepted
