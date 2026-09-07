// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A fat publisher may not publish until its row records that it is about to.
 *
 * The receipt is the only durable answer to "can a message for this row exist?",
 * and `not_attempted` is read as proof that none does: the no-delivery guard
 * terminalizes such a row and hands its session back. So a publish made while
 * the receipt still says `not_attempted` is a live run a Stop or a reaper may
 * destroy, and the write that says otherwise has to be a gate rather than a
 * best-effort note.
 *
 * Both ways that write can fail to establish anything are driven -- the
 * statement erroring, and the statement matching no armed row because a holder
 * disarmed it in between -- against both fat publishers.
 */

import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";

import { db } from "../src/infra/db.js";
import type { UserInfo } from "../src/auth/models.js";
import { registerSessionRoutes } from "../src/routes/sessions.js";
import { closedDoorbellBarrier } from "./doorbell-barrier-stub.js";
import { startHarness, seedSession, type Harness } from "./scenario-harness.js";

const OWNER: UserInfo = {
  userId: "u-1", userName: "u-1", roles: ["default"], platformKey: "pk", virtualKey: "vk-u-1",
};

/** The statement under test, recognised by the path it sets. */
const RECEIPT_WRITE = /jsonb_set\(\s*metadata, '\{dispatch_compensation,publish\}'/;

let h: Harness;
let published: string[];
let originalConnect: typeof db.pool.connect;
let pristineSession: Record<string, unknown> | null = null;
let pristinePending: Record<string, unknown> | null = null;

async function sessionPorts() {
  const { sessionDispatchPorts } = await import("../src/sessions/dispatch.js");
  pristineSession ??= { ...sessionDispatchPorts };
  Object.assign(sessionDispatchPorts, pristineSession);
  sessionDispatchPorts.doorbellDispatch = closedDoorbellBarrier;
  sessionDispatchPorts.publishSse = () => {};
  sessionDispatchPorts.publishTask = async (subject: string) => {
    published.push(subject);
    return published.length;
  };
  return sessionDispatchPorts;
}

async function pendingPorts() {
  const { pendingDispatchPorts } = await import("../src/tasks/pending-dispatch.js");
  pristinePending ??= { ...pendingDispatchPorts };
  Object.assign(pendingDispatchPorts, pristinePending);
  pendingDispatchPorts.doorbellDispatch = closedDoorbellBarrier;
  pendingDispatchPorts.bindWorkspace = async () => "kws_1";
  pendingDispatchPorts.publish = async (subject: string) => {
    published.push(subject);
    return published.length;
  };
  return pendingDispatchPorts;
}

/**
 * Make every receipt write fail the way an unreachable database does.
 *
 * @returns a restore function; a substitution left in place would make the next
 *   case pass for this case's reason.
 */
function breakReceiptWrite(): () => void {
  const query = db.query;
  db.query = (async (text: string, params?: unknown[]) => {
    if (RECEIPT_WRITE.test(text)) throw new Error("connection terminated");
    return query(text, params);
  }) as typeof db.query;
  return () => { db.query = query; };
}

/** Disarm the receipt the moment the row is opened, as a racing Stop does. */
function disarmReceiptOnOpen(ports: { openChatRun: typeof import("../src/tasks/chat-run.js")["openChatRun"] }): void {
  const open = ports.openChatRun;
  ports.openChatRun = async (args) => {
    const run = await open(args);
    if (run) {
      await h.sql(
        "UPDATE claw_tasks SET metadata = metadata - 'dispatch_compensation' WHERE task_id = $1",
        [run.taskId],
      );
    }
    return run;
  };
}

async function appAs(register: (app: FastifyInstance) => Promise<void>): Promise<FastifyInstance> {
  const app = Fastify();
  app.addHook("preHandler", async (req) => {
    (req as unknown as { user: UserInfo }).user = OWNER;
  });
  await register(app);
  await app.ready();
  return app;
}

const sendMessage = (app: FastifyInstance) => app.inject({
  method: "POST", url: "/v1/sessions/s1/messages", payload: { content: "hello" },
});

const drainQueued = async () => {
  const { dispatchPendingMessage } = await import("../src/tasks/pending-dispatch.js");
  return await dispatchPendingMessage({
    sessionId: "s1", pendingId: 7, userId: "u-1", messageId: "claw-1",
    prompt: "hello", workspaceId: "kws_1",
    task: { session_id: "s1", prompt: "hello" } as Record<string, unknown>,
  });
};

async function runStates(): Promise<string[]> {
  const rows = await h.sql("SELECT status FROM claw_tasks ORDER BY task_id");
  return rows.map((row) => row.status as string);
}

before(async () => {
  h = await startHarness();
  originalConnect = db.pool.connect;
  // The message route flips the session gate in a transaction on its own
  // connection, which a `db.query` substitution never sees.
  db.pool.connect = (async () => ({
    query: (text: string, params?: unknown[]) => db.query(text, params),
    release: () => {},
  })) as unknown as typeof db.pool.connect;
});

beforeEach(async () => {
  await h.reset();
  published = [];
});

after(async () => {
  if (pristineSession) await sessionPorts();
  if (pristinePending) await pendingPorts();
  db.pool.connect = originalConnect;
  await h?.close();
});

test("a message whose receipt write fails is refused rather than published", async () => {
  await sessionPorts();
  await seedSession(h, "s1", { agentStatus: "idle", gateOwner: null });
  const restore = breakReceiptWrite();
  const app = await appAs(registerSessionRoutes);
  try {
    const res = await sendMessage(app);

    assert.equal(res.statusCode, 503, "the turn is reported as not dispatched");
    assert.deepEqual(published, [], "and nothing reached the stream under an unrecorded receipt");
  } finally {
    restore();
    await app.close();
  }
});

test("a message whose receipt a holder disarmed is refused rather than published", async () => {
  const ports = await sessionPorts();
  disarmReceiptOnOpen(ports);
  await seedSession(h, "s1", { agentStatus: "idle", gateOwner: null });
  const app = await appAs(registerSessionRoutes);
  try {
    const res = await sendMessage(app);

    assert.equal(res.statusCode, 503);
    assert.deepEqual(published, [], "a row somebody else owns is not published for");
    assert.deepEqual(
      await runStates(), ["preparing"],
      "and the holder that disarmed the receipt keeps its row; only it may settle one",
    );
  } finally {
    await app.close();
  }
});

test("a queued drain whose receipt write fails publishes nothing", async () => {
  await pendingPorts();
  await seedSession(h, "s1", { agentStatus: "idle" });
  await h.sql(
    "INSERT INTO claw_pending_messages (id, session_id, user_id, content) VALUES (7, 's1', 'u-1', 'hello')",
  );
  const restore = breakReceiptWrite();
  try {
    await assert.rejects(drainQueued(), "the drain reports the failure for the outer nak to retry");
  } finally {
    restore();
  }

  assert.deepEqual(published, []);
  assert.equal(
    (await h.sql("SELECT 1 FROM claw_pending_messages WHERE id = 7")).length, 1,
    "the queue row stays, so the turn is still owed",
  );
});

test("a queued drain whose receipt a holder disarmed publishes nothing", async () => {
  const ports = await pendingPorts();
  disarmReceiptOnOpen(ports);
  await seedSession(h, "s1", { agentStatus: "idle" });
  await h.sql(
    "INSERT INTO claw_pending_messages (id, session_id, user_id, content) VALUES (7, 's1', 'u-1', 'hello')",
  );

  await assert.rejects(drainQueued());

  assert.deepEqual(published, []);
  assert.deepEqual(
    await runStates(), ["preparing"],
    "and the holder that disarmed the receipt keeps its row; only it may settle one",
  );
});
