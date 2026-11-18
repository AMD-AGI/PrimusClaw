// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Brain's half of a session's placement: every sandbox it creates for the request
 * carries the node labels, and a placement that does not pass is refused with nothing created.
 *
 *   B1 an application's sandbox and its reader sandbox carry the labels; without one, no field
 *   B2 an AppRunner hands the labels to every sandbox it ensures, a rebuild included
 *   B3 a request whose placement fails the check creates no workload, with its own reason
 */
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import type { ExecuteRequest } from "@claw/protocol";

import { createAppReaderSandbox, ensureAppSandbox, type AppSandboxRun } from "../src/apps/app-sandbox.js";
import { placementNodeLabels, SANDBOX_PLACEMENT_INVALID } from "../src/sandbox/create-sandbox.js";
import { ensureHands } from "../src/sandbox/ensure-hands.js";
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
