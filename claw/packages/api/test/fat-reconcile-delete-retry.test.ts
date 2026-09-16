// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What is left owed when the delete the reconciler decided on does not commit.
 *
 * `commitSessionDeletion` is one transaction and any abort reaches its
 * `TeardownRefused` -- a deadlock (one is recorded in its own comment), a full
 * disk, a statement timeout. The arm's `return false` is written as "this row
 * stays eligible", and that was only true while the marker was still armed when
 * it ran. Taking the marker by clearing it made an ordinary rollback permanent:
 * `reconcileAmbiguousDispatches` selects on `dispatch_reconcile_at IS NOT NULL`
 * and nothing else ever selects the row, so the session was left created, not
 * deleted, not `cleanup_state = 'pending'` -- and the first test here is the
 * measurement that nothing in this deployment collects that state.
 *
 * The marker is therefore held at a fresh lease rather than erased. The fence
 * the clear was buying is `dispatch_reconcile_deleted`, not the NULL, so the
 * publisher still loses the race it used to lose.
 *
 * The failure is a real one: a trigger that makes Postgres roll the deletion's
 * transaction back, not a stubbed throw.
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
let cleanupSweep: typeof import("../src/sessions/cleanup-sweep.js");
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
  cleanupSweep = await import("../src/sessions/cleanup-sweep.js");
  app = Fastify();
  app.addHook("preHandler", async (req) => {
    (req as unknown as { user: UserInfo }).user = {
      userId: "user-retry", userName: "user-retry", roles: ["default"],
      platformKey: "pk-test", virtualKey: "vk-test",
    };
  });
  await harness.app.sessions.registerSessionRoutes(app);
  await app.ready();
});

beforeEach(async () => {
  if (skip) return;
  await dropBoom();
  await client.query("TRUNCATE claw_tasks, claw_sessions, claw_workspaces CASCADE");
  await client.query("TRUNCATE claw_conversation_turns");
  await client.query("TRUNCATE claw_session_events");
  Object.assign(ports, originalPorts);
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
  await dropBoom().catch(() => {});
  Object.assign(ports, originalPorts);
  gate.resetDoorbellGate();
  await app?.close();
  await harness?.stop();
});

/** A database failure inside the delete's own transaction, not a fake throw. */
async function armBoom(sessionId: string) {
  await client.query(`
    CREATE OR REPLACE FUNCTION reconcile_boom() RETURNS trigger AS $fn$
    BEGIN RAISE EXCEPTION 'could not write block: No space left on device'; END
    $fn$ LANGUAGE plpgsql`);
  await client.query(`
    CREATE TRIGGER reconcile_boom_trg BEFORE UPDATE ON claw_sessions
      FOR EACH ROW WHEN (NEW.session_id = '${sessionId}')
      EXECUTE FUNCTION reconcile_boom()`);
}
async function dropBoom() {
  await client.query("DROP TRIGGER IF EXISTS reconcile_boom_trg ON claw_sessions");
}

async function runRow(taskId: string) {
  const { rows: [row] } = await client.query("SELECT * FROM claw_tasks WHERE task_id = $1", [taskId]);
  assert.ok(row);
  return row;
}
async function sessionRow(sessionId: string) {
  const { rows: [row] } = await client.query(
    "SELECT deleted_at, cleanup_state, cleanup_attempts, agent_status FROM claw_sessions "
    + "WHERE session_id = $1", [sessionId],
  );
  assert.ok(row);
  return row;
}

/** The row a 503 `publish_unknown` create leaves, terminal and due. */
async function armedDeleteRow() {
  ports.publishTask = async () => { throw new Error("nats: timeout"); };
  const response = await app.inject({
    method: "POST", url: "/v1/sessions",
    payload: { name: "retry", message: { content: "hello" } },
  });
  assert.equal(response.statusCode, 503, response.body);
  const row = await runRow(opened[0]);
  assert.equal(row.dispatch_reconcile_action, "delete_created_session");
  await client.query(
    `UPDATE claw_tasks SET status = 'failed', failure_reason = 'dispatch_failed',
            completed_at = NOW() WHERE task_id = $1`,
    [row.task_id],
  );
  const due = await client.query(
    `UPDATE claw_tasks SET dispatch_reconcile_at = clock_timestamp() - INTERVAL '1 second'
      WHERE task_id = $1 AND dispatch_reconcile_at IS NOT NULL`,
    [row.task_id],
  );
  assert.equal(due.rowCount, 1);
  return row;
}

/** The statement the fat publisher's release issues, verbatim. */
async function publisherHandsBack(taskId: string): Promise<number> {
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

/** Bring the held lease forward, the way a later tick would find it. */
async function nextTickIsDue(taskId: string): Promise<number> {
  const r = await client.query(
    `UPDATE claw_tasks SET dispatch_reconcile_at = clock_timestamp() - INTERVAL '1 second'
      WHERE task_id = $1 AND dispatch_reconcile_at IS NOT NULL`,
    [taskId],
  );
  return r.rowCount ?? 0;
}

test("a deletion that rolled back is retried, and finishes", { skip }, async () => {
  const row = await armedDeleteRow();
  await armBoom(row.session_id);
  assert.equal(await sweeper.reconcileAmbiguousDispatches(), 0, "nothing settled");
  const refused = await sessionRow(row.session_id);
  assert.equal(refused.deleted_at, null, "the transaction really did roll back");
  assert.equal(refused.cleanup_state, null);

  // The ordering the take buys is untouched: a publisher handing the marker
  // back after the take still matches nothing, so no request answers 200
  // `dispatched` naming a session this pass is still going to delete.
  assert.equal(await publisherHandsBack(row.task_id), 0);

  await dropBoom();
  assert.equal(await nextTickIsDue(row.task_id), 1, "the row is still armed to be found");
  assert.equal(await sweeper.reconcileAmbiguousDispatches(), 1, "and the next tick finishes it");
  const done = await sessionRow(row.session_id);
  assert.notEqual(done.deleted_at, null, "the session the 503 create minted is deleted");
  assert.equal(done.cleanup_state, "pending", "and its content is scheduled for tombstoning");
});

test("nothing else would have collected it, so the retry is the only owner", { skip }, async () => {
  // The measurement the abandoned-row trade used to be argued from. Every pass
  // this deployment runs, against a session that is created, not deleted, and
  // has no `cleanup_state`: if any of them collected it, the retry above would
  // be optional. None do.
  const row = await armedDeleteRow();
  await armBoom(row.session_id);
  await sweeper.reconcileAmbiguousDispatches();
  await dropBoom();
  // Detach the row the way the old clear did, so what is measured is the
  // collection question alone rather than the retry that now answers it.
  await client.query(
    "UPDATE claw_tasks SET dispatch_reconcile_at = NULL, dispatch_reconcile_action = NULL "
    + "WHERE task_id = $1", [row.task_id],
  );
  await client.query(
    "UPDATE claw_sessions SET created_at = NOW() - INTERVAL '2 days', "
    + "updated_at = NOW() - INTERVAL '2 days' WHERE session_id = $1", [row.session_id],
  );

  await sweeper.sweeperTick();
  assert.equal(await cleanupSweep.sweepSessionCleanups(), 0,
    "sweepSessionCleanups only sees cleanup_state = 'pending'");
  assert.equal(await sweeper.reapStuckSessions(), 0);
  const after = await sessionRow(row.session_id);
  assert.equal(after.deleted_at, null, "no pass in this deployment collects it");
  assert.equal(after.cleanup_state, null);
});

test("a retry after the delete did commit does not redo it", { skip }, async () => {
  // The re-entry the lease makes possible: a crash between the take and the
  // marker's retirement leaves an armed row for a deletion that landed.
  // Re-running `commitSessionDeletion` would be idempotent on `deleted_at` and
  // destructive on everything `stuckCleanups` reads -- it resets
  // `cleanup_attempts` to zero and clears `cleanup_error`.
  const row = await armedDeleteRow();
  assert.equal(await sweeper.reconcileAmbiguousDispatches(), 1);
  const first = await sessionRow(row.session_id);
  assert.notEqual(first.deleted_at, null);

  await client.query(
    `UPDATE claw_tasks SET dispatch_reconcile_at = clock_timestamp() - INTERVAL '1 second',
            dispatch_reconcile_action = 'delete_created_session' WHERE task_id = $1`,
    [row.task_id],
  );
  await client.query(
    "UPDATE claw_sessions SET cleanup_attempts = 4, cleanup_error = 'store down' "
    + "WHERE session_id = $1", [row.session_id],
  );
  await sweeper.reconcileAmbiguousDispatches();
  const after = await sessionRow(row.session_id);
  assert.equal(
    (after.deleted_at as Date).getTime(), (first.deleted_at as Date).getTime(),
    "the delete instant did not move",
  );
  assert.equal(Number(after.cleanup_attempts), 4,
    "and the cleanup still in flight kept its attempt count");
});
