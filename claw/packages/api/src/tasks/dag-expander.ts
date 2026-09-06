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
import {
  acquireAdmissionLock, decideAdmission, type AdmissionAsk, type AdmissionRefusal,
} from "./admission.js";
import { insertEdge, insertTask } from "./db.js";
import { newTaskId } from "./ids.js";
import { gpuNodesFromSpec, topologyErrors } from "./run-spec.js";
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

/** A declared topology the boundary refused, answered as 400 rather than 429. */
export interface TopologyRefusal {
  admitted: false;
  invalidTopology: string[];
}

/**
 * Why a creation helper wrote nothing.
 *
 * Two arms because the caller owes two different answers: a malformed
 * declaration is the request's fault and a full fleet is not.
 */
export type CreateRefusal = AdmissionRefusal | TopologyRefusal;

export function isCreateRefusal(
  result: object,
): result is CreateRefusal {
  return (result as { admitted?: unknown }).admitted === false;
}

export function isTopologyRefusal(refusal: CreateRefusal): refusal is TopologyRefusal {
  return "invalidTopology" in refusal;
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

/** Node count and longest `depends_on` path, folded over the sort already taken. */
export function dagShape(order: readonly DagNode[]): { nodeCount: number; depth: number } {
  const depthOf = new Map<string, number>();
  let deepest = 0;
  for (const node of order) {
    let longestDep = 0;
    for (const dep of node.depends_on ?? []) longestDep = Math.max(longestDep, depthOf.get(dep) ?? 0);
    const depth = longestDep + 1;
    depthOf.set(node.id, depth);
    if (depth > deepest) deepest = depth;
  }
  return { nodeCount: order.length, depth: deepest };
}

/**
 * What the nodes born `queued` will hold, which is not what the graph will.
 *
 * Only the entry set is charged: every other node is born `waiting_deps`, holds
 * nothing for as long as it waits, and is charged again at its own promotion.
 * Charging the whole graph here would refuse a valid sequential DAG against
 * capacity it never consumes, and charge it twice.
 */
export function dagResourceAsk(
  entryNodes: readonly DagNode[],
  plugin: ExpandOpts["plugin"],
  input: Record<string, unknown>,
): { sandboxes: number; gpuNodes: number } {
  let sandboxes = 0;
  for (const node of entryNodes) {
    const spec = applyPluginDefaults(node, plugin).sandbox_spec;
    if (spec != null && JSON.stringify(spec) !== '"none"') sandboxes++;
  }
  // Every node row carries `opts.input` verbatim, so each contributes the same
  // figure the aggregate reads back off it.
  return { sandboxes, gpuNodes: gpuNodesFromSpec(input) * entryNodes.length };
}

async function admitDagExpansion(
  opts: ExpandOpts,
  order: readonly DagNode[],
  client: PoolClient,
): Promise<AdmissionRefusal | null> {
  const shape = dagShape(order);
  const entryNodes = order.filter((node) => !node.depends_on?.length);
  const ask: AdmissionAsk = {
    origin: "dag_node",
    newRunRoots: 1,
    ...dagResourceAsk(entryNodes, opts.plugin, opts.input),
    treeNodeCount: shape.nodeCount,
    treeDepth: shape.depth,
  };
  const decision = await decideAdmission(ask, client);
  return decision.kind === "reject" ? { admitted: false, reason: decision.reason } : null;
}

interface DagIds {
  rootTaskId: string;
  taskIdMap: Record<string, string>;
  order: readonly DagNode[];
}

async function materializeDag(opts: ExpandOpts, ids: DagIds, client: PoolClient): Promise<void> {
  const dag = opts.dag;
  const derived = dag.metadata.derived ?? { root_node_id: "", handle_last_user: {}, schema_digest: "" };
  const { rootTaskId, taskIdMap } = ids;
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
  for (const node of ids.order) {
    const tid = taskIdMap[node.id];
    const inherited = applyPluginDefaults(node, opts.plugin);
    const initialStatus = node.depends_on?.length ? "waiting_deps" : "queued";
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
      // Node overrides DAG; neither set means the workspace is published as usual.
      workspace_throwaway: node.workspace_throwaway ?? dag.workspace_throwaway ?? false,
      tools_allowlist: inherited.tools_allowlist,
      skills: inherited.skills,
      rules_text: inherited.rules_text,
      agent_hooks: inherited.agent_hooks,
      sandbox_spec: inherited.sandbox_spec,
      callback_url: `${INTERNAL_BACKEND_URL}/v1/internal/tasks/${tid}`,
      backend_mcp_url: `${INTERNAL_BACKEND_URL}/v1/internal/tasks/${tid}/backend-mcp`,
      status: initialStatus,
      metadata: {
        derived: {
          ...dagDerived,
          node_id: node.id,
          callback_url: `${INTERNAL_BACKEND_URL}/v1/internal/tasks/${tid}`,
          outputs_schema: node.outputs ?? [],
          on_failure: node.on_failure ?? "cascade_fail",
          wait_external_timeout_sec: node.wait_external_timeout_sec ?? 1800,
        },
      },
    }, client);
  }

  // 3. Edges (virtual root NOT included; admission/scheduler walk
  // `claw_tasks.depends_on` for that level).
  for (const node of dag.nodes) {
    for (const dep of node.depends_on ?? []) {
      await insertEdge(rootTaskId, taskIdMap[dep], taskIdMap[node.id], client);
    }
  }
}

/**
 * Admit a graph and write it, or write nothing and say why.
 *
 * The lock is this transaction's first statement, so the decision and the
 * inserts it was made against cannot be interleaved with another expansion's.
 * A caller-supplied client already holds it; the acquisition is re-entrant.
 */
export async function expandDag(
  opts: ExpandOpts,
  transactionClient?: PoolClient,
): Promise<ExpandResult | CreateRefusal> {
  const invalid = topologyErrors(opts.input);
  if (invalid) return { admitted: false, invalidTopology: invalid };

  const dag = opts.dag;
  const rootTaskId = newTaskId();
  const taskIdMap: Record<string, string> = {};
  for (const node of dag.nodes) taskIdMap[node.id] = newTaskId();
  const order = topologicalSort(dag.nodes);
  const client = transactionClient ?? await db.pool.connect();
  const ownsTransaction = !transactionClient;

  try {
    if (ownsTransaction) await client.query("BEGIN");
    await acquireAdmissionLock(client);
    const refusal = await admitDagExpansion(opts, order, client);
    if (refusal) {
      if (ownsTransaction) await client.query("ROLLBACK");
      return refusal;
    }
    await materializeDag(opts, { rootTaskId, taskIdMap, order }, client);
    if (ownsTransaction) await client.query("COMMIT");
    return { dag_root_task_id: rootTaskId, task_ids: { __dag_root__: rootTaskId, ...taskIdMap } };
  } catch (error) {
    if (ownsTransaction) await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    if (ownsTransaction) client.release();
  }
}

/**
 * Single-task creation (chat / chat-with-tools path), gated like every other.
 *
 * A single task is a tree of one, so it carries no tree fields: `treeCapReason`
 * already reads an absent count as one. The lock is acquired on the client the
 * caller handed over, which owns the transaction the refusal rolls back.
 */
export async function createSingleTask(opts: {
  session_id: string;
  plugin_id?: number | null;
  input?: Record<string, unknown>;
  prompt?: string;
  mode?: "llm" | "script";
  sandbox_spec?: unknown;
  workspace_throwaway?: boolean;
}, client?: PoolClient): Promise<{ task_id: string } | CreateRefusal> {
  const input = opts.input ?? {};
  const invalid = topologyErrors(input);
  if (invalid) return { admitted: false, invalidTopology: invalid };

  await acquireAdmissionLock(client ?? db);
  const ask: AdmissionAsk = {
    origin: "task",
    newRunRoots: 1,
    sandboxes: opts.sandbox_spec != null && JSON.stringify(opts.sandbox_spec) !== '"none"' ? 1 : 0,
    gpuNodes: gpuNodesFromSpec(input),
  };
  const decision = await decideAdmission(ask, client ?? db);
  if (decision.kind === "reject") return { admitted: false, reason: decision.reason };

  const tid = newTaskId();
  await insertTask({
    task_id: tid,
    session_id: opts.session_id,
    origin: "task",
    plugin_id: opts.plugin_id ?? null,
    name: opts.prompt?.slice(0, 64) ?? "task",
    input,
    prompt: opts.prompt ?? null,
    depends_on: [],
    executor: "brain",
    mode: opts.mode ?? "llm",
    workspace_throwaway: opts.workspace_throwaway ?? false,
    sandbox_spec: opts.sandbox_spec,
    callback_url: `${INTERNAL_BACKEND_URL}/v1/internal/tasks/${tid}`,
    backend_mcp_url: `${INTERNAL_BACKEND_URL}/v1/internal/tasks/${tid}/backend-mcp`,
    status: "queued",
    metadata: {
      derived: { callback_url: `${INTERNAL_BACKEND_URL}/v1/internal/tasks/${tid}` },
    },
  }, client);
  return { task_id: tid };
}

// Re-exported for tests.
export { topologicalSort };
