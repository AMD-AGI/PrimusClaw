// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What answers the dispatch reconciler's question, once three proxies for it
 * have each been shown to be absent on some legitimate path.
 *
 * The marker `insertTask` arms exists to ask one thing: did this dispatch ever
 * reach anyone? Three answers have been tried and all three are artefacts of
 * HOW the run was serviced rather than of whether it ran. `claim_count` is a
 * doorbell counter. Holder evidence -- `lease_owner`, `lease_expires_at`,
 * `claim_count` -- is written on the fat path by the lease heartbeat, and
 * `startLeaseHeartbeat` is un-awaited with its rejection swallowed: one failed
 * POST during a rolling restart plus a turn shorter than the heartbeat period
 * and a row that executed and answered the user carries none of the three. The
 * publisher-side disarms are per branch, and the branch that matters has no
 * request left to patch.
 *
 * So the record is written by the act of completing instead: `closeChatRun`
 * retires the marker in the same statement that terminalizes the row. A worker
 * reporting an outcome is a fact that can only exist if the message reached a
 * worker, which is exactly what the marker asks, and it is not a property of
 * the lease machinery at all.
 *
 * Every case here asserts on `claw_sessions.deleted_at` and `cleanup_state`,
 * because what is at stake is a conversation the user was answered in being
 * soft-deleted and queued for content tombstoning. The controls are what keep
 * the rest honest: a dispatch no worker ever reported on must still be cleaned
 * up, and a report that closed no row must retire nothing.
 *
 * RUN_FAT_PREPARING_RECONCILE is false throughout, for the reason the sibling
 * suites give: the rollout doc mandates it for exactly this mixed-version
 * window, and it must not be what saves the session.
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
let chatRun: typeof import("../src/tasks/chat-run.js");
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
  chatRun = harness.app.chatRun;
  app = Fastify();
  app.addHook("preHandler", async (req) => {
    (req as unknown as { user: UserInfo }).user = {
      userId: "user-worker-report", userName: "user-worker-report", roles: ["default"],
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
  Object.assign(ports, originalPorts);
  opened = [];
  // Revoked, so `beginDoorbellDispatch` declines and the turn takes the fat
  // fallback -- the only path that produces a fat row at all.
  gate.setDoorbellLatch({ state: "revoked" });
  assert.equal(gate.doorbellGateOpen(), false);
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

function createWithMessage() {
  return app.inject({
    method: "POST", url: "/v1/sessions",
    payload: { name: "worker-report", message: { content: "hello" } },
  });
}

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
  assert.ok(row);
  return row;
}

async function expireArmedMarker(taskId: string): Promise<number> {
  const r = await client.query(
    `UPDATE claw_tasks SET dispatch_reconcile_at = clock_timestamp() - INTERVAL '1 second'
      WHERE task_id = $1 AND dispatch_reconcile_at IS NOT NULL`,
    [taskId],
  );
  return r.rowCount ?? 0;
}

/**
 * The row a 503 `publish_unknown` leaves: fat, `preparing`, cleanup armed, and
 * -- the point of this suite -- no holder evidence of any kind, because the one
 * writer of it on a pre-`accept` Brain is a heartbeat that never landed.
 *
 * `nats: timeout` carries no `code` and no `api_error`, so
 * `publishCertainlyFailed` is false, no refusal is noted, and the compensation
 * can establish nothing: the row stays open with its receipt reading
 * `attempted`, which is the same value a healthy dispatch's row carries. That
 * identity is the whole reason the marker exists.
 */
async function unreportedFatRow() {
  ports.publishTask = async () => { throw new Error("nats: timeout"); };
  const response = await createWithMessage();
  assert.equal(response.statusCode, 503, response.body);
  assert.equal(opened.length, 1);
  const row = await runRow(opened[0]);
  assert.equal(row.metadata.dispatch, "fat");
  assert.equal(row.status, "preparing", "the compensation established nothing, so no rollback ran");
  assert.equal(row.dispatch_reconcile_action, "delete_created_session");
  assert.notEqual(row.dispatch_reconcile_at, null);
  assert.equal(row.lease_owner, null);
  assert.equal(row.lease_expires_at, null);
  assert.equal(row.claim_count, 0, "and nothing a holder would have written is here");
  assert.equal(row.metadata.dispatch_compensation.publish, "attempted");
  return row;
}

/** What the completion consumer does when the turn is answered. */
async function workerReports(
  row: { task_id: string; session_id: string; metadata: any },
  outcome: "completed" | "failed" | "cancelled",
  failureReason?: string,
  named = true,
) {
  const closed = await chatRun.closeChatRun(
    row.session_id, row.metadata.message_id, outcome, failureReason,
    named ? { taskId: row.task_id, runClaim: undefined } : {},
  );
  assert.deepEqual(closed, [row.task_id]);
  return await runRow(row.task_id);
}

/** The assistant turn `recordCompletionTurns` writes for an answered turn. */
async function recordAnswer(sessionId: string, messageId: string, placeholder = false) {
  await client.query(
    `INSERT INTO claw_conversation_turns
       (session_id, turn_index, role, content, token_count, message_id, is_placeholder)
     VALUES ($1, 1, 'user', 'hello', 1, $2, false),
            ($1, 2, 'assistant', 'the answer', 2, $2, $3)`,
    [sessionId, messageId, placeholder],
  );
}

test("a turn whose worker never wrote a heartbeat is not reconciled away", { skip }, async () => {
  const row = await unreportedFatRow();

  // The turn ran and answered. A Brain that predates the `accept` flag reaches
  // no `acquireFatLease`, and `startLeaseHeartbeat` is `void`-ed with its
  // rejection swallowed, so a single failed POST during the rolling restart
  // leaves every column the reconciler reads exactly as it found them.
  const closed = await workerReports(row, "completed");
  assert.equal(closed.status, "completed");
  assert.equal(closed.claim_count, 0);
  assert.equal(closed.lease_owner, null, "no holder evidence: this is the shape under test");
  assert.equal(closed.lease_expires_at, null);

  // Whatever marker is left reaches its horizon, and the real pass runs.
  await expireArmedMarker(row.task_id);
  await sweeper.reconcileAmbiguousDispatches();

  // The outcome first, because it is the thing at stake and the assertion that
  // fails without the fix: a conversation the user was answered in, soft
  // deleted and queued for content tombstoning.
  const session = await sessionRow(row.session_id);
  assert.equal(session.deleted_at, null, "the conversation the user was answered in survives");
  assert.equal(session.cleanup_state, null, "and nothing is queued to tombstone its content");
  // Then the mechanism that produced it.
  assert.equal(
    closed.dispatch_reconcile_at, null,
    "the act of completing is what retires the marker",
  );
  assert.equal(closed.dispatch_reconcile_action, null);
  assert.equal(closed.metadata.dispatch_reconcile_token, undefined);
});

test("the same, through the unnamed close a Brain that sends no task id makes", { skip }, async () => {
  const row = await unreportedFatRow();

  const closed = await workerReports(row, "completed", undefined, false);
  assert.equal(closed.status, "completed");

  await expireArmedMarker(row.task_id);
  await sweeper.reconcileAmbiguousDispatches();
  const session = await sessionRow(row.session_id);
  assert.equal(session.deleted_at, null);
  assert.equal(session.cleanup_state, null);
  assert.equal(closed.dispatch_reconcile_at, null);
});

/**
 * The semantic decision this change makes, stated as a test rather than
 * inherited: a worker reporting a REFUSAL retires the marker too.
 *
 * `resolvePoisonedTask` publishes `exec_complete` with `failed: true` for a
 * delivery whose JetStream budget ran out without the turn ever executing. It
 * is a worker reporting a non-execution -- and it is still proof that the
 * message was delivered, repeatedly, which is the entire question this marker
 * asks. It also emits a terminal event the user can see, which
 * `recordCompletionTurns` writes into the conversation. Rolling the session
 * back under an answer already shown is the failure this whole sequence is
 * about, and a session left behind is a leak that can be collected while a
 * session deleted is a conversation that cannot be recovered.
 */
test("a worker reporting a refusal retires the marker too", { skip }, async () => {
  const row = await unreportedFatRow();

  const closed = await workerReports(row, "failed", "run_budget_exhausted");
  assert.equal(closed.status, "failed");
  assert.equal(closed.failure_reason, "run_budget_exhausted");

  await expireArmedMarker(row.task_id);
  await sweeper.reconcileAmbiguousDispatches();
  const session = await sessionRow(row.session_id);
  assert.equal(session.deleted_at, null);
  assert.equal(session.cleanup_state, null);
  assert.equal(
    closed.dispatch_reconcile_at, null,
    "a delivery a worker spent its budget on is a delivery that landed",
  );
});

/**
 * The control, and the one the two above must not buy: the same 503, the same
 * armed `delete_created_session`, and no worker ever reported anything. A
 * duplicate or superseded report that matches no row retires nothing -- which
 * is what keeps the fix scoped to rows a close actually moved.
 */
test("a dispatch no worker reported on is still cleaned up", { skip }, async () => {
  const row = await unreportedFatRow();

  // What the compensation writes once it can establish non-delivery. Not
  // through `closeChatRun`: nothing reported this row, the sweeper and the
  // publisher terminalize it themselves.
  const r = await client.query(
    `UPDATE claw_tasks
        SET status = 'failed', failure_reason = 'dispatch_failed', completed_at = NOW()
      WHERE task_id = $1`,
    [row.task_id],
  );
  assert.equal(r.rowCount, 1);

  // A late report for the row arrives anyway -- a redelivered completion, or a
  // generation the row's holder superseded. It matches nothing, so it may not
  // retire anything either.
  assert.deepEqual(
    await chatRun.closeChatRun(
      row.session_id, row.metadata.message_id, "completed", undefined,
      { taskId: row.task_id, runClaim: undefined },
    ),
    [],
  );
  const stillArmed = await runRow(row.task_id);
  assert.notEqual(
    stillArmed.dispatch_reconcile_at, null,
    "a close that moved no row is not a report about this dispatch",
  );

  assert.equal(await expireArmedMarker(row.task_id), 1);
  assert.equal(await sweeper.reconcileAmbiguousDispatches(), 1);
  const session = await sessionRow(row.session_id);
  assert.notEqual(session.deleted_at, null, "the session a create minted for a turn that never ran is taken back");
  assert.equal(session.cleanup_state, "pending", "durably");
});

/**
 * The floor, for the case no record reaches the row at all: the reconciler
 * refuses to delete a session that holds an answer.
 *
 * Reached when the report never closed the row -- a reaper got there first, a
 * completion was classified `foreign` -- so neither the close-side record nor
 * holder evidence is present. What is present is the thing the delete would
 * destroy, and measuring that directly is the only guard here that is not a
 * proxy for execution.
 */
test("a session holding a real answer is never deleted, whatever the row says", { skip }, async () => {
  const row = await unreportedFatRow();
  await recordAnswer(row.session_id, row.metadata.message_id);

  // Terminalized by something that is not a worker report, so the marker
  // survives and no holder evidence exists: the delete arm is entered.
  await client.query(
    `UPDATE claw_tasks SET status = 'failed', failure_reason = 'dispatch_unconfirmed',
            completed_at = NOW() WHERE task_id = $1`,
    [row.task_id],
  );
  assert.equal(await expireArmedMarker(row.task_id), 1);
  assert.equal(await sweeper.reconcileAmbiguousDispatches(), 1, "the row is settled and the marker retired");

  const session = await sessionRow(row.session_id);
  assert.equal(session.deleted_at, null, "a conversation with an answer in it is not rolled back");
  assert.equal(session.cleanup_state, null);
});

/** And the floor's own control: a sweeper's placeholder is not an answer. */
test("a session holding only a sweeper placeholder is still cleaned up", { skip }, async () => {
  const row = await unreportedFatRow();
  await recordAnswer(row.session_id, row.metadata.message_id, true);

  await client.query(
    `UPDATE claw_tasks SET status = 'failed', failure_reason = 'dispatch_unconfirmed',
            completed_at = NOW() WHERE task_id = $1`,
    [row.task_id],
  );
  assert.equal(await expireArmedMarker(row.task_id), 1);
  assert.equal(await sweeper.reconcileAmbiguousDispatches(), 1);

  const session = await sessionRow(row.session_id);
  assert.notEqual(
    session.deleted_at, null,
    "an announcement the sweeper synthesised is not a turn the user was answered in",
  );
  assert.equal(session.cleanup_state, "pending");
});
