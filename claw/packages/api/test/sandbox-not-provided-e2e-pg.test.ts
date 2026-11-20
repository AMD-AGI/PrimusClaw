// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A run whose sandbox the platform did not provide ends failed, with a stable
 * code and the platform's own words, everywhere a caller reads it -- end to end:
 * the API's real create route and claim, Brain's real run, sandbox open and SaFE
 * provider against a fake SaFE over HTTP, and the API's real completion consumer
 * on a real Postgres.
 *
 * On 2026-11-20 SaFE's admission webhook refused the sandbox workload ("timeout
 * 64800 exceeds the qos limit of 10800 seconds for scope Sandbox"); the run
 * ended `class: exited`, `exit_code: null`, with an empty `failure_reason`, and
 * nothing a caller read told a quota refusal from a crash. Skipped without
 * DATABASE_URL; a skip is not a pass.
 *
 * Coverage, each read from the run (`GET /v1/runs`), the run row, the session's
 * events and the run.failed notification (and, for E1 over A2A, `GetTask`):
 *   E1 SaFE's webhook denial (HTTP 400, its production body): sandbox_rejected,
 *      SaFE's text, and the timeout the run asked for beside the one Claw sent;
 *      the same through the A2A route
 *   E2 the workload failed before it was ready (AdminFailed): its code, and the
 *      condition's message
 *   E3 the create answered 5xx every time, a proxy's multi-line text echoing the
 *      env back: sandbox_create_failed, on one line, every env value masked
 *   E4 admitted, and no node takes the pod: sandbox_unschedulable
 *   E5 queued past the capacity wait: sandbox_pending_timeout
 *   E6 the control: SaFE refusing the account the workspace (403), which a run
 *      carries on without by design, is not a failed run
 */

import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { registerHooks } from "node:module";
import type { AddressInfo } from "node:net";
import test, { after, before, beforeEach } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { StringCodec, type JsMsg, type KV } from "nats";
import type pg from "pg";
import { DOORBELL_SEMANTICS_VERSION, isRunDoorbell, type ExecuteRequest, type RunDoorbell } from "@claw/protocol";

import type { UserInfo } from "../src/auth/models.js";
import { startAdmissionCluster, type AdmissionCluster } from "./support/admission-cluster.js";
import { postgresSkipReason } from "./support/pg-cluster.js";

// The A2A route publishes its run straight to JetStream; here, to this file's `js`, whose
// payload Brain then runs (as a2a-context-tasks.test.ts does).
const A2A_MODULE = new URL("../src/routes/a2a.ts", import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === A2A_MODULE && specifier === "../infra/nats.js") {
      return { url: import.meta.url, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
export const sc = StringCodec();
const a2aExecutes: Array<Record<string, unknown>> = [];
export const js = {
  async publish(subject: string, data: Uint8Array): Promise<void> {
    if (subject === "tasks.execute") a2aExecutes.push(JSON.parse(sc.decode(data)));
  },
};
export const nc = { publish(): void {}, subscribe() { return { unsubscribe() {}, async *[Symbol.asyncIterator]() {} }; } };

const skip = postgresSkipReason();
const USER = "user-sandbox-not-provided";
const PLATFORM_KEY = "pk-sandbox-e2e-3c8d1f9a02b7";
/** What the run asks for: 17 hours. Claw adds 3600s, and SaFE's Sandbox ceiling is 3 hours. */
const REQUESTED_TIMEOUT = 61_200;
/** SaFE's answer to the 2026-11-20 create, byte for byte in shape (apiserver `PrimusApiError` around the webhook's status). */
const WEBHOOK_DENIAL = JSON.stringify({
  errorCode: "Primus.00002",
  errorMessage: "admission webhook \"vworkload.kb.io\" denied the request: Bad request. "
    + "timeout 64800 exceeds the qos limit of 10800 seconds for scope Sandbox",
});

type Mode = "rejected" | "forbidden" | "admin_failed" | "create_5xx" | "unschedulable" | "queued";
let mode: Mode = "rejected";
/** Every request the fake SaFE received: method, path, and the create's body. */
let safeCalls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
let safe: Server;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => { data += c; });
    req.on("end", () => resolve(data));
  });
}

/** SaFE's workload API as this test needs it, in the shapes the live platform answers with. */
async function startFakeSafe(): Promise<string> {
  safe = createServer(async (req, res) => {
    const raw = await readBody(req);
    const path = (req.url ?? "").split("?")[0]!;
    safeCalls.push({ method: req.method ?? "", path, ...(raw ? { body: JSON.parse(raw) } : {}) });
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    if (req.method === "POST" && path === "/api/v1/workloads") {
      if (mode === "rejected") return send(400, WEBHOOK_DENIAL);
      if (mode === "forbidden") {
        return send(403, { errorCode: "Primus.00003", errorMessage: `The user(${USER}) is not allowed to create workload, workspace: [default]` });
      }
      if (mode === "create_5xx") {
        // A proxy's plain-text 503, on several lines, echoing the request's env back:
        // what reaches the run must be one line with every credential in it masked.
        const env = (safeCalls.at(-1)?.body?.env ?? {}) as Record<string, string>;
        const echoed = Object.entries(env).map(([k, v]) => `${k}=${v}`).join("\n");
        res.writeHead(503, { "content-type": "text/plain" });
        return res.end(`upstream connect error or disconnect/reset before headers.\nreset reason: connection termination\n${echoed}`);
      }
      return send(200, { workloadId: "claw-e2e-sandbox-k7m2p" });
    }
    if (req.method === "GET" && path.startsWith("/api/v1/workloads/")) {
      if (mode === "admin_failed") {
        return send(200, {
          phase: "Failed",
          conditions: [{
            type: "AdminFailed", status: "True", reason: "FailedCreatePod",
            message: "pods \"claw-e2e-sandbox-k7m2p\" is forbidden: exceeded quota: sandbox-quota, requested: cpu=4, limited: cpu=2",
          }],
        });
      }
      if (mode === "unschedulable") {
        return send(200, {
          phase: "NotReady", queuePosition: null, pods: null,
          message: "In queue - waiting for scale-up - 0/3 nodes are available: 3 node(s) were unschedulable. - "
            + "NotTriggerScaleUp: pod didn't trigger scale-up: pool p1: NoHeadroom: the pods need 1 new node(s)",
        });
      }
      return send(200, { phase: "Pending", queuePosition: 2, pods: null, message: "In queue - insufficient resources" });
    }
    // A stop, and anything else: accepted.
    return send(200, {});
  });
  await new Promise<void>((r) => safe.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${(safe.address() as AddressInfo).port}`;
}

let harness: AdmissionCluster;
let client: pg.Client;
let app: FastifyInstance;
let ports: typeof import("../src/sessions/dispatch.js")["sessionDispatchPorts"];
let originalPorts: typeof ports;
let gate: typeof import("../src/tasks/doorbell-gate.js");
let brain: typeof import("../../brain/src/tasks/runner.js");
let published: RunDoorbell[];
let consumerErrors: unknown[];
let seq = 0;

/** A JetStream KV bucket in memory, with its compare-and-set answers (`wrong last sequence`). */
function fakeKv(): KV {
  const enc = new TextEncoder();
  const map = new Map<string, { value: Uint8Array; revision: number }>();
  let last = 0;
  const conflict = (seq: number) => new Error(`wrong last sequence: ${seq}`);
  const bytes = (v: Uint8Array | string) => (typeof v === "string" ? enc.encode(v) : v);
  const matches = (key: string, filter: string) => {
    const re = new RegExp(`^${filter.split(".").map((t) => (t === ">" ? ".+" : t === "*" ? "[^.]+" : t.replace(/[-/\\^$+?()|[\]{}]/g, "\\$&"))).join("\\.")}$`);
    return re.test(key);
  };
  return {
    async get(key: string) {
      const held = map.get(key);
      return held ? { key, value: held.value, revision: held.revision, operation: "PUT" } : null;
    },
    async put(key: string, value: Uint8Array | string) {
      map.set(key, { value: bytes(value), revision: ++last });
      return last;
    },
    async create(key: string, value: Uint8Array | string) {
      if (map.has(key)) throw conflict(map.get(key)!.revision);
      map.set(key, { value: bytes(value), revision: ++last });
      return last;
    },
    async update(key: string, value: Uint8Array | string, revision?: number) {
      if (revision !== undefined && map.get(key)?.revision !== revision) throw conflict(map.get(key)?.revision ?? 0);
      map.set(key, { value: bytes(value), revision: ++last });
      return last;
    },
    async delete(key: string, opts?: { previousSeq?: number }) {
      const held = map.get(key);
      if (opts?.previousSeq && (!held || held.revision !== opts.previousSeq)) throw conflict(held?.revision ?? 0);
      map.delete(key);
    },
    async purge(key: string) { map.delete(key); },
    async keys(filter = ">") {
      const matched = [...map.keys()].filter((k) => matches(k, filter));
      return (async function* () { yield* matched; })();
    },
  } as unknown as KV;
}

before(async () => {
  if (skip) return;
  const safeUrl = await startFakeSafe();
  // Read once when Brain's config loads, so set before the first import of it.
  Object.assign(process.env, {
    SAFE_API_URL: safeUrl,
    SANDBOX_UNSCHEDULABLE_TIMEOUT_SECONDS: "1",
    SANDBOX_PENDING_TIMEOUT_SECONDS: "2",
  });
  harness = await startAdmissionCluster({
    RUN_DOORBELL_DISPATCH: "true", CLAW_NOTIFICATIONS_ENABLED: "true", CLAW_A2A_CONTEXT_TASKS: "1",
    // The deployment's default sandbox, which the API seeds and puts on the request.
    DEFAULT_SANDBOX_IMAGE: "registry.test/claw/sandbox:1",
  });
  client = await harness.connect();
  ({ sessionDispatchPorts: ports } = await import("../src/sessions/dispatch.js"));
  originalPorts = { ...ports };
  gate = await import("../src/tasks/doorbell-gate.js");
  const { tombstoneReader } = await import("../src/events/consumer.js");
  Object.assign(tombstoneReader, { has: async () => false });
  const { registerRunRoutes } = await import("../src/runs/routes.js");
  app = Fastify();
  app.addHook("onRequest", async (req) => {
    (req as unknown as { user: UserInfo }).user = {
      userId: USER, userName: USER, roles: ["default"], platformKey: PLATFORM_KEY, virtualKey: "vk-test",
    };
    (req as unknown as { authMethod: unknown }).authMethod = "api_key";
  });
  await harness.app.sessions.registerSessionRoutes(app);
  await registerRunRoutes(app);
  await (await import("../src/routes/a2a.js")).registerA2ARoutes(app);
  await app.ready();

  brain = await import("../../brain/src/tasks/runner.js");
  const { bindHandsKv } = await import("../../brain/src/sandbox/registry.js");
  const { NatsEmitter } = await import("../../brain/src/events/emitter.js");
  const { consumeEventDelivery } = await import("../src/events/consumer.js");
  const { resetDeletedSessionCache } = await import("../src/sessions/deleted-cache.js");
  const kv = fakeKv();
  bindHandsKv(kv);
  (await import("../../brain/src/sandbox/handles.js")).bindDagHandlesForTest(fakeKv());
  // Brain's own emitter, publishing into the API's own consumer: what JetStream carries between them.
  const emitter = new NatsEmitter();
  (emitter as unknown as { js: unknown }).js = {
    async publish(subject: string, payload: Uint8Array) {
      resetDeletedSessionCache();
      await consumeEventDelivery({
        subject, data: payload, seq: ++seq, ack: () => {}, nak: () => {},
      } as unknown as JsMsg).catch((err) => { consumerErrors.push(err); });
      return { seq };
    },
  };
  const noop = <T>(v: T) => (() => Promise.resolve(v)) as never;
  brain.bindTaskRunnerDeps({
    kv, kvCkpt: fakeKv(), emitter,
    // The model, as the agent loop runs it: one tool call that needs the sandbox,
    // then an answer written from what the tool said.
    engine: {
      async execute(_r: unknown, _e: unknown, _s: unknown, _h: unknown, extras?: { attachHands?: () => Promise<unknown> }) {
        const said = await extras!.attachHands!().then(() => "the sandbox is up", (err: Error) => err.message);
        return {
          finalText: `I could not run it: ${said}`,
          tokenUsage: { input_tokens: 1, output_tokens: 1, cache_read: 0, cache_create: 0 },
          turns: 1, pendingSkills: [], skillsUsed: {}, errorCount: 1,
          toolStats: { total_calls: 1, error_calls: 1, by_tool: { bash: 1 } }, elapsedMs: 5,
        };
      },
    } as never,
    // The run's own bookkeeping with the API and S3, which this test is not about.
    sideEffects: {
      postTaskRunning: noop(undefined),
      postRunLease: noop("running"),
      settleRunAttempt: noop(undefined),
      refreshTaskLock: noop(undefined),
      releaseTaskLock: noop(undefined),
      flushTranscript: noop(undefined),
      syncWorkspaceToS3: noop({ uploaded: 0, totalFiles: 0, failedCount: 0, exhausted: false, empty: true }),
      syncWorkspaceFromS3: noop(undefined),
      archiveRunToS3: noop(undefined),
      copyS3Prefix: noop({ copied: 0 }),
      syncWorkspace: noop({ ok: true }),
      restoreWorkspace: noop({ ok: true }),
      fetchPlatformFacts: noop(null),
      markHandsIdle: (() => Promise.resolve({ outcome: "parked" })) as never,
      makeHandsClient: (() => ({ close: async () => {} })) as never,
    } as never,
  });
});

beforeEach(async () => {
  if (skip) return;
  await client.query("TRUNCATE claw_tasks, claw_sessions, claw_workspaces CASCADE");
  await client.query("TRUNCATE claw_conversation_turns");
  await client.query("TRUNCATE claw_session_events");
  await client.query("DELETE FROM claw_notification_outbox");
  await client.query("DELETE FROM claw_notification_subscriptions");
  Object.assign(ports, originalPorts);
  published = [];
  consumerErrors = [];
  safeCalls = [];
  gate.setDoorbellLatch({ state: "floor", version: DOORBELL_SEMANTICS_VERSION });
  ports.publishSse = () => {};
});

after(async () => {
  if (skip) return;
  Object.assign(ports, originalPorts);
  gate.resetDoorbellGate();
  await app?.close();
  await harness?.stop();
  await new Promise<void>((r) => safe?.close(() => r()));
});

/**
 * One message on a new session, through the API's create route; the run is
 * claimed as a brain claims it, and the request the claim assembles is run by
 * Brain. Returns once the run's completion has been consumed.
 */
async function runOnce(): Promise<{ sessionId: string; runId: string; request: ExecuteRequest }> {
  const { claimRunById } = await import("../src/tasks/run-claim.js");
  let request: ExecuteRequest | null = null;
  ports.publishTask = async (_subject, payload) => {
    const doorbell: unknown = JSON.parse(payload);
    assert.ok(isRunDoorbell(doorbell));
    published.push(doorbell);
    return 1;
  };
  const response = await app.inject({
    method: "POST", url: "/v1/sessions",
    payload: {
      name: "probe", config: { notify_on_finish: true },
      message: { content: "run the build", timeout: REQUESTED_TIMEOUT },
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(published.length, 1);
  const doorbell = published[0]!;
  const claimed = await claimRunById(doorbell.task_id, "brain-e2e");
  assert.ok(claimed && typeof claimed === "object" && "request" in claimed, `claimed: ${JSON.stringify(claimed)}`);
  request = claimed.request;
  // A run announced on its end: a subscription, and the session counted as long-running.
  await client.query(
    `INSERT INTO claw_notification_subscriptions (subscription_id, owner_user_id, url, secret_enc, event_types)
     VALUES (gen_random_uuid(), $1, 'https://hooks.example.com/claw', 'x', ARRAY['run.failed','run.completed'])`, [USER],
  );
  await client.query("UPDATE claw_tasks SET run_time_epoch_at = NOW() - interval '2 hours' WHERE task_id = $1", [doorbell.task_id]);
  await runBrain(request, doorbell.session_id, request.message_id ?? doorbell.message_id);
  return { sessionId: doorbell.session_id, runId: doorbell.task_id, request };
}

/** Run `request` as a brain that took it off the queue does, and wait for its completion to be consumed. */
async function runBrain(request: ExecuteRequest, sessionId: string, messageId: string): Promise<void> {
  const msg = { seq: 1, redelivered: false, info: { deliveryCount: 1 }, ack() {}, nak() {}, term() {}, working() {} } as unknown as JsMsg;
  await brain.runHandleTask(msg, request, sessionId, `lock.${sessionId}`, messageId, USER, new AbortController());
  assert.deepEqual(consumerErrors, []);
}

let rpcId = 0;
async function rpc(method: string, params: unknown): Promise<Record<string, any>> {
  const res = await app.inject({
    method: "POST", url: "/a2a", headers: { "a2a-version": "1.0" },
    payload: { jsonrpc: "2.0", id: ++rpcId, method, params },
  });
  assert.equal(res.statusCode, 200, res.body);
  return JSON.parse(res.body) as Record<string, any>;
}

/** One A2A message through the real route; the run it opens is run by Brain. Returns the task id and its session. */
async function runA2A(): Promise<{ taskId: string; sessionId: string }> {
  a2aExecutes.length = 0;
  const sent = await rpc("SendMessage", {
    message: { messageId: `m-${++rpcId}`, role: "ROLE_USER", parts: [{ text: "run the build" }] },
    configuration: { returnImmediately: true },
  });
  const taskId = String(sent.result?.task?.id ?? "");
  assert.ok(taskId, JSON.stringify(sent));
  assert.equal(a2aExecutes.length, 1, "the route published the run");
  const request = a2aExecutes[0]! as unknown as ExecuteRequest;
  await client.query(
    `INSERT INTO claw_notification_subscriptions (subscription_id, owner_user_id, url, secret_enc, event_types)
     VALUES (gen_random_uuid(), $1, 'https://hooks.example.com/claw', 'x', ARRAY['run.failed','run.completed'])
     ON CONFLICT DO NOTHING`, [USER],
  );
  // Announced on its end, as a long run of a session that asked to be told.
  await client.query(
    `UPDATE claw_sessions SET config = COALESCE(config, '{}'::jsonb) || '{"notify_on_finish": true}'::jsonb WHERE session_id = $1`,
    [request.session_id],
  );
  await client.query("UPDATE claw_tasks SET run_time_epoch_at = NOW() - interval '2 hours' WHERE task_id = $1", [taskId]);
  await runBrain(request, request.session_id, String(request.message_id));
  return { taskId, sessionId: request.session_id };
}

interface Seen {
  run: Record<string, any>;
  row: Record<string, any>;
  sandboxFailed: Array<Record<string, any>>;
  notice: Record<string, any> | undefined;
}

/** What each surface a caller reads says about the run. */
async function seen(sessionId: string, runId: string): Promise<Seen> {
  const response = await app.inject({ method: "GET", url: `/v1/runs?session_ids=${sessionId}` });
  assert.equal(response.statusCode, 200, response.body);
  const runs = (response.json() as { runs: Array<Record<string, any>> }).runs;
  assert.equal(runs.length, 1, response.body);
  const { rows: [row] } = await client.query(
    "SELECT status, failure_reason, error_message FROM claw_tasks WHERE task_id = $1", [runId],
  );
  const { rows: events } = await client.query(
    "SELECT data FROM claw_session_events WHERE session_id = $1 AND event = 'sandboxStatus' ORDER BY id", [sessionId],
  );
  const { rows: notices } = await client.query(
    "SELECT payload FROM claw_notification_outbox WHERE payload->>'task_id' = $1", [runId],
  );
  return {
    run: runs[0]!,
    row: row!,
    sandboxFailed: events.map((e) => e.data).filter((d) => d.status === "failed"),
    notice: notices[0]?.payload,
  };
}

/**
 * Every surface says the run failed, with `reason`, and with a message matching `said`. The runs view
 * classes a run the platform's deadline ended as `killed` (`deadline`), as it always has; its row is failed.
 */
function assertFailedEverywhere(s: Seen, reason: string, said: RegExp, runClass = "failed"): void {
  assert.equal(s.run.phase, "terminal");
  assert.equal(s.run.terminal.class, runClass, JSON.stringify(s.run.terminal));
  assert.equal(s.run.terminal.failure_reason, reason);
  assert.match(s.run.terminal.failure_message, said);
  assert.equal(s.row.status, "failed");
  assert.equal(s.row.failure_reason, reason);
  assert.match(s.row.error_message, said);
  assert.ok(s.sandboxFailed.some((e) => e.reason === reason && said.test(String(e.message))), JSON.stringify(s.sandboxFailed));
  assert.ok(s.notice, "a run.failed notification is recorded");
  assert.equal(s.notice!.type, "run.failed");
  assert.ok(String(s.notice!.summary).startsWith(`${reason}: `), s.notice!.summary);
  assert.match(String(s.notice!.summary), said);
  for (const text of [s.run.terminal.failure_message, s.row.error_message, s.notice!.summary]) {
    assert.ok(!String(text).includes(PLATFORM_KEY), `the platform key left the run: ${text}`);
  }
}

test("E1 SaFE's webhook denial: sandbox_rejected, SaFE's words, and the timeout asked for beside the one sent", { skip }, async () => {
  mode = "rejected";
  const { sessionId, runId, request } = await runOnce();
  assert.equal(request.timeout, REQUESTED_TIMEOUT, "the request carries the timeout the caller asked for");
  const creates = safeCalls.filter((c) => c.method === "POST");
  assert.equal(creates.length, 1, "a refused create is not sent again within the run");
  assert.equal(creates[0]!.body!.timeout, REQUESTED_TIMEOUT + 3600, "Claw sends the requested timeout plus its stop buffer");
  const s = await seen(sessionId, runId);
  assertFailedEverywhere(s, "sandbox_rejected", /timeout 64800 exceeds the qos limit of 10800 seconds for scope Sandbox/);
  const message = s.run.terminal.failure_message as string;
  assert.match(message, /^The platform refused to create the sandbox \(HTTP 400\): admission webhook "vworkload\.kb\.io" denied the request/);
  assert.match(message, /The run asked for timeout=61200s; Claw adds 3600s to stop the run cleanly and sent timeout=64800s, above the platform's limit of 10800s\./);
  assert.ok(!message.includes("Primus.00002"), "the platform's error code is not the message");
  // The conversation keeps the answer the model wrote from what the tool said.
  const { rows: turns } = await client.query(
    "SELECT role, content FROM claw_conversation_turns WHERE session_id = $1 ORDER BY turn_index", [sessionId],
  );
  assert.ok(turns.some((t) => t.role === "assistant" && /qos limit/.test(t.content)), JSON.stringify(turns));
});

test("E1 over A2A: GetTask says TASK_STATE_FAILED, with SaFE's words and the code", { skip }, async () => {
  mode = "rejected";
  const { taskId, sessionId } = await runA2A();
  const got = await rpc("GetTask", { id: taskId });
  const status = got.result?.status as { state: string; message?: { parts: Array<{ text?: string }>; metadata?: Record<string, unknown> } };
  assert.equal(status.state, "TASK_STATE_FAILED", JSON.stringify(got));
  assert.match(String(status.message?.parts[0]?.text), /timeout \d+ exceeds the qos limit of 10800 seconds for scope Sandbox/);
  assert.match(String(status.message?.parts[0]?.text), /^The platform refused to create the sandbox \(HTTP 400\)/);
  assert.deepEqual(status.message?.metadata, { failure_reason: "sandbox_rejected" });
  assert.ok(!String(status.message?.parts[0]?.text).includes(PLATFORM_KEY));
  // And the same run read as a run, with its notification.
  const s = await seen(sessionId, taskId);
  assertFailedEverywhere(s, "sandbox_rejected", /exceeds the qos limit of 10800 seconds/);
});

test("E2 a workload that failed before it was ready (AdminFailed): its code and the condition's message", { skip }, async () => {
  mode = "admin_failed";
  const { sessionId, runId } = await runOnce();
  assertFailedEverywhere(await seen(sessionId, runId), "sandbox_workload_terminal",
    /entered terminal phase=failed \(AdminFailed: FailedCreatePod: pods "claw-e2e-sandbox-k7m2p" is forbidden: exceeded quota/);
});

test("E3 a create answered 5xx: sandbox_create_failed, with the status", { skip }, async () => {
  mode = "create_5xx";
  const { sessionId, runId } = await runOnce();
  const s = await seen(sessionId, runId);
  assertFailedEverywhere(s, "sandbox_create_failed", /Create Hands failed: HTTP 503 upstream connect error or disconnect\/reset before headers\. reset reason: connection termination /);
  const env = safeCalls.find((c) => c.method === "POST")!.body!.env as Record<string, string>;
  // Any of them may be a credential under an innocent name (a sandbox spec's own
  // env is sent as written), so none long enough to be one may come back unmasked.
  const credentials = Object.values(env).filter((v) => typeof v === "string" && v.length >= 16);
  assert.ok(credentials.length > 0, "the sandbox's env carries values for the platform to echo");
  const texts = [s.run.terminal.failure_message, s.row.error_message, s.notice!.summary, ...s.sandboxFailed.map((e) => e.message)];
  for (const text of texts) {
    assert.ok(!/[\r\n]/.test(String(text)), `on one line: ${JSON.stringify(text)}`);
    for (const c of credentials) assert.ok(!String(text).includes(c), `a value the sandbox's env was sent left the run unmasked: ${text}`);
  }
  assert.match(String(s.run.terminal.failure_message), /<redacted>/, "the echoed env is in the message, masked");
});

test("E4 admitted, and no node takes the pod: sandbox_unschedulable", { skip, timeout: 60_000 }, async () => {
  mode = "unschedulable";
  const { sessionId, runId } = await runOnce();
  assertFailedEverywhere(await seen(sessionId, runId), "sandbox_unschedulable", /could not be scheduled/);
});

test("E5 queued past the capacity wait: sandbox_pending_timeout", { skip, timeout: 60_000 }, async () => {
  mode = "queued";
  const { sessionId, runId } = await runOnce();
  const s = await seen(sessionId, runId);
  assertFailedEverywhere(s, "sandbox_pending_timeout", /still queued \(Pending\) after 2\.0s/, "killed");
  assert.equal(s.run.terminal.kill_reason, "deadline");
});

test("E6 the control: an account SaFE refuses the workspace to (403) carries on, and the run is not failed for it", { skip }, async () => {
  mode = "forbidden";
  const { sessionId, runId } = await runOnce();
  assert.equal(safeCalls.filter((c) => c.method === "POST").length, 1, "the create was asked, and refused");
  const s = await seen(sessionId, runId);
  assert.equal(s.run.terminal.class, "exited", JSON.stringify(s.run.terminal));
  assert.equal(s.run.terminal.failure_reason, "");
  assert.notEqual(s.row.status, "failed");
  assert.equal(s.notice?.type, "run.completed");
});
