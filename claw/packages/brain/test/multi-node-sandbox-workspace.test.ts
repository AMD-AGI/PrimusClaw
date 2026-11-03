// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A multi-node run's Hands sandbox is placed next to its cluster, whatever it asks for.
 *
 * With a CPU workspace (SANDBOX_CPU_NAMESPACE) a sandbox that asks for no GPU goes there, and
 * that workspace may be on another cluster (SANDBOX_CPU_ROUTER_URL). A multi-node run's
 * cluster is always in the GPU workspace, and the optimizer in Hands drives it through the
 * Ray head's service and the Infera pods' IPs, which resolve only on the cluster's own
 * cluster. So the sandbox of such a run goes to the cluster's namespace, and is reached
 * through the Router of that namespace, not the CPU one.
 *
 * Driven through the real `ensureHands` with a stub provider: what the provider was asked to
 * create, the Hands URL and health probe that were built, and the record the sandbox is
 * stored under all have to name the same namespace.
 */
import test, { afterEach, before } from "node:test";
import assert from "node:assert/strict";
import type { KV } from "nats";
import type { ExecuteRequest } from "@claw/protocol";
import { bindDagHandles } from "./support/dag-handle-kv.js";

process.env.SANDBOX_NAMESPACE = "gpu-ws";
process.env.SANDBOX_CPU_NAMESPACE = "cpu-ws";
process.env.SANDBOX_ROUTER_URL = "http://gpu-r1.test";
process.env.SANDBOX_CPU_ROUTER_URL = "http://cpu-r1.test";
process.env.SANDBOX_HANDS_VIA_ROUTER = "true";
delete process.env.CLAW_DEPLOY_MODE;

const { ensureHands, bindSandboxReuseEffects, requestSpecFingerprint } = await import("../src/sandbox/ensure-hands.js");
const { resolveSandboxAction } = await import("../src/sandbox/params.js");
const { bindHandsKv } = await import("../src/sandbox/registry.js");
const { bindSandboxProviders } = await import("../src/sandbox/factory.js");
type SandboxCreateParams = import("../src/sandbox/provider.js").SandboxCreateParams;
type SandboxProvider = import("../src/sandbox/provider.js").SandboxProvider;
type MultiNodeContext = import("../src/sandbox/multi-node/types.js").MultiNodeContext;

before(bindDagHandles);

let restores: Array<() => void> = [];
let realFetch: typeof globalThis.fetch;
afterEach(() => {
  for (const r of restores.reverse()) if (typeof r === "function") r();
  restores = [];
  if (realFetch) globalThis.fetch = realFetch;
});

const CPU_ONLY = { cpu: "4", memory: "16Gi" };
const CPU_ONLY_GPU_ZERO = { cpu: "4", memory: "16Gi", gpu: "0" };
const WITH_GPU = { cpu: "4", memory: "16Gi", gpu: "8" };

/** The handle the optimizer gets on a cluster that was created in `namespace`. */
function clusterIn(namespace: string): MultiNodeContext {
  return {
    backend: "rayjob",
    provider: "safe",
    name: "msg-mn-rayjob",
    namespace,
    nodeCount: 2,
    gpusPerNode: 8,
    serviceUrl: `http://msg-mn-rayjob.${namespace}.svc.cluster.local:8888`,
    headHost: `msg-mn-rayjob.${namespace}.svc.cluster.local`,
  };
}

function requestOf(resources: Record<string, string>, workspaceId: string | undefined): ExecuteRequest {
  return {
    task_id: "task-mn-ws", session_id: "sess-mn-ws", message_id: "msg-mn-ws",
    ...(workspaceId === undefined ? {} : { workspace_id: workspaceId }),
    sandbox_spec: { handle: "main", image: "registry.test/img:1", resources },
  } as unknown as ExecuteRequest;
}

type Placement = {
  /** The namespace the provider was asked to create in. */
  createdIn: string;
  handsUrl: string;
  /** The URLs the Hands health probe was sent to. */
  probed: string[];
  /** The namespace the ready record (what the keepalive reads back) carries. */
  recordedIn: string;
  /** The namespace the sandbox is registered under. */
  registeredIn: string;
  /** What the ready record says the sandbox was built to: what a later request compares itself against. */
  recordedSpec: string;
  /** What the same request fingerprints to, asked directly. */
  fingerprint: string;
};

/** Run `ensureHands` to the end for a sandbox with `resources`, optionally as part of a multi-node run. */
async function place(
  resources: Record<string, string>,
  workspaceId: string | undefined,
  cluster?: MultiNodeContext,
): Promise<Placement> {
  const stored: Record<string, Uint8Array> = {};
  bindHandsKv({
    async get(key: string) { return stored[key] ? { key, value: stored[key], revision: 1 } : null; },
    async put(key: string, value: Uint8Array) { stored[key] = value; return 1; },
    async update(key: string, value: Uint8Array) { stored[key] = value; return 2; },
    async create(key: string, value: Uint8Array) { stored[key] = value; return 1; },
    async delete(key: string) { delete stored[key]; },
  } as unknown as KV);
  let created: SandboxCreateParams | undefined;
  const provider = {
    kind: "safe-workload",
    async create(params: SandboxCreateParams) {
      created = params;
      return { provider: "safe-workload", id: "wl-created", sandboxName: "wl-created", namespace: params.namespace, handsBaseUrl: "", platformKey: "pk" };
    },
    async exec() { return { exitCode: 0, stdout: "", stderr: "" }; },
    async stop() {},
  } as unknown as SandboxProvider;
  restores.push(bindSandboxProviders({ safeWorkload: provider, agentSandbox: provider }));
  let registeredIn = "";
  restores.push(bindSandboxReuseEffects({
    registerSandbox: (_sid: string, identity: { namespace?: string }) => { registeredIn = identity.namespace ?? ""; },
  }));
  const probed: string[] = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    probed.push(String(input));
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;

  const request = requestOf(resources, workspaceId);
  const result = await ensureHands("sess-mn-ws", request, "pk", async () => {}, cluster);
  assert.ok(created, "the provider was asked to create the sandbox");
  const key = Object.keys(stored).find((k) => k.startsWith("hands."));
  assert.ok(key, "the ready record was written");
  const record = JSON.parse(new TextDecoder().decode(stored[key]!)) as { namespace?: string; specFingerprint?: string };
  const action = resolveSandboxAction(request);
  assert.equal(action.kind, "create");
  return {
    createdIn: created.namespace ?? "",
    handsUrl: result.handsUrl,
    probed,
    recordedIn: record.namespace ?? "",
    registeredIn,
    recordedSpec: record.specFingerprint ?? "",
    fingerprint: requestSpecFingerprint(request, action as never, cluster),
  };
}

const gpuRouter = (ns: string) => `http://gpu-r1.test/v1/namespaces/${ns}/code-interpreters/wl-created/invocations/proxy/`;
const cpuRouter = (ns: string) => `http://cpu-r1.test/v1/namespaces/${ns}/code-interpreters/wl-created/invocations/proxy/`;

type Row = {
  name: string;
  resources: Record<string, string>;
  /** What the request names, as the console and the API do. */
  workspace: string | undefined;
  /** The workspace the run's cluster was created in; absent for a single-node run. */
  cluster?: string;
  namespace: string;
  router: (ns: string) => string;
};

const ROWS: Row[] = [
  // The defect: the sandbox asks for no GPU, so it was sent to the CPU workspace and its Router.
  { name: "multi-node, CPU-only sandbox, request names nothing: the cluster's namespace", resources: CPU_ONLY, workspace: undefined, cluster: "gpu-ws", namespace: "gpu-ws", router: gpuRouter },
  { name: "multi-node, CPU-only sandbox, request names ''", resources: CPU_ONLY, workspace: "", cluster: "gpu-ws", namespace: "gpu-ws", router: gpuRouter },
  { name: "multi-node, gpu 0 sandbox, request names the CPU workspace (the console's default)", resources: CPU_ONLY_GPU_ZERO, workspace: "cpu-ws", cluster: "gpu-ws", namespace: "gpu-ws", router: gpuRouter },
  { name: "multi-node, CPU-only sandbox, request names a workspace of its own: where its cluster is", resources: CPU_ONLY, workspace: "team-ws", cluster: "team-ws", namespace: "team-ws", router: gpuRouter },
  // Unchanged: a sandbox that asks for a GPU was already there.
  { name: "multi-node, GPU sandbox: the cluster's namespace, as before", resources: WITH_GPU, workspace: undefined, cluster: "gpu-ws", namespace: "gpu-ws", router: gpuRouter },
  // Unchanged: no cluster, no change to where a sandbox goes.
  { name: "single-node, CPU-only sandbox: the CPU workspace, through the CPU Router", resources: CPU_ONLY, workspace: undefined, namespace: "cpu-ws", router: cpuRouter },
  { name: "single-node, GPU sandbox: the GPU workspace, through the GPU Router", resources: WITH_GPU, workspace: undefined, namespace: "gpu-ws", router: gpuRouter },
];

for (const row of ROWS) {
  test(`placement: ${row.name}`, async () => {
    const p = await place(row.resources, row.workspace, row.cluster ? clusterIn(row.cluster) : undefined);
    assert.equal(p.createdIn, row.namespace, "the workload is created in this namespace");
    assert.ok(p.handsUrl.startsWith(row.router(row.namespace)), `Hands is reached through ${row.router(row.namespace)}, got ${p.handsUrl}`);
    assert.ok(p.probed.length > 0 && p.probed.every((u) => u.startsWith(row.router(row.namespace))), `the health probe went to the same Router: ${p.probed.join(", ")}`);
    assert.equal(p.recordedIn, row.namespace, "the ready record names it (the keepalive reads it back)");
    assert.equal(p.registeredIn, row.namespace, "the registered identity names it");
    assert.equal(p.recordedSpec, p.fingerprint, "and the spec it was recorded with is the one the request fingerprints to");
  });
}

test("the spec fingerprint carries the namespace the multi-node sandbox is created in", async () => {
  const withCluster = await place(CPU_ONLY, undefined, clusterIn("gpu-ws"));
  const sameSandboxNamed = await place(CPU_ONLY, "gpu-ws");
  const singleNode = await place(CPU_ONLY, undefined);
  // The sandbox lives in gpu-ws, so it is the same sandbox as a single-node one asked for there ...
  assert.equal(withCluster.recordedSpec, sameSandboxNamed.recordedSpec);
  // ... and not the one a later CPU-only single-node turn asks for in the CPU workspace, which
  // must not be handed a pod that is on the GPU cluster.
  assert.notEqual(withCluster.recordedSpec, singleNode.recordedSpec);
});
