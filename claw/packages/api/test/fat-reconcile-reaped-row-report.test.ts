// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The report that arrives with no row left to move.
 *
 * `RETIRE_DISPATCH_RECONCILE_SQL` records "a worker reported on this dispatch"
 * inside the transition the close wins, which makes the record conditional on
 * this report being the one that terminalizes the row. A reaper can take that
 * transition away: `reapOrphanedFatRuns` closes a holderless fat row on
 * delivery-settled evidence, the row goes `failed`, the worker's own close then
 * matches nothing -- and the armed `delete_created_session` marker survives to
 * delete the conversation the worker had just answered in.
 *
 * Two facts have to hold for the answer to be safe, and they are tested apart
 * because they fail apart: the consumer records the report for a row it no
 * longer closes, and the delete arm decides against the report and the answer
 * in the statement that takes the marker rather than in a SELECT above it. The
 * second is what covers a report landing inside the pass.
 *
 * Ordering is produced by hooking the exact statement the delete arm issues, so
 * the interleaving is a fact rather than a race the test hopes to win. No
 * timers.
 */

import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import type pg from "pg";

import type { UserInfo } from "../src/auth/models.js";
import { startAdmissionCluster, type AdmissionCluster } from "./support/admission-cluster.js";
import { postgresSkipReason } from "./support/pg-cluster.js";

const skip = postgresSkipReason();
let harness: AdmissionCluster;
let client: pg.Client;
let app: FastifyInstance;
let ports: typeof import("../src/sessions/dispatch.js")["sessionDispatchPorts"];
let originalPorts: typeof ports;
let gate: typeof import("../src/tasks/doorbell-gate.js");
let sweeper: typeof import("../src/tasks/sweeper.js");
let consumer: typeof import("../src/events/consumer.js");
let deletedCache: typeof import("../src/sessions/deleted-cache.js");
let natsCodec: typeof import("../src/infra/nats.js");
let dbmod: typeof import("../src/infra/db.js");
let opened: string[];

before(async () => {
  if (skip) return;
  harness = await startAdmissionCluster({
    RUN_DOORBELL_DISPATCH: "true",
    RUN_FAT_PREPARING_RECONCILE: "false",
  });
  const { initUserEnvCrypto } = await import("../src/crypto/user-env.js");
  initUserEnvCrypto();
  client = await harness.connect();
  ({ sessionDispatchPorts: ports } = await import("../src/sessions/dispatch.js"));
  originalPorts = { ...ports };
  gate = await import("../src/tasks/doorbell-gate.js");
  sweeper = await import("../src/tasks/sweeper.js");
  consumer = await import("../src/events/consumer.js");
  deletedCache = await import("../src/sessions/deleted-cache.js");
  natsCodec = await import("../src/infra/nats.js");
  dbmod = harness.app.db;
  app = Fastify();
  app.addHook("preHandler", async (req) => {
    (req as unknown as { user: UserInfo }).user = {
      userId: "user-reap", userName: "user-reap", roles: ["default"],
      platformKey: "pk-test", virtualKey: "vk-test",
    };
  });
  await harness.app.sessions.registerSessionRoutes(app);
  await app.ready();
});

beforeEach(async () => {
  if (skip) return;
  await client.query("TRUNCATE claw_tasks, claw_sessions, claw_workspaces CASCADE");
  await client.query("TRUNCATE claw_conversation_turns");
  await client.query("TRUNCATE claw_session_events");
  Object.assign(ports, originalPorts);
  opened = [];
  gate.setDoorbellLatch({ state: "revoked" });
  assert.equal(gate.doorbellGateOpen(), false);
  deletedCache.resetDeletedSessionCache();
  ports.publishSse = () => {};
  ports.openChatRun = async (input) => {
    const run = await originalPorts.openChatRun(input);
    assert.ok(run);
    opened.push(run.taskId);
    return run;
  };
});

after(async () => {
  if (skip) return;
  Object.assign(ports, originalPorts);
  gate.resetDoorbellGate();
  await app?.close();
  await harness?.stop();
});

async function runRow(taskId: string) {
  const { rows: [row] } = await client.query("SELECT * FROM claw_tasks WHERE task_id = $1", [taskId]);
  assert.ok(row);
  return row;
}

async function sessionRow(sessionId: string) {
  const { rows: [row] } = await client.query(
    "SELECT deleted_at, cleanup_state FROM claw_sessions WHERE session_id = $1",
    [sessionId],
  );
  assert.ok(row, "the session row itself is still there");
  return row;
}

async function turnRows(sessionId: string) {
  const { rows } = await client.query(
    "SELECT role, content, is_placeholder, deleted_at FROM claw_conversation_turns "
    + "WHERE session_id = $1 ORDER BY turn_index", [sessionId],
  );
  return rows;
}

async function expireArmedMarker(taskId: string): Promise<number> {
  const r = await client.query(
    `UPDATE claw_tasks SET dispatch_reconcile_at = clock_timestamp() - INTERVAL '1 second'
      WHERE task_id = $1 AND dispatch_reconcile_at IS NOT NULL`,
    [taskId],
  );
  return r.rowCount ?? 0;
}

/** The row a 503 `publish_unknown` leaves: fat, preparing, armed, no holder evidence. */
async function unreportedFatRow() {
  ports.publishTask = async () => { throw new Error("nats: timeout"); };
  const response = await app.inject({
    method: "POST", url: "/v1/sessions",
    payload: { name: "reaped", message: { content: "hello" } },
  });
  assert.equal(response.statusCode, 503, response.body);
  assert.equal(opened.length, 1);
  const row = await runRow(opened[0]);
  assert.equal(row.metadata.dispatch, "fat");
  assert.equal(row.status, "preparing");
  assert.equal(row.dispatch_reconcile_action, "delete_created_session");
  assert.notEqual(row.dispatch_reconcile_at, null);
  assert.equal(row.lease_owner, null);
  assert.equal(row.lease_expires_at, null);
  assert.equal(row.claim_count, 0);
  return row;
}

/** Age the row past BRAIN_TASK_TIMEOUT_SEC so the orphan reaper's scan matches it. */
async function ageRow(taskId: string) {
  await client.query(
    "UPDATE claw_tasks SET started_at = NOW() - INTERVAL '2 hours' WHERE task_id = $1",
    [taskId],
  );
}

/**
 * The reap, with the durable reporting the tasks stream fully settled: the
 * message this row's publish could not confirm did land and was acknowledged.
 * That is the only arm a `publish_unknown` row can qualify through -- it banked
 * no `dispatch_seq` -- and it is what puts the reaper inside its guard.
 */
async function reapWithSettledDelivery(): Promise<number> {
  const original = sweeper.sweeperPorts.deliverySettlement;
  sweeper.sweeperPorts.deliverySettlement = async () => ({ ackFloor: 42, lastSeq: 42 });
  try {
    return await sweeper.reapOrphanedFatRuns();
  } finally {
    sweeper.sweeperPorts.deliverySettlement = original;
  }
}

/** The real completion consumer, on the exec_complete the worker published. */
async function workerCompletionLands(sessionId: string, taskId: string, messageId: string) {
  const original = { ...consumer.tombstoneReader };
  Object.assign(consumer.tombstoneReader, { has: async () => false });
  deletedCache.resetDeletedSessionCache();
  try {
    await consumer.consumeEventDelivery({
      subject: `events.${sessionId}`,
      seq: 7,
      data: natsCodec.sc.encode(JSON.stringify({
        type: "exec_complete", session_id: sessionId, task_id: taskId,
        message_id: messageId, user_id: "user-reap",
        prompt: "hello", final_text: "the answer the user saw", failed: false,
        error_count: 0, skills_used: {},
      })),
      ack: () => {}, nak: () => {},
    });
  } finally {
    Object.assign(consumer.tombstoneReader, original);
  }
}

/**
 * Run `body` with a one-shot hook that fires immediately BEFORE the statement
 * the delete arm uses to take the marker -- the last thing it does before the
 * deletion commits. `dispatch_reconcile_deleted` appears in no other statement
 * this pass issues against a live session.
 */
async function beforeMarkerTake<T>(hook: () => Promise<void>, body: () => Promise<T>): Promise<T> {
  const real = dbmod.db.query.bind(dbmod.db);
  let fired = false;
  (dbmod.db as { query: unknown }).query = async (text: unknown, ...rest: unknown[]) => {
    if (!fired && String(text).includes("dispatch_reconcile_deleted")) {
      fired = true;
      (dbmod.db as { query: unknown }).query = real;
      await hook();
    }
    return await (real as (...a: unknown[]) => Promise<unknown>)(text, ...rest);
  };
  try {
    const out = await body();
    assert.equal(fired, true, "the delete arm never reached its marker take");
    return out;
  } finally {
    (dbmod.db as { query: unknown }).query = real;
  }
}

test("a report the reaper left no row for still retires the marker", { skip }, async () => {
  const row = await unreportedFatRow();
  const messageId = row.metadata.message_id as string;
  await ageRow(row.task_id);
  assert.equal(await reapWithSettledDelivery(), 1, "the reaper closed the holderless row");
  const reaped = await runRow(row.task_id);
  assert.equal(reaped.status, "failed");
  assert.notEqual(reaped.dispatch_reconcile_at, null, "the reaper's close retires nothing");

  await workerCompletionLands(row.session_id, row.task_id, messageId);

  // The cleanup is no longer owed, and that is visible as an outcome rather
  // than as a column: the pass finds nothing to do, and the conversation the
  // worker answered in is still there.
  assert.equal(await sweeper.reconcileAmbiguousDispatches(), 0,
    "the marker was retired, so the horizon has nothing to select");
  await expireArmedMarker(row.task_id);
  assert.equal(await sweeper.reconcileAmbiguousDispatches(), 0);
  const session = await sessionRow(row.session_id);
  assert.equal(session.deleted_at, null);
  const assistant = (await turnRows(row.session_id)).find((t) => t.role === "assistant");
  assert.ok(assistant, "the worker's answer is in the conversation");
  assert.equal(assistant!.is_placeholder, false);
  assert.equal(assistant!.deleted_at, null);
});

test("a report landing inside the pass is not overtaken by the delete", { skip }, async () => {
  const row = await unreportedFatRow();
  const messageId = row.metadata.message_id as string;
  await ageRow(row.task_id);
  assert.equal(await reapWithSettledDelivery(), 1);
  assert.equal(await expireArmedMarker(row.task_id), 1);

  // The completion lands after every probe the arm makes and before the
  // deletion commits -- the window a re-read cannot close, because the consumer
  // is a writer no SELECT excludes.
  let reported = false;
  await beforeMarkerTake(async () => {
    assert.equal((await turnRows(row.session_id)).length, 0,
      "no turn exists at the moment the reconciler decides");
    await workerCompletionLands(row.session_id, row.task_id, messageId);
    const { rows } = await client.query(
      "SELECT 1 FROM claw_session_events WHERE session_id = $1 AND event = 'exec_complete'",
      [row.session_id],
    );
    assert.equal(rows.length, 1, "the worker's report is durably persisted");
    reported = true;
  }, async () => {
    await sweeper.reconcileAmbiguousDispatches();
  });
  assert.equal(reported, true);

  // The consumer may have been deferred by the lock the arm holds; its report
  // is redelivered, and nothing about the outcome may depend on which side of
  // the pass it lands on.
  if (!(await turnRows(row.session_id)).some((t) => t.role === "assistant")) {
    await workerCompletionLands(row.session_id, row.task_id, messageId);
  }

  const session = await sessionRow(row.session_id);
  assert.equal(session.deleted_at, null, "the conversation the user was answered in survives");
  assert.equal(session.cleanup_state, null, "and nothing is queued to tombstone its content");
  const assistant = (await turnRows(row.session_id)).find((t) => t.role === "assistant");
  assert.ok(assistant, "the worker's answer is in the conversation");
  assert.equal(assistant!.content, "the answer the user saw");
  assert.equal(assistant!.is_placeholder, false);
  assert.equal(assistant!.deleted_at, null, "and it is not tombstoned");
});

test("control: a dispatch no worker ever reported on is still cleaned up", { skip }, async () => {
  // The other side of the floor: silence is not a report, and a session whose
  // turn never ran is still taken back. Without this the two tests above are
  // satisfied by an arm that deletes nothing at all.
  const row = await unreportedFatRow();
  await ageRow(row.task_id);
  assert.equal(await reapWithSettledDelivery(), 1);
  assert.equal(await expireArmedMarker(row.task_id), 1);
  assert.equal(await sweeper.reconcileAmbiguousDispatches(), 1);
  const session = await sessionRow(row.session_id);
  assert.notEqual(session.deleted_at, null, "the session the 503 create minted is deleted");
  assert.equal(session.cleanup_state, "pending", "and its content is scheduled for tombstoning");
});
