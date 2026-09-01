// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Task DAG template shape (task-design.md §6.3).
 *
 * A DAG template is an immutable, versioned spec uploaded once via
 * `POST /v1/task-dags`. The shape captured here is the *stored* form,
 * which is identical to what `validateDag` consumes plus a derived
 * `metadata.derived` block we attach during admission.
 */

export type TrustLevel = "platform" | "user";
export type NodeMode = "llm" | "script";
export type OnFailure = "cascade_fail" | "skip" | "stop_dag";
export type ScriptOnFail = "abort" | "continue" | "wait_external";

/** Inline `sandbox` field on a DAG node. */
export type NodeSandbox =
  | "none"
  | NodeSandboxCreate
  | NodeSandboxUse;

export interface NodeSandboxCreate {
  handle: string;
  image?: string;
  resources?: Record<string, unknown>;
  image_digest_allowlist?: string[];
  env?: Record<string, string>;
  labels?: Record<string, string>;
  ttl_sec?: number;
  timeout?: number;
}

export interface NodeSandboxUse {
  use: string;
}

export interface ScriptStepDef {
  name: string;
  arguments?: Record<string, unknown>;
  timeout_sec?: number;
  on_fail?: ScriptOnFail;
  captures?: string;
  /**
   * Bounded repetition of this step. Mirrors `ScriptRepeat` in the protocol
   * package -- the two types describe the same JSON and are checked against each
   * other by admission, so a field added to one and not the other is a step that
   * validates here and means something else at dispatch.
   */
  repeat?: {
    until: { path: string; equals: string | number | boolean };
    max_attempts: number;
    max_seconds: number;
    interval_sec?: number;
  };
}

export interface DagNode {
  id: string;
  name?: string;
  depends_on?: string[];
  priority?: number;
  executor: "brain";
  mode: NodeMode;
  prompt?: string;
  skills?: string[];
  rules_text?: string;
  tools_allowlist?: string[];
  agent_hooks?: Record<string, unknown>;
  model?: string;
  max_turns?: number;
  script?: ScriptStepDef[];
  sandbox: NodeSandbox;
  outputs?: string[];
  on_failure?: OnFailure;
  wait_external_timeout_sec?: number;
  /**
   * This node's workspace is throwaway: skip the post-run upload to S3.
   * Falls back to the DAG-level flag when unset; false when neither is set.
   */
  workspace_throwaway?: boolean;
}

export interface BatchAggregator {
  /**
   * Optional `dag_id` to spawn after every task in the batch reaches a
   * terminal state. Aggregator DAG receives `input = { batch_id, summary }`.
   */
  dag_id?: string;
  /**
   * Soft cap on per-batch parallel running tasks. Scheduler honours this
   * even when the global quota allows more.
   */
  max_parallel?: number;
}

export interface TaskDagDef {
  dag_id: string;
  name: string;
  version?: string;
  description?: string;
  plugin_id?: number | null;
  trust_level?: TrustLevel;
  input_schema?: Record<string, unknown>;
  nodes: DagNode[];
  /**
   * Default for every node's `workspace_throwaway`. Declared here because a DAG
   * whose nodes share one sandbox shares one workspace: opting a single node out
   * saves nothing if the next node uploads the same tree.
   */
  workspace_throwaway?: boolean;
  batch_aggregator?: BatchAggregator | null;
  metadata?: Record<string, unknown>;
  owner_user_id?: string | null;
  is_public?: boolean;
  status?: "active" | "deprecated" | "deleted";
}

/** Derived block we persist on `claw_task_dags.metadata.derived`. */
export interface DagDerived {
  root_node_id: string;
  /** node_id -> handle_name owned by this node (one entry per declared handle). */
  handle_last_user: Record<string, string>;
  /** sha256 hex digest over `nodes` JSONB; used for client-side cache busting. */
  schema_digest: string;
}
