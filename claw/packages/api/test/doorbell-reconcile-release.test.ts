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
