// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A2A push notifications (CLAW_A2A_PUSH_ENABLED), against a real Postgres.
 * NATS is this file's own exports (a resolve hook, as in
 * a2a-context-tasks.test.ts); the webhook transport and the resolver are
 * injected, so what goes on the wire, and to which address, is read directly.
 *
 * Coverage:
 *   (P1, the shape of a config, is pure and lives in a2a-push-config.test.ts: this file points the
 *   database modules at a private database, so it must not load them before the cluster is up)
 *   P2 the four methods: owner-scoped, secrets never returned, bounded, idempotent delete
 *   P3 a send that carries a config: a refused callback leaves no task, a failed publish leaves no config
 *   P4 which events owe which notifications, once, in order
 *   P5 delivery: the spec's headers, the address that was checked, retries, order, the last one
 *   P6 the callback guard, at creation and again at delivery
 */

import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { after, before, beforeEach, describe } from "node:test";

import Fastify, { type FastifyInstance } from "fastify";
import { StringCodec } from "nats";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startAdmissionCluster, type AdmissionCluster } from "./support/admission-cluster.js";

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
let failPublish = false;
const executes: Array<Record<string, unknown>> = [];
export const js = {
  async publish(_subject: string, data: Uint8Array): Promise<void> {
    if (failPublish) throw new Error("jetstream down");
    executes.push(JSON.parse(sc.decode(data)));
  },
};
export const nc = {
  publish(): void { /* nothing listens */ },
  subscribe() {
    return { unsubscribe(): void {}, async *[Symbol.asyncIterator]() { /* no events */ } };
  },
};

const skip = postgresSkipReason();
const ALICE = { userId: "u-alice", userName: "alice", roles: ["default"], platformKey: "pk-a", virtualKey: "vk-a" };
const BOB = { userId: "u-bob", userName: "bob", roles: ["default"], platformKey: "pk-b", virtualKey: "vk-b" };
const HOOK = "https://203.0.113.7/hooks/a2a";

describe("A2A push notifications", { skip }, () => {
  let harness: AdmissionCluster;
  let app: FastifyInstance;
  let who = ALICE;
  let seq = 0;
  let push: typeof import("../src/routes/a2a-push.js");

  before(async () => {
    harness = await startAdmissionCluster({
      ADMIT_HARD_RUNS: "100", CLAW_A2A_CONTEXT_TASKS: "1", CLAW_A2A_PUSH_ENABLED: "1",
      CLAW_A2A_PUSH_ALLOWED_HOSTS: "127.0.0.1,hooks.internal",
    });
    (await import("../src/crypto/user-env.js")).initUserEnvCrypto();
    push = await import("../src/routes/a2a-push.js");
    const a2a = await import("../src/routes/a2a.js");
    app = Fastify();
    app.addHook("onRequest", async (req) => {
      (req as unknown as { user: unknown }).user = who;
      (req as unknown as { authMethod: unknown }).authMethod = "api_key";
    });
    await a2a.registerA2ARoutes(app);
    await app.ready();
  });
  after(async () => {
    await app?.close();
    await harness?.stop();
  });
  beforeEach(async () => {
    who = ALICE;
    failPublish = false;
    executes.length = 0;
    process.env.CLAW_A2A_CONTEXT_TASKS = "1";
    process.env.CLAW_A2A_PUSH_ENABLED = "1";
    process.env.CLAW_A2A_PUSH_ALLOWED_HOSTS = "127.0.0.1,hooks.internal";
    await query("DELETE FROM claw_a2a_push_outbox");
    await query("DELETE FROM claw_a2a_push_configs");
  });

  const query = (sql: string, params: unknown[] = []) => harness.app.db.db.query(sql, params);

  async function rpc(name: string, params: unknown) {
    const res = await app.inject({
      method: "POST", url: "/a2a", headers: { "a2a-version": "1.0" },
      payload: { jsonrpc: "2.0", id: ++seq, method: name, params },
    });
    return JSON.parse(res.body);
  }
  const msg = (text: string, extra: Record<string, unknown> = {}) => ({ messageId: `m-${++seq}`, role: "ROLE_USER", parts: [{ text }], ...extra });
  async function send(text: string, config?: unknown, extra: Record<string, unknown> = {}) {
    return rpc("SendMessage", {
      message: msg(text, extra),
      configuration: { returnImmediately: true, ...(config === undefined ? {} : { taskPushNotificationConfig: config }) },
    });
  }
  async function liveTask(contextId = `ctx-${++seq}`) {
    const r = await send("a job", undefined, { contextId });
    const taskId = r.result.task.id as string;
    const sessionId = String((await query("SELECT session_id FROM claw_tasks WHERE task_id = $1", [taskId])).rows[0].session_id);
    const messageId = String((await query("SELECT metadata->>'message_id' AS m FROM claw_tasks WHERE task_id = $1", [taskId])).rows[0].m);
    return { taskId, sessionId, messageId, contextId };
  }
  /** A config stored as it would be for a name that resolved when it was created. */
  async function storeConfig(t: { taskId: string; sessionId: string }, url: string, id = `cfg-${++seq}`) {
    await query(
      "INSERT INTO claw_a2a_push_configs (config_id, task_id, session_id, owner, url) VALUES ($1, $2, $3, 'user:u-alice', $4)",
      [id, t.taskId, t.sessionId, url],
    );
  }
  const configCount = async () => Number((await query("SELECT COUNT(*)::int AS n FROM claw_a2a_push_configs")).rows[0].n);
  const outbox = async () => (await query("SELECT dedupe_key, payload, final, attempts, delivered_at, dropped_at, last_status FROM claw_a2a_push_outbox ORDER BY id")).rows as Array<Record<string, any>>;

  describe("P2 the four methods", () => {
    test("create, get, list and delete a config, and never a secret back", async () => {
      const t = await liveTask();
      const created = (await rpc("CreateTaskPushNotificationConfig", {
        taskId: t.taskId, url: HOOK, token: "tok-1", authentication: { scheme: "Bearer", credentials: "cred-1" },
      })).result;
      assert.deepEqual(created, { id: created.id, taskId: t.taskId, url: HOOK, authentication: { scheme: "Bearer" } });
      assert.match(created.id, /^[0-9a-f-]{36}$/, "the server names it");
      const got = (await rpc("GetTaskPushNotificationConfig", { taskId: t.taskId, id: created.id })).result;
      assert.deepEqual(got, created);
      const listed = (await rpc("ListTaskPushNotificationConfigs", { taskId: t.taskId })).result;
      assert.deepEqual(listed, { configs: [created], nextPageToken: "" });
      assert.equal(JSON.stringify([got, listed]).includes("cred-1"), false);
      assert.equal(JSON.stringify([got, listed]).includes("tok-1"), false);
      // At rest the secrets are encrypted.
      const row = (await query("SELECT token_enc, auth_credentials_enc FROM claw_a2a_push_configs WHERE config_id = $1", [created.id])).rows[0];
      assert.ok(row.token_enc && !String(row.token_enc).includes("tok-1"));
      assert.ok(row.auth_credentials_enc && !String(row.auth_credentials_enc).includes("cred-1"));

      assert.deepEqual((await rpc("DeleteTaskPushNotificationConfig", { taskId: t.taskId, id: created.id })).result, {});
      assert.deepEqual((await rpc("DeleteTaskPushNotificationConfig", { taskId: t.taskId, id: created.id })).result, {}, "idempotent");
      assert.equal((await rpc("GetTaskPushNotificationConfig", { taskId: t.taskId, id: created.id })).error.code, -32001);
    });

    test("the client names the config, and a name is taken once", async () => {
      const t = await liveTask();
      assert.equal((await rpc("CreateTaskPushNotificationConfig", { taskId: t.taskId, url: HOOK, id: "mine" })).result.id, "mine");
      assert.equal((await rpc("CreateTaskPushNotificationConfig", { taskId: t.taskId, url: HOOK, id: "mine" })).error.code, -32602);
    });

    test("a task takes five", async () => {
      const t = await liveTask();
      for (let i = 0; i < push.MAX_CONFIGS_PER_TASK; i += 1) {
        assert.ok((await rpc("CreateTaskPushNotificationConfig", { taskId: t.taskId, url: HOOK })).result);
      }
      assert.match((await rpc("CreateTaskPushNotificationConfig", { taskId: t.taskId, url: HOOK })).error.message, /at most 5/);
    });

    test("another caller sees a task that is not theirs as not found, for all four", async () => {
      const t = await liveTask();
      const mine = (await rpc("CreateTaskPushNotificationConfig", { taskId: t.taskId, url: HOOK })).result;
      who = BOB;
      for (const [name, params] of [
        ["CreateTaskPushNotificationConfig", { taskId: t.taskId, url: HOOK }],
        ["GetTaskPushNotificationConfig", { taskId: t.taskId, id: mine.id }],
        ["ListTaskPushNotificationConfigs", { taskId: t.taskId }],
        ["DeleteTaskPushNotificationConfig", { taskId: t.taskId, id: mine.id }],
      ] as const) {
        assert.equal((await rpc(name, params)).error.code, -32001, name);
      }
      assert.equal(await configCount(), 1, "and the delete did not delete");
    });

    test("a finished task takes no config", async () => {
      const t = await liveTask();
      await query("UPDATE claw_tasks SET status = 'completed', completed_at = NOW() WHERE task_id = $1", [t.taskId]);
      assert.equal((await rpc("CreateTaskPushNotificationConfig", { taskId: t.taskId, url: HOOK })).error.code, -32004);
    });

    test("a task id is required, and a config id for get and delete", async () => {
      assert.equal((await rpc("CreateTaskPushNotificationConfig", { url: HOOK })).error.code, -32602);
      const t = await liveTask();
      assert.equal((await rpc("GetTaskPushNotificationConfig", { taskId: t.taskId })).error.code, -32602);
      assert.equal((await rpc("DeleteTaskPushNotificationConfig", { taskId: t.taskId })).error.code, -32602);
    });

    test("with push off all four are unsupported", async () => {
      process.env.CLAW_A2A_PUSH_ENABLED = "0";
      const t = await liveTask();
      for (const name of ["CreateTaskPushNotificationConfig", "GetTaskPushNotificationConfig", "ListTaskPushNotificationConfigs", "DeleteTaskPushNotificationConfig"]) {
        assert.equal((await rpc(name, { taskId: t.taskId, url: HOOK, id: "x" })).error.code, -32003, name);
      }
      assert.equal((await send("with a config", { url: HOOK })).error.code, -32003);
    });
  });

  describe("P3 a send that carries a config", () => {
    test("the config is stored for the task the send opened, before it is published", async () => {
      const r = await send("notify me", { url: HOOK, token: "t", authentication: { scheme: "Bearer", credentials: "c" } });
      const taskId = r.result.task.id as string;
      const rows = (await query("SELECT task_id, owner, url FROM claw_a2a_push_configs")).rows;
      assert.deepEqual(rows, [{ task_id: taskId, owner: "user:u-alice", url: HOOK }]);
      assert.equal(executes.length, 1);
    });

    test("a refused callback leaves no task, no session and nothing published", async () => {
      const sessions = Number((await query("SELECT COUNT(*)::int AS n FROM claw_sessions")).rows[0].n);
      const r = await send("never runs", { url: "https://10.1.2.3/hook" });
      assert.equal(r.error.code, -32602);
      assert.match(r.error.message, /refused: private_address/);
      assert.equal(Number((await query("SELECT COUNT(*)::int AS n FROM claw_sessions")).rows[0].n), sessions);
      assert.equal(executes.length, 0);
      assert.equal(await configCount(), 0);
    });

    test("a send that fails to publish leaves no config behind", async () => {
      failPublish = true;
      const r = await send("will fail", { url: HOOK });
      assert.equal(r.error.code, -32603);
      assert.equal(await configCount(), 0);
    });

    test("a malformed config is an invalid request, not a server error", async () => {
      assert.equal((await send("x", { url: HOOK, token: "a\nb" })).error.code, -32602);
      assert.equal((await send("x", { token: "t" })).error.code, -32602);
    });
  });

  describe("P4 which events owe which notifications", () => {
    const state = (row: Record<string, any>) => (row.payload.statusUpdate?.status.state ?? "artifact").replace("TASK_STATE_", "");

    test("running, a request, the decision and the end, each once, in order", async () => {
      const t = await liveTask();
      await rpc("CreateTaskPushNotificationConfig", { taskId: t.taskId, url: HOOK });
      const record = (event: Record<string, unknown>, rowId: number) => push.recordSessionEvent(t.sessionId, event, rowId);
      assert.equal(await record({ type: "statusUpdate", agentStatus: "running" }, 1), 1);
      assert.equal(await record({ type: "AssistantMessage", data: { content: [{ text: "chunk" }] } }, 2), 0, "text is not pushed per chunk");
      assert.equal(await record({ type: "permissionRequest", actionId: "a1", tool: "bash", input: { command: "ls" }, summary: "Lists" }, 3), 1);
      assert.equal(await record({ type: "decisionResult", actionId: "a1", decision: "allow" }, 4), 1);
      await query(
        "INSERT INTO claw_session_events (event_id, session_id, event, data) VALUES ('e-1', $1, 'AssistantMessage', $2)",
        [t.sessionId, { type: "AssistantMessage", data: { content: [{ type: "text", text: "all done" }] } }],
      );
      await query("UPDATE claw_tasks SET status = 'completed', completed_at = NOW() WHERE task_id = $1", [t.taskId]);
      assert.equal(await record({ type: "exec_complete", message_id: t.messageId, final_text: "all done" }, 5), 1);

      const rows = await outbox();
      assert.deepEqual(rows.map(state), ["WORKING", "INPUT_REQUIRED", "WORKING", "artifact", "COMPLETED"]);
      assert.deepEqual(rows.map((r) => r.final), [false, false, false, false, true], "only the last closes the config");
      const waiting = rows[1].payload.statusUpdate;
      assert.equal(waiting.taskId, t.taskId);
      assert.equal(waiting.contextId, t.contextId);
      assert.equal(waiting.status.message.parts[1].data.actionId, "a1");
      const artifact = rows[3].payload.artifactUpdate;
      assert.deepEqual([artifact.artifact.parts[0].text, artifact.lastChunk], ["all done", true]);
    });

    test("an event delivered twice owes nothing the second time", async () => {
      const t = await liveTask();
      await rpc("CreateTaskPushNotificationConfig", { taskId: t.taskId, url: HOOK });
      const event = { type: "permissionRequest", actionId: "a1", tool: "bash", input: {} };
      await push.recordSessionEvent(t.sessionId, event, 11);
      await push.recordSessionEvent(t.sessionId, event, 11);
      assert.equal((await outbox()).length, 1);
    });

    test("every config of the task is told, and no other task's", async () => {
      const a = await liveTask();
      const b = await liveTask();
      await rpc("CreateTaskPushNotificationConfig", { taskId: a.taskId, url: HOOK, id: "a1" });
      await rpc("CreateTaskPushNotificationConfig", { taskId: a.taskId, url: `${HOOK}/2`, id: "a2" });
      await rpc("CreateTaskPushNotificationConfig", { taskId: b.taskId, url: HOOK, id: "b1" });
      await push.recordSessionEvent(a.sessionId, { type: "statusUpdate", agentStatus: "running" }, 21);
      assert.deepEqual((await query("SELECT config_id FROM claw_a2a_push_outbox ORDER BY config_id")).rows.map((r) => r.config_id), ["a1", "a2"]);
    });

    test("an earlier task of the context is not notified of a later task's events", async () => {
      const first = await liveTask("ctx-two");
      await rpc("CreateTaskPushNotificationConfig", { taskId: first.taskId, url: HOOK });
      await query("UPDATE claw_tasks SET status = 'completed', completed_at = NOW() WHERE task_id = $1", [first.taskId]);
      await query("UPDATE claw_sessions SET agent_status = 'idle', agent_gate_message_id = NULL WHERE session_id = $1", [first.sessionId]);
      await send("second", undefined, { contextId: "ctx-two" });
      assert.equal(await push.recordSessionEvent(first.sessionId, { type: "statusUpdate", agentStatus: "running" }, 31), 0);
    });

    test("an event of another turn, or of no interest, or with push off, owes nothing", async () => {
      const t = await liveTask();
      await rpc("CreateTaskPushNotificationConfig", { taskId: t.taskId, url: HOOK });
      await query("UPDATE claw_tasks SET status = 'completed', completed_at = NOW() WHERE task_id = $1", [t.taskId]);
      assert.equal(await push.recordSessionEvent(t.sessionId, { type: "exec_complete", message_id: "m-someone-else" }, 41), 0);
      assert.equal(await push.recordSessionEvent(t.sessionId, { type: "ThinkingMessage" }, 42), 0);
      process.env.CLAW_A2A_PUSH_ENABLED = "0";
      assert.equal(await push.recordSessionEvent(t.sessionId, { type: "exec_complete", message_id: t.messageId }, 43), 0);
      assert.equal((await outbox()).length, 0);
    });

    test("a session with no config costs nothing and writes nothing", async () => {
      const t = await liveTask();
      assert.equal(await push.recordSessionEvent(t.sessionId, { type: "exec_complete", message_id: t.messageId }, 51), 0);
    });
  });

  describe("P5 delivery", () => {
    type Req = { target: { address: string; family: number; url: URL }; headers: Record<string, string>; body: string };

    async function configured(extra: Record<string, unknown> = {}, url = HOOK) {
      const t = await liveTask();
      await rpc("CreateTaskPushNotificationConfig", {
        taskId: t.taskId, url, token: "tok-9", authentication: { scheme: "Bearer", credentials: "cred-9" }, ...extra,
      });
      return t;
    }
    const sender = (codes: number[] = [200]) => {
      const requests: Req[] = [];
      return {
        requests,
        transport: async (req: Req) => { requests.push(req); return codes[Math.min(requests.length - 1, codes.length - 1)]; },
      };
    };
    const hostResolver = (address = "203.0.113.7") => async () => [{ address, family: 4 }];

    test("the request is the spec's: the client's own credentials, the token header, the StreamResponse", async () => {
      const t = await configured();
      await push.recordSessionEvent(t.sessionId, { type: "permissionRequest", actionId: "a1", tool: "bash", input: {} }, 61);
      const s = sender();
      const r = await push.deliverDue({ transport: s.transport as never, resolve: hostResolver() });
      assert.deepEqual(r, { delivered: 1, failed: 0 });
      const req = s.requests[0];
      assert.equal(req.headers.authorization, "Bearer cred-9");
      assert.equal(req.headers["X-A2A-Notification-Token"], "tok-9");
      assert.equal(req.headers["content-type"], "application/a2a+json");
      const body = JSON.parse(req.body);
      assert.deepEqual(Object.keys(body), ["statusUpdate"], "exactly one of task, message, statusUpdate, artifactUpdate");
      assert.equal(body.statusUpdate.status.state, "TASK_STATE_INPUT_REQUIRED");
      assert.equal((await outbox())[0].last_status, "200");
    });

    test("no token and no credentials send neither header", async () => {
      const t = await liveTask();
      await rpc("CreateTaskPushNotificationConfig", { taskId: t.taskId, url: HOOK });
      await push.recordSessionEvent(t.sessionId, { type: "statusUpdate", agentStatus: "running" }, 62);
      const s = sender();
      await push.deliverDue({ transport: s.transport as never, resolve: hostResolver() });
      assert.equal("authorization" in s.requests[0].headers, false);
      assert.equal("X-A2A-Notification-Token" in s.requests[0].headers, false);
    });

    test("it connects to the address that was checked", async () => {
      const t = await liveTask();
      await storeConfig(t, "https://receiver.example.com/hook");
      await push.recordSessionEvent(t.sessionId, { type: "statusUpdate", agentStatus: "running" }, 63);
      const s = sender();
      await push.deliverDue({ transport: s.transport as never, resolve: async () => [{ address: "198.51.100.9", family: 4 }, { address: "198.51.100.10", family: 4 }] });
      assert.equal(s.requests[0].target.address, "198.51.100.9");
      assert.equal(s.requests[0].target.url.hostname, "receiver.example.com", "the name stays for TLS and Host");
    });

    test("a refusal is retried with backoff and the next notification waits behind it", async () => {
      const t = await configured();
      await push.recordSessionEvent(t.sessionId, { type: "statusUpdate", agentStatus: "running" }, 71);
      await push.recordSessionEvent(t.sessionId, { type: "permissionRequest", actionId: "a1", tool: "bash", input: {} }, 72);
      const s = sender([503, 200]);
      assert.deepEqual(await push.deliverDue({ transport: s.transport as never, resolve: hostResolver() }), { delivered: 0, failed: 1 });
      let rows = await outbox();
      assert.deepEqual([rows[0].attempts, rows[0].last_status, rows[1].attempts], [1, "http_503", 0]);
      // Not due yet, and the second is not sent past the first.
      assert.deepEqual(await push.deliverDue({ transport: s.transport as never, resolve: hostResolver() }), { delivered: 0, failed: 0 });
      assert.equal(s.requests.length, 1);
      await query("UPDATE claw_a2a_push_outbox SET next_attempt_at = NOW() WHERE delivered_at IS NULL");
      assert.deepEqual(await push.deliverDue({ transport: s.transport as never, resolve: hostResolver() }), { delivered: 1, failed: 0 });
      assert.equal(JSON.parse(s.requests[1].body).statusUpdate.status.state, "TASK_STATE_WORKING", "the order they were written");
      rows = await outbox();
      assert.equal(rows[0].delivered_at !== null, true);
      assert.equal(rows[1].delivered_at, null);
    });

    test("a transport error is a failure like any other", async () => {
      const t = await configured();
      await push.recordSessionEvent(t.sessionId, { type: "statusUpdate", agentStatus: "running" }, 73);
      const r = await push.deliverDue({ transport: (async () => { throw new Error("ECONNREFUSED"); }) as never, resolve: hostResolver() });
      assert.deepEqual(r, { delivered: 0, failed: 1 });
      assert.match((await outbox())[0].last_status, /^error:ECONNREFUSED/);
    });

    test("a notification that was never delivered is dropped after the window", async () => {
      const t = await configured();
      await push.recordSessionEvent(t.sessionId, { type: "statusUpdate", agentStatus: "running" }, 74);
      await query("UPDATE claw_a2a_push_outbox SET created_at = NOW() - INTERVAL '2 hours'");
      await push.deliverDue({ transport: sender([500]).transport as never, resolve: hostResolver() });
      const [row] = await outbox();
      assert.ok(row.dropped_at);
      assert.equal(row.last_status, "http_500");
    });

    test("the last notification delivered takes the config with it", async () => {
      const t = await configured();
      await query("UPDATE claw_tasks SET status = 'failed', error_message = 'boom', completed_at = NOW() WHERE task_id = $1", [t.taskId]);
      await push.recordSessionEvent(t.sessionId, { type: "exec_complete", message_id: t.messageId, failed: true }, 75);
      const s = sender();
      await push.deliverDue({ transport: s.transport as never, resolve: hostResolver() });
      assert.equal(JSON.parse(s.requests[0].body).statusUpdate.status.state, "TASK_STATE_FAILED");
      assert.equal(await configCount(), 0);
      assert.equal((await outbox()).length, 0, "and its rows");
    });

    test("a config deleted while a notification waits is not sent to", async () => {
      const t = await configured();
      await push.recordSessionEvent(t.sessionId, { type: "statusUpdate", agentStatus: "running" }, 76);
      await query("DELETE FROM claw_a2a_push_configs WHERE task_id = $1", [t.taskId]);
      const s = sender();
      assert.deepEqual(await push.deliverDue({ transport: s.transport as never, resolve: hostResolver() }), { delivered: 0, failed: 0 });
      assert.equal(s.requests.length, 0);
    });
  });

  describe("P6 the callback guard", () => {
    const refusals: Array<[string, string]> = [
      ["loopback over http (not on the list)", "http://127.0.0.2:9/hook"],
      ["loopback over https", "https://127.0.0.2/hook"],
      ["loopback, IPv6", "https://[::1]/hook"],
      ["IPv4-mapped loopback", "https://[::ffff:7f00:1]/hook"],
      ["a 10.x address", "https://10.1.2.3/hook"],
      ["a 172.16.x address", "https://172.16.0.9/hook"],
      ["a 192.168.x address", "https://192.168.1.1/hook"],
      ["the link-local metadata address", "https://169.254.169.254/latest/meta-data"],
      ["carrier-grade NAT space", "https://100.64.0.1/hook"],
      ["unique-local IPv6", "https://[fd00::1]/hook"],
      ["a private address over plain http", "http://10.0.0.5/hook"],
      ["a public host over plain http", "http://203.0.113.7/hook"],
      ["credentials in the url", "https://user:pw@203.0.113.7/hook"],
      ["not a url", "not a url"],
      ["another scheme", "ftp://203.0.113.7/hook"],
    ];
    for (const [name, url] of refusals) {
      test(`creation refuses ${name}`, async () => {
        const t = await liveTask();
        const r = await rpc("CreateTaskPushNotificationConfig", { taskId: t.taskId, url });
        assert.equal(r.error?.code, -32602, JSON.stringify(r));
        assert.match(r.error.message, /^push notification url refused: /);
        assert.equal(await configCount(), 0);
      });
    }

    test("a host the operator named is let in, over http, though it is private", async () => {
      const t = await liveTask();
      const r = await rpc("CreateTaskPushNotificationConfig", { taskId: t.taskId, url: "http://127.0.0.1:18911/hook" });
      assert.ok(r.result, JSON.stringify(r));
    });

    test("a name that resolves to a private address is refused when the config is created", async () => {
      const { checkWebhookUrl } = await import("../src/routes/a2a-push.js");
      assert.deepEqual(await checkWebhookUrl("https://evil.example.com/x", async () => [{ address: "10.0.0.7", family: 4 }]), { ok: false, reason: "private_address" });
      assert.deepEqual(await checkWebhookUrl("https://good.example.com/x", async () => [{ address: "203.0.113.9", family: 4 }]), { ok: true });
      assert.deepEqual(await checkWebhookUrl("https://mixed.example.com/x", async () => [{ address: "203.0.113.9", family: 4 }, { address: "10.0.0.7", family: 4 }]),
        { ok: false, reason: "private_address" }, "any private answer refuses it");
      assert.deepEqual(await checkWebhookUrl("https://gone.example.com/x", async () => { throw new Error("ENOTFOUND"); }), { ok: false, reason: "unresolvable_host" });
    });

    test("a name that resolved to a public address then moves to a private one is refused at delivery, and nothing connects", async () => {
      const t = await liveTask();
      // Stored while it resolved publicly (the resolver is only consulted at delivery here).
      await storeConfig(t, "https://rebind.example.com/hook", "rebind");
      await push.recordSessionEvent(t.sessionId, { type: "statusUpdate", agentStatus: "running" }, 81);
      let called = 0;
      const r = await push.deliverDue({
        transport: (async () => { called += 1; return 200; }) as never,
        resolve: async () => [{ address: "169.254.169.254", family: 4 }],
      });
      assert.deepEqual(r, { delivered: 0, failed: 1 });
      assert.equal(called, 0, "no connection was made");
      const [row] = await outbox();
      assert.equal(row.last_status, "refused:private_address");
      assert.ok(row.dropped_at, "a refusal is not retried");
    });

    test("the operator's list is read when it is used", async () => {
      const t = await liveTask();
      await storeConfig(t, "http://hooks.internal:8080/hook");
      await push.recordSessionEvent(t.sessionId, { type: "statusUpdate", agentStatus: "running" }, 82);
      process.env.CLAW_A2A_PUSH_ALLOWED_HOSTS = "";
      const s = { n: 0 };
      const r = await push.deliverDue({
        transport: (async () => { s.n += 1; return 200; }) as never,
        resolve: async () => [{ address: "10.2.3.4", family: 4 }],
      });
      assert.deepEqual(r, { delivered: 0, failed: 1 });
      assert.equal(s.n, 0, "taken off the list, it is refused at delivery");
    });
  });
});
