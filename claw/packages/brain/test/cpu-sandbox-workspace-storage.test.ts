// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A CPU sandbox is created without the workspace's storage, through the real `ensureHands` and the real SaFE provider: the workload
 * body SaFE receives carries `useWorkspaceStorage: false`, so SaFE mounts neither the owner's directory nor the workspace's volumes
 * (the shared filesystem every session could otherwise read). A sandbox that asks for a GPU, and a multi-node run's sandbox whatever it
 * asks for, keep SaFE's default: the field is absent from their bodies.
 *
 *   C1  a CPU sandbox's workload body carries useWorkspaceStorage: false, in the CPU workspace and in a workspace the request names
 *   C2  a GPU sandbox's workload body has no useWorkspaceStorage field
 *   C3  a multi-node run's sandbox (CPU-only resources, in its cluster's namespace) has no useWorkspaceStorage field
 *   C4  the fingerprint tells a CPU sandbox built with the storage from one built without; a GPU or multi-node one is unchanged
 */
process.env.SANDBOX_CPU_NAMESPACE = "global-cpu";
process.env.SANDBOX_NAMESPACE = "gpu-default";

import test, { afterEach, before } from "node:test";
import assert from "node:assert/strict";
import type { KV } from "nats";
import type { ExecuteRequest } from "@claw/protocol";
import type { MultiNodeContext } from "../src/sandbox/multi-node/types.js";
import { bindDagHandles } from "./support/dag-handle-kv.js";

const { ensureHands, bindSandboxReuseEffects, requestSpecFingerprint, sandboxWithoutWorkspaceStorage } =
  await import("../src/sandbox/ensure-hands.js");
const { resolveSandboxAction } = await import("../src/sandbox/params.js");
const { bindHandsKv } = await import("../src/sandbox/registry.js");
const { bindSandboxProviders } = await import("../src/sandbox/factory.js");
const { SafeWorkloadProvider } = await import("../src/sandbox/safe-workload-provider.js");
const { sandboxSpecFingerprint } = await import("../src/sandbox/spec-fingerprint.js");

before(bindDagHandles);

const PLATFORM_KEY = "ak-test-platform-key";
let restores: Array<() => void> = [];
let realFetch: typeof globalThis.fetch | undefined;
afterEach(() => {
  for (const r of restores.reverse()) if (typeof r === "function") r();
  restores = [];
  if (realFetch) globalThis.fetch = realFetch;
  realFetch = undefined;
});

function emptyKv(): KV {
  return {
    async get() { return null; },
    async put() { return 1; },
    async update() { return 2; },
    async create() { return 1; },
    async delete() {},
  } as unknown as KV;
}

const request = (resources: Record<string, string>, extra: Partial<ExecuteRequest> = {}): ExecuteRequest => ({
  task_id: "task-cpu", session_id: "sess-cpu", llm_api_key: "sk-test",
  sandbox_spec: { handle: "main", image: "registry.test/img:1", resources },
  ...extra,
} as unknown as ExecuteRequest);

const MULTI_NODE: MultiNodeContext = {
  backend: "rayjob", provider: "safe", name: "mn-wl-1", namespace: "the-clusters-workspace",
  nodeCount: 2, gpusPerNode: 8, serviceUrl: "http://head.test:8888",
} as unknown as MultiNodeContext;

/** The workload body the real SafeWorkloadProvider POSTs to SaFE for this request; SaFE answers 500 so nothing runs past the create. */
async function workloadBody(req: ExecuteRequest, multiNodeContext?: MultiNodeContext): Promise<Record<string, unknown>> {
  bindHandsKv(emptyKv());
  restores.push(bindSandboxProviders({ safeWorkload: new SafeWorkloadProvider() }));
  restores.push(bindSandboxReuseEffects({ registerSandbox: () => {} }));
  const bodies: Array<Record<string, unknown>> = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: { method?: string; body?: string }) => {
    if (String(url).endsWith("/api/v1/workloads") && init?.method === "POST") {
      bodies.push(JSON.parse(String(init.body ?? "{}")));
      return new Response("stop here", { status: 500 });
    }
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;
  await assert.rejects(ensureHands("sess-cpu", req, PLATFORM_KEY, async () => {}, multiNodeContext), /Create Hands failed: HTTP 500/);
  assert.equal(bodies.length, 1, "exactly one workload create reached SaFE");
  return bodies[0]!;
}

const gpuOf = (body: Record<string, unknown>) =>
  ((body.resources ?? []) as Array<Record<string, unknown>>).some((e) => Number(e.gpu ?? 0) > 0);

test("C1 a CPU sandbox's workload body carries useWorkspaceStorage: false, in the CPU workspace and in a workspace the request names", async () => {
  const cpu = await workloadBody(request({ cpu: "2", memory: "4Gi" }));
  assert.equal(cpu.workspace, "global-cpu");
  assert.equal(cpu.useWorkspaceStorage, false);
  assert.equal(gpuOf(cpu), false);
  const named = await workloadBody(request({ cpu: "2", memory: "4Gi", gpu: "0" }, { workspace_id: "a-named-workspace" }));
  assert.equal(named.workspace, "a-named-workspace");
  assert.equal(named.useWorkspaceStorage, false, "a GPU count of 0 asks for no GPU");
});

test("C2 a GPU sandbox's workload body has no useWorkspaceStorage field (SaFE's default mounts the storage)", async () => {
  const gpu = await workloadBody(request({ cpu: "2", memory: "4Gi", gpu: "1" }));
  assert.equal(gpu.workspace, "gpu-default");
  assert.equal(gpuOf(gpu), true);
  assert.equal("useWorkspaceStorage" in gpu, false);
});

test("C3 a multi-node run's sandbox keeps the storage, though its own resources ask for no GPU", async () => {
  const mn = await workloadBody(request({ cpu: "2", memory: "4Gi" }), MULTI_NODE);
  assert.equal(mn.workspace, "the-clusters-workspace");
  assert.equal(gpuOf(mn), false, "a CPU-only sandbox: the storage is kept for the multi-node run, not for a GPU");
  assert.equal("useWorkspaceStorage" in mn, false);
});

test("C4 the fingerprint tells a CPU sandbox built with the storage from one built without; GPU and multi-node fingerprint as before", () => {
  const fp = (req: ExecuteRequest, mn?: MultiNodeContext) => requestSpecFingerprint(req, resolveSandboxAction(req) as never, mn);
  const cpu = request({ cpu: "2", memory: "4Gi" });
  const gpu = request({ cpu: "2", memory: "4Gi", gpu: "1" });
  assert.equal(sandboxWithoutWorkspaceStorage(cpu, [{ cpu: "2" }]), true);
  assert.equal(sandboxWithoutWorkspaceStorage(gpu, [{ cpu: "2", gpu: "1" }]), false);
  assert.equal(sandboxWithoutWorkspaceStorage(cpu, [{ cpu: "2" }], MULTI_NODE), false);
  assert.equal(sandboxWithoutWorkspaceStorage({ ...gpu, sandbox_profile: "review" }, [{ cpu: "2", gpu: "1" }], MULTI_NODE), true);
  const base = { image: "registry.test/img:1", resources: { cpu: "2" }, env: {} };
  assert.notEqual(
    sandboxSpecFingerprint({ ...base, withoutWorkspaceStorage: true }),
    sandboxSpecFingerprint(base),
    "a CPU sandbox an earlier Brain built with the storage mounted is not reused",
  );
  assert.equal(sandboxSpecFingerprint({ ...base, withoutWorkspaceStorage: false }), sandboxSpecFingerprint(base));
  // Through the request: a CPU request and the same request asking for a GPU differ (namespace aside, by the storage marker too).
  assert.notEqual(fp(cpu), fp(gpu));
  assert.notEqual(fp(cpu), fp(cpu, MULTI_NODE), "a multi-node run's sandbox is not reused from a CPU sandbox without the storage");
});
