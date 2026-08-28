// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Two-layer template rendering (task-design.md §6.5).
 *
 * Layer A (Backend, this file): runs at `queued → preparing`. Expands
 *   - ${task.*}, ${session.*}, ${batch.*}
 *   - ${task.metadata.derived.<key>}
 *   - ${<upstream_node_id>.{output|captures.<k>|metadata.<k>|artifacts}}
 *   results are written back to `claw_tasks.prompt` / `.script` /
 *   `.sandbox_spec` and embedded into the `ExecuteRequest` sent to Brain.
 *
 * Layer B (Brain, `brain/src/tasks/script-runner.ts`): runs per-step. Expands
 *   - ${captures.<k>}, ${prev.captures.<k>}, ${prev.stdout}
 *
 * Backend MUST NOT touch the Brain-layer expressions; we copy them through
 * verbatim. Brain MUST NOT touch ours either (they are already resolved
 * when the ExecuteRequest arrives).
 */
import { db } from "../infra/db.js";

const NON_NODE_ROOTS = new Set(["task", "session", "batch", "captures", "prev", "input", "user"]);
const BRAIN_LAYER_ROOTS = new Set(["captures", "prev"]);

interface TaskLite {
  task_id: string;
  session_id: string;
  dag_root_task_id: string | null;
  dag_node_id: string | null;
  input: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

interface UpstreamLite {
  task_id: string;
  dag_node_id: string;
  output: string | null;
  captures: Record<string, string>;
  metadata: Record<string, unknown>;
  artifacts: unknown[];
}

interface SessionLite {
  session_id: string;
  user_id: string | null;
  workspace_id: string | null;
}

export interface RenderContext {
  task: TaskLite;
  session: SessionLite;
  batch: { batch_id: string | null; task_ids?: Record<string, string> };
  upstreams: Record<string, UpstreamLite>;
}

/** Render every Backend-layer `${...}` placeholder inside `value`. */
export function renderBackendTemplates(value: unknown, ctx: RenderContext): unknown {
  if (typeof value === "string") return renderString(value, ctx);
  if (Array.isArray(value)) return value.map((v) => renderBackendTemplates(v, ctx));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = renderBackendTemplates(v, ctx);
    return out;
  }
  return value;
}

function renderString(s: string, ctx: RenderContext): string {
  return s.replace(/\$\{([^}]+)\}/g, (raw, expr: string) => {
    const path = expr.trim();
    const dot = path.indexOf(".");
    if (dot < 0) return raw; // not a path; leave literal
    const root = path.slice(0, dot);
    const rest = path.slice(dot + 1);

    // Brain-layer expressions: leave them untouched.
    if (BRAIN_LAYER_ROOTS.has(root)) return raw;

    const resolved = resolveBackendPath(root, rest, ctx);
    if (resolved === undefined) {
      throw new Error(`template '${raw}' could not be resolved at backend stage`);
    }
    return typeof resolved === "string" ? resolved : JSON.stringify(resolved);
  });
}

function resolveBackendPath(root: string, rest: string, ctx: RenderContext): unknown {
  if (root === "task") {
    if (rest === "task_id") return ctx.task.task_id;
    if (rest === "session_id") return ctx.task.session_id;
    if (rest === "dag_root_task_id") return ctx.task.dag_root_task_id;
    if (rest === "dag_node_id") return ctx.task.dag_node_id;
    if (rest.startsWith("input.")) return getDeep(ctx.task.input, rest.slice("input.".length).split("."));
    if (rest.startsWith("metadata.")) return getDeep(ctx.task.metadata, rest.slice("metadata.".length).split("."));
    return undefined;
  }
  if (root === "session") {
    if (rest === "user_id") return ctx.session.user_id ?? "";
    if (rest === "workspace_id") return ctx.session.workspace_id ?? "";
    return undefined;
  }
  if (root === "batch") {
    if (rest === "batch_id") return ctx.batch.batch_id ?? "";
    if (rest === "task_ids") return ctx.batch.task_ids ?? {};
    return undefined;
  }
  if (NON_NODE_ROOTS.has(root)) return undefined;

  const up = ctx.upstreams[root];
  if (!up) return undefined;
  if (rest === "output") return up.output ?? "";
  if (rest === "artifacts") return up.artifacts;
  if (rest.startsWith("captures.")) {
    const tail = rest.slice("captures.".length);
    const captures = up.captures ?? {};
    // Direct hit (capture name with no nested access).
    if (Object.prototype.hasOwnProperty.call(captures, tail)) return captures[tail];
    // Nested access: try the longest matching capture key, then dig into the
    // parsed JSON value if present. Lets DAG authors write
    // `${node.captures.prompt.s3_asset_url}` when `build_prompt` captures
    // structured JSON under `prompt`.
    const parts = tail.split(".");
    for (let i = parts.length - 1; i >= 1; i--) {
      const head = parts.slice(0, i).join(".");
      const raw = captures[head];
      if (typeof raw !== "string") continue;
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { continue; }
      const deep = getDeep(parsed, parts.slice(i));
      if (deep !== undefined) return deep;
    }
    return undefined;
  }
  if (rest.startsWith("metadata.")) return getDeep(up.metadata, rest.slice("metadata.".length).split("."));
  return undefined;
}

function getDeep(obj: unknown, parts: string[]): unknown {
  let cur: unknown = obj;
  for (const p of parts) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

/**
 * Build a {@link RenderContext} for the given task. Walks each upstream
 * dependency by `claw_tasks.depends_on` so the renderer can resolve
 * `${<node>.captures.X}` even when the upstream finished long ago.
 */
export async function buildRenderContext(taskId: string): Promise<RenderContext> {
  // `claw_sessions` does not have a dedicated workspace_id column in the
  // canonical schema; defensive deployments stash it under
  // `claw_sessions.config.workspace_id` (string). We select user_id +
  // config and unpack workspace_id from JSONB.
  const r = await db.query(
    `SELECT t.task_id, t.session_id, t.dag_root_task_id, t.dag_node_id,
            t.input, t.metadata, t.depends_on, t.batch_id,
            s.user_id, s.config AS session_config
     FROM claw_tasks t
     LEFT JOIN claw_sessions s ON s.session_id = t.session_id
     WHERE t.task_id = $1`,
    [taskId],
  );
  if (r.rowCount === 0) throw new Error(`task ${taskId} not found`);
  const row = r.rows[0] as {
    task_id: string;
    session_id: string;
    dag_root_task_id: string | null;
    dag_node_id: string | null;
    input: Record<string, unknown>;
    metadata: Record<string, unknown>;
    depends_on: string[];
    batch_id: string | null;
    user_id: string | null;
    session_config: Record<string, unknown> | null;
  };
  const sessionCfg = (row.session_config ?? {}) as Record<string, unknown>;
  const workspaceId = typeof sessionCfg.workspace_id === "string" ? sessionCfg.workspace_id : null;

  // Pull *every* task in the same DAG instance keyed by dag_node_id. The
  // direct-deps query previously here missed ancestors (e.g. authoring -> 
  // hydrate_benchmark -> pre_task), so `${pre_task.captures.X}` from
  // authoring failed admission. Admission already enforces ancestry, so
  // exposing the whole DAG here only widens the visible set in a safe
  // direction.
  const ups: Record<string, UpstreamLite> = {};
  if (row.dag_root_task_id) {
    const upR = await db.query(
      `SELECT task_id, dag_node_id, output, captures, metadata, artifacts
         FROM claw_tasks
        WHERE dag_root_task_id = $1
          AND dag_node_id IS NOT NULL
          AND dag_node_id <> '__dag_root__'
          AND task_id <> $2`,
      [row.dag_root_task_id, row.task_id],
    );
    for (const ur of upR.rows) {
      const u = ur as UpstreamLite;
      if (u.dag_node_id) ups[u.dag_node_id] = u;
    }
  }

  return {
    task: {
      task_id: row.task_id,
      session_id: row.session_id,
      dag_root_task_id: row.dag_root_task_id,
      dag_node_id: row.dag_node_id,
      input: row.input ?? {},
      metadata: row.metadata ?? {},
    },
    session: {
      session_id: row.session_id,
      user_id: row.user_id,
      workspace_id: workspaceId,
    },
    batch: { batch_id: row.batch_id },
    upstreams: ups,
  };
}
