// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Brain's half of a session's placement: every sandbox it creates for the request
 * carries the node labels, and a placement that does not pass is refused with nothing created.
 *
 *   B1 an application's sandbox and its reader sandbox carry the labels; without one, no field
 *   B2 an AppRunner hands the labels to every sandbox it ensures, a rebuild included
 *   B3 a request whose placement fails the check creates no workload, with its own reason
 *   B4 an application's run adopts a live sandbox only when it was created with the placement;
 *      one created without it is stopped and replaced, and without a placement nothing is asked
 *   B5 a session's Hands sandbox built without the placement is not reused for a request with
 *      one; the fingerprint without a placement is the one every stored sandbox already has
 */
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import type { ExecuteRequest } from "@claw/protocol";

import { createAppReaderSandbox, ensureAppSandbox, type AppSandboxRun } from "../src/apps/app-sandbox.js";
import { placementNodeLabels, SANDBOX_PLACEMENT_INVALID } from "../src/sandbox/create-sandbox.js";
import { bindSandboxReuseEffects, ensureHands, requestSpecFingerprint, tryReuseSessionSandbox } from "../src/sandbox/ensure-hands.js";
import { resolveSandboxAction } from "../src/sandbox/params.js";
import { evaluateReuse } from "../src/sandbox/spec-fingerprint.js";
import { bindSandboxProviders } from "../src/sandbox/factory.js";
import { bindHandsKv } from "../src/sandbox/registry.js";
import { SandboxProvisionTerminalError } from "../src/sandbox/errors.js";
import type { SandboxCreateParams, SandboxInstance, SandboxProvider } from "../src/sandbox/provider.js";

const { AppRunner } = await import("../src/apps/app-runner.js");
const { World, MANIFEST, RUN_ID } = await import("./support/app-runner-world.js");

const LABELS = { "autopilot.amd.com/preemptible": "false" };
const restores: Array<() => void> = [];
afterEach(() => { for (const r of restores.splice(0).reverse()) r(); });

function appRun(over: Partial<AppSandboxRun> = {}): AppSandboxRun {
  return {
    runId: "run-1", sessionId: "sess-1", workspaceId: "ws-1", platformKey: "pk",
    sandboxSpec: { handle: "app", image: "registry.example/app:1", resources: { cpu: "1", memory: "1Gi" }, timeout: 600 },
    ...over,
  };
}

function capturingCreate() {
  const created: SandboxCreateParams[] = [];
  const create = async (p: SandboxCreateParams): Promise<SandboxInstance> => {
    created.push(p);
    await p.onProvisioned?.(`wl-${created.length}`);
    return { provider: "safe-workload", id: `wl-${created.length}`, sandboxName: "x", namespace: p.namespace, handsBaseUrl: "", platformKey: p.platformKey };
  };
  return { created, create };
}

/** SaFE's list answers that the run has no live sandbox yet. */
const emptyList = (async () => new Response(JSON.stringify({ totalCount: 0, items: [] }), { status: 200 })) as typeof fetch;

test("B1 an application's sandbox and reader carry the session's node labels", async () => {
  const c = capturingCreate();
  await ensureAppSandbox(appRun({ nodeLabels: LABELS }), { fetch: emptyList, recordWorkloadId: async () => {}, create: c.create });
  await createAppReaderSandbox(appRun({ nodeLabels: LABELS }), { create: c.create, stop: async () => {} });
  assert.equal(c.created.length, 2);
  for (const p of c.created) assert.deepEqual(p.nodeLabels, LABELS);
});

test("B1 without a placement the create parameters carry no node labels", async () => {
  const c = capturingCreate();
  await ensureAppSandbox(appRun(), { fetch: emptyList, recordWorkloadId: async () => {}, create: c.create });
  await createAppReaderSandbox(appRun(), { create: c.create, stop: async () => {} });
  for (const p of c.created) assert.equal("nodeLabels" in p, false);
});

test("B2 an AppRunner hands the labels to every sandbox it ensures, a rebuild included", async () => {
  const world = new World(MANIFEST);
  const ensured: Array<Record<string, string> | undefined> = [];
  const read: Array<Record<string, string> | undefined> = [];
  const ensure = world.sandbox.ensure.bind(world.sandbox);
  const reader = world.sandbox.reader.bind(world.sandbox);
  world.sandbox.ensure = (async (run: AppSandboxRun, opts?: unknown) => {
    ensured.push(run.nodeLabels);
    return ensure(run, opts as never);
  }) as typeof world.sandbox.ensure;
  world.sandbox.reader = (async (run: AppSandboxRun, opts?: unknown) => {
    read.push(run.nodeLabels);
    return reader(run, opts as never);
  }) as typeof world.sandbox.reader;
  const runner = new AppRunner(RUN_ID, "pk", {
    store: world.store, sandbox: world.sandbox, now: world.now, sleep: world.sleep, tickMs: 5000, nodeLabels: LABELS,
  });
  const until = async (state: string) => {
    for (let i = 0; i < 12 && world.rec.state !== state; i++) await runner.reconcile();
    assert.equal(world.rec.state, state);
  };
  await until("running");
  const first = world.rec.sandbox_workload_id!;
  // The sandbox is lost while the application runs: the runner builds another.
  world.killWorkload(first, "terminal", { reason: "sandbox_container_failed" });
  await runner.reconcile();
  await until("running");
  assert.notEqual(world.rec.sandbox_workload_id, first, "no new sandbox was built");
  assert.ok(ensured.length >= 2, `ensured ${ensured.length} times`);
  assert.ok(read.length >= 1, "the lost sandbox's state was not read");
  for (const labels of [...ensured, ...read]) assert.deepEqual(labels, LABELS);
});

test("B2 the AppRunner Brain builds for a run carries the session's labels, and none without them", async () => {
  const { createAppRunner } = await import("../src/apps/app-runner-wiring.js");
  const depsOf = (r: unknown) => (r as { deps: { nodeLabels?: Record<string, string> } }).deps;
  assert.deepEqual(depsOf(createAppRunner("run-w", "pk", 1, undefined, LABELS)).nodeLabels, LABELS);
  assert.equal("nodeLabels" in depsOf(createAppRunner("run-w", "pk", 1)), false);
});

test("B3 placementNodeLabels: none, the labels, or a refusal with its own reason", () => {
  assert.equal(placementNodeLabels({}), undefined);
  assert.deepEqual(placementNodeLabels({ placement: { nodeLabels: LABELS } }), LABELS);
  for (const bad of [
    { nodeLabels: { "kubernetes.io/hostname": "node-1" } },
    { nodeLabels: { "example.com/pool": "a b" } },
    "pool=a",
  ]) {
    assert.throws(
      () => placementNodeLabels({ placement: bad } as unknown as ExecuteRequest),
      (e: unknown) => e instanceof SandboxProvisionTerminalError && e.reason === SANDBOX_PLACEMENT_INVALID,
      JSON.stringify(bad),
    );
  }
});

test("B3 ensureHands creates no workload for a placement that fails the check", async () => {
  let creates = 0;
  const provider = {
    kind: "safe-workload",
    async create() { creates++; throw new Error("must not be reached"); },
    async exec() { return { exitCode: 0, stdout: "", stderr: "" }; },
    async stop() {},
  } as unknown as SandboxProvider;
  restores.push(bindSandboxProviders({ safeWorkload: provider, agentSandbox: provider }));
  bindHandsKv({ async get() { return null; }, async put() { return 1; }, async update() { return 1; }, async delete() {} } as never);
  const request = {
    task_id: "task-1",
    sandbox_spec: { handle: "main", image: "registry.test/img:1", resources: { cpu: "1", memory: "1Gi" } },
    placement: { nodeLabels: { "excluded-nodes": "node-1" } },
  } as unknown as ExecuteRequest;
  await assert.rejects(
    ensureHands("sess-bad", request, "pk", async () => {}),
    (e: unknown) => e instanceof SandboxProvisionTerminalError && e.reason === SANDBOX_PLACEMENT_INVALID,
  );
  assert.equal(creates, 0);
});

test("B3 ensureHands refuses a placement that fails the check before a DAG handle is even looked up", async () => {
  bindHandsKv({ async get() { return null; }, async put() { return 1; }, async update() { return 1; }, async delete() {} } as never);
  const request = {
    task_id: "task-1", dag_root_task_id: "dag-1",
    sandbox_spec: { use: "main" },
    placement: { nodeLabels: { "kubernetes.io/hostname": "node-1" } },
  } as unknown as ExecuteRequest;
  await assert.rejects(
    ensureHands("sess-bad", request, "pk", async () => {}),
    (e: unknown) => e instanceof SandboxProvisionTerminalError && e.reason === SANDBOX_PLACEMENT_INVALID,
  );
});

// --- B4 adopting an application's live sandbox -----------------------------------

/**
 * SaFE for the adopt path: the run's list names one live sandbox `wl-old`, whose detail
 * carries `customerLabels`. Records every path asked.
 */
function adoptSafe(customerLabels: Record<string, string> | null) {
  const asked: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input), "http://safe.test");
    asked.push(url.pathname);
    if (url.pathname === "/api/v1/workloads") {
      return new Response(JSON.stringify({
        totalCount: 1,
        items: [{ workloadId: "wl-old", phase: "Running", groupVersionKind: { kind: "Sandbox" } }],
      }), { status: 200 });
    }
    if (url.pathname === "/api/v1/workloads/wl-old") {
      return new Response(JSON.stringify({ workloadId: "wl-old", phase: "Running", customerLabels }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { asked, fetchImpl };
}

test("B4 a live sandbox created without the session's labels is stopped, and one with them created", async () => {
  for (const left of [null, { "example.com/pool": "reserved" }, { ...LABELS, "example.com/extra": "x" }]) {
    const safe = adoptSafe(left);
    const c = capturingCreate();
    const stopped: string[] = [];
    const got = await ensureAppSandbox(appRun({ nodeLabels: LABELS }), {
      fetch: safe.fetchImpl, recordWorkloadId: async () => {}, create: c.create, stop: async (id) => { stopped.push(id); },
    });
    assert.deepEqual(stopped, ["wl-old"], JSON.stringify(left));
    assert.equal(got.created, true, JSON.stringify(left));
    assert.equal(c.created.length, 1);
    assert.deepEqual(c.created[0]!.nodeLabels, LABELS);
  }
});

test("B4 a live sandbox created with the session's labels is adopted", async () => {
  const safe = adoptSafe({ ...LABELS });
  const c = capturingCreate();
  const stopped: string[] = [];
  const got = await ensureAppSandbox(appRun({ nodeLabels: LABELS }), {
    fetch: safe.fetchImpl, recordWorkloadId: async () => {}, create: c.create, stop: async (id) => { stopped.push(id); },
  });
  assert.equal(got.created, false);
  assert.equal(got.workloadId, "wl-old");
  assert.deepEqual(stopped, []);
  assert.equal(c.created.length, 0);
});

test("B4 without a placement a live sandbox is adopted as before, its detail never asked", async () => {
  const safe = adoptSafe({ ...LABELS });
  const c = capturingCreate();
  const got = await ensureAppSandbox(appRun(), {
    fetch: safe.fetchImpl, recordWorkloadId: async () => {}, create: c.create, stop: async () => { throw new Error("stopped"); },
  });
  assert.equal(got.workloadId, "wl-old");
  assert.equal(got.created, false);
  assert.deepEqual(safe.asked, ["/api/v1/workloads"]);
});

test("B4 a detail SaFE will not give is not read as either answer", async () => {
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input), "http://safe.test");
    if (url.pathname === "/api/v1/workloads") {
      return new Response(JSON.stringify({
        totalCount: 1, items: [{ workloadId: "wl-old", phase: "Running", groupVersionKind: { kind: "Sandbox" } }],
      }), { status: 200 });
    }
    return new Response("{}", { status: 503 });
  }) as typeof fetch;
  const c = capturingCreate();
  const stopped: string[] = [];
  await assert.rejects(ensureAppSandbox(appRun({ nodeLabels: LABELS }), {
    fetch: fetchImpl, recordWorkloadId: async () => {}, create: c.create, stop: async (id) => { stopped.push(id); },
  }), /placement check failed: HTTP 503/);
  assert.deepEqual(stopped, []);
  assert.equal(c.created.length, 0);
});

// --- B5 reusing a session's Hands sandbox ------------------------------------------

const HANDS_REQUEST: ExecuteRequest = { session_id: "s-place", prompt: "go", sandbox_image: "example.io/torch:2.4" };

function fingerprintOf(request: ExecuteRequest): string {
  const action = resolveSandboxAction(request);
  assert.equal(action.kind, "create");
  return requestSpecFingerprint(request, action as never);
}

test("B5 the fingerprint carries the placement, and without one is what it always was", () => {
  const plain = fingerprintOf(HANDS_REQUEST);
  for (const none of [null, {}, { nodeLabels: {} }]) {
    assert.equal(fingerprintOf({ ...HANDS_REQUEST, placement: none } as ExecuteRequest), plain, JSON.stringify(none));
  }
  const placed = fingerprintOf({ ...HANDS_REQUEST, placement: { nodeLabels: LABELS } });
  assert.notEqual(placed, plain);
  assert.equal(evaluateReuse(plain, placed).reuse, false, "a sandbox built without the placement was reused");
  assert.equal(fingerprintOf({ ...HANDS_REQUEST, placement: { nodeLabels: { ...LABELS } } }), placed);
  assert.notEqual(fingerprintOf({ ...HANDS_REQUEST, placement: { nodeLabels: { ...LABELS, "example.com/pool": "a" } } }), placed);
  assert.throws(
    () => fingerprintOf({ ...HANDS_REQUEST, placement: { nodeLabels: { "kubernetes.io/hostname": "n" } } } as ExecuteRequest),
    (e: unknown) => e instanceof SandboxProvisionTerminalError && e.reason === SANDBOX_PLACEMENT_INVALID,
  );
});

/** A session record naming a parked sandbox built to `builtFor`. */
function sessionKv(builtFor: ExecuteRequest) {
  const enc = new TextEncoder();
  const entry = {
    status: "ready", provider: "safe-workload", workloadId: "wl-hands", platformKey: "pk", sessionId: "s-place",
    sandboxName: "sb", namespace: "ns", handsUrl: "http://hands:9100/mcp", token: "tok",
    specFingerprint: fingerprintOf(builtFor), keepalive: false, idleSince: "2020-01-01T00:00:00.000Z",
  };
  let revision = 7;
  return {
    async get(key: string) {
      if (!key.startsWith("hands.")) return null;
      return { key, value: enc.encode(JSON.stringify(entry)), revision };
    },
    async update() { return ++revision; },
    async put() { return ++revision; },
    async create() { return ++revision; },
    async delete() {},
  };
}

test("B5 a session's sandbox built without the placement is rebuilt, not reused, for a request with one", async () => {
  const realFetch = globalThis.fetch;
  restores.push(() => { globalThis.fetch = realFetch; });
  globalThis.fetch = (async () => ({ ok: true, status: 200 }) as Response) as typeof fetch;
  const destroyed: string[] = [];
  restores.push(bindSandboxReuseEffects({
    destroyHands: async (sessionId: string) => { destroyed.push(sessionId); },
    registerSandbox: (() => {}) as never,
    probeSandboxContainer: async () => ({ verdict: "alive" as const, reason: "exec_ok" as const }),
  }));
  const placed = { ...HANDS_REQUEST, placement: { nodeLabels: LABELS } } as ExecuteRequest;
  const attempt = (builtFor: ExecuteRequest, request: ExecuteRequest) => tryReuseSessionSandbox({
    kv: sessionKv(builtFor), sessionId: "s-place", request, requestedSpec: fingerprintOf(request), onEvent: async () => {},
  } as never);

  assert.equal(await attempt(HANDS_REQUEST, placed), null, "the sandbox built without the placement was reused");
  // The controls: the same placement, and none on either side, are reused as before.
  assert.notEqual(await attempt(placed, placed), null, "a sandbox built with the placement was not reused");
  assert.notEqual(await attempt(HANDS_REQUEST, HANDS_REQUEST), null, "a sandbox without a placement was not reused");
});
