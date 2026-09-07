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
 *
 * The session a create keeps this way is a created session, and is counted as
 * one. The status code is the wrong thing to book the counter on: it is the
 * same 503 the settled failure answers, and that one deletes its row.
 */

import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";

import { db } from "../src/infra/db.js";
import { registry } from "../src/infra/metrics.js";
import type { UserInfo } from "../src/auth/models.js";
import { registerSessionRoutes } from "../src/routes/sessions.js";
import { registerAnthropicManagedAgentsRoutes } from "../src/routes/anthropic-managed-agents.js";
import type { AdmissionDecision } from "../src/tasks/admission.js";
import { startHarness, seedSession, type Harness } from "./scenario-harness.js";
import { closedDoorbellBarrier, openDoorbellBarrier } from "./doorbell-barrier-stub.js";

const OWNER: UserInfo = {
  userId: "u-1", userName: "u-1", roles: ["default"], platformKey: "pk", virtualKey: "vk-u-1",
};

let h: Harness;
let pristinePorts: Record<string, unknown> | null = null;
let originalConnect: typeof db.pool.connect;

/**
 * Start every case from the ports as the module defined them.
 *
 * Snapshotting inside each helper captured whatever the previous case had
 * already replaced, so a later case inherited its `openChatRun` and got its
 * verdict rather than the one it arranged.
 */
async function freshPorts(): Promise<typeof import("../src/sessions/dispatch.js")["sessionDispatchPorts"]> {
  const { sessionDispatchPorts } = await import("../src/sessions/dispatch.js");
  pristinePorts ??= { ...sessionDispatchPorts };
  Object.assign(sessionDispatchPorts, pristinePorts);
  return sessionDispatchPorts;
}

before(async () => {
  h = await startHarness();
  await freshPorts();
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
  if (pristinePorts) await freshPorts();
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
  const sessionDispatchPorts = await freshPorts();
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

/** A publish that fails for good, so the rollback deletes what the create wrote. */
async function settledPublishFailure(): Promise<void> {
  const sessionDispatchPorts = await freshPorts();
  sessionDispatchPorts.doorbellDispatch = closedDoorbellBarrier;
  sessionDispatchPorts.publishSse = () => {};
  sessionDispatchPorts.publishTask = async () => {
    throw Object.assign(new Error("no responders"), { code: "503" });
  };
}

async function managedEventWithAdmission(
  decision: AdmissionDecision,
): Promise<{ response: Awaited<ReturnType<FastifyInstance["inject"]>>; events: Record<string, unknown>[] }> {
  const sessionDispatchPorts = await freshPorts();
  sessionDispatchPorts.doorbellDispatch = openDoorbellBarrier;
  sessionDispatchPorts.admit = async () => decision;
  sessionDispatchPorts.publishSse = () => {};
  sessionDispatchPorts.publishTask = async () => 1;
  await seedSession(h, "s1", { agentStatus: "idle", gateOwner: null });
  const app = await appAs(registerAnthropicManagedAgentsRoutes);
  try {
    const response = await app.inject({
      method: "POST", url: "/anthropic/v1/sessions/s1/events",
      payload: { events: [{ type: "user.message", content: [{ type: "text", text: "hello" }] }] },
    });
    const events = await h.sql(
      "SELECT event_id, event, data FROM claw_session_events ORDER BY id",
    );
    return { response, events };
  } finally {
    await app.close();
  }
}

const createdOk = async (): Promise<number> => {
  const text = await registry.metrics();
  for (const line of text.split("\n")) {
    if (line.startsWith("claw_api_session_created_total{") && line.includes('outcome="ok"')) {
      return Number(line.slice(line.lastIndexOf(" ") + 1));
    }
  }
  return 0;
};

const createWithMessage = (app: FastifyInstance) => app.inject({
  method: "POST", url: "/v1/sessions",
  payload: { name: "s", message: { content: "hello" } },
});

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

test("a managed-agent rejection records no event saying the turn started", async () => {
  const { response, events } = await managedEventWithAdmission({
    kind: "reject", reason: "runs_hard_limit",
  });

  assert.equal(response.statusCode, 429);
  assert.deepEqual(events, []);
  assert.equal((await sessionRows())[0].agent_status, "idle");
});

test("a managed-agent deferral records the message but not a running event", async () => {
  const { response, events } = await managedEventWithAdmission({ kind: "queue", position: 1 });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(events.map((event) => event.event), ["UserMessage"]);
});

test("a managed-agent dispatch records one stable running event after admission", async () => {
  const { response, events } = await managedEventWithAdmission({ kind: "admit" });

  assert.equal(response.statusCode, 200);
  const messageId = response.json().data[0].id as string;
  const running = events.find((event) => event.event === "AnthropicSessionRunning");
  assert.ok(running);
  assert.equal(running.event_id, `claw-running-${messageId}`);
  assert.equal((running.data as { message_id: string }).message_id, running.event_id);
});

test("the session an unknown publish keeps is counted as a creation", async () => {
  await unknownPublishOutcome();
  const app = await appAs(registerSessionRoutes);
  try {
    const before = await createdOk();
    const res = await createWithMessage(app);
    const moved = await createdOk() - before;

    assert.equal(res.statusCode, 503);
    assert.equal((await sessionRows()).length, 1, "the row is still there");
    assert.equal(moved, 1, "and the counter names it, though the answer was a 503");
  } finally {
    await app.close();
  }
});

test("the session a settled publish failure deletes is counted as nothing", async () => {
  await settledPublishFailure();
  const app = await appAs(registerSessionRoutes);
  try {
    const before = await createdOk();
    const res = await createWithMessage(app);
    const moved = await createdOk() - before;

    assert.equal(res.statusCode, 503);
    assert.equal((await sessionRows()).length, 0, "the rollback took the row back");
    assert.equal(moved, 0, "so there is no creation to count");
  } finally {
    await app.close();
  }
});
