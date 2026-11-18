// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A multi-node cluster is GPU nodes, so a deployment with a CPU workspace
 * (SANDBOX_CPU_NAMESPACE) must never create one there.
 *
 * Once that variable is set the API stamps no workspace on a task, and the console
 * names the CPU workspace on every turn (it is what `GET /v1/me` calls the default).
 * Both reach the multi-node provider as `request.workspace_id`:
 *
 *   - "" used to be refused with "multi-node request requires workspace_id";
 *   - the CPU workspace used to be used as-is, so the cluster was created where no
 *     GPU exists and never scheduled.
 *
 * Both now resolve to the GPU workspace, as a single-node GPU sandbox does, and a
 * workspace the request names that is neither stays as named. The run's own release
 * (the teardownRayJob fallback, for a run that failed before it had a cluster context)
 * applies the same rule, so it does not skip the release for want of a namespace.
 */
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { JsMsg, KV } from "nats";
import type { ExecuteRequest } from "@claw/protocol";
import type { Engine } from "../src/agent/index.js";
import type { NatsEmitter } from "../src/events/emitter.js";
import type { TaskRunnerSideEffects } from "../src/tasks/runner.js";

const SESSION = "sess-mn-gpu-ws";
const MESSAGE = "msg-mn-gpu-ws";

/** What the stub SaFE saw: "METHOD /path", and the workspace of each create. */
const safeCalls: string[] = [];
const createdIn: string[] = [];

const safe = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const path = (req.url ?? "").split("?")[0]!;
    safeCalls.push(`${req.method} ${path}`);
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "POST") {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { workspaceId?: string };
      createdIn.push(String(body.workspaceId));
      // Accepted without an id: ensure ends there ("no workloadId"), which is all these
      // tests need of it. What they read is the workspace the create asked for.
      return reply(200, {});
    }
    // Nothing to adopt, and the release's DELETE finds the workload already gone.
    return reply(404, { message: "not found" });
  });
});
await new Promise<void>((resolve) => { safe.listen(0, "127.0.0.1", resolve); });
safe.unref();

// Read once when config.ts loads, hence the dynamic imports below.
process.env.SAFE_API_URL = `http://127.0.0.1:${(safe.address() as AddressInfo).port}`;
process.env.SANDBOX_NAMESPACE = "gpu-ws";
process.env.SANDBOX_CPU_NAMESPACE = "cpu-ws";
process.env.LOCK_REFRESH_INTERVAL_MS = "1000";
delete process.env.CLAW_DEPLOY_MODE;

const { SafeMultiNodeProvider } = await import("../src/sandbox/multi-node/safe-provider.js");
const { gpuWorkspaceFor } = await import("../src/sandbox/workspace-select.js");
const { bindTaskRunnerDeps, runHandleTask } = await import("../src/tasks/runner.js");
const { activeAbort, RUN_ROW_TERMINAL_ABORT_REASON } = await import("../src/tasks/abort-registry.js");

function request(workspaceId: string | undefined, prompt: string): ExecuteRequest {
  return {
    session_id: SESSION,
    message_id: MESSAGE,
    ...(workspaceId === undefined ? {} : { workspace_id: workspaceId }),
    prompt,
    user_id: "u1",
    platform_key: "safe-key",
  } as ExecuteRequest;
}

/** Run ensure to the end (the stub cluster fails) and say which workspace the create named. */
async function workspaceOfCreate(workspaceId: string | undefined): Promise<string> {
  safeCalls.length = 0;
  createdIn.length = 0;
  await assert.rejects(
    () => new SafeMultiNodeProvider().ensure(
      SESSION,
      request(workspaceId, "optimize --nodes 2 --mn-backend rayjob --mn-image img:1"),
      async () => {},
    ),
    /no workloadId/,
  );
  assert.equal(createdIn.length, 1, "exactly one create went out");
  return createdIn[0]!;
}

test("gpuWorkspaceFor: the CPU workspace and nothing both mean the GPU workspace", () => {
  assert.equal(gpuWorkspaceFor(undefined), "gpu-ws");
  assert.equal(gpuWorkspaceFor(null), "gpu-ws");
  assert.equal(gpuWorkspaceFor(""), "gpu-ws");
  assert.equal(gpuWorkspaceFor("  "), "gpu-ws");
  assert.equal(gpuWorkspaceFor("cpu-ws"), "gpu-ws");
  assert.equal(gpuWorkspaceFor(" cpu-ws "), "gpu-ws");
  assert.equal(gpuWorkspaceFor("gpu-ws"), "gpu-ws");
  assert.equal(gpuWorkspaceFor("team-ws"), "team-ws");
});

test("multi-node ensure: a request that names no workspace gets a cluster in the GPU workspace", async () => {
  // The API stamps "" on a task once SANDBOX_CPU_NAMESPACE is set. This was refused
  // with "multi-node request requires workspace_id".
  assert.equal(await workspaceOfCreate(""), "gpu-ws");
  assert.equal(await workspaceOfCreate(undefined), "gpu-ws");
});

test("multi-node ensure: a request that names the CPU workspace does not get a cluster there", async () => {
  // The console sends /v1/me's default with every turn, and that default is the CPU one.
  assert.equal(await workspaceOfCreate("cpu-ws"), "gpu-ws");
});

test("multi-node ensure: a workspace the request names that is not the CPU one is kept", async () => {
  assert.equal(await workspaceOfCreate("team-ws"), "team-ws");
  assert.equal(await workspaceOfCreate("gpu-ws"), "gpu-ws");
});

test("multi-node ensure: SANDBOX_ALLOWED_NAMESPACES refuses a cluster in a workspace off the list before any create", async () => {
  const saved = process.env.SANDBOX_ALLOWED_NAMESPACES;
  process.env.SANDBOX_ALLOWED_NAMESPACES = "team-ws";
  try {
    safeCalls.length = 0;
    createdIn.length = 0;
    await assert.rejects(
      () => new SafeMultiNodeProvider().ensure(
        SESSION,
        request("other-ws", "optimize --nodes 2 --mn-backend rayjob --mn-image img:1"),
        async () => {},
      ),
      (e: unknown) => (e as { reason?: string }).reason === "sandbox_workspace_not_allowed",
    );
    assert.deepEqual(createdIn, [], "a cluster was created in a workspace off the list");
    assert.deepEqual(safeCalls.filter((c) => c.startsWith("POST")), []);
    // Listed, and the deployment's own GPU workspace a request naming nothing goes to, still create.
    assert.equal(await workspaceOfCreate("team-ws"), "team-ws");
    assert.equal(await workspaceOfCreate(""), "gpu-ws");
  } finally {
    if (saved === undefined) delete process.env.SANDBOX_ALLOWED_NAMESPACES;
    else process.env.SANDBOX_ALLOWED_NAMESPACES = saved;
  }
});

// --- the run's own release ----------------------------------------------------

function fakeMsg() {
  const verdicts: string[] = [];
  const msg = {
    info: { deliveryCount: 1 },
    ack() { verdicts.push("ack"); },
    nak(ms?: number) { verdicts.push(`nak:${ms ?? "none"}`); },
    working() {},
    term() { verdicts.push("term"); },
  };
  return { msg: msg as unknown as JsMsg, verdicts };
}

function fakeKv(): KV {
  return {
    async get() { return null; },
    async put() { return 1; },
    async delete() {},
  } as unknown as KV;
}

function stubSideEffects(): Partial<TaskRunnerSideEffects> {
  const resolved = <T>(value: T) => (..._a: unknown[]) => Promise.resolve(value) as never;
  return {
    ensureHands: resolved({
      handsUrl: "http://hands.test",
      created: true,
      token: "t",
      identity: { provider: "safe-workload", workloadId: "wl-test", platformKey: "pk" },
    }),
    destroyHands: resolved(undefined),
    reapPendingHands: resolved(undefined),
    unregisterSandbox: (() => {}) as never,
    markHandsIdle: (() => Promise.resolve({ outcome: "parked" })) as never,
    syncWorkspaceToS3: resolved({ uploaded: 0, totalFiles: 0, failedCount: 0, exhausted: false, empty: true }),
    syncWorkspaceFromS3: resolved(undefined),
    archiveRunToS3: resolved(undefined),
    copyS3Prefix: resolved({ copied: 0 }),
    postAgentDone: resolved(undefined),
    postTaskRunning: resolved(undefined),
    refreshTaskLock: resolved(undefined),
    releaseTaskLock: resolved(undefined),
    flushTranscript: resolved(undefined),
    makeHandsClient: (() => ({ close: async () => {}, reapShells: async () => 1 })) as never,
  };
}

/**
 * A multi-node run whose row went terminal before it had a cluster context, so the release
 * on the way out is the fallback: it has only the request to say which workspace. Returns
 * the namespaces the provider was asked to release in, and the calls SaFE saw.
 */
async function releaseOf(t: TestContext, workspaceId: string): Promise<{ namespaces: string[]; calls: string[] }> {
  safeCalls.length = 0;
  const namespaces: string[] = [];
  const original = SafeMultiNodeProvider.prototype.releaseForMessage;
  SafeMultiNodeProvider.prototype.releaseForMessage = function (this: unknown, ...args: Parameters<typeof original>) {
    namespaces.push(args[1]);
    return original.apply(this as InstanceType<typeof SafeMultiNodeProvider>, args);
  };
  t.after(() => { SafeMultiNodeProvider.prototype.releaseForMessage = original; });

  const { msg } = fakeMsg();
  const kv = fakeKv();
  const engine: Engine = { async execute() { throw new Error("no engine in this scenario"); } };
  bindTaskRunnerDeps({
    kv, kvCkpt: kv,
    emitter: { async emit() {} } as unknown as NatsEmitter,
    engine, sideEffects: stubSideEffects(),
  });
  const abortCtrl = new AbortController();
  const lockKey = `lock.${SESSION}`;
  activeAbort.set(lockKey, abortCtrl);
  abortCtrl.abort(RUN_ROW_TERMINAL_ABORT_REASON);
  await runHandleTask(
    msg,
    request(workspaceId, "train something --nodes=2 --mn-backend=rayjob"),
    SESSION, lockKey, MESSAGE, "u1", abortCtrl,
  );
  return { namespaces, calls: [...safeCalls] };
}

test("the run's release: a request that names no workspace still releases its cluster, in the GPU workspace", async (t) => {
  const { namespaces, calls } = await releaseOf(t, "");
  assert.ok(calls.includes(`DELETE /api/v1/workloads/${MESSAGE}`),
    "with no workspace on the request the fallback used to find no namespace and return without releasing");
  assert.deepEqual(namespaces, ["gpu-ws"]);
});

test("the run's release: a request that names the CPU workspace releases in the GPU workspace", async (t) => {
  const { namespaces, calls } = await releaseOf(t, "cpu-ws");
  assert.ok(calls.includes(`DELETE /api/v1/workloads/${MESSAGE}`));
  assert.deepEqual(namespaces, ["gpu-ws"],
    "the cluster was never in the CPU workspace, so the release is not aimed there");
});

test("the run's release: a workspace the request names that is not the CPU one is kept", async (t) => {
  const { namespaces } = await releaseOf(t, "team-ws");
  assert.deepEqual(namespaces, ["team-ws"]);
});
