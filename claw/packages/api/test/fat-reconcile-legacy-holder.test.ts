// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the dispatch reconciler is allowed to infer from `claim_count = 0`, and
 * why the answer is "nothing" once the row is a fat one.
 *
 * `resolveAmbiguousDispatch` runs a stored cleanup -- for a create, the
 * deletion of the session the create minted -- against a row it believes never
 * executed, and it used to decide that from `claim_count` alone. That counter
 * is written by `takeClaim` on the doorbell path and, on the fat path, by
 * `acquireFatLease` and nothing else; `acquireFatLease` sits behind the
 * `accept` flag. A Brain that predates that flag therefore runs a whole fat
 * turn at zero: its attempt token quotes `claim_count = 0`, `renewRunLease`'s
 * fence matches that zero and renews, and the completion is admitted because no
 * `lease_fenced` was ever written. The row goes terminal at zero, still holding
 * the lease columns that renewal wrote, and the reconciler reads it as a
 * dispatch that never happened.
 *
 * That is not an exotic interleaving. It is the fleet during a rolling upgrade,
 * which moves API before Brain, and every one of the ways an armed marker can
 * outlive a request lands on it: the `held` catch arm returning HTTP 200 (first
 * case below), and a 503 `publish_unknown` whose request is gone before the
 * turn even runs (second case) -- the case no publisher-side disarm can ever
 * cover, because the marker outliving the request is the entire reason the
 * marker exists.
 *
 * So these cases assert on `claw_sessions.deleted_at`, not on a status code:
 * what is at stake is a conversation the user was successfully answered in
 * being soft-deleted and queued for content tombstoning. The third case is the
 * control that keeps the first two honest -- the same marker, the same action,
 * the same flag, differing only in whether a worker ever had the row -- and it
 * must still delete.
 *
 * RUN_FAT_PREPARING_RECONCILE is false throughout on purpose: the rollout doc
 * mandates it for exactly this mixed-version window, and it protects nothing
 * here. Its only consumer in this pass is the arm that closes a *non-terminal*
 * row, and every row below is terminal by the time the pass sees it.
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
      userId: "user-legacy-holder", userName: "user-legacy-holder", roles: ["default"],
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
  // fallback -- the only path that can produce a fat row at all.
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
    payload: { name: "legacy-holder", message: { content: "hello" } },
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

/**
 * The row shape a pre-`accept` Brain leaves behind, written directly for the
 * same reason `fat-reconcile-lost-fence` writes it: the two lease columns and
 * the untouched counter ARE the shape, and which of `renewRunLease` or
 * `renewLegacyRunLease` produced them changes nothing this pass can see.
 * `run-lease-acquisition.test.ts` is where the route is pinned to produce it --
 * an attempt token quoting `claim_count: 0` renews and never reaches the one
 * writer that increments.
 */
async function legacyBrainHolds(taskId: string): Promise<void> {
  const r = await client.query(
    `UPDATE claw_tasks
        SET lease_owner = 'brain-legacy',
            lease_expires_at = NOW() + INTERVAL '45 seconds',
            heartbeat_at = NOW()
      WHERE task_id = $1 AND COALESCE(claim_count, 0) = 0`,
    [taskId],
  );
  assert.equal(r.rowCount, 1);
}

/** The turn answers, through the same call the completion consumer makes. */
async function legacyBrainCompletes(row: { task_id: string; session_id: string; metadata: any }) {
  assert.deepEqual(
    await chatRun.closeChatRun(row.session_id, row.metadata.message_id, "completed"),
    [row.task_id],
  );
  const closed = await runRow(row.task_id);
  assert.equal(closed.status, "completed");
  assert.equal(
    closed.claim_count, 0,
    "a legacy fat turn completes without ever incrementing the doorbell counter",
  );
  assert.equal(closed.lease_owner, "brain-legacy", "and the close leaves the holder evidence on the row");
  assert.notEqual(closed.dispatch_reconcile_at, null, "with the marker still armed");
  assert.equal(closed.dispatch_reconcile_action, "delete_created_session");
  return closed;
}

async function expireArmedMarker(taskId: string): Promise<number> {
  const r = await client.query(
    `UPDATE claw_tasks SET dispatch_reconcile_at = clock_timestamp() - INTERVAL '1 second'
      WHERE task_id = $1 AND dispatch_reconcile_at IS NOT NULL`,
    [taskId],
  );
  return r.rowCount ?? 0;
}

test("a legacy fat turn answered through the held branch is not reconciled away", { skip }, async () => {
  // A publish whose ack times out after the message was in fact delivered. The
  // error carries no code, so `publishCertainlyFailed` is false and no refusal
  // is noted; by the time the catch compensates, the Brain that got the message
  // is already renewing, so the real `failChatRunDispatch` answers `held` and
  // the request reports `dispatched`.
  ports.publishTask = async (_subject, payload) => {
    const taskId = (JSON.parse(payload) as { task_id: string }).task_id;
    await legacyBrainHolds(taskId);
    throw new Error("publish ack timed out");
  };

  const response = await createWithMessage();

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(opened.length, 1);
  const row = await runRow(opened[0]);
  assert.equal(row.metadata.dispatch, "fat");
  assert.equal(response.json().data.message.run_id, row.task_id, "the held branch reports the row");
  // The premise, stated as an assertion rather than assumed: this branch has no
  // proof to act on and so hands nothing back, and the marker outlives an HTTP
  // 200. Fixing that here is what the sweeper-side fix deliberately does not
  // rely on -- the third case below reaches the same state with no branch left.
  assert.notEqual(row.dispatch_reconcile_at, null);
  assert.equal(row.dispatch_reconcile_action, "delete_created_session");

  const closed = await legacyBrainCompletes(row);
  assert.equal(await expireArmedMarker(closed.task_id), 1);
  assert.equal(
    await sweeper.reconcileAmbiguousDispatches(), 1,
    "the row is settled and its marker retired, so it does not stay eligible for ever",
  );

  const session = await sessionRow(row.session_id);
  assert.equal(
    session.deleted_at, null,
    "the session the user was successfully answered in survives the reconcile pass",
  );
  assert.equal(
    session.cleanup_state, null,
    "and its content is not tombstoned nor its workspace objects scheduled for collection",
  );
  assert.equal(await runRow(row.task_id).then((r) => r.dispatch_reconcile_at), null);
});

test("a legacy fat turn answered after a 503 publish_unknown is not reconciled away", { skip }, async () => {
  // No publisher branch survives this one: the request returns 503 and is gone
  // long before the turn runs, which is precisely the case the marker exists
  // for. Nothing but the reconciler's own decision can save the session here.
  ports.publishTask = async () => { throw new Error("nats: timeout"); };

  const response = await createWithMessage();

  assert.equal(response.statusCode, 503, response.body);
  assert.equal(opened.length, 1);
  const row = await runRow(opened[0]);
  assert.equal(row.status, "preparing", "the compensation established nothing, so no rollback ran");
  assert.equal(row.dispatch_reconcile_action, "delete_created_session");
  assert.notEqual(row.dispatch_reconcile_at, null);

  // The message was on the stream after all -- that is what "unknown" means --
  // and a pre-`accept` Brain takes it, holds it by renewal alone, and answers.
  await legacyBrainHolds(row.task_id);
  const closed = await legacyBrainCompletes(row);

  assert.equal(await expireArmedMarker(closed.task_id), 1);
  assert.equal(await sweeper.reconcileAmbiguousDispatches(), 1);

  const session = await sessionRow(row.session_id);
  assert.equal(
    session.deleted_at, null,
    "a turn that executed and answered is not a dispatch that never happened",
  );
  assert.equal(session.cleanup_state, null);
});

/**
 * The control, and the case that must not be bought by the two above: the same
 * 503, the same armed `delete_created_session`, the same flag -- and no worker
 * ever had the row. The publisher's compensation terminalizes it on a later
 * attempt, and the session the create minted is still owed back.
 */
test("a fat dispatch no worker ever had is still cleaned up", { skip }, async () => {
  ports.publishTask = async () => { throw new Error("nats: timeout"); };

  const response = await createWithMessage();

  assert.equal(response.statusCode, 503, response.body);
  const row = await runRow(opened[0]);
  assert.equal(row.lease_owner, null);
  assert.equal(row.lease_expires_at, null);
  assert.equal(row.claim_count, 0);

  // What the compensation writes once it can establish non-delivery: terminal,
  // `dispatch_failed`, and still holding the marker whose action it never ran.
  const r = await client.query(
    `UPDATE claw_tasks
        SET status = 'failed', failure_reason = 'dispatch_failed', completed_at = NOW()
      WHERE task_id = $1`,
    [row.task_id],
  );
  assert.equal(r.rowCount, 1);

  assert.equal(await expireArmedMarker(row.task_id), 1);
  assert.equal(await sweeper.reconcileAmbiguousDispatches(), 1);

  const session = await sessionRow(row.session_id);
  assert.notEqual(
    session.deleted_at, null,
    "the session a create minted for a turn that never ran is taken back",
  );
  assert.equal(
    session.cleanup_state, "pending",
    "durably, so its content is tombstoned and its workspace objects collected",
  );
});
