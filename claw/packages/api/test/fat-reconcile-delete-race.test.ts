// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The two halves of the race between a publisher retiring a reconcile marker
 * and the reconciler running the cleanup that marker stores.
 *
 * `releaseDispatchedFatReconcile` hands the marker back after a publish it can
 * no longer fence with a token, and reports its success to a request that then
 * answers HTTP 200. `runCleanupAction`'s delete arm runs `commitSessionDeletion`
 * against the session the create minted. Both write the same row and the answer
 * has to be total: a revocation that committed first must stop the delete, and
 * a delete that took the marker first must stop the publisher claiming the turn
 * was dispatched into a session that no longer exists. Reporting a dispatched
 * turn as unknown costs the caller a retry; reporting a turn as dispatched into
 * a deleted session hands back a session id that is about to stop existing.
 *
 * Driven by ordering, never by a timer. The horizon is brought forward with an
 * UPDATE for the same reason the sibling suites do it -- what is under test is
 * which write lands first, not how long a lease is -- and the interleaving is
 * produced by hooking the statement each party issues, so the two orderings are
 * exact rather than probable.
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
let db: typeof import("../src/infra/db.js")["db"];
let originalQuery: typeof db.query;
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
  ({ db } = await import("../src/infra/db.js"));
  originalQuery = db.query;
  app = Fastify();
  app.addHook("preHandler", async (req) => {
    (req as unknown as { user: UserInfo }).user = {
      userId: "user-delete-race", userName: "user-delete-race", roles: ["default"],
      platformKey: "pk-test", virtualKey: "vk-test",
    };
  });
  await harness.app.sessions.registerSessionRoutes(app);
  await app.ready();
});

beforeEach(async () => {
  if (skip) return;
  await client.query("TRUNCATE claw_tasks, claw_sessions, claw_workspaces CASCADE");
  Object.assign(ports, originalPorts);
  db.query = originalQuery;
  opened = [];
  gate.setDoorbellLatch({ state: "revoked" });
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
  db.query = originalQuery;
  gate.resetDoorbellGate();
  await app?.close();
  await harness?.stop();
});

function createWithMessage() {
  return app.inject({
    method: "POST", url: "/v1/sessions",
    payload: { name: "delete-race", message: { content: "hello" } },
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
 * The statement `releaseDispatchedFatReconcile` issues, verbatim.
 *
 * Written out here because the half being tested in the first case is the
 * reconciler's, and the publisher has to be made to commit at a chosen instant
 * inside the pass; the second case drives the real function through the real
 * route instead, which is where its own half is pinned.
 */
async function publisherRevokes(taskId: string): Promise<number> {
  const r = await client.query(
    `UPDATE claw_tasks
        SET dispatch_reconcile_at = NULL, dispatch_reconcile_action = NULL,
            metadata = metadata - 'dispatch_reconcile_token'
      WHERE task_id = $1
        AND COALESCE((metadata->>'dispatch_reconcile_deleted')::boolean, false) = false`,
    [taskId],
  );
  return r.rowCount ?? 0;
}

/** The 503 `publish_unknown` shape: fat, armed for a delete, no holder ever. */
async function armedDeleteRow() {
  ports.publishTask = async () => { throw new Error("nats: timeout"); };
  const response = await createWithMessage();
  assert.equal(response.statusCode, 503, response.body);
  const row = await runRow(opened[0]);
  assert.equal(row.dispatch_reconcile_action, "delete_created_session");
  // Terminal and unheld, which is the only state in which the delete arm is
  // entered at all.
  await client.query(
    `UPDATE claw_tasks SET status = 'failed', failure_reason = 'dispatch_failed',
            completed_at = NOW() WHERE task_id = $1`,
    [row.task_id],
  );
  assert.equal(await expireArmedMarker(row.task_id), 1);
  return row;
}

/**
 * The invariant, and the one ordering that was never in doubt: a hand-back that
 * commits before the pass decides anything stops the cleanup. Here so that the
 * case below cannot be passed by a fence that simply refuses every hand-back.
 */
test("a revocation that commits before the pass stops the delete", { skip }, async () => {
  const row = await armedDeleteRow();

  assert.equal(await publisherRevokes(row.task_id), 1);
  await sweeper.reconcileAmbiguousDispatches();

  const session = await sessionRow(row.session_id);
  assert.equal(session.deleted_at, null, "the cleanup was revoked, so it did not run");
  assert.equal(session.cleanup_state, null);
});

/**
 * The ordering that was broken, and the reason the check could not be a SELECT.
 *
 * A read can only see a disarm that committed before the read, and the commit
 * it guards comes after it -- so a hand-back landing in between used to be
 * reported to the publisher as a success, which answers HTTP 200, while the
 * delete it was supposed to revoke committed anyway. Both parties believed they
 * had won. Taking the marker instead makes the order total: the pass holds it,
 * so the hand-back matches nothing and the publisher learns it lost.
 *
 * The interleaving is exact rather than probable: the hand-back is issued from
 * inside `commitSessionDeletion`'s own first statement.
 */
test("a hand-back racing the commit loses, and is told so", { skip }, async () => {
  const row = await armedDeleteRow();

  // Hooked on the statement the delete arm uses to settle the marker, and
  // issued after it has committed: that is the instant the old SELECT could not
  // cover, because everything it had already read was by then a snapshot. The
  // match names the statement in both shapes -- the read this used to be and
  // the take it now is -- so the case is an ordering both versions reach and
  // only one survives.
  let revoked = -1;
  db.query = (async (text: string, params?: unknown[]) => {
    const settlesMarker = text.includes("dispatch_reconcile_deleted")
      || text.includes("dispatch_reconcile_at IS NOT NULL LIMIT 1");
    const r = await originalQuery(text, params);
    if (revoked < 0 && settlesMarker) revoked = await publisherRevokes(row.task_id);
    return r;
  }) as typeof db.query;

  await sweeper.reconcileAmbiguousDispatches();
  db.query = originalQuery;

  assert.equal(
    revoked, 0,
    "the pass already holds the marker, so the hand-back matches nothing and reports failure",
  );
  const session = await sessionRow(row.session_id);
  assert.notEqual(session.deleted_at, null, "and the delete it lost to is the one that runs");
  assert.equal(session.cleanup_state, "pending");
});

test("a delete that takes the marker first stops the publisher answering 200", { skip }, async () => {
  // Everything happens inside the publish, so there is no window to guess at:
  // by the time `publishTask` returns, the reconciler has already run to
  // completion and committed the deletion.
  let deleted = false;
  ports.publishTask = async () => {
    const taskId = opened[0];
    const row = await runRow(taskId);
    // A Stop that landed while the publish was in flight: the row is terminal
    // and unheld, so the pass is free to run the cleanup it stores.
    await client.query(
      `UPDATE claw_tasks SET status = 'cancelled', failure_reason = 'interrupted',
              completed_at = NOW() WHERE task_id = $1`,
      [taskId],
    );
    assert.equal(await expireArmedMarker(taskId), 1);
    await sweeper.reconcileAmbiguousDispatches();
    deleted = (await sessionRow(row.session_id)).deleted_at !== null;
    return 1;
  };

  const response = await createWithMessage();

  assert.equal(deleted, true, "the reconciler took the marker and committed the deletion");
  assert.equal(
    response.statusCode, 503,
    "so the publish may not be reported as a dispatch into a session that is gone",
  );
  const row = await runRow(opened[0]);
  assert.equal(row.dispatch_reconcile_at, null, "and the marker stays retired, not re-armed");
});
