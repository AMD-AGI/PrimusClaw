// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * DAG admission: structural + semantic validation that runs on
 * `POST /v1/task-dags` before persisting the template (task-design.md §6.3.1).
 *
 * Every check that fails throws a `DagAdmissionError`; the route layer maps
 * those to HTTP 400 / 403. On success we return a `DagDerived` block the
 * caller will store under `claw_task_dags.metadata.derived`.
 *
 * Validation steps (in execution order):
 *
 *   1. Structural: node ids unique, depends_on references resolved,
 *      acyclic, exactly one root, executor === 'brain'.
 *   2. Handles: every `sandbox.handle` declared once, every `sandbox.use`
 *      points to a declared handle that is an *ancestor* of the using
 *      node (so the handle KV entry definitely exists at runtime).
 *   3. mode/sandbox combo: mode='llm' requires a sandbox; mode='script'
 *      requires its tools' scope to match `sandbox` (backend-scope tools
 *      may run with `sandbox='none'`).
 *   4. Trust: GPU resources, image_digest_allowlist, and backend-scope
 *      tool references all require `trust_level === 'platform'`.
 *   5. Template references: collect every `${a.b.c}` from prompt /
 *      script.arguments / sandbox and check ancestry + outputs whitelist.
 *   6. Derive: root_node_id, handle_last_user, schema_digest.
 */
import { createHash } from "node:crypto";
import { db } from "../../infra/db.js";
import { BadRequestError } from "../../shared/errors.js";
import { backendMcpRegistry } from "../../backend-mcp/registry.js";
import type {
  DagDerived,
  DagNode,
  NodeSandboxCreate,
  NodeSandboxUse,
  ScriptStepDef,
  TaskDagDef,
} from "./types.js";

/**
 * Hands-side builtin tools always available; not in the `tools` table.
 *
 * `wait` and `log_s3_upload_manifest` were missing, and `wait` is the tool the
 * repeat/until step exists to drive -- so the very pattern this admission code
 * validates the bounds of was rejected one check earlier as an unknown tool.
 * The list is duplicated from brain's HANDS_TOOLS by necessity (the API cannot
 * import from brain), which is exactly how it fell behind; anything added
 * there has to be added here.
 */
const HANDS_BUILTIN_TOOLS = new Set([
  "read", "write", "edit", "multi_edit", "bash", "glob", "grep", "ls",
  "notebook_edit", "upload_to_s3", "download_from_s3", "bash_output", "kill_shell",
  "wait", "log_s3_upload_manifest",
]);

export interface ToolMeta {
  scope: "hands" | "backend";
  type: string;
}

/** Tools table accessor used for global scope lookup. */
async function lookupGlobalTool(name: string): Promise<ToolMeta | null> {
  const r = await db.query(
    "SELECT type, config FROM tools WHERE name = $1 AND deleted_at IS NULL AND status = 'active' ORDER BY id DESC LIMIT 1",
    [name],
  );
  if (r.rowCount === 0) return null;
  const row = r.rows[0] as { type: string; config: { scope?: string } | null };
  const scope = row.config?.scope === "backend" ? "backend" : "hands";
  return { scope, type: row.type };
}

/** Plugin-scoped tool lookup: `plugins.tools` is an array of tool descriptors. */
async function lookupPluginTool(name: string, pluginId: number): Promise<ToolMeta | null> {
  const r = await db.query("SELECT tools FROM plugins WHERE id = $1 AND deleted_at IS NULL", [pluginId]);
  if (r.rowCount === 0) return null;
  const tools = r.rows[0].tools;
  if (!Array.isArray(tools)) return null;
  for (const raw of tools) {
    if (!raw || typeof raw !== "object") continue;
    const t = raw as Record<string, unknown>;
    if (String(t.name ?? "") !== name) continue;
    const cfg = (t.config && typeof t.config === "object") ? t.config as Record<string, unknown> : {};
    const scope = cfg.scope === "backend" ? "backend" : "hands";
    return { scope, type: String(t.type ?? "mcp") };
  }
  return null;
}

/**
 * R-6 tool meta lookup order: builtin → backend-side MCP registry →
 * plugin.tools → global tools. Throws on unknown so admission fails closed.
 *
 * The Backend-side MCP registry is process-local (tools register themselves
 * at module load), so platform-trusted DAGs can reference them without an
 * extra `tools` row.
 */
export async function resolveToolMeta(name: string, pluginId: number | null | undefined): Promise<ToolMeta> {
  if (HANDS_BUILTIN_TOOLS.has(name)) return { scope: "hands", type: "builtin" };
  if (backendMcpRegistry.has(name)) return { scope: "backend", type: "mcp" };
  if (pluginId) {
    const m = await lookupPluginTool(name, pluginId);
    if (m) return m;
  }
  const g = await lookupGlobalTool(name);
  if (g) return g;
  throw new BadRequestError(`unknown tool: ${name}`);
}

function hasCycle(nodes: DagNode[]): boolean {
  // Kahn's algorithm: cycle iff some node remains unprocessed.
  const incoming = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const n of nodes) {
    incoming.set(n.id, n.depends_on?.length ?? 0);
    for (const d of n.depends_on ?? []) {
      adj.set(d, [...(adj.get(d) ?? []), n.id]);
    }
  }
  const queue: string[] = [];
  for (const [id, c] of incoming) if (c === 0) queue.push(id);
  let processed = 0;
  while (queue.length) {
    const cur = queue.shift()!;
    processed++;
    for (const nxt of adj.get(cur) ?? []) {
      incoming.set(nxt, (incoming.get(nxt) ?? 0) - 1);
      if (incoming.get(nxt) === 0) queue.push(nxt);
    }
  }
  return processed !== nodes.length;
}

/** Map<node_id, Set<ancestor_node_id>> via transitive closure on depends_on. */
function computeAncestors(nodes: DagNode[]): Map<string, Set<string>> {
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const cache = new Map<string, Set<string>>();
  function dfs(id: string): Set<string> {
    if (cache.has(id)) return cache.get(id)!;
    const acc = new Set<string>();
    const node = byId.get(id);
    if (!node) return acc;
    for (const dep of node.depends_on ?? []) {
      acc.add(dep);
      for (const a of dfs(dep)) acc.add(a);
    }
    cache.set(id, acc);
    return acc;
  }
  for (const n of nodes) dfs(n.id);
  return cache;
}

interface TemplateRef {
  upstream: string;
  path: string;
  /** Raw `${...}` expression, for error messages. */
  raw: string;
}

/** Extract every `${a.b.c}` token from a JSON-encodable value. */
function collectRefsFromValue(value: unknown, into: TemplateRef[]): void {
  if (typeof value === "string") {
    const re = /\$\{([^}]+)\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(value)) !== null) {
      const expr = m[1].trim();
      const dot = expr.indexOf(".");
      if (dot < 0) continue;
      into.push({ upstream: expr.slice(0, dot), path: expr.slice(dot + 1), raw: m[0] });
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectRefsFromValue(v, into);
    return;
  }
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) collectRefsFromValue(v, into);
  }
}

function collectTemplateRefs(node: DagNode): TemplateRef[] {
  const refs: TemplateRef[] = [];
  if (node.prompt) collectRefsFromValue(node.prompt, refs);
  if (node.script) collectRefsFromValue(node.script, refs);
  collectRefsFromValue(node.sandbox, refs);
  return refs;
}

/** Non-node template root names: skipped during outputs check. */
const NON_NODE_ROOTS = new Set(["task", "session", "batch", "prev", "captures", "input", "user"]);

/**
 * Walk the DAG in reverse-topological order over each declared handle's
 * users; the last referencing node is responsible for cleanup. The current
 * implementation: for every handle name, find the topologically *latest*
 * node that names it (create or use). That node id becomes `handle_last_user[handle]`.
 */
function computeHandleLastUser(nodes: DagNode[]): Record<string, string> {
  // Topo order via Kahn.
  const order: string[] = [];
  const incoming = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const n of nodes) {
    incoming.set(n.id, n.depends_on?.length ?? 0);
    for (const d of n.depends_on ?? []) {
      adj.set(d, [...(adj.get(d) ?? []), n.id]);
    }
  }
  const queue: string[] = [];
  for (const [id, c] of incoming) if (c === 0) queue.push(id);
  while (queue.length) {
    const cur = queue.shift()!;
    order.push(cur);
    for (const nxt of adj.get(cur) ?? []) {
      incoming.set(nxt, (incoming.get(nxt) ?? 0) - 1);
      if (incoming.get(nxt) === 0) queue.push(nxt);
    }
  }
  const byId = new Map(nodes.map((n) => [n.id, n] as const));
  const lastUser: Record<string, string> = {};
  for (const id of order) {
    const n = byId.get(id);
    if (!n) continue;
    const handle = handleNameOf(n);
    if (!handle) continue;
    lastUser[handle] = n.id;
  }
  return lastUser;
}

function handleNameOf(n: DagNode): string | null {
  if (n.sandbox === "none") return null;
  if (typeof n.sandbox === "object" && "handle" in n.sandbox) return (n.sandbox as NodeSandboxCreate).handle;
  if (typeof n.sandbox === "object" && "use" in n.sandbox) return (n.sandbox as NodeSandboxUse).use;
  return null;
}

function declaresGpu(dag: TaskDagDef): boolean {
  for (const n of dag.nodes) {
    if (typeof n.sandbox !== "object") continue;
    if (!("handle" in n.sandbox)) continue;
    const res = (n.sandbox as NodeSandboxCreate).resources;
    if (!res) continue;
    for (const k of Object.keys(res)) {
      if (k.includes("gpu")) return true;
    }
  }
  return false;
}

function declaresImageDigest(dag: TaskDagDef): boolean {
  for (const n of dag.nodes) {
    if (typeof n.sandbox !== "object") continue;
    if (!("handle" in n.sandbox)) continue;
    const allow = (n.sandbox as NodeSandboxCreate).image_digest_allowlist;
    if (Array.isArray(allow) && allow.length > 0) return true;
  }
  return false;
}

export interface DagAdmissionResult {
  derived: DagDerived;
}

export async function validateDag(dag: TaskDagDef): Promise<DagAdmissionResult> {
  if (!Array.isArray(dag.nodes) || dag.nodes.length === 0) {
    throw new BadRequestError("dag.nodes must be a non-empty array");
  }

  // 1. Structural.
  const idSet = new Set<string>();
  if (dag.workspace_throwaway !== undefined && typeof dag.workspace_throwaway !== "boolean") {
    throw new BadRequestError("workspace_throwaway must be a boolean");
  }
  for (const n of dag.nodes) {
    if (!n || typeof n !== "object") throw new BadRequestError("each node must be an object");
    if (!n.id || typeof n.id !== "string") throw new BadRequestError("each node must have a string id");
    if (idSet.has(n.id)) throw new BadRequestError(`duplicate node id: ${n.id}`);
    idSet.add(n.id);
    if (n.executor !== "brain") throw new BadRequestError(`node ${n.id}: executor must be 'brain'`);
    if (n.mode !== "llm" && n.mode !== "script") {
      throw new BadRequestError(`node ${n.id}: mode must be 'llm' or 'script'`);
    }
    if (n.workspace_throwaway !== undefined && typeof n.workspace_throwaway !== "boolean") {
      throw new BadRequestError(`node ${n.id}: workspace_throwaway must be a boolean`);
    }
  }
  for (const n of dag.nodes) {
    for (const dep of n.depends_on ?? []) {
      if (!idSet.has(dep)) throw new BadRequestError(`node ${n.id} depends_on unknown ${dep}`);
    }
  }
  if (hasCycle(dag.nodes)) throw new BadRequestError("dag has cycle");
  const roots = dag.nodes.filter((n) => !n.depends_on?.length);
  if (roots.length === 0) throw new BadRequestError("dag has no root node (no node with empty depends_on)");
  if (roots.length > 1) throw new BadRequestError(`dag has multiple roots: ${roots.map((r) => r.id).join(",")}`);
  const rootNodeId = roots[0].id;

  // 2. Handles: declare-once + use-after-ancestor.
  const declaredHandles = new Map<string, string>();
  for (const n of dag.nodes) {
    if (typeof n.sandbox === "object" && "handle" in n.sandbox) {
      const h = (n.sandbox as NodeSandboxCreate).handle;
      if (declaredHandles.has(h)) {
        throw new BadRequestError(`handle '${h}' declared twice (nodes ${declaredHandles.get(h)} and ${n.id})`);
      }
      declaredHandles.set(h, n.id);
    }
  }
  const ancestors = computeAncestors(dag.nodes);
  for (const n of dag.nodes) {
    if (typeof n.sandbox === "object" && "use" in n.sandbox) {
      const useHandle = (n.sandbox as NodeSandboxUse).use;
      const declarer = declaredHandles.get(useHandle);
      if (!declarer) throw new BadRequestError(`node ${n.id} uses undeclared handle '${useHandle}'`);
      if (declarer !== n.id && !ancestors.get(n.id)?.has(declarer)) {
        throw new BadRequestError(
          `node ${n.id} uses handle '${useHandle}' declared by ${declarer}, which is not an ancestor`,
        );
      }
    }
  }

  // 3. mode + sandbox combo (with tool meta lookup).
  for (const n of dag.nodes) {
    if (n.mode === "llm" && n.sandbox === "none") {
      throw new BadRequestError(`node ${n.id}: mode=llm requires a sandbox`);
    }
    if (n.mode === "script") {
      const steps: ScriptStepDef[] = Array.isArray(n.script) ? n.script : [];
      for (const step of steps) {
        const meta = await resolveToolMeta(step.name, dag.plugin_id ?? null);
        if (n.sandbox === "none" && meta.scope !== "backend") {
          throw new BadRequestError(
            `node ${n.id}: tool '${step.name}' has scope='${meta.scope}' but sandbox='none'`,
          );
        }
        assertRepeatIsBounded(n.id, step);
      }
    }
  }

  // 4. Trust.
  const trust = dag.trust_level ?? "user";
  if (trust !== "platform") {
    if (declaresGpu(dag)) throw new BadRequestError("GPU resources require trust_level='platform'");
    if (declaresImageDigest(dag)) throw new BadRequestError("image_digest_allowlist requires trust_level='platform'");
    for (const n of dag.nodes) {
      if (n.mode !== "script") continue;
      for (const step of n.script ?? []) {
        const meta = await resolveToolMeta(step.name, dag.plugin_id ?? null);
        if (meta.scope === "backend") {
          throw new BadRequestError(
            `node ${n.id} references backend-scope tool '${step.name}'; requires trust_level='platform'`,
          );
        }
      }
    }
  }

  // 5. Template refs.
  for (const node of dag.nodes) {
    const refs = collectTemplateRefs(node);
    for (const ref of refs) {
      if (NON_NODE_ROOTS.has(ref.upstream)) continue;
      const upstream = dag.nodes.find((m) => m.id === ref.upstream);
      if (!upstream) {
        throw new BadRequestError(
          `node ${node.id} references unknown upstream '${ref.upstream}' (raw: ${ref.raw})`,
        );
      }
      if (!ancestors.get(node.id)?.has(ref.upstream)) {
        throw new BadRequestError(
          `node ${node.id} references ${ref.upstream}.${ref.path} but ${ref.upstream} is not an ancestor`,
        );
      }
      const outs = new Set(upstream.outputs ?? []);
      const parts = ref.path.split(".");
      // Accept any of: exact match, "output"/"artifacts" shorthand, or any
      // prefix-prefix match -- e.g. an upstream that declared
      // `captures.prompt` admits `${node.captures.prompt.s3_asset_url}`
      // because the renderer / script-runner can dig into the captured JSON.
      let ok = outs.has(ref.path) || outs.has(parts[0]);
      if (!ok) {
        for (let i = parts.length - 1; i >= 1; i--) {
          if (outs.has(parts.slice(0, i).join("."))) { ok = true; break; }
        }
      }
      if (!ok) {
        throw new BadRequestError(
          `node ${node.id} references ${ref.upstream}.${ref.path} not declared in upstream.outputs`,
        );
      }
    }
  }

  // 6. Derive.
  const schemaDigest = createHash("sha256")
    .update(JSON.stringify(dag.nodes))
    .digest("hex");

  return {
    derived: {
      root_node_id: rootNodeId,
      handle_last_user: computeHandleLastUser(dag.nodes),
      schema_digest: schemaDigest,
    },
  };
}


/**
 * Largest repetition a step may declare.
 *
 * Not a policy about how long work may take -- the run's own budget decides that,
 * and a graph node can be given days. These bound the shape of the loop, so a
 * typo cannot ask for a million attempts, and they are refused at upload rather
 * than clamped at runtime: a script that quietly ran a tenth of what it asked for
 * is worse than one that would not save.
 */
const REPEAT_MAX_ATTEMPTS = 10_000;
const REPEAT_MAX_SECONDS = 7 * 24 * 60 * 60;

/**
 * Refuse a repetition that is not bounded in both dimensions.
 *
 * Both, because they bound different failures: a step that returns instantly
 * burns its attempts in seconds, and one that blocks for its full timeout every
 * time needs a wall-clock ceiling rather than an attempt count nobody can convert
 * into one. An unbounded loop inside a script is the hang the per-call ceiling
 * exists to prevent, and a script has no judgement to fall back on.
 */
function assertRepeatIsBounded(nodeId: string, step: ScriptStepDef): void {
  const repeat = step.repeat;
  if (!repeat) return;
  const where = `node ${nodeId}: step '${step.name}' repeat`;

  const attempts = repeat.max_attempts;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > REPEAT_MAX_ATTEMPTS) {
    throw new BadRequestError(
      `${where}.max_attempts must be a whole number between 1 and ${REPEAT_MAX_ATTEMPTS}`,
    );
  }
  const seconds = repeat.max_seconds;
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > REPEAT_MAX_SECONDS) {
    throw new BadRequestError(
      `${where}.max_seconds must be between 1 and ${REPEAT_MAX_SECONDS}`,
    );
  }
  if (repeat.interval_sec !== undefined) {
    const interval = repeat.interval_sec;
    if (!Number.isFinite(interval) || interval < 0 || interval > seconds) {
      throw new BadRequestError(`${where}.interval_sec must be between 0 and max_seconds`);
    }
  }
  const path = repeat.until?.path;
  if (typeof path !== "string" || path.trim() === "") {
    throw new BadRequestError(
      `${where}.until.path must name the structured field that says the work is done`,
    );
  }
  // Narrowed to what the comparison can actually match. `repeatSatisfied`
  // decides the loop with `===` against the value the tool reported, so an
  // object or an array here compares by identity and is unequal to every
  // structured result the step could ever return -- and the loop it can never
  // leave is not refused, it is run: the step repeats until max_attempts,
  // max_seconds, or the 72h ceiling stops it. NaN is the same shape of bug
  // without the excuse of a type error, since it is not even equal to itself.
  // The declared type is `string | number | boolean`; a JSON request body is
  // not bound by it, so it is enforced here rather than assumed.
  const equals: unknown = repeat.until.equals;
  const kind = typeof equals;
  if (kind !== "string" && kind !== "boolean" && kind !== "number") {
    throw new BadRequestError(
      `${where}.until.equals must be a string, number, or boolean -- the value that means done`,
    );
  }
  if (kind === "number" && !Number.isFinite(equals)) {
    throw new BadRequestError(
      `${where}.until.equals must be a finite number: NaN and Infinity match nothing`,
    );
  }
}