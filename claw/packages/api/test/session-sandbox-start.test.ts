// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `POST /v1/sessions/:id/sandbox` and its keepalive.
 *
 * The contract under test: only the creator may start or keep a session's
 * sandbox; two callers racing for the gate dispatch ONE sandbox-only run; a
 * sandbox that already runs is reused without a run; and the run is a script
 * run with nothing to execute, so no model turn and no transcript entry.
 *
 * The registry is behind `sandboxStartPorts` because `kv` is a live binding.
 * `db.pool.connect` is replaced by a connection that holds a mutex from BEGIN
 * to COMMIT/ROLLBACK: PGlite has one connection and no row locks, and the
 * route's correctness under concurrency IS `SELECT ... FOR UPDATE`, so the
 * mutex stands in for exactly that and nothing else.
 */

import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";

import { db } from "../src/infra/db.js";
import type { UserInfo } from "../src/auth/models.js";
import { registerSessionRoutes, sandboxStartPorts } from "../src/routes/sessions.js";
import { startHarness, seedSession, type Harness } from "./scenario-harness.js";
import { closedDoorbellBarrier } from "./doorbell-barrier-stub.js";

const OWNER: UserInfo = {
  userId: "u-1", userName: "u-1", roles: ["default"], platformKey: "pk", virtualKey: "vk-u-1",
};
const OTHER: UserInfo = {
  userId: "u-2", userName: "u-2", roles: ["default"], platformKey: "pk2", virtualKey: "vk-u-2",
};

let h: Harness;
let originalConnect: typeof db.pool.connect;
let pristinePorts: Record<string, unknown> | null = null;
let pristineSandboxPorts: typeof sandboxStartPorts;

let published: Record<string, unknown>[] = [];
let claims: string[] = [];
let binding: { ready: boolean; workloadId: string | null } = { ready: false, workloadId: null };

/** A tail of the lock chain; each transaction waits for the one before it. */
let lockTail: Promise<void> = Promise.resolve();

before(async () => {
  h = await startHarness();
  const { sessionDispatchPorts } = await import("../src/sessions/dispatch.js");
  pristinePorts = { ...sessionDispatchPorts };
  pristineSandboxPorts = { ...sandboxStartPorts };
  originalConnect = db.pool.connect;
  db.pool.connect = (async () => {
    let release: (() => void) | null = null;
    let held = false;
    return {
      query: async (text: string, params?: unknown[]) => {
        if (/^\s*BEGIN/i.test(text)) {
          const prev = lockTail;
          lockTail = new Promise<void>((r) => { release = r; });
          await prev;
          held = true;
        }
        try {
          return await db.query(text, params);
        } finally {
          if (held && /^\s*(COMMIT|ROLLBACK)/i.test(text)) {
            held = false;
            release?.();
          }
        }
      },
      release: () => { if (held) { held = false; release?.(); } },
    };
  }) as unknown as typeof db.pool.connect;
});

beforeEach(async () => {
  await h.reset();
  const { sessionDispatchPorts } = await import("../src/sessions/dispatch.js");
  Object.assign(sessionDispatchPorts, pristinePorts);
  published = [];
  claims = [];
  binding = { ready: false, workloadId: null };
  lockTail = Promise.resolve();
  sessionDispatchPorts.doorbellDispatch = closedDoorbellBarrier;
  sessionDispatchPorts.publishSse = () => {};
  sessionDispatchPorts.publishTask = async (_subject: string, payload: string) => {
    // Yield, as a real publish does, so a second caller can reach the gate
    // while the first is still dispatching.
    await new Promise((r) => setTimeout(r, 5));
    published.push(JSON.parse(payload) as Record<string, unknown>);
    return published.length;
  };
  sandboxStartPorts.claim = async (sid: string) => { claims.push(sid); return true; };
  sandboxStartPorts.readBinding = async () => binding;
});

after(async () => {
  const { sessionDispatchPorts } = await import("../src/sessions/dispatch.js");
  if (pristinePorts) Object.assign(sessionDispatchPorts, pristinePorts);
  Object.assign(sandboxStartPorts, pristineSandboxPorts);
  db.pool.connect = originalConnect;
  await h?.close();
});

async function appAs(user: UserInfo): Promise<FastifyInstance> {
  const app = Fastify();
  app.addHook("preHandler", async (req) => {
    (req as unknown as { user: UserInfo }).user = user;
  });
  await registerSessionRoutes(app);
  await app.ready();
  return app;
}

async function gate(sid: string): Promise<{ agent_status: string; agent_gate_message_id: string | null }> {
  const rows = await h.sql("SELECT agent_status, agent_gate_message_id FROM claw_sessions WHERE session_id = $1", [sid]);
  return rows[0] as { agent_status: string; agent_gate_message_id: string | null };
}

test("the creator starts a sandbox: one sandbox-only run, no transcript entry, claim taken", async () => {
  await seedSession(h, "s1", { agentStatus: "idle", gateOwner: null });
  const app = await appAs(OWNER);
  const res = await app.inject({ method: "POST", url: "/v1/sessions/s1/sandbox", payload: {} });
  assert.equal(res.statusCode, 202, res.body);
  assert.equal(res.json().state, "starting");
  assert.equal(published.length, 1);
  assert.equal(published[0].mode, "script");
  assert.deepEqual(published[0].script, []);
  assert.equal(published[0].sandbox_only, true, "the completion writer recognises the run by this flag");
  const row = await h.sql("SELECT input FROM claw_tasks WHERE session_id = 's1'");
  assert.equal((row[0].input as Record<string, unknown>).sandbox_only, true, "and finds it on the run row");
  assert.deepEqual(claims, ["s1"]);
  const events = await h.sql("SELECT event FROM claw_session_events WHERE session_id = 's1'");
  assert.equal(events.length, 0, "a sandbox start is not a conversation turn");
  assert.equal((await gate("s1")).agent_status, "running");
});

test("another user is refused and nothing is dispatched, claimed or gated", async () => {
  await seedSession(h, "s1", { agentStatus: "idle", gateOwner: null });
  const app = await appAs(OTHER);
  const res = await app.inject({ method: "POST", url: "/v1/sessions/s1/sandbox", payload: {} });
  assert.equal(res.statusCode, 403, res.body);
  assert.equal(published.length, 0);
  assert.deepEqual(claims, []);
  assert.equal((await gate("s1")).agent_status, "idle");
});

test("an unknown session is a 404", async () => {
  const app = await appAs(OWNER);
  const res = await app.inject({ method: "POST", url: "/v1/sessions/nope/sandbox", payload: {} });
  assert.equal(res.statusCode, 404);
  assert.equal(published.length, 0);
});

test("two concurrent calls dispatch one run: the second sees the gate taken", async () => {
  await seedSession(h, "s1", { agentStatus: "idle", gateOwner: null });
  const app = await appAs(OWNER);
  const [a, b] = await Promise.all([
    app.inject({ method: "POST", url: "/v1/sessions/s1/sandbox", payload: {} }),
    app.inject({ method: "POST", url: "/v1/sessions/s1/sandbox", payload: {} }),
  ]);
  assert.equal(published.length, 1, "exactly one run, hence one sandbox");
  const codes = [a.statusCode, b.statusCode].sort();
  assert.deepEqual(codes, [200, 202]);
  const second = a.statusCode === 200 ? a : b;
  assert.equal(second.json().state, "busy");
});

test("a turn already holding the gate is not raced: nothing dispatched", async () => {
  await seedSession(h, "s1", { agentStatus: "running", gateOwner: "claw-1" });
  const app = await appAs(OWNER);
  const res = await app.inject({ method: "POST", url: "/v1/sessions/s1/sandbox", payload: {} });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().state, "busy", "a turn that never calls a tool never opens a sandbox, so this is not 'starting'");
  assert.equal(published.length, 0);
  assert.deepEqual(claims, ["s1"], "the terminal is still claimed, so the turn's end does not stop it");
  assert.equal((await gate("s1")).agent_gate_message_id, "claw-1");
});

test("once the turn has ended the same call starts the sandbox the turn never needed", async () => {
  await seedSession(h, "s1", { agentStatus: "running", gateOwner: "claw-1" });
  const app = await appAs(OWNER);
  assert.equal((await app.inject({ method: "POST", url: "/v1/sessions/s1/sandbox", payload: {} })).json().state, "busy");
  await h.sql("UPDATE claw_sessions SET agent_status = 'idle', agent_gate_message_id = NULL WHERE session_id = 's1'");
  const res = await app.inject({ method: "POST", url: "/v1/sessions/s1/sandbox", payload: {} });
  assert.equal(res.statusCode, 202);
  assert.equal(published.length, 1);
});

test("a sandbox that already runs is reused: no run, workload reported", async () => {
  await seedSession(h, "s1", { agentStatus: "idle", gateOwner: null });
  binding = { ready: true, workloadId: "wl-1" };
  const app = await appAs(OWNER);
  const res = await app.inject({ method: "POST", url: "/v1/sessions/s1/sandbox", payload: {} });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(
    { state: res.json().state, workload_id: res.json().workload_id }, { state: "running", workload_id: "wl-1" },
  );
  assert.equal(published.length, 0);
  assert.equal((await gate("s1")).agent_status, "idle");
});

test("refresh distrusts the binding: Brain validates and reuses or replaces", async () => {
  await seedSession(h, "s1", { agentStatus: "idle", gateOwner: null });
  binding = { ready: true, workloadId: "wl-gone" };
  const app = await appAs(OWNER);
  const res = await app.inject({ method: "POST", url: "/v1/sessions/s1/sandbox", payload: { refresh: true } });
  assert.equal(res.statusCode, 202);
  assert.equal(published.length, 1);
});

test("a publish failure hands the gate back and answers 503", async () => {
  await seedSession(h, "s1", { agentStatus: "idle", gateOwner: null });
  const { sessionDispatchPorts } = await import("../src/sessions/dispatch.js");
  sessionDispatchPorts.publishTask = async () => { throw Object.assign(new Error("no responders"), { code: "503" }); };
  const app = await appAs(OWNER);
  const res = await app.inject({ method: "POST", url: "/v1/sessions/s1/sandbox", payload: {} });
  assert.equal(res.statusCode, 503);
  assert.equal((await gate("s1")).agent_status, "idle");
});

test("keepalive: the creator renews the claim, rate-limited; another user is refused", async () => {
  await seedSession(h, "s1", { agentStatus: "idle", gateOwner: null });
  const other = await appAs(OTHER);
  const denied = await other.inject({ method: "POST", url: "/v1/sessions/s1/sandbox/keepalive" });
  assert.equal(denied.statusCode, 403);
  assert.deepEqual(claims, []);

  const app = await appAs(OWNER);
  const first = await app.inject({ method: "POST", url: "/v1/sessions/s1/sandbox/keepalive" });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().throttled, false);
  const second = await app.inject({ method: "POST", url: "/v1/sessions/s1/sandbox/keepalive" });
  assert.equal(second.json().throttled, true);
  assert.deepEqual(claims, ["s1"], "the second call within the gap writes nothing");
});
