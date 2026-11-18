// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A session's placement binds its multi-node GPU cluster as it binds its Hands sandbox.
 *
 * A multi-node run creates its cluster (a RayJob or an InferaDeployment workload) before
 * the Hands sandbox, through its own create body. Every pod of that cluster must require
 * the session's node labels too, or the sandbox would wait on the nodes the session named
 * while the GPU workers ran on any node at all. And a placement that does not pass the
 * check must stop the run before the cluster exists, not at the Hands sandbox after it.
 *
 *   M1 both bodies carry the labels as `customerLabels`; without them the body is unchanged
 *   M2 the provider's create, against a stand-in SaFE, sends them (RayJob and InferaDeployment)
 *   M3 a placement that fails the check asks SaFE nothing at all
 *   M4 through the run: the cluster the runner opens carries them, and a bad one opens nothing
 *   M5 a cluster an earlier delivery left is adopted only when it carries the same labels; one
 *      created without them (by a Brain that did not read the placement) is deleted and
 *      created again with them, and without a placement adoption is what it always was
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { JsMsg, KV } from "nats";
import type { ExecuteRequest } from "@claw/protocol";
import type { Engine } from "../src/agent/index.js";
import type { NatsEmitter } from "../src/events/emitter.js";
import type { TaskRunnerSideEffects } from "../src/tasks/runner.js";

const SESSION = "sess-mn-placement";
const MESSAGE = "msg-mn-placement";
const LABELS = { "autopilot.amd.com/preemptible": "false", "example.com/pool": "reserved" };

/** What the stand-in SaFE saw: "METHOD /path", and each create body. */
const safeCalls: string[] = [];
const creates: Array<Record<string, unknown>> = [];
/** The workload an earlier delivery left under the message id, as SaFE's GET describes it; null: none. */
let existing: Record<string, unknown> | null = null;

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
    if (req.method === "POST" && path === "/api/v1/workloads") {
      creates.push(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>);
      // Accepted without an id: ensure ends there ("no workloadId"). What these tests
      // read is the body the create sent.
      return reply(200, {});
    }
    if (path === `/api/v1/workloads/${MESSAGE}` && existing) {
      if (req.method === "GET") return reply(200, existing);
      if (req.method === "DELETE") {
        existing = null;
        return reply(200, {});
      }
    }
    // Nothing to adopt, and a release finds the workload already gone.
    return reply(404, { message: "not found" });
  });
});
await new Promise<void>((resolve) => { safe.listen(0, "127.0.0.1", resolve); });
safe.unref();

// Read once when config.ts loads, hence the dynamic imports below.
process.env.SAFE_API_URL = `http://127.0.0.1:${(safe.address() as AddressInfo).port}`;
process.env.SANDBOX_NAMESPACE = "gpu-ws";
process.env.AUTH_INTERNAL_TOKEN ??= "test-internal-token";
process.env.LOCK_REFRESH_INTERVAL_MS = "1000";
delete process.env.CLAW_DEPLOY_MODE;

const { SafeMultiNodeProvider } = await import("../src/sandbox/multi-node/safe-provider.js");
const { buildInferaWorkloadBody, buildRayJobWorkloadBody } = await import("../src/sandbox/multi-node/safe-body.js");
const { SANDBOX_PLACEMENT_INVALID } = await import("../src/sandbox/create-sandbox.js");
const { SandboxProvisionTerminalError } = await import("../src/sandbox/errors.js");
const { bindTaskRunnerDeps, runHandleTask } = await import("../src/tasks/runner.js");
const { activeAbort } = await import("../src/tasks/abort-registry.js");

const RAYJOB = "optimize --nodes 2 --mn-backend rayjob --mn-image img:1";
const INFERA = "optimize --nodes 2 --mn-backend infera --model /models/m --mn-image img:1";

function request(prompt: string, placement?: unknown): ExecuteRequest {
  return {
    session_id: SESSION,
    message_id: MESSAGE,
    workspace_id: "gpu-ws",
    prompt,
    user_id: "u1",
    platform_key: "safe-key",
    ...(placement === undefined ? {} : { placement }),
  } as ExecuteRequest;
}

function reset(): void {
  safeCalls.length = 0;
  creates.length = 0;
  existing = null;
}

// --- M1 the bodies --------------------------------------------------------------

const COMMON = {
  workspace: "ws", displayName: "msg1-rayjob", image: "img:1", nodes: 2, gpusPerNode: 8, cpusPerNode: 64,
  memGiPerNode: 512, ephemeralGiPerNode: 100, sessionId: "s1", messageId: "msg1",
};
const INFERA_EXTRA = {
  sshAuthorizedKey: "ssh-ed25519 AAAA test", model: "/models/m", framework: "sglang",
  kvTransferBackend: "mooncake", pdMode: "aggregated" as const,
};
const BUILDERS: Array<[string, (nodeLabels?: Record<string, string>) => Record<string, unknown>]> = [
  ["RayJob", (nodeLabels) => buildRayJobWorkloadBody({ ...COMMON, ...(nodeLabels ? { nodeLabels } : {}) })],
  ["InferaDeployment", (nodeLabels) => buildInferaWorkloadBody({
    ...COMMON, displayName: "msg1-infera", ...INFERA_EXTRA, ...(nodeLabels ? { nodeLabels } : {}),
  })],
];

for (const [kind, build] of BUILDERS) {
  test(`M1 ${kind}: the labels are the body's customerLabels, and nothing else changes`, () => {
    const plain = build();
    const placed = build(LABELS);
    assert.deepEqual(placed.customerLabels, LABELS);
    const { customerLabels: _dropped, ...rest } = placed;
    assert.equal(JSON.stringify(rest), JSON.stringify(plain), "the rest of the body changed");
    // A copy, not the caller's object.
    assert.notEqual(placed.customerLabels, LABELS);
  });

  test(`M1 ${kind}: without labels, or with none, the body has no customerLabels and is byte-identical`, () => {
    const plain = build();
    assert.equal("customerLabels" in plain, false);
    assert.equal(JSON.stringify(build({})), JSON.stringify(plain));
  });
}

// --- M2 / M3 the provider -------------------------------------------------------

async function ensureFails(prompt: string, placement?: unknown, left: Record<string, unknown> | null = null): Promise<unknown> {
  reset();
  existing = left;
  let caught: unknown;
  await new SafeMultiNodeProvider().ensure(SESSION, request(prompt, placement), async () => {})
    .catch((e: unknown) => { caught = e; });
  assert.ok(caught, "ensure succeeded against a SaFE that names no workload");
  return caught;
}

for (const [kind, prompt] of [["RayJob", RAYJOB], ["InferaDeployment", INFERA]] as const) {
  test(`M2 ${kind}: the provider's create sends the session's labels as customerLabels`, async () => {
    const err = await ensureFails(prompt, { nodeLabels: LABELS });
    assert.match(String((err as Error).message), /no workloadId/);
    assert.equal(creates.length, 1, "exactly one create went out");
    assert.equal((creates[0]!.groupVersionKind as { kind: string }).kind, kind);
    assert.deepEqual(creates[0]!.customerLabels, LABELS);
  });

  test(`M2 ${kind}: without a placement the create sends no customerLabels`, async () => {
    for (const placement of [undefined, { nodeLabels: {} }]) {
      await ensureFails(prompt, placement);
      assert.equal(creates.length, 1);
      assert.equal("customerLabels" in creates[0]!, false, JSON.stringify(placement));
    }
  });
}

const BAD: Array<[string, unknown]> = [
  ["the hostname key", { nodeLabels: { "kubernetes.io/hostname": "node-1" } }],
  ["the excluded-nodes key", { nodeLabels: { "excluded-nodes": "node-1" } }],
  ["a value with a space", { nodeLabels: { "example.com/pool": "a b" } }],
  ["not an object", "pool=a"],
];

for (const [label, placement] of BAD) {
  test(`M3 ${label}: refused with its own reason before SaFE is asked anything`, async () => {
    const err = await ensureFails(RAYJOB, placement);
    assert.ok(err instanceof SandboxProvisionTerminalError, String(err));
    assert.equal(err.reason, SANDBOX_PLACEMENT_INVALID);
    assert.deepEqual(safeCalls, [], "SaFE was asked something for a placement that fails the check");
  });
}

// --- M4 through the run -----------------------------------------------------------

function fakeMsg(): JsMsg {
  return {
    info: { deliveryCount: 1 },
    ack() {}, nak() {}, working() {}, term() {},
  } as unknown as JsMsg;
}

function fakeKv(): KV {
  return {
    async get() { return null; },
    async put() { return 1; },
    async create() { return 1; },
    async update() { return 1; },
    async delete() {},
  } as unknown as KV;
}

/** Side effects that keep the run off the network; counts the Hands sandbox opens. */
function sideEffects(counter: { ensureHands: number }): Partial<TaskRunnerSideEffects> {
  const resolved = <T>(value: T) => (..._a: unknown[]) => Promise.resolve(value) as never;
  return {
    ensureHands: ((..._a: unknown[]) => {
      counter.ensureHands++;
      return Promise.resolve({
        handsUrl: "http://hands.test", created: true, token: "t",
        identity: { provider: "safe-workload", workloadId: "wl-test", platformKey: "pk" },
      });
    }) as never,
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

/** One run of the request through the task runner; returns what it emitted and opened. */
async function run(req: ExecuteRequest): Promise<{ events: Array<Record<string, unknown>>; ensureHands: number }> {
  reset();
  const events: Array<Record<string, unknown>> = [];
  const counter = { ensureHands: 0 };
  const kv = fakeKv();
  const engine: Engine = { async execute() { throw new Error("no engine in this scenario"); } };
  bindTaskRunnerDeps({
    kv, kvCkpt: kv,
    emitter: { async emit(_s: string, e: Record<string, unknown>) { events.push(e); } } as unknown as NatsEmitter,
    engine, sideEffects: sideEffects(counter),
  });
  const abortCtrl = new AbortController();
  const lockKey = `lock.${SESSION}`;
  activeAbort.set(lockKey, abortCtrl);
  await runHandleTask(fakeMsg(), req, SESSION, lockKey, MESSAGE, "u1", abortCtrl);
  return { events, ensureHands: counter.ensureHands };
}

test("M4 the cluster a run opens carries the session's labels", async () => {
  await run(request(RAYJOB, { nodeLabels: LABELS }));
  const posts = creates.filter((b) => (b.groupVersionKind as { kind: string }).kind === "RayJob");
  assert.equal(posts.length, 1, `the run did not create its cluster: ${safeCalls.join(", ")}`);
  assert.deepEqual(posts[0]!.customerLabels, LABELS);
});

test("M4 a run whose placement fails the check opens no cluster and no sandbox", async () => {
  const r = await run(request(RAYJOB, { nodeLabels: { "kubernetes.io/hostname": "node-1" } }));
  assert.deepEqual(safeCalls.filter((c) => c.startsWith("POST")), [], "a cluster was created");
  assert.deepEqual(creates, []);
  assert.equal(r.ensureHands, 0, "the Hands sandbox was opened");
  assert.match(JSON.stringify(r.events), /placement/, "the run did not say why");
});

// --- M5 adopting what an earlier delivery left ------------------------------------

/** A RayJob cluster an earlier delivery created, running, with these customerLabels (absent: SaFE's null). */
function leftCluster(customerLabels: Record<string, string> | null): Record<string, unknown> {
  return {
    workloadId: MESSAGE, phase: "Running", groupVersionKind: { kind: "RayJob", version: "v1" },
    customerLabels, pods: [],
  };
}

test("M5 a cluster left without the session's labels is deleted, and created again with them", async () => {
  for (const left of [null, {}, { "example.com/pool": "reserved" }, { ...LABELS, "example.com/extra": "x" }]) {
    const err = await ensureFails(RAYJOB, { nodeLabels: LABELS }, leftCluster(left));
    assert.match(String((err as Error).message), /no workloadId/, JSON.stringify(left));
    assert.ok(safeCalls.includes(`DELETE /api/v1/workloads/${MESSAGE}`), `not deleted: ${JSON.stringify(left)}`);
    assert.equal(creates.length, 1, `not created again: ${JSON.stringify(left)}`);
    assert.deepEqual(creates[0]!.customerLabels, LABELS);
  }
});

test("M5 a cluster left with the session's labels is adopted: no delete, no create", async () => {
  reset();
  existing = leftCluster({ ...LABELS });
  const ac = new AbortController();
  const events: Array<Record<string, unknown>> = [];
  await new SafeMultiNodeProvider().ensure(SESSION, request(RAYJOB, { nodeLabels: LABELS }), async (e) => {
    events.push(e as Record<string, unknown>);
  }, { signal: ac.signal }).catch(() => {});
  assert.ok(events.some((e) => String(e.status ?? "").includes("reused")), JSON.stringify(events));
  assert.equal(safeCalls.filter((c) => c.startsWith("DELETE")).length, 0, safeCalls.join(", "));
  assert.deepEqual(creates, []);
});

test("M5 without a placement a left cluster is adopted whatever it carries, as before", async () => {
  for (const left of [null, { ...LABELS }]) {
    reset();
    existing = leftCluster(left);
    const events: Array<Record<string, unknown>> = [];
    await new SafeMultiNodeProvider().ensure(SESSION, request(RAYJOB), async (e) => {
      events.push(e as Record<string, unknown>);
    }).catch(() => {});
    assert.ok(events.some((e) => String(e.status ?? "").includes("reused")), JSON.stringify(events));
    assert.equal(safeCalls.filter((c) => c.startsWith("DELETE")).length, 0, safeCalls.join(", "));
    assert.deepEqual(creates, []);
  }
});
