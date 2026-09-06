// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a client is told when the publish outcome was never decided, and what
 * the server must not do while telling them.
 *
 * `publish_unknown` is a 503 like `publish_failed`, and that is where the
 * resemblance ends: the row may still be claimable and about to run, so the
 * rollback a settled failure earns -- deleting the session a create just made,
 * or handing back the gate a message just took -- would unwind a turn that then
 * executes with nothing to report to. Every caller of `dispatchTaskToBrain` is
 * driven here, because the branch is written once per caller and a caller added
 * without it fails only in production.
 */

import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";

import { db } from "../src/infra/db.js";
import type { UserInfo } from "../src/auth/models.js";
import { registerSessionRoutes } from "../src/routes/sessions.js";
import { registerAnthropicManagedAgentsRoutes } from "../src/routes/anthropic-managed-agents.js";
import { startHarness, seedSession, type Harness } from "./scenario-harness.js";
import { closedDoorbellBarrier } from "./doorbell-barrier-stub.js";

const OWNER: UserInfo = {
  userId: "u-1", userName: "u-1", roles: ["default"], platformKey: "pk", virtualKey: "vk-u-1",
};

let h: Harness;
let restorePorts: (() => void) | null = null;
let originalConnect: typeof db.pool.connect;

before(async () => {
  h = await startHarness();
  originalConnect = db.pool.connect;
  // The message routes do their gate flip in a transaction on their own
  // connection, which a `db.query` substitution never sees.
  db.pool.connect = (async () => ({
    query: (text: string, params?: unknown[]) => db.query(text, params),
    release: () => {},
  })) as unknown as typeof db.pool.connect;
});

beforeEach(async () => { await h.reset(); });

after(async () => {
  restorePorts?.();
  db.pool.connect = originalConnect;
  await h?.close();
});

/**
 * A publish whose ack never came, over a row this replica cannot settle.
 *
 * Both halves are needed for the verdict to be `unknown`: a timeout says the
 * message may be on the stream, and a compensation receipt written by a newer
 * replica says nothing about the row can be established from here.
 */
async function unknownPublishOutcome(): Promise<void> {
  const { sessionDispatchPorts } = await import("../src/sessions/dispatch.js");
  const original = { ...sessionDispatchPorts };
  restorePorts = () => Object.assign(sessionDispatchPorts, original);
  const realOpen = sessionDispatchPorts.openChatRun;
  sessionDispatchPorts.doorbellDispatch = closedDoorbellBarrier;
  sessionDispatchPorts.publishSse = () => {};
  sessionDispatchPorts.publishTask = async () => {
    throw Object.assign(new Error("TIMEOUT"), { code: "TIMEOUT" });
  };
  sessionDispatchPorts.openChatRun = async (args) => {
    const run = await realOpen(args);
    if (run) {
      await h.sql(
        `UPDATE claw_tasks
            SET metadata = jsonb_set(metadata, '{dispatch_compensation}', '{"version":2}'::jsonb)
          WHERE task_id = $1`,
        [run.taskId],
      );
    }
    return run;
  };
}

async function appAs(
  register: (app: FastifyInstance) => Promise<void>,
): Promise<FastifyInstance> {
  const app = Fastify();
  app.addHook("preHandler", async (req) => {
    (req as unknown as { user: UserInfo }).user = OWNER;
  });
  await register(app);
  await app.ready();
  return app;
}

async function sessionRows(): Promise<Record<string, unknown>[]> {
  return await h.sql("SELECT session_id, agent_status, agent_gate_message_id FROM claw_sessions");
}

test("a create whose publish outcome is unknown answers 503 and keeps the session", async () => {
  await unknownPublishOutcome();
  const app = await appAs(registerSessionRoutes);
  try {
    const res = await app.inject({
      method: "POST", url: "/v1/sessions",
      payload: { name: "s", message: { content: "hello" } },
    });

    assert.equal(res.statusCode, 503);
    const rows = await sessionRows();
    assert.equal(rows.length, 1, "the session a settled failure would have deleted is still here");
    assert.equal(rows[0].agent_status, "running", "and still gated for the turn that may run");
    assert.equal(
      Number((await h.sql(
        "SELECT count(*)::int AS n FROM claw_session_events WHERE event = 'UserMessage'",
      ))[0].n),
      1,
      "with the message the turn would answer still in its history",
    );
  } finally {
    await app.close();
  }
});

test("a message whose publish outcome is unknown answers 503 and keeps the gate", async () => {
  await unknownPublishOutcome();
  await seedSession(h, "s1", { agentStatus: "idle", gateOwner: null });
  const app = await appAs(registerSessionRoutes);
  try {
    const res = await app.inject({
      method: "POST", url: "/v1/sessions/s1/messages", payload: { content: "hello" },
    });

    assert.equal(res.statusCode, 503);
    const row = (await sessionRows())[0];
    assert.equal(row.agent_status, "running");
    assert.notEqual(
      row.agent_gate_message_id, null,
      "the gate still names the turn, so a later message parks rather than overtaking it",
    );
  } finally {
    await app.close();
  }
});

test("the managed-agents event route answers 503 and keeps the gate too", async () => {
  await unknownPublishOutcome();
  await seedSession(h, "s1", { agentStatus: "idle", gateOwner: null });
  const app = await appAs(registerAnthropicManagedAgentsRoutes);
  try {
    const res = await app.inject({
      method: "POST", url: "/anthropic/v1/sessions/s1/events",
      payload: { events: [{ type: "user.message", content: [{ type: "text", text: "hello" }] }] },
    });

    assert.equal(res.statusCode, 503);
    const row = (await sessionRows())[0];
    assert.equal(row.agent_status, "running");
    assert.notEqual(row.agent_gate_message_id, null);
  } finally {
    await app.close();
  }
});
