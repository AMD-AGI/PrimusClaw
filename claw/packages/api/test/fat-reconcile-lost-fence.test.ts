// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a fat dispatch owes its reconcile marker once the message is on the
 * stream, and why a lost fence may not end the attempt there.
 *
 * The fat fallback arms `dispatch_reconcile_action` at open for the same reason
 * the doorbell path does -- a publish whose outcome is never decided has to
 * leave the created session to somebody -- and hands it back the moment the
 * publish is decided. The two paths part company when the hand-back is refused:
 * `clearDispatchReconcile` is token-fenced, and it answers false both for a
 * reconciler that has already adopted the row (the sweeper's own take strips
 * `dispatch_reconcile_token` out of the metadata) and for an UPDATE that never
 * landed.
 *
 * On a doorbell row that answer costs nothing, because the row can still prove
 * it executed: every `takeClaim` increments `claim_count`, which is the single
 * column `resolveAmbiguousDispatch` reads to decide "never executed". A fat row
 * proves nothing. Nothing on the publish path increments it, and the only writer
 * that does -- `acquireFatLease` -- is unreachable for a Brain that predates the
 * `accept` flag: its attempt token quotes `claim_count = 0`, `renewRunLease`'s
 * fence matches that, and the row is renewed at zero for the whole turn. That is
 * the fleet executing these turns during a rolling upgrade, which rolls API
 * before Brain.
 *
 * So an armed marker surviving a successful fat publish is a scheduled
 * deletion, not a deferral: while the turn runs the reconciler's non-terminal
 * arm refuses to close a held row and merely re-arms, and once the turn
 * completes that arm -- the only consumer of RUN_FAT_PREPARING_RECONCILE -- is
 * skipped altogether and the stored `delete_created_session` runs against a
 * conversation the user was successfully answered in.
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
  // False on purpose: the rollout doc mandates it for exactly the mixed-version
  // window this covers, and it must not be what saves the session.
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
      userId: "user-fat-fence", userName: "user-fat-fence", roles: ["default"],
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
  opened = [];
  // Revoked, so `beginDoorbellDispatch` declines and the turn takes the fat
  // fallback. Every non-floor latch state resolves the same way.
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
    payload: { name: "fat-fence", message: { content: "hello" } },
  });
}

async function runRow(taskId: string) {
  const { rows: [row] } = await client.query("SELECT * FROM claw_tasks WHERE task_id = $1", [taskId]);
  assert.ok(row);
  return row;
}

async function sessionRow(sessionId: string) {
  const { rows: [row] } = await client.query(
    "SELECT deleted_at, cleanup_state, agent_status FROM claw_sessions WHERE session_id = $1",
    [sessionId],
  );
  assert.ok(row);
  return row;
}

/** Bring whatever marker is still armed to its horizon, and only that. */
async function expireArmedMarker(taskId: string): Promise<number> {
  const r = await client.query(
    `UPDATE claw_tasks SET dispatch_reconcile_at = clock_timestamp() - INTERVAL '1 second'
      WHERE task_id = $1 AND dispatch_reconcile_at IS NOT NULL`,
    [taskId],
  );
  return r.rowCount ?? 0;
}

/**
 * The take `reconcileAmbiguousDispatches` performs, and the only half of it that
 * matters to the publisher: the token it was fencing on is gone, so its
 * hand-back matches nothing. Written out rather than driven through the sweeper
 * so the case does not depend on the horizon having passed -- a reconcile-token
 * takeover and a transient failure of the hand-back UPDATE reach the publisher
 * as the same `false`.
 */
async function stripReconcileToken(taskId: string): Promise<void> {
  const r = await client.query(
    "UPDATE claw_tasks SET metadata = metadata - 'dispatch_reconcile_token' WHERE task_id = $1",
    [taskId],
  );
  assert.equal(r.rowCount, 1);
}

test("a fat publish whose hand-back loses its fence still disarms the marker", { skip }, async () => {
  ports.publishTask = async (_subject, payload) => {
    const taskId = (JSON.parse(payload) as { task_id: string }).task_id;
    const armed = await runRow(taskId);
    assert.equal(armed.dispatch_reconcile_action, "delete_created_session");
    assert.notEqual(armed.dispatch_reconcile_at, null);
    await stripReconcileToken(taskId);
    return 1;
  };

  const response = await createWithMessage();

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(opened.length, 1);
  const row = await runRow(opened[0]);
  assert.equal(row.metadata.dispatch, "fat");
  assert.equal(
    row.dispatch_reconcile_at, null,
    "a fat row cannot prove it executed, so the marker may not survive its own publish",
  );
  assert.equal(row.dispatch_reconcile_action, null);
  assert.equal(row.claim_count, 0, "and it is still at zero, which is the whole reason");

  // The turn the user is having now runs and answers, through the same call the
  // completion consumer makes. A Brain that predates the `accept` flag holds the
  // row by renewal alone, so `claim_count` never leaves zero.
  await client.query(
    "UPDATE claw_tasks SET lease_owner = 'brain-pod-1', lease_expires_at = NOW() + INTERVAL '60 seconds' WHERE task_id = $1",
    [row.task_id],
  );
  assert.deepEqual(
    await chatRun.closeChatRun(row.session_id, row.metadata.message_id, "completed"),
    [row.task_id],
  );
  const closed = await runRow(row.task_id);
  assert.equal(closed.status, "completed");
  assert.equal(closed.claim_count, 0);

  assert.equal(await expireArmedMarker(row.task_id), 0, "there is no marker left to reach a horizon");
  assert.equal(await sweeper.reconcileAmbiguousDispatches(), 0, "so nothing is owing");
  const session = await sessionRow(row.session_id);
  assert.equal(
    session.deleted_at, null,
    "the session the user was successfully answered in survives the reconcile pass",
  );
  assert.notEqual(
    session.cleanup_state, "pending",
    "and its content is not tombstoned nor its workspace objects scheduled for collection",
  );
});

/**
 * The other half of the same change, and the reason the marker is armed at all:
 * a publish whose outcome was never decided still has to leave the created
 * session to the sweeper, which before it was armed could not see the row at
 * all. Nothing above may buy the case below.
 */
test("a fat publish that never decided is still visible to reconciliation", { skip }, async () => {
  ports.publishTask = async () => { throw new Error("stream unavailable"); };
  ports.failChatRunDispatch = async () => "unknown";

  const response = await createWithMessage();

  assert.equal(response.statusCode, 503, response.body);
  assert.equal(response.json().detail, "stream unavailable");
  assert.equal(opened.length, 1);
  const row = await runRow(opened[0]);
  assert.equal(row.dispatch_reconcile_action, "delete_created_session");
  assert.notEqual(row.dispatch_reconcile_at, null);
  assert.equal(await sessionRow(row.session_id).then((s) => s.deleted_at), null);

  assert.equal(await expireArmedMarker(row.task_id), 1, "this marker does reach a horizon");
  // Declined rather than resolved, because RUN_FAT_PREPARING_RECONCILE is off
  // for this suite and the row is still `preparing` with a delivery that may
  // exist -- so `failChatRunDispatch` will not close it and the pass re-arms.
  // What matters here is that the row was *taken*: selected, its horizon pushed
  // forward and its publisher's token revoked, with the cleanup still owed.
  assert.equal(await sweeper.reconcileAmbiguousDispatches(), 0);
  const taken = await runRow(row.task_id);
  assert.ok(
    taken.dispatch_reconcile_at > new Date(),
    "a fat row armed with no action is invisible here, and this turn would be owed to nobody",
  );
  assert.equal(taken.dispatch_reconcile_action, "delete_created_session", "and still owes it");
  assert.equal(taken.metadata.dispatch_reconcile_token, undefined, "the take revokes the token");
  assert.equal(await sessionRow(row.session_id).then((s) => s.deleted_at), null,
    "while the outcome is genuinely undecided nothing is rolled back either way");
});
