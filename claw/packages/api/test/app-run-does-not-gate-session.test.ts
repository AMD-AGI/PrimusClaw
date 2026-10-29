// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A hosted application runs for hours beside its session, and the session's
 * foreground conversation has to keep working meanwhile (hosting design 5.8: every
 * turn sees the application's MCP tools).
 *
 * `claw_sessions.agent_status = 'running'` is the gate on the conversation: while
 * it reads running, a message is parked in `claw_pending_messages`. The status
 * events a Brain emits for a run (`taskResumed` on a redelivery, `taskInterrupted`
 * on SIGTERM) are mirrored into that column by the event consumer, which is right
 * for a chat turn and wrong for an app run: there is no turn to complete and no gate
 * marker, so a redelivered app run left the session `running` for good, and the
 * application's own events kept the stuck-session reaper off it. The consumer now
 * leaves an app run's lifecycle events off the gate; chat turns are untouched.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test, { after, before, beforeEach } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";

import type { UserInfo } from "../src/auth/models.js";
import { postgresSkipReason } from "./support/pg-cluster.js";
import { startAdmissionCluster, type AdmissionCluster } from "./support/admission-cluster.js";
import { closedDoorbellBarrier } from "./doorbell-barrier-stub.js";

const OWNER: UserInfo = { userId: "u-1", userName: "u-1", roles: ["default"], platformKey: "pk", virtualKey: "vk-u-1" };
const APP_TASK = "ktsk_app";
const MCP_TOKEN = "cmt_testtoken0123456789abcdef";

const skip = postgresSkipReason();
let c: AdmissionCluster;
let consumer: typeof import("../src/events/consumer.js");
let ports: typeof import("../src/sessions/dispatch.js")["sessionDispatchPorts"];
let registerSessionRoutes: typeof import("../src/routes/sessions.js")["registerSessionRoutes"];
let sealAppRunSecret: typeof import("../src/crypto/app-run-secrets.js")["sealAppRunSecret"];
let originalHas: unknown;
let pristine: Record<string, unknown>;
let seq = 1000;
const sql = async (text: string, params: unknown[] = []) => (await c.app.db.db.query(text, params)).rows as any[];

before(async () => {
  if (skip) return;
  process.env.USER_ENV_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  c = await startAdmissionCluster({ APP_RUNS_ENABLED: "true" });
  (await import("../src/crypto/user-env.js")).initUserEnvCrypto();
  sealAppRunSecret = (await import("../src/crypto/app-run-secrets.js")).sealAppRunSecret;
  consumer = await import("../src/events/consumer.js");
  ports = (await import("../src/sessions/dispatch.js")).sessionDispatchPorts;
  registerSessionRoutes = (await import("../src/routes/sessions.js")).registerSessionRoutes;
  originalHas = consumer.tombstoneReader.has;
  consumer.tombstoneReader.has = async () => false;
  pristine = { ...ports };
});
beforeEach(async () => {
  if (skip) return;
  for (const t of ["claw_session_app_mcp", "claw_app_runs", "claw_pending_messages", "claw_session_events", "claw_tasks", "claw_sessions"]) {
    await sql(`DELETE FROM ${t}`).catch(() => {});
  }
  Object.assign(ports, pristine);
});
after(async () => {
  if (skip) return;
  consumer.tombstoneReader.has = originalHas as typeof consumer.tombstoneReader.has;
  Object.assign(ports, pristine);
  await c?.stop();
});

const seedSession = (sid: string) =>
  sql("INSERT INTO claw_sessions (session_id, name, user_id, mode, agent_status) VALUES ($1, 't', 'u-1', 'claw', 'idle')", [sid]);

async function seedAppRun(sessionId: string): Promise<void> {
  await sql(
    `INSERT INTO claw_tasks (task_id, session_id, name, status, origin, mode, executor)
     VALUES ($1, $2, 'app', 'running', 'task', 'app', 'brain')`,
    [APP_TASK, sessionId],
  );
  await sql(
    `INSERT INTO claw_app_runs (task_id, session_id, plugin_id, manifest, state, mcp_token_enc)
     VALUES ($1, $2, 1, $3::jsonb, 'running', $4)`,
    [APP_TASK, sessionId, JSON.stringify({ name: "example-app", mcp: { port: 8765, path: "/mcp", token_header: "X-App-Token" } }),
      sealAppRunSecret(MCP_TOKEN, APP_TASK, "mcp_token")],
  );
  await sql(
    `INSERT INTO claw_session_app_mcp (session_id, name, app_task_id, url, sandbox_session_id)
     VALUES ($1, 'example-app', $2, 'http://router.example.invalid/v1/namespaces/ns/code-interpreters/wl-1/invocations/proxy/8765/mcp', 'wl-1')`,
    [sessionId, APP_TASK],
  );
}

async function deliver(sessionId: string, event: Record<string, unknown>): Promise<void> {
  const verdicts: string[] = [];
  await consumer.consumeEventDelivery({
    subject: `events.${sessionId}`,
    data: new TextEncoder().encode(JSON.stringify(event)),
    seq: ++seq,
    ack: () => { verdicts.push("ack"); },
    nak: () => { verdicts.push("nak"); },
  });
  assert.deepEqual(verdicts, ["ack"]);
}

const agentStatus = async (sid: string) =>
  (await sql("SELECT agent_status FROM claw_sessions WHERE session_id = $1", [sid]))[0].agent_status;

async function appAs(): Promise<FastifyInstance> {
  const app = Fastify();
  app.addHook("preHandler", async (req) => { (req as unknown as { user: UserInfo }).user = OWNER; });
  await registerSessionRoutes(app);
  await app.ready();
  return app;
}

test("a redelivered or interrupted app run does not move the session's gate", { skip }, async () => {
  await seedSession("s1");
  await seedAppRun("s1");
  const wall = Date.now();
  await deliver("s1", { type: "taskResumed", message_id: APP_TASK, wallclock_ms: wall, delivery_count: 2 });
  assert.equal(await agentStatus("s1"), "idle");
  await deliver("s1", { type: "taskInterrupted", message_id: APP_TASK, wallclock_ms: wall + 1, reason: "sigterm" });
  assert.equal(await agentStatus("s1"), "idle");
});

test("the same events from a chat turn still do (the gate is only taken off the app run)", { skip }, async () => {
  await seedSession("s1");
  await sql(
    `INSERT INTO claw_tasks (task_id, session_id, name, status, origin, executor, metadata)
     VALUES ('chat-1', 's1', 'chat', 'running', 'chat', 'brain', '{"message_id":"claw-1"}'::jsonb)`,
  );
  await deliver("s1", { type: "taskResumed", message_id: "claw-1", wallclock_ms: Date.now(), delivery_count: 2 });
  assert.equal(await agentStatus("s1"), "running");
});

test("with an app run in progress, a message is dispatched at once and carries the app's MCP", { skip }, async () => {
  await seedSession("s1");
  await seedAppRun("s1");
  // What a Brain redelivering the app run publishes.
  await deliver("s1", { type: "taskResumed", message_id: APP_TASK, wallclock_ms: Date.now(), delivery_count: 2 });

  const published: string[] = [];
  ports.doorbellDispatch = closedDoorbellBarrier;
  ports.publishSse = () => {};
  ports.publishTask = async (_s: string, payload: string) => { published.push(payload); return published.length; };
  const app = await appAs();
  try {
    const res = await app.inject({ method: "POST", url: "/v1/sessions/s1/messages", payload: { content: "call get_status" } });
    assert.equal(res.statusCode, 200, res.body);
    assert.notEqual(res.json().queued, true, "not parked behind the application");
    assert.equal(published.length, 1, "the turn was published for execution");
    assert.equal((await sql("SELECT count(*)::int AS n FROM claw_pending_messages"))[0].n, 0);
    const servers = JSON.parse(published[0]!).mcp_servers;
    assert.equal(servers["example-app"].headers["X-App-Token"], MCP_TOKEN);
    assert.equal(servers["example-app"].headers["x-session-id"], "wl-1");

    // Serial semantics between foreground turns are unchanged: the next message parks.
    const second = await app.inject({ method: "POST", url: "/v1/sessions/s1/messages", payload: { content: "again" } });
    assert.equal(second.statusCode, 200, second.body);
    assert.equal(second.json().queued, true);
    assert.equal(published.length, 1);
  } finally {
    await app.close();
  }
});
