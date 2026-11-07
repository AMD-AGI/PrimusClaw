// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A deployment with a CPU workspace: a sandbox that asks for no GPU goes there, one
 * that asks for a GPU never does, and both workspaces are reached through the one Router.
 *
 * The rule is pinned three ways, because it is applied in three places that have to
 * agree: the pure function, the namespace a request's spec fingerprint folds in (the
 * same function picks the namespace the workload is created in), and the instance an
 * app sandbox is addressed by when its run names no workspace (a run that names one
 * runs there). The one Router serves both workspaces.
 */
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import type { ExecuteRequest } from "@claw/protocol";

process.env.SANDBOX_NAMESPACE = "gpu-ws";
process.env.SANDBOX_CPU_NAMESPACE = "cpu-ws";
process.env.SANDBOX_ROUTER_URL = "http://gpu-r1.test,http://gpu-r2.test";
process.env.SANDBOX_HANDS_VIA_ROUTER = "true";
delete process.env.CLAW_DEPLOY_MODE;

const { pickSandboxNamespace, resourcesNeedGpu, sandboxNamespaceForResources } = await import("../src/sandbox/workspace-select.js");
const { requestSpecFingerprint } = await import("../src/sandbox/ensure-hands.js");
const { resolveSandboxAction } = await import("../src/sandbox/params.js");
const { appSandboxInstance } = await import("../src/apps/app-sandbox.js");
const {
  sandboxRouterBases, handsViaRouter, safeHandsBaseUrl, routerBaseForPortProxy,
  withRouterFailover, resetRouterPreferenceForTest,
} = await import("../src/sandbox/sandbox-router.js");
const { SafeWorkloadProvider } = await import("../src/sandbox/safe-workload-provider.js");
const { handsBehindRouterProxy } = await import("../src/config.js");
const { probeAppMcp } = await import("../src/apps/app-mcp.js");

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  resetRouterPreferenceForTest();
});

// --- the rule ---------------------------------------------------------------

test("resourcesNeedGpu: only a count above zero, or a value that is not a number, asks for a GPU", () => {
  const rows: Array<[string, unknown, boolean]> = [
    ["nothing", undefined, false],
    ["no resources", {}, false],
    ["cpu and memory only", { cpu: "4", memory: "16Gi" }, false],
    ["gpu 0", { cpu: "4", gpu: "0" }, false],
    ["gpu 0.0", { gpu: "0.0" }, false],
    ["gpu number 0", { gpu: 0 }, false],
    ["gpu blank", { gpu: " " }, false],
    ["gpu 1", { gpu: "1" }, true],
    ["gpu 8", { gpu: "8" }, true],
    ["gpu number 8", { gpu: 8 }, true],
    ["the Kubernetes spelling, 0", { "amd.com/gpu": "0" }, false],
    ["the Kubernetes spelling, 8", { "amd.com/gpu": "8" }, true],
    ["unreadable is treated as a GPU request", { gpu: "lots" }, true],
    ["workload array, none asks", [{ cpu: "4", gpu: "0", replica: 1 }], false],
    ["workload array, one asks", [{ cpu: "4", gpu: "0" }, { cpu: "4", gpu: "8" }], true],
    ["empty array", [], false],
  ];
  for (const [name, resources, expected] of rows) assert.equal(resourcesNeedGpu(resources), expected, name);
});

test("pickSandboxNamespace: with no CPU workspace it is exactly what it was", () => {
  for (const needsGpu of [false, true]) {
    for (const requested of [undefined, null, "", "  ", "ws-x", " ws-x "]) {
      const want = (requested?.trim() ?? "") || "gpu-ws";
      assert.equal(pickSandboxNamespace({ requested, needsGpu, defaultNamespace: "gpu-ws", cpuNamespace: "" }), want);
      assert.equal(pickSandboxNamespace({ requested, needsGpu, defaultNamespace: "gpu-ws", cpuNamespace: "  " }), want);
    }
  }
});

test("pickSandboxNamespace: with a CPU workspace the choice follows what the sandbox asks for", () => {
  const pick = (requested: string | undefined, needsGpu: boolean) =>
    pickSandboxNamespace({ requested, needsGpu, defaultNamespace: "gpu-ws", cpuNamespace: "cpu-ws" });
  // Names nothing.
  assert.equal(pick(undefined, false), "cpu-ws");
  assert.equal(pick("  ", false), "cpu-ws");
  assert.equal(pick(undefined, true), "gpu-ws");
  // Names a workspace of its own: honoured.
  assert.equal(pick("ws-x", false), "ws-x");
  assert.equal(pick("ws-x", true), "ws-x");
  assert.equal(pick("gpu-ws", false), "gpu-ws");
  assert.equal(pick("cpu-ws", false), "cpu-ws");
  // Names the CPU workspace and asks for a GPU: it has none, so it goes to the GPU workspace.
  assert.equal(pick("cpu-ws", true), "gpu-ws");
  assert.equal(pick(" cpu-ws ", true), "gpu-ws");
});

// --- applied where the namespace is decided -----------------------------------

function fingerprintOf(extra: Partial<ExecuteRequest>): string {
  const request = { session_id: "s-1", prompt: "go", sandbox_image: "example.io/torch:2.4", ...extra } as ExecuteRequest;
  const action = resolveSandboxAction(request);
  assert.equal(action.kind, "create");
  return requestSpecFingerprint(request, action as never);
}

test("the spec fingerprint folds in the namespace the rule picks (the workload is created there)", () => {
  const cpu = { resources: { cpu: "4", memory: "16Gi", gpu: "0" } };
  const gpu = { resources: { cpu: "4", memory: "16Gi", gpu: "8" } };
  // CPU-only, names nothing: the CPU workspace, not SANDBOX_NAMESPACE.
  assert.equal(fingerprintOf(cpu), fingerprintOf({ ...cpu, workspace_id: "cpu-ws" }));
  assert.notEqual(fingerprintOf(cpu), fingerprintOf({ ...cpu, workspace_id: "gpu-ws" }));
  // No `gpu` key at all is no GPU.
  const bare = { resources: { cpu: "4", memory: "16Gi" } };
  assert.equal(fingerprintOf(bare), fingerprintOf({ ...bare, workspace_id: "cpu-ws" }));
  // GPU, names nothing: the GPU workspace.
  assert.equal(fingerprintOf(gpu), fingerprintOf({ ...gpu, workspace_id: "gpu-ws" }));
  // GPU, names the CPU workspace (the console does, with the server's default): the GPU workspace.
  assert.equal(fingerprintOf({ ...gpu, workspace_id: "cpu-ws" }), fingerprintOf({ ...gpu, workspace_id: "gpu-ws" }));
  // GPU, names a workspace of its own: that one.
  assert.notEqual(fingerprintOf({ ...gpu, workspace_id: "ws-x" }), fingerprintOf({ ...gpu, workspace_id: "gpu-ws" }));
  // Same workspace named by a GPU request and a CPU request does not make them one sandbox: the resources differ.
  assert.notEqual(fingerprintOf({ ...gpu, workspace_id: "ws-x" }), fingerprintOf({ ...cpu, workspace_id: "ws-x" }));
});

test("an app sandbox is addressed in its named workspace, else the workspace the rule picks", () => {
  const run = (workspaceId: string | undefined, gpu: string) => ({
    workspaceId,
    platformKey: "pk",
    sandboxSpec: { handle: "h", image: "i", resources: { cpu: "4", gpu } },
  }) as never;
  assert.equal(appSandboxInstance(run(undefined, "0"), "wl-1").namespace, "cpu-ws");
  assert.equal(appSandboxInstance(run(undefined, "8"), "wl-1").namespace, "gpu-ws");
  // The app runs in resources.workspace, which admission checked: the rule does not move it.
  assert.equal(appSandboxInstance(run("cpu-ws", "8"), "wl-1").namespace, "cpu-ws");
  assert.equal(appSandboxInstance(run("gpu-ws", "0"), "wl-1").namespace, "gpu-ws");
  assert.equal(appSandboxInstance(run("ws-x", "8"), "wl-1").namespace, "ws-x");
  assert.equal(sandboxNamespaceForResources(undefined, { gpu: "0" }), "cpu-ws");
});

// --- every workspace through the one Router ----------------------------------

test("one Router list serves every workspace", () => {
  assert.deepEqual(sandboxRouterBases(), ["http://gpu-r1.test", "http://gpu-r2.test"]);
});

test("Hands URLs and the port-proxy base are built on the one Router for every workspace", () => {
  assert.equal(handsViaRouter(), true);
  assert.equal(
    safeHandsBaseUrl("cpu-ws", "wl-1", "9100"),
    "http://gpu-r1.test/v1/namespaces/cpu-ws/code-interpreters/wl-1/invocations/proxy/9100",
  );
  assert.equal(
    safeHandsBaseUrl("gpu-ws", "wl-2", "9100"),
    "http://gpu-r1.test/v1/namespaces/gpu-ws/code-interpreters/wl-2/invocations/proxy/9100",
  );
  assert.equal(routerBaseForPortProxy(), "http://gpu-r1.test");
  assert.equal(handsBehindRouterProxy(), true);
});

test("exec for any workspace goes to the one Router, and a refusal moves within its list", async () => {
  const seen: string[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    seen.push(`${init?.method} ${String(input)}`);
    if (new URL(String(input)).host === "gpu-r1.test") {
      throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }) });
    }
    return { ok: true, status: 200, json: async () => ({ exit_code: 0, stdout: "hi\n", stderr: "" }) } as Response;
  }) as typeof fetch;
  const inst = (namespace: string, id: string) => ({ provider: "safe-workload" as const, id, sandboxName: id, namespace, handsBaseUrl: "", platformKey: "pk" });
  const provider = new SafeWorkloadProvider();
  await provider.exec(inst("cpu-ws", "wl-c"), "echo hi", "5s");
  resetRouterPreferenceForTest();
  await provider.exec(inst("gpu-ws", "wl-g"), "echo hi", "5s");
  assert.deepEqual(seen, [
    "POST http://gpu-r1.test/v1/namespaces/cpu-ws/code-interpreters/wl-c/invocations/api/execute",
    "POST http://gpu-r2.test/v1/namespaces/cpu-ws/code-interpreters/wl-c/invocations/api/execute",
    "POST http://gpu-r1.test/v1/namespaces/gpu-ws/code-interpreters/wl-g/invocations/api/execute",
    "POST http://gpu-r2.test/v1/namespaces/gpu-ws/code-interpreters/wl-g/invocations/api/execute",
  ]);
});

test("a stored Hands URL fails over inside the Router list; a direct URL passes through", async () => {
  const seen: string[] = [];
  const f = withRouterFailover(async (input: string) => {
    seen.push(String(input));
    if (new URL(String(input)).host === "gpu-r1.test") {
      throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }) });
    }
    return "ok";
  });
  await f("http://gpu-r1.test/v1/namespaces/cpu-ws/code-interpreters/w/invocations/proxy/9100/health");
  await f("http://w.cpu-ws.svc.cluster.local:9100/health");
  assert.deepEqual(seen, [
    "http://gpu-r1.test/v1/namespaces/cpu-ws/code-interpreters/w/invocations/proxy/9100/health",
    "http://gpu-r2.test/v1/namespaces/cpu-ws/code-interpreters/w/invocations/proxy/9100/health",
    "http://w.cpu-ws.svc.cluster.local:9100/health",
  ]);
});

test("the app MCP probe fails over inside the Router list", async () => {
  const seen: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    seen.push(String(input));
    if (new URL(String(input)).host === "gpu-r1.test") {
      throw Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }) });
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const verdict = await probeAppMcp({
    url: "http://gpu-r1.test/v1/namespaces/cpu-ws/code-interpreters/wl-1/invocations/proxy/9000/mcp",
    tokenHeader: "x-mcp-token", token: "t", sandboxSessionId: "wl-1", bearer: "b",
  });
  assert.deepEqual(verdict, { kind: "ok" });
  assert.deepEqual(seen, [
    "http://gpu-r1.test/v1/namespaces/cpu-ws/code-interpreters/wl-1/invocations/proxy/9000/mcp",
    "http://gpu-r2.test/v1/namespaces/cpu-ws/code-interpreters/wl-1/invocations/proxy/9000/mcp",
  ]);
});
