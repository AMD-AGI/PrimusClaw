// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * DAG expander: turn a DAG template + user input into a virtual root task
 * plus one `claw_tasks` row per node plus all edges (task-design.md §6.4).
 *
 * Trust enforcement is done at admission time (`tasks/dags/admission.ts`);
 * here we just materialize the already-validated template.
 *
 * Plugin defaults (image / resources / skills / rules_text / tools_allowlist)
 * are inherited at expansion time, *not* at runtime: copies the values into
 * each `claw_tasks` row so a later plugin version bump does not affect
 * in-flight DAG instances (task-design.md §6.5.3 plugin_assets_version).
 */
import { db } from "../infra/db.js";
import type { PoolClient } from "pg";
import { insertEdge, insertTask } from "./db.js";
import { newTaskId } from "./ids.js";
import type { DagNode, NodeSandbox, TaskDagDef } from "./dags/types.js";

// The URL Brain (and other workers) should call back into for agent_done /
// event / backend-mcp. Defaults to the local API port so the dev harness
// works out of the box; production should set INTERNAL_BACKEND_URL to the
// in-cluster API service DNS.
const INTERNAL_BACKEND_URL =
  process.env.INTERNAL_BACKEND_URL || `http://127.0.0.1:${process.env.API_PORT || "8200"}`;

export interface ExpandResult {
  dag_root_task_id: string;
  task_ids: Record<string, string>;
}

interface ExpandOpts {
  session_id: string;
  user_id: string;
  workspace_id?: string;
  dag: TaskDagDef & { metadata: { derived?: { root_node_id: string; handle_last_user: Record<string, string>; schema_digest: string } } };
  plugin?: { id: number; version: string; image: string; resource: Record<string, unknown>; tools: unknown[] } | null;
  input: Record<string, unknown>;
  prompt?: string;
  batch_id?: string | null;
}

/** Kahn topo sort (task-design.md §6.4). */
function topologicalSort(nodes: DagNode[]): DagNode[] {
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const n of nodes) {
    indeg.set(n.id, n.depends_on?.length ?? 0);
    for (const d of n.depends_on ?? []) {
      adj.set(d, [...(adj.get(d) ?? []), n.id]);
    }
  }
  const ready: string[] = [];
  for (const [id, c] of indeg) if (c === 0) ready.push(id);
  const out: DagNode[] = [];
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  while (ready.length) {
    const cur = ready.shift()!;
    out.push(byId.get(cur)!);
    for (const nxt of adj.get(cur) ?? []) {
      indeg.set(nxt, (indeg.get(nxt) ?? 0) - 1);
      if (indeg.get(nxt) === 0) ready.push(nxt);
    }
  }
  return out;
}

/**
 * Render plugin defaults into the node's runtime fields. The result lands
 * straight into `claw_tasks` so the live row is fully self-describing.
 */
function applyPluginDefaults(node: DagNode, plugin: ExpandOpts["plugin"]): {
  sandbox_spec: NodeSandbox;
  tools_allowlist: unknown[];
  skills: unknown[];
  rules_text: string | null;
  agent_hooks: Record<string, unknown>;
} {
  // Sandbox handle defaults: fill image / resources from plugin row. Use `||`
  // for `image` so a plugin row with `image=""` (legacy / unset) does not leak
  // an empty string into the sandbox spec — brain would then fail to launch
  // the workload with a misleading error. Falling back to `undefined` lets the
  // sandbox layer surface a clearer "no image configured" failure.
  let sandbox: NodeSandbox = node.sandbox;
  if (typeof sandbox === "object" && "handle" in sandbox && plugin) {
    const inheritedImage = sandbox.image || plugin.image || undefined;
    sandbox = {
      ...sandbox,
      image: inheritedImage,
      resources: sandbox.resources ?? (plugin.resource as Record<string, unknown>),
    };
  }

  // Tool / skill / rule / hook inheritance only applies to mode=llm nodes.
  const tools: unknown[] = node.tools_allowlist
    ? [...node.tools_allowlist]
    : (plugin?.tools ?? [])
      .filter((t: any) => t?.type === "mcp" && (t?.config?.scope ?? "hands") === "hands")
      .map((t: any) => t.name);

  const skills = node.skills
    ? [...node.skills]
    : (plugin?.tools ?? [])
      .filter((t: any) => t?.type === "skill")
      .map((t: any) => t.name);

  let rules = node.rules_text ?? null;
  if (rules === null && plugin) {
    const ruleTexts = (plugin.tools ?? [])
      .filter((t: any) => t?.type === "rule")
      .map((t: any) => t?.config?.body ?? t?.config?.text ?? "")
      .filter((s: string) => s);
    if (ruleTexts.length) rules = ruleTexts.join("\n\n");
  }

  const agent_hooks: Record<string, unknown> = node.agent_hooks ?? {};

  return { sandbox_spec: sandbox, tools_allowlist: tools, skills, rules_text: rules, agent_hooks };
}

export async function expandDag(opts: ExpandOpts, transactionClient?: PoolClient): Promise<ExpandResult> {
  const dag = opts.dag;
  const derived = dag.metadata.derived ?? { root_node_id: "", handle_last_user: {}, schema_digest: "" };
  const rootTaskId = newTaskId();
  const taskIdMap: Record<string, string> = {};
  for (const node of dag.nodes) taskIdMap[node.id] = newTaskId();
  const client = transactionClient ?? await db.pool.connect();
  const ownsTransaction = !transactionClient;

  try {
    if (ownsTransaction) await client.query("BEGIN");
    const dagDerived: Record<string, unknown> = {};
    if (opts.plugin) {
      dagDerived.plugin_assets_version = opts.plugin.version;
      dagDerived.plugin_id = opts.plugin.id;
    }
    dagDerived.dag_id = dag.dag_id;
    dagDerived.dag_root_task_id = rootTaskId;

  // 1. Virtual DAG root (executor='dag'; never dispatched to Brain).
    await insertTask({
    task_id: rootTaskId,
    session_id: opts.session_id,
    origin: "dag_node",
    dag_id: dag.dag_id,
    dag_node_id: "__dag_root__",
    dag_root_task_id: rootTaskId,
    plugin_id: opts.plugin?.id ?? null,
    name: `${dag.name} DAG`,
    input: opts.input,
    executor: "dag",
    mode: "dag",
    sandbox_spec: "none",
    depends_on: [],
    status: "running",
    metadata: {
      derived: {
        ...dagDerived,
        root_node_id: derived.root_node_id,
        handle_last_user: derived.handle_last_user,
      },
    },
    }, client);

  // 2. Execution nodes in topological order.
    const order = topologicalSort(dag.nodes);
    for (const node of order) {
    const tid = taskIdMap[node.id];
    const inherited = applyPluginDefaults(node, opts.plugin);
    const initialStatus = node.depends_on?.length ? "waiting_deps" : "queued";
    const taskMetadata = {
      derived: {
        ...dagDerived,
        node_id: node.id,
        callback_url: `${INTERNAL_BACKEND_URL}/v1/internal/tasks/${tid}`,
        outputs_schema: node.outputs ?? [],
        on_failure: node.on_failure ?? "cascade_fail",
        wait_external_timeout_sec: node.wait_external_timeout_sec ?? 1800,
      },
    };
      await insertTask({
      task_id: tid,
      session_id: opts.session_id,
      origin: "dag_node",
      batch_id: opts.batch_id ?? null,
      dag_id: dag.dag_id,
      dag_node_id: node.id,
      dag_root_task_id: rootTaskId,
      plugin_id: opts.plugin?.id ?? null,
      name: node.name ?? node.id,
      input: opts.input,
      prompt: node.prompt ?? null,
      script: node.script ?? null,
      depends_on: (node.depends_on ?? []).map((x) => taskIdMap[x]),
      priority: node.priority ?? 0,
      executor: "brain",
      mode: node.mode,
      model: node.model ?? null,
      tools_allowlist: inherited.tools_allowlist,
      skills: inherited.skills,
      rules_text: inherited.rules_text,
      agent_hooks: inherited.agent_hooks,
      sandbox_spec: inherited.sandbox_spec,
      callback_url: `${INTERNAL_BACKEND_URL}/v1/internal/tasks/${tid}`,
      backend_mcp_url: `${INTERNAL_BACKEND_URL}/v1/internal/tasks/${tid}/backend-mcp`,
      status: initialStatus,
      metadata: taskMetadata,
      }, client);
    }

  // 3. Edges (virtual root NOT included; admission/scheduler walk
  // `claw_tasks.depends_on` for that level).
    for (const node of dag.nodes) {
      for (const dep of node.depends_on ?? []) {
        await insertEdge(rootTaskId, taskIdMap[dep], taskIdMap[node.id], client);
      }
    }

    if (ownsTransaction) await client.query("COMMIT");
    return { dag_root_task_id: rootTaskId, task_ids: { __dag_root__: rootTaskId, ...taskIdMap } };
  } catch (error) {
    if (ownsTransaction) await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    if (ownsTransaction) client.release();
  }
}

/** Convenience: single-task creation (chat / chat-with-tools path). */
export async function createSingleTask(opts: {
  session_id: string;
  plugin_id?: number | null;
  input?: Record<string, unknown>;
  prompt?: string;
  mode?: "llm" | "script";
  sandbox_spec?: unknown;
}): Promise<{ task_id: string }> {
  const tid = newTaskId();
  await insertTask({
    task_id: tid,
    session_id: opts.session_id,
    origin: "task",
    plugin_id: opts.plugin_id ?? null,
    name: opts.prompt?.slice(0, 64) ?? "task",
    input: opts.input ?? {},
    prompt: opts.prompt ?? null,
    depends_on: [],
    executor: "brain",
    mode: opts.mode ?? "llm",
    sandbox_spec: opts.sandbox_spec,
    callback_url: `${INTERNAL_BACKEND_URL}/v1/internal/tasks/${tid}`,
    backend_mcp_url: `${INTERNAL_BACKEND_URL}/v1/internal/tasks/${tid}/backend-mcp`,
    status: "queued",
    metadata: {
      derived: { callback_url: `${INTERNAL_BACKEND_URL}/v1/internal/tasks/${tid}` },
    },
  });
  return { task_id: tid };
}

// Re-exported for tests.
export { topologicalSort };
