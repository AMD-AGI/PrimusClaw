// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `POST /v1/sessions/:id/messages` takes a `tools_allowlist` and hands it to
 * Brain, which enforces it (brain/src/tools/allowlist.ts). And every turn tells
 * Brain whether skill self-evolution is on, so Brain does not offer the skill
 * tools whose writes the API would drop.
 *
 *   A1 a list of names reaches Brain as sent
 *   A2 no list, and an empty one, send no field: no restriction
 *   A3 a value that is not a list of strings is refused with 400 and nothing is sent
 *   A4 a message queued behind a running turn keeps its list, on the queue row and
 *      when the queue is drained
 *   A5 every turn carries skill_evolution_enabled, false by default
 */
import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";

import { db } from "../src/infra/db.js";
import type { UserInfo } from "../src/auth/models.js";
import { registerSessionRoutes } from "../src/routes/sessions.js";
import { startHarness, type Harness } from "./scenario-harness.js";
import { closedDoorbellBarrier } from "./doorbell-barrier-stub.js";

const OWNER: UserInfo = {
  userId: "u-1", userName: "u-1", roles: ["default"], platformKey: "pk", virtualKey: "vk-u-1",
};

let h: Harness;
let pristinePorts: Record<string, unknown> | null = null;
let originalConnect: typeof db.pool.connect;
let published: Record<string, unknown>[] = [];

before(async () => {
  h = await startHarness();
  for (const column of [
    "plugin_id INTEGER", "tool_ids JSONB DEFAULT '[]'::jsonb", "workspace_id TEXT",
    "platform_key TEXT", "llm_api_key TEXT", "credentials_blob TEXT", "image TEXT",
    "resources JSONB", "timeout INTEGER", "topology JSONB", "tools_allowlist JSONB",
    "user_env JSONB DEFAULT '{}'::jsonb", "session_env JSONB DEFAULT '{}'::jsonb",
  ]) {
    await h.sql(`ALTER TABLE claw_pending_messages ADD COLUMN IF NOT EXISTS ${column}`);
  }
  const { sessionDispatchPorts } = await import("../src/sessions/dispatch.js");
  pristinePorts = { ...sessionDispatchPorts };
  originalConnect = db.pool.connect;
  // The message route takes the gate in a transaction on its own connection.
  db.pool.connect = (async () => ({
    query: (text: string, params?: unknown[]) => db.query(text, params),
    release: () => {},
  })) as unknown as typeof db.pool.connect;
});

beforeEach(async () => {
  await h.reset();
  const { sessionDispatchPorts } = await import("../src/sessions/dispatch.js");
  Object.assign(sessionDispatchPorts, pristinePorts);
  published = [];
  sessionDispatchPorts.doorbellDispatch = closedDoorbellBarrier;
  sessionDispatchPorts.publishSse = () => {};
  sessionDispatchPorts.publishTask = async (_subject: string, payload: string) => {
    published.push(JSON.parse(payload) as Record<string, unknown>);
    return published.length;
  };
});

after(async () => {
  const { sessionDispatchPorts } = await import("../src/sessions/dispatch.js");
  if (pristinePorts) Object.assign(sessionDispatchPorts, pristinePorts);
  db.pool.connect = originalConnect;
  await h?.close();
});

async function withApp(fn: (app: FastifyInstance, sid: string) => Promise<void>): Promise<void> {
  const app = Fastify();
  app.addHook("preHandler", async (req) => {
    (req as unknown as { user: UserInfo }).user = OWNER;
  });
  await registerSessionRoutes(app);
  await app.ready();
  try {
    const created = await app.inject({ method: "POST", url: "/v1/sessions", payload: { name: "s" } });
    assert.equal(created.statusCode, 200, created.body);
    const sid = (created.json() as { data: { session_id: string } }).data.session_id;
    await fn(app, sid);
  } finally {
    await app.close();
  }
}

const send = (app: FastifyInstance, sid: string, payload: Record<string, unknown>) =>
  app.inject({ method: "POST", url: `/v1/sessions/${sid}/messages`, payload: { content: "go", ...payload } });

test("A1 a list of names reaches Brain as sent", async () => {
  await withApp(async (app, sid) => {
    const res = await send(app, sid, { tools_allowlist: ["read", "mcp__docs__*"] });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(published.length, 1);
    assert.deepEqual(published[0].tools_allowlist, ["read", "mcp__docs__*"]);
  });
});

test("A2 no list, and an empty one, send no field", async () => {
  for (const payload of [{}, { tools_allowlist: [] }, { tools_allowlist: null }]) {
    await h.reset();
    published = [];
    await withApp(async (app, sid) => {
      const res = await send(app, sid, payload);
      assert.equal(res.statusCode, 200, `${JSON.stringify(payload)}: ${res.body}`);
      assert.equal(published.length, 1);
      assert.equal("tools_allowlist" in published[0], false, `${JSON.stringify(payload)} restricted the turn`);
    });
  }
});

test("A3 a value that is not a list of strings is refused and nothing is sent", async () => {
  for (const bad of ["read", ["read", 3], { read: true }]) {
    await h.reset();
    published = [];
    await withApp(async (app, sid) => {
      const res = await send(app, sid, { tools_allowlist: bad });
      assert.equal(res.statusCode, 400, `${JSON.stringify(bad)}: ${res.body}`);
      assert.match(res.body, /tools_allowlist must be an array of strings/);
      assert.equal(published.length, 0);
    });
  }
});

test("A4 a message queued behind a running turn keeps its list", async () => {
  await withApp(async (app, sid) => {
    assert.equal((await send(app, sid, {})).statusCode, 200);
    // The first turn holds the gate, so the second is parked on the queue row.
    const res = await send(app, sid, { tools_allowlist: ["grep"] });
    assert.equal(res.statusCode, 200, res.body);
    const rows = await h.sql("SELECT tools_allowlist FROM claw_pending_messages WHERE session_id = $1", [sid]);
    assert.equal(rows.length, 1, "the second message was not queued");
    assert.deepEqual(rows[0].tools_allowlist, ["grep"]);

    // The running turn ends and the queued message is sent on from its row.
    const { pendingDispatchPorts } = await import("../src/tasks/pending-dispatch.js");
    const { drainOldestPendingMessage } = await import("../src/events/consumer.js");
    const pristine = { ...pendingDispatchPorts };
    const drained: Record<string, unknown>[] = [];
    const realQuery = db.query;
    db.query = (async (text: string, params: unknown[] = []) => (
      /^\s*UPDATE claw_tasks/.test(text) ? { rows: [], rowCount: 1 } : realQuery(text, params)
    )) as typeof db.query;
    try {
      pendingDispatchPorts.doorbellDispatch = closedDoorbellBarrier;
      pendingDispatchPorts.admit = async () => ({ kind: "admit" });
      pendingDispatchPorts.bindWorkspace = (async () => "kws_1") as typeof pendingDispatchPorts.bindWorkspace;
      pendingDispatchPorts.requireWorkspaceBinding =
        ((workspaceId?: string) => workspaceId as string) as typeof pendingDispatchPorts.requireWorkspaceBinding;
      pendingDispatchPorts.publishSessionEvent =
        (async () => {}) as unknown as typeof pendingDispatchPorts.publishSessionEvent;
      pendingDispatchPorts.openChatRun = (async () => (
        { taskId: "run-2", workspaceId: "kws_1", lease: { url: "http://api/lease", token: "t0ken" } }
      )) as unknown as typeof pendingDispatchPorts.openChatRun;
      pendingDispatchPorts.publish = (async (_subject: string, payload: string) => {
        drained.push(JSON.parse(payload) as Record<string, unknown>);
        return drained.length;
      }) as typeof pendingDispatchPorts.publish;
      await drainOldestPendingMessage(sid, OWNER.userId);
    } finally {
      db.query = realQuery;
      Object.assign(pendingDispatchPorts, pristine);
    }
    assert.equal(drained.length, 1, "the queued message was not sent on");
    assert.deepEqual(drained[0].tools_allowlist, ["grep"]);
    assert.equal(drained[0].skill_evolution_enabled, false);
  });
});

test("A5 every turn says whether skill self-evolution is on (off by default)", async () => {
  await withApp(async (app, sid) => {
    assert.equal((await send(app, sid, {})).statusCode, 200);
    assert.equal(published[0].skill_evolution_enabled, false);
  });
});
