// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test, { after, afterEach, before, beforeEach } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import type pg from "pg";
import { DOORBELL_SEMANTICS_VERSION, isRunDoorbell, type RunDoorbell } from "@claw/protocol";

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
let checkedDeadlines = 0;
let published: RunDoorbell[];

before(async () => {
  if (skip) return;
  harness = await startAdmissionCluster({ RUN_DOORBELL_DISPATCH: "true" });
  const { initUserEnvCrypto } = await import("../src/crypto/user-env.js");
  initUserEnvCrypto();
  client = await harness.connect();
  await client.query(`
    CREATE FUNCTION precise_dispatch_deadline() RETURNS trigger AS $$
    BEGIN
      IF NEW.dispatch_reconcile_at IS NOT NULL THEN
        NEW.dispatch_reconcile_at = date_trunc('milliseconds', NEW.dispatch_reconcile_at)
          + INTERVAL '321 microseconds';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
    CREATE TRIGGER precise_dispatch_deadline BEFORE INSERT ON claw_tasks
      FOR EACH ROW EXECUTE FUNCTION precise_dispatch_deadline();
  `);
  ({ sessionDispatchPorts: ports } = await import("../src/sessions/dispatch.js"));
  originalPorts = { ...ports };
  gate = await import("../src/tasks/doorbell-gate.js");
  sweeper = await import("../src/tasks/sweeper.js");
  app = Fastify();
  app.addHook("preHandler", async (req) => {
    (req as unknown as { user: UserInfo }).user = {
      userId: "user-reconcile", userName: "user-reconcile", roles: ["default"],
      platformKey: "pk-test", virtualKey: "vk-test",
    };
  });
  await harness.app.sessions.registerSessionRoutes(app);
  await app.ready();
});

beforeEach(async () => {
  if (skip) return;
  await client.query("TRUNCATE claw_tasks, claw_sessions, claw_workspaces CASCADE");
  checkedDeadlines = 0;
  published = [];
  gate.setDoorbellLatch({ state: "floor", version: DOORBELL_SEMANTICS_VERSION });
  assert.equal(gate.doorbellGateOpen(), true);
  ports.publishSse = () => {};
  ports.publishTask = async (_subject, payload) => {
    const doorbell: unknown = JSON.parse(payload);
    assert.ok(isRunDoorbell(doorbell));
    published.push(doorbell);
    return 1;
  };
  ports.openChatRun = async (input) => {
    const run = await originalPorts.openChatRun(input);
    assert.ok(run);
    assert.ok(input.client);
    await assertSubmillisecondDeadline(input.client, run.taskId);
    checkedDeadlines += 1;
    return run;
  };
});

afterEach(() => {
  if (skip) return;
  Object.assign(ports, originalPorts);
  gate.resetDoorbellGate();
});

after(async () => {
  if (skip) return;
  await app?.close();
  await harness?.stop();
});

async function assertSubmillisecondDeadline(connection: pg.PoolClient, taskId: string): Promise<void> {
  const { rows: [row] } = await connection.query(
    `SELECT dispatch_reconcile_at,
            EXTRACT(MICROSECONDS FROM dispatch_reconcile_at)::int % 1000 AS remainder
       FROM claw_tasks WHERE task_id = $1`,
    [taskId],
  );
  assert.equal(row.remainder, 321);
  assert.ok(row.dispatch_reconcile_at instanceof Date);
  const { rows: [roundTrip] } = await connection.query(
    "SELECT dispatch_reconcile_at = $2::timestamptz AS matches FROM claw_tasks WHERE task_id = $1",
    [taskId, row.dispatch_reconcile_at],
  );
  assert.equal(roundTrip.matches, false);
}

function createWithMessage() {
  return app.inject({
    method: "POST", url: "/v1/sessions",
    payload: { name: "reconcile", message: { content: "hello" } },
  });
}

async function runRow(taskId: string) {
  const { rows: [row] } = await client.query("SELECT * FROM claw_tasks WHERE task_id = $1", [taskId]);
  assert.ok(row);
  return row;
}

for (const admission of ["admit", "queue"] as const) {
  test(`a doorbell create returns a run_id with a submillisecond deadline on ${admission}`, { skip }, async () => {
    if (admission === "queue") ports.admit = async () => ({ kind: "queue", position: 1 });

    const response = await createWithMessage();

    assert.equal(checkedDeadlines, 1);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().ok, true);
    const runId = response.json().data.message.run_id;
    assert.equal(typeof runId, "string");
    assert.ok(runId.length > 0);
    const row = await runRow(runId);
    assert.equal(row.metadata.dispatch, "doorbell");
    assert.equal(row.dispatch_reconcile_at, null);
    assert.equal(row.dispatch_reconcile_action, null);
    assert.equal(row.metadata.dispatch_reconcile_token, undefined);
    assert.equal(published.length, admission === "admit" ? 1 : 0);
    if (admission === "admit") assert.equal(published[0].task_id, runId);
  });
}

async function expireDispatch(taskId: string): Promise<void> {
  await client.query(
    "UPDATE claw_tasks SET dispatch_reconcile_at = clock_timestamp() - INTERVAL '1 second' WHERE task_id = $1",
    [taskId],
  );
}

test("a doorbell create stays ambiguous while reconciliation owns the pending cleanup", { skip }, async (t) => {
  const db = harness.app.db.db;
  const query = db.query.bind(db);
  const taken = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  let reconciliation: Promise<number> | undefined;
  t.mock.method(db, "query", (async (sql: string, params?: unknown[]) => {
    const result = await query(sql, params);
    if (sql.includes("WITH due AS") && sql.includes("dispatch_reconcile_at")) {
      taken.resolve();
      await resume.promise;
    }
    return result;
  }) as typeof db.query);
  const publish = ports.publishTask;
  ports.publishTask = async (...args) => {
    await publish(...args);
    await expireDispatch(published[0].task_id);
    reconciliation = sweeper.reconcileAmbiguousDispatches();
    await Promise.race([
      taken.promise,
      reconciliation.then(() => { throw new Error("reconciliation did not pause after taking the row"); }),
    ]);
    return 1;
  };
  try {
    const response = await createWithMessage();

    assert.equal(checkedDeadlines, 1);
    assert.equal(response.statusCode, 503, response.body);
    assert.equal(response.json().detail, "task dispatch outcome unknown");
    const row = await runRow(published[0].task_id);
    assert.equal(row.status, "queued");
    assert.notEqual(row.dispatch_reconcile_at, null);
    assert.equal(row.dispatch_reconcile_action, "delete_created_session");
  } finally {
    resume.resolve();
    if (reconciliation) await reconciliation;
  }
  const row = await runRow(published[0].task_id);
  assert.equal(row.status, "failed");
  assert.equal(row.dispatch_reconcile_at, null);
});

test("a doorbell create stays ambiguous after reconciliation clears the marker", { skip }, async () => {
  const publish = ports.publishTask;
  ports.publishTask = async (...args) => {
    await publish(...args);
    await expireDispatch(published[0].task_id);
    assert.equal(await sweeper.reconcileAmbiguousDispatches(), 1);
    return 1;
  };

  const response = await createWithMessage();

  assert.equal(checkedDeadlines, 1);
  assert.equal(response.statusCode, 503, response.body);
  assert.equal(response.json().detail, "task dispatch outcome unknown");
  const row = await runRow(published[0].task_id);
  assert.equal(row.status, "failed");
  assert.equal(row.dispatch_reconcile_at, null);
});

test("a doorbell turn into a session that already existed owes an idle, not a delete", { skip }, async () => {
  // The create path is the only one that may delete: it minted the session, so
  // nothing is lost by removing it. A turn sent into a session the user has
  // been talking to owes the opposite cleanup, and the difference is a stored
  // string rather than a reconstructed closure -- so the row's own value is
  // what decides whether reconciliation hands that session back or deletes it.
  const created = await app.inject({
    method: "POST", url: "/v1/sessions", payload: { name: "reconcile" },
  });
  assert.equal(created.statusCode, 200, created.body);
  const sessionId = created.json().data.session_id;

  const publish = ports.publishTask;
  let owedAction: unknown;
  ports.publishTask = async (...args) => {
    await publish(...args);
    owedAction = (await runRow(published[0].task_id)).dispatch_reconcile_action;
    await expireDispatch(published[0].task_id);
    assert.equal(await sweeper.reconcileAmbiguousDispatches(), 1);
    return 1;
  };

  const response = await app.inject({
    method: "POST", url: `/v1/sessions/${sessionId}/messages`, payload: { content: "carry on" },
  });

  assert.equal(response.statusCode, 503, response.body);
  const { rows: [session] } = await client.query(
    "SELECT agent_status, deleted_at FROM claw_sessions WHERE session_id = $1", [sessionId],
  );
  assert.equal(
    session.deleted_at, null,
    "the session the user was talking to may not be removed by the repair of one failed turn",
  );
  assert.equal(session.agent_status, "idle", "and is handed back rather than left running");
  assert.equal(
    owedAction, "idle_existing_session",
    "which is only true while the row records the cleanup this path actually owes",
  );
});

/**
 * The fallback the gate takes whenever `beginDoorbellDispatch` declines --
 * a revoked floor, or a KV watch that merely died -- publishes the whole task
 * on the wire instead of ringing a doorbell. Everything else about the turn is
 * the same, the owed cleanup included, and the marker is what records it:
 * `insertTask` writes `dispatch_reconcile_at` only where
 * `dispatch_reconcile_action` is non-null, and `reconcileAmbiguousDispatches`
 * selects on nothing else. A fat row that never armed one is therefore a row no
 * sweep can reach, and `publish_unknown` -- the answer that exists precisely to
 * say "do not roll back, someone else will" -- would name nobody.
 */
test("a fat fallback arms the marker at open and hands it back at dispatch", { skip }, async () => {
  gate.setDoorbellLatch({ state: "revoked" });
  assert.equal(gate.doorbellGateOpen(), false);
  let armed: { action: unknown; at: unknown; taskId: string } | undefined;
  ports.publishTask = async (_subject, payload) => {
    const taskId = (JSON.parse(payload) as { task_id: string }).task_id;
    const row = await runRow(taskId);
    armed = { action: row.dispatch_reconcile_action, at: row.dispatch_reconcile_at, taskId };
    return 1;
  };

  const response = await createWithMessage();

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(checkedDeadlines, 1, "and the deadline is written with the same precision");
  assert.ok(armed, "the fat branch publishes the task itself");
  assert.equal(armed.action, "delete_created_session", "the create path owes a delete here too");
  assert.notEqual(armed.at, null, "which is only reachable through dispatch_reconcile_at");
  // Released on the way out, for the reason the doorbell path releases: nothing
  // on this path increments `claim_count`, so a marker left on a healthy fat row
  // reads to `resolveAmbiguousDispatch` as a turn that never executed, and the
  // stored action would delete the session the user is talking in.
  const settled = await runRow(armed.taskId);
  assert.equal(settled.metadata.dispatch, "fat");
  assert.equal(settled.dispatch_reconcile_at, null);
  assert.equal(settled.dispatch_reconcile_action, null);
  assert.equal(await sweeper.reconcileAmbiguousDispatches(), 0, "nothing is left owing");
});

test("a fat publish_unknown leaves a session reconciliation can still clean up", { skip }, async () => {
  gate.setDoorbellLatch({ state: "revoked" });
  let taskId = "";
  ports.openChatRun = async (input) => {
    const run = await originalPorts.openChatRun(input);
    assert.ok(run);
    taskId = run.taskId;
    return run;
  };
  ports.publishTask = async () => { throw new Error("stream unavailable"); };
  // The compensation could not establish anything, which is the only way this
  // path answers `publish_unknown`: no rollback has run, so the session, its
  // UserMessage and its running gate are all still there, owed to whoever picks
  // the row up.
  ports.failChatRunDispatch = async () => "unknown";

  const response = await createWithMessage();

  assert.equal(response.statusCode, 503, response.body);
  // The fat branch reports the publish error itself rather than the doorbell
  // branch's manufactured one; the kind is what the caller acts on.
  assert.equal(response.json().detail, "stream unavailable");
  const { rows: [before] } = await client.query(
    "SELECT deleted_at FROM claw_sessions WHERE session_id = (SELECT session_id FROM claw_tasks WHERE task_id = $1)",
    [taskId],
  );
  assert.equal(before.deleted_at, null, "nothing was rolled back, as the kind promises");

  await expireDispatch(taskId);
  assert.equal(
    await sweeper.reconcileAmbiguousDispatches(), 1,
    "a fat row with no marker is invisible here, and this turn would be owed to nobody",
  );

  const row = await runRow(taskId);
  assert.equal(row.status, "failed");
  assert.equal(row.dispatch_reconcile_at, null);
  const { rows: [session] } = await client.query(
    "SELECT deleted_at FROM claw_sessions WHERE session_id = $1", [row.session_id],
  );
  assert.notEqual(session.deleted_at, null, "and the session the create minted is taken back");
});
