// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { EnvironmentTopology } from "./topology.js";

/** Conversation message for LLM API. */
export interface Message {
  role: "user" | "assistant" | "system";
  content: string | Array<Record<string, unknown>>;
}

/**
 * Task execution mode (see task-design.md §7).
 *
 *   - "llm"    classic agent loop driven by an LLM
 *   - "script" predefined tool sequence, no LLM invocations
 *
 * Note: the virtual DAG root row uses `mode='dag'` at the DB layer but is never
 * dispatched to Brain, so we do not list it here.
 */
export type TaskMode = "llm" | "script";

/**
 * Sandbox specification rendered by Backend Dispatcher and shipped to Brain
 * verbatim (task-design.md §9.3). Brain never queries plugin tables to derive
 * image / resources / handle relationships -- everything lives in this struct.
 *
 *   - "none"        no sandbox; only backend-scope tools are callable
 *   - {handle, ...} create a fresh sandbox and register it under `handle`
 *                   in `DagHandleMap[dag_root_task_id]`
 *   - {use}         reuse an upstream sandbox previously registered as `use`
 */
export type SandboxSpec =
  | "none"
  | SandboxSpecCreate
  | SandboxSpecUse;

export interface SandboxSpecCreate {
  /** Logical name used to register the sandbox in DagHandleMap. */
  handle: string;
  /** Container image (already resolved to a concrete tag by Backend). */
  image: string;
  /** k8s-style resource requests: amd.com/gpu / cpu / memory / ephemeral-storage. */
  resources?: Record<string, string>;
  /** Optional sha256 allow-list; only honoured for platform-trust DAGs. */
  image_digest_allowlist?: string[];
  /** Sandbox idle TTL hint forwarded to SaFE. */
  ttl_sec?: number;
  /**
   * Max wall-clock RUNNING lifetime of the workload, in seconds, forwarded to
   * SaFE. This is the running budget ONLY: SaFE counts it from Status.StartTime,
   * which it writes when the workload LEAVES the Pending queue and starts running
   * (not at dispatch — the workload is still Pending when marked dispatched, and
   * StartTime is set later, once it actually starts). So time spent Pending
   * waiting for resources is never charged against it. The Pending/queue wait is
   * bounded separately by SANDBOX_PENDING_TIMEOUT_SECONDS (Brain config), which
   * fails the message with reason `sandbox_pending_timeout` if it never starts.
   */
  timeout?: number;
  /** Extra env vars baked into the sandbox at create time. */
  env?: Record<string, string>;
  /** Extra labels merged into the SaFE workload (Sweeper consistency keys). */
  labels?: Record<string, string>;
}

export interface SandboxSpecUse {
  /** Name of an existing sandbox handle in DagHandleMap (created by upstream). */
  use: string;
}

/**
 * A single step in `mode=script` execution (task-design.md §7.3).
 *
 * `arguments` may contain `${captures.X}` / `${prev.captures.X}` runtime
 * template references that Brain expands on the fly with the in-memory
 * `captures` map; all other `${...}` placeholders are expanded by Backend
 * at dispatch time and arrive as literals.
 */
export interface ScriptStep {
  /** Tool name registered in the `tools` table. */
  name: string;
  arguments?: Record<string, unknown>;
  /** Per-step soft timeout in seconds; defaults to 300 when omitted. */
  timeout_sec?: number;
  /**
   * Behaviour when this step throws or returns `{error: ...}`:
   *
   *   - "abort"          (default) terminate the task with `script_step_failed`
   *   - "continue"       record the error and proceed to next step
   *   - "wait_external"  pause the task in `waiting_external`; ExternalResolver
   *                      will resume the entire script from step 0 once the
   *                      external prerequisite reports back
   */
  on_fail?: "abort" | "continue" | "wait_external";
  /**
   * When set, the step's `stdout` (or full structured result when no stdout)
   * is written to `captures[<value>]` for downstream steps and the
   * `claw_tasks.captures` JSON column at agent_done time.
   */
  captures?: string;
  /**
   * Dispatch scope resolved by Backend admission at upsert / dispatch time.
   * Defaults to "hands" when omitted. Brain's script-runner uses this to
   * pick between the Hands MCP client and the Backend MCP HTTP RPC client
   * (task-design.md §8.2).
   */
  scope?: "hands" | "backend";
  /**
   * Run this step repeatedly until it reports done, or the bound runs out.
   *
   * A modifier on an ordinary step, deliberately, rather than a step kind of its
   * own that wraps a body. `name` stays a registered tool, so every check that
   * already reads it keeps working: DAG admission resolves the tool's scope
   * against `sandbox='none'` and refuses a backend-scope tool without
   * `trust_level='platform'`, and both of those walk the top-level array only. A
   * nested body would have slipped past both, which is a hole rather than a
   * feature to add carefully later.
   *
   * It also means the executor stays a flat loop over one array, and the runtime
   * template pass keeps rendering exactly `arguments` -- a nested body's
   * `${captures.x}` would never have been expanded, since nothing renders below
   * the top level.
   *
   * What it exists for: a run whose work outlives any single call. `wait` blocks
   * on a background shell for up to WAIT_MAX_SEC and then says the shell is still
   * running, expecting to be called again -- an agent loops, a script could not.
   * Hands work is measured in hours to days, and the per-call ceiling is there to
   * stop a half-dead sandbox holding a run open, not to bound the work.
   */
  repeat?: ScriptRepeat;
}

/**
 * When to stop repeating a step.
 *
 * Both bounds are required and neither may be unbounded. An unbounded loop in a
 * script is precisely the hang the per-call ceiling exists to prevent, and a
 * script -- unlike an agent -- has no judgement to fall back on.
 */
export interface ScriptRepeat {
  /**
   * The structured field that says the work is finished, and the value that says
   * so. `wait` reports `{ finished: true }` when its shell has exited.
   *
   * One path and one equality, not an expression language: a condition a reader
   * has to evaluate in their head is one that fails in a way nobody predicted, at
   * hour nine of a run.
   */
  until: { path: string; equals: string | number | boolean };
  /** Hard stop on attempts. The step is executed at most this many times. */
  max_attempts: number;
  /**
   * Hard stop on elapsed wall time across all attempts, in seconds.
   *
   * Separate from `max_attempts` because they bound different failures: a step
   * that returns instantly burns the attempts and stops in seconds, and one that
   * blocks for its full timeout every time needs an hour ceiling rather than an
   * attempt count nobody can convert into one.
   */
  max_seconds: number;
  /** Pause between attempts, in seconds. Defaults to none: `wait` blocks already. */
  interval_sec?: number;
}

/** Lease renewal endpoint for a run that has a row of its own. */
export interface RunLease {
  /** Full URL, so Brain needs no knowledge of how the API is addressed. */
  url: string;
  /** Bearer token scoped to this run; the same per-run token the callbacks use. */
  token: string;
}

/** What a run is doing right now, as reported with each lease renewal. */
export type RunPhase = "executing" | "waiting";

/** Why a run is not executing. Waits are the whole reason A2 exists. */
export type RunWaitReason = "approval" | "background_command";

/** Brain task execution request (Backend Dispatcher → Brain HTTP). */
export interface ExecuteRequest {
  // ── Task identity ─────────────────────────────────────────────────────
  /** Required for task-system dispatch (Phase 4+); legacy chat path leaves this undefined and engines fall back to `session_id`/`message_id` for log correlation. */
  task_id?: string;
  session_id: string;
  /** Idempotency key for engine-level deduplication. */
  message_id?: string;

  // ── DAG context (absent for single-task / chat) ───────────────────────
  dag_id?: string;
  dag_node_id?: string;
  dag_root_task_id?: string;

  // ── Backend callback wiring (Phase 4+; absent for legacy chat) ────────
  /** `POST {callback_url}/agent_done` + `/event` accept Brain → Backend results. */
  callback_url?: string;
  /** Backend-side MCP JSON-RPC endpoint (scope=backend tools). */
  backend_mcp_url?: string;
  /** Bearer token Brain must send to `backend_mcp_url` and `callback_url`. */
  backend_internal_token?: string;

  /**
   * Where to renew this run's lease while it executes.
   *
   * A run's row is the authoritative record of whether it is still alive, and
   * a lease is how the row learns that: the worker renews it every few
   * seconds, and a lease that stops being renewed means the worker is gone —
   * knowable in seconds instead of waiting out a queue redelivery budget or an
   * hour-long timeout. Deliberately separate from `callback_url`, which drives
   * the run's status and triggers scheduling; renewing a lease says only that
   * a worker is still there.
   *
   * Absent for runs dispatched before this existed, and for anything without a
   * row of its own. Absent means no heartbeat, which is exactly the old
   * behaviour.
   */
  run_lease?: RunLease;

  /**
   * The workspace this run's files belong to.
   *
   * Distinct from `workspace_id`, which is the SaFE namespace the sandbox is
   * created in -- an unfortunate collision of names for two unrelated things.
   * This one identifies the files: what is restored into /workspace, synced
   * back out, and collected when nothing needs it any more.
   *
   * Absent for runs dispatched before workspaces had rows.
   */
  files_workspace_id?: string;

  /**
   * Whether the dispatcher promises that `files_workspace_id` is set.
   *
   * Exists to separate two situations a worker otherwise cannot tell apart,
   * which matters because it refuses to run in one of them and must not
   * refuse in the other:
   *
   *   - a message published by an API that predates workspace rows, so the
   *     field was never going to be there;
   *   - a message from an API that knows about workspaces and failed to bind
   *     one, which means the concurrency gate would silently fall back to a
   *     key that lets two runs write the same directory.
   *
   * Both look identical -- an absent id -- so without this flag a worker
   * either tolerates the second (silent corruption) or refuses the first
   * (every run fails until the rollout finishes). Set unconditionally by any
   * API that binds workspaces; absent means the old, tolerated case.
   */
  files_workspace_required?: boolean;

  // ── Execution mode ────────────────────────────────────────────────────
  /** Defaults to "llm" when omitted (legacy chat path). */
  mode?: TaskMode;

  // ── Run budget ────────────────────────────────────────────────────────
  /**
   * ISO timestamp at which this run's active budget is exhausted, stamped by
   * the API when the task entered `preparing`.
   *
   * Brain stops itself on this and reports a terminal result, so a run that
   * outlasts its budget ends with a stated reason instead of being marked
   * failed in the database by a sweeper that cannot reach the process. Absent
   * on the legacy chat path and on rows dispatched before the column existed;
   * absent means no self-imposed limit, and the sweeper's older
   * `started_at + BRAIN_TASK_TIMEOUT_SEC` rule remains the only ceiling.
   */
  deadline_at?: string;

  // ── Sandbox provisioning (data-driven) ────────────────────────────────
  /** Rendered sandbox spec; Brain decides ensure/use/none from this field alone. Legacy chat path leaves this undefined and ships top-level `sandbox_image` / `resources` instead; Phase 4 collapses both into this single field. */
  sandbox_spec?: SandboxSpec;
  /** SaFE workspace id (== Kubernetes namespace) for SaFE workload create. */
  workspace_id?: string;
  /** SaFE platform API key for this user; Brain calls SaFE on behalf of user. */
  platform_key?: string;

  // ── Legacy chat fields (Phase 4 removes; do not use in new task code) ─
  /** @deprecated Use `sandbox_spec.image`. Kept for legacy chat NATS path. */
  sandbox_image?: string;
  /** @deprecated Use `sandbox_spec.resources`. Kept for legacy chat NATS path. */
  resources?: Record<string, unknown>;
  /**
   * @deprecated Use `sandbox_spec.timeout`. Kept for legacy chat NATS path.
   * Same semantics: the sandbox's max RUNNING lifetime (seconds), excluding the
   * Pending/queue wait (that is bounded by SANDBOX_PENDING_TIMEOUT_SECONDS).
   */
  timeout?: number;

  // ── mode=llm payload ──────────────────────────────────────────────────
  prompt?: string;
  history?: Message[];
  system_append?: string;
  rules_text?: string;
  model?: string;
  max_turns?: number;
  llm_api_key?: string;
  /** Per-user environment variables snapshot at message creation time; Brain merges this into the sandbox podSpec.env after CLAW / SaFE / system env layers, validated against `isUserEnvKeyAllowed` on both ends (API write + Brain merge). */
  user_env?: Record<string, string>;
  /** Per-session (request-level) environment variables from the POST body; highest precedence in the sandbox env merge chain, validated against `isUserEnvKeyAllowed`. */
  session_env?: Record<string, string>;
  /** Local + marketplace skills available to this task; `files` holds optional sub-files (relative path -> content) under references/, templates/, scripts/, assets/, materialized onto the sandbox fs alongside SKILL.md. */
  skills?: Record<string, {
    content: string;
    enabled: boolean;
    version?: number;
    description?: string;
    files?: Array<{ path: string; content: string; is_binary?: boolean }>;
  }>;
  /** AgentHooks attached to this task (see brain/src/agent/hooks.ts). */
  hooks?: {
    pre?: Array<{ type: "tool"; name: string; args: Record<string, unknown> }>;
    post?: Array<{ type: "tool"; name: string; args: Record<string, unknown> }>;
  };

  /**
   * This run's workspace is throwaway: do not upload it when the run ends.
   *
   * Off by default, and deliberately per-task rather than per-mode. With
   * `WORKSPACE_PERSIST_BASE` unset -- the default in code and in the shipped Helm
   * values alike -- S3 is the only durable copy of a workspace, so opting out
   * means the next sandbox in this session rehydrates without these files and the
   * file browser shows nothing for the run. That is right for a task that has
   * already delivered its output somewhere else and wrong for almost everything
   * else, which is why it is a declaration rather than a default.
   *
   * The immediate case: a long-running job uploads its own report to a presigned
   * URL of its own, so syncing the whole tree afterwards copies gigabytes a second
   * time to a prefix nobody reads.
   *
   * Note it also skips the prune, so files this run deleted stay in S3 and come
   * back on the next rehydrate. For a throwaway workspace that is nothing; for
   * anything else it is the second reason not to set this.
   */
  workspace_throwaway?: boolean;

  // ── mode=script payload ───────────────────────────────────────────────
  script?: ScriptStep[];

  // ── Tool / plugin enrichment ──────────────────────────────────────────
  /** Marketplace plugin row id this task originated from. */
  plugin_id?: number;
  /** Same `tools` array as GET /v1/plugins/:pluginId (`formatPluginRow` with enrichRefs); null when plugin missing or access denied. */
  plugin_tools?: unknown[] | null;
  /** Tool name allow-list applied on top of plugin_tools (script-mode hardening). */
  tools_allowlist?: string[];
  /** Pass-through MCP server configs (resolved at admission time). */
  mcp_servers?: Record<string, Record<string, unknown>>;

  // ── Environment topology ──────────────────────────────────────────────
  /**
   * What this run needs beyond a sandbox: node count, per-node shape, backend.
   *
   * The declaration Brain prefers over the the dispatcher flags in the prompt (see
   * protocol/topology.ts). Absent means "read the prompt", which is what every
   * caller did before this field existed.
   */
  topology?: EnvironmentTopology;

  // ── Identity / auth ───────────────────────────────────────────────────
  user_id?: string;
  /** Selected tool ids forwarded to engines (mode=llm). */
  tool_ids?: number[];
  /** Hands sidecar URL when sandbox already exists out-of-band (legacy chat). */
  hands_mcp_url?: string;
  /** Parent session ID for agent team topology. */
  parent_session_id?: string;
  /** Role name within the agent team (e.g. "researcher", "coder"). */
  team_role?: string;
}

/** Token usage accumulated across agent loop turns. */
export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_create: number;
  turns: number;
}

/** Pending memory entry from save_memory tool (Brain → API via exec_complete). */
export interface PendingMemory {
  category: string;
  content: string;
  importance: number;
}

/** Pending skill entry from save_skill tool (Brain → API via exec_complete). */
export interface PendingSkill {
  skill_name: string;
  content: string;
  description?: string;
  /** Optional sub-files passed in one call (rare — usually added separately). */
  files?: Array<{ path: string; content: string; is_binary?: boolean }>;
}

/** Sub-file mutation from add_skill_file / update_skill_file / remove_skill_file tools. */
export interface PendingSkillFileMutation {
  action: "add" | "update" | "remove";
  skill_name: string;
  file_path: string;
  /** Required for add / update; ignored for remove. */
  content?: string;
  is_binary?: boolean;
}

/** Tool call statistics from agent loop. */
export interface ToolStats {
  total_calls: number;
  error_calls: number;
  by_tool: Record<string, number>;
}

/** Artifact emitted by an executed Task (uploaded blob reference). */
export interface Artifact {
  /** Relative path inside the sandbox workspace (or logical name). */
  path: string;
  /** Resolved URL (e.g. s3:// or signed http) where the blob lives. */
  url?: string;
  content_type?: string;
  size_bytes?: number;
  sha256?: string;
}

/**
 * Reason a Brain execution stopped, reported to Backend via `agent_done`.
 *
 *   - completed              normal termination (mode=llm Stop / mode=script done)
 *   - max_turns              mode=llm hit turn budget
 *   - cancelled              Backend issued cancel during execution
 *   - error                  unrecoverable exception
 *   - wait_external          mode=script step requested wait_external resolution
 *   - script_pre_hook_blocked AgentHook PreToolUse blocked a script step
 *   - script_step_failed     mode=script step threw and on_fail=abort
 */
export type AbortReason =
  | "completed"
  | "max_turns"
  | "cancelled"
  | "error"
  | "wait_external"
  | "script_pre_hook_blocked"
  | "script_step_failed";

/**
 * What the platform said about a run's sandbox ending, read from SaFE at the
 * moment the sandbox was found dead.
 *
 * Carried on the result rather than resolved later because it is perishable:
 * SaFE serves a pod's account of its own ending from the pod, and a reclaimed
 * node's pods are collected within minutes.
 */
export interface ExecutePlatformFacts {
  /** Verbatim `pods[].failedMessage` -- `pod.status.reason + ", " + message`. */
  message: string;
  node: string;
  exitCode: number | null;
  /** `state.terminated.reason`; the only place an OOM is stated. */
  containerReason: string;
}

export interface ExecuteResult {
  finalText: string;
  /** Absent when nothing counted it: a run stopped before any turn anywhere
   *  finished has no usage to report, and a zero there is indistinguishable
   *  from a turn that really spent nothing. `applyAgentDone` stores this in
   *  `claw_tasks.token_usage`, where the difference is a NULL against a row
   *  that claims the run used no tokens. */
  tokenUsage?: TokenUsage;
  turns: number;
  /**
   * Absent unless the platform ended this run's sandbox and said why. An absence
   * means nothing was read, never "the platform had no reason" -- the callback
   * only writes these fields when they are present, so an absence leaves a row
   * that an earlier attempt filled alone.
   */
  platformFacts?: ExecutePlatformFacts;
  pendingMemories: PendingMemory[];
  pendingSkills: PendingSkill[];
  /** Sub-file mutations queued by add/update/remove_skill_file tool calls. */
  pendingSkillFileMutations?: PendingSkillFileMutation[];
  skillsUsed: Record<string, number>;
  errorCount: number;
  /** Absent for the same reason as `tokenUsage`, and stored the same way in
   *  `claw_tasks.tool_stats`. */
  toolStats?: ToolStats;
  elapsedMs: number;
  /** mode=script captures collected across the run, written to `claw_tasks.captures`. */
  captures?: Record<string, string>;
  /** mode=script declared outputs uploaded out-of-band (artifact references). */
  artifacts?: Artifact[];
  /** Set when the engine ended in a non-`completed` state. */
  abortReason?: AbortReason;
  /** Free-form error explanation when `abortReason` is `error` / `wait_external` / ... */
  failureReason?: string;
  /** Carried through for wait_external resume: which step name caused the wait. */
  waitExternalId?: string;
}

/** Tool schema for LLM API (Claude format). */
export interface ToolSchema {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface UserInfo {
  userId: string;
  userName: string;
  roles: string[];
  platformKey: string;
  virtualKey: string;
}

export type EventCallback = (payload: Record<string, unknown>) => void | Promise<void>;
