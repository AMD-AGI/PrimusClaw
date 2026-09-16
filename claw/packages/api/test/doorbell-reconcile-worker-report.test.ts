// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The doorbell worker that reports before its publisher has released the token.
 *
 * `publishDoorbell` returns once the message is durable, and the doorbell
 * carries no spec -- the worker claims the row over HTTP and gets the spec with
 * the claim -- so a worker is already executing while the publisher still owes
 * one DB round trip. Since `RETIRE_DISPATCH_RECONCILE_SQL` landed in the close,
 * that worker's own completion retires the marker, and a token-only release
 * then reads this turn's success as a takeover: HTTP 503 `task dispatch outcome
 * unknown` for a turn that was published, executed and answered, with nothing
 * left armed for any reconciler to settle and the 503 saved under the create's
 * idempotency key. `resolvePoisonedTask` reaches the same close without running
 * a turn at all, so the race does not even need a fast one.
 *
 * The interleaving is exact rather than probable: the worker is driven inside
 * `ports.publishTask`, which is the publish itself, so everything it does
 * happens strictly between the doorbell landing and `releaseReconcileClaim`.
 * Real claim, real completion consumer, real route.
 */

import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
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
let published: RunDoorbell[];
let consumerErrors: unknown[];

before(async () => {
  if (skip) return;
  harness = await startAdmissionCluster({ RUN_DOORBELL_DISPATCH: "true" });
  const { initUserEnvCrypto } = await import("../src/crypto/user-env.js");
  initUserEnvCrypto();
  client = await harness.connect();
  ({ sessionDispatchPorts: ports } = await import("../src/sessions/dispatch.js"));
  originalPorts = { ...ports };
  gate = await import("../src/tasks/doorbell-gate.js");
  const { tombstoneReader } = await import("../src/events/consumer.js");
  Object.assign(tombstoneReader, { has: async () => false });
  app = Fastify();
  app.addHook("preHandler", async (req) => {
    (req as unknown as { user: UserInfo }).user = {
      userId: "user-race", userName: "user-race", roles: ["default"],
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
  published = [];
  consumerErrors = [];
  gate.setDoorbellLatch({ state: "floor", version: DOORBELL_SEMANTICS_VERSION });
  assert.equal(gate.doorbellGateOpen(), true);
  ports.publishSse = () => {};
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

/** The worker's own report, through the real completion consumer. */
async function deliverCompletion(doorbell: RunDoorbell, finalText: string): Promise<void> {
  const { consumeEventDelivery } = await import("../src/events/consumer.js");
  const { sc } = await import("../src/infra/nats.js");
  const { resetDeletedSessionCache } = await import("../src/sessions/deleted-cache.js");
  resetDeletedSessionCache();
  await consumeEventDelivery({
    subject: `events.${doorbell.session_id}`,
    data: sc.encode(JSON.stringify({
      type: "exec_complete",
      session_id: doorbell.session_id,
      message_id: doorbell.message_id,
      task_id: doorbell.task_id,
      user_id: "user-race",
      prompt: "hello",
      final_text: finalText,
      failed: false,
      error_count: 0,
      skills_used: {},
    })),
    seq: 1,
    ack: () => {}, nak: () => {},
  }).catch((err) => { consumerErrors.push(err); });
}

test("a doorbell turn its worker reported on answers 200, not 503", { skip }, async () => {
  const { claimRunById } = await import("../src/tasks/run-claim.js");
  ports.publishTask = async (_subject, payload) => {
    const doorbell: unknown = JSON.parse(payload);
    assert.ok(isRunDoorbell(doorbell));
    published.push(doorbell);
    // A worker quicker than the publisher's next round trip. `claimRunById` is
    // the only way a doorbell worker can get the spec at all, and it is what
    // makes `claim_count` the fence this path still defers to.
    const claimed = await claimRunById(doorbell.task_id, "brain-fast");
    assert.ok(claimed, "the worker claimed the row");
    await deliverCompletion(doorbell, "the answer");
    return 1;
  };

  const response = await app.inject({
    method: "POST", url: "/v1/sessions",
    payload: { name: "race", message: { content: "hello" } },
  });

  assert.deepEqual(consumerErrors, []);
  assert.equal(published.length, 1);
  assert.equal(response.statusCode, 200, response.body);
  const body = JSON.parse(response.body);
  assert.equal(body.data?.message?.dispatched, true, response.body);
  assert.ok(body.data?.message?.run_id, `the caller is given the run it dispatched: ${response.body}`);

  const row = await runRow(published[0].task_id);
  assert.equal(row.status, "completed", "the turn really did run");
  assert.equal(Number(row.claim_count), 1);
  const { rows: [session] } = await client.query(
    "SELECT agent_status, deleted_at FROM claw_sessions WHERE session_id = $1",
    [published[0].session_id],
  );
  assert.equal(session.deleted_at, null);
  assert.equal(session.agent_status, "idle", "and handed the conversation back");
  const { rows: turns } = await client.query(
    "SELECT role, content FROM claw_conversation_turns WHERE session_id = $1 ORDER BY turn_index",
    [published[0].session_id],
  );
  assert.ok(turns.some((t) => t.role === "assistant" && t.content === "the answer"),
    "the answer the 503 would have disowned is in the conversation");
});

test("a reconciler that genuinely took the row still makes the publisher stand down",
  { skip }, async () => {
  // The fence this path keeps, and must keep: a marker the reconciler holds is
  // not released by anyone else, so the publisher answers `publish_unknown` and
  // leaves the row to the pass that owns it. Only a worker's own report reads
  // as released -- not the bare NULL a completed reconciliation also leaves,
  // which is how a 200 `dispatched` would come to name a row already failed.
  const sweeper = await import("../src/tasks/sweeper.js");
  ports.publishTask = async (_subject, payload) => {
    const doorbell: unknown = JSON.parse(payload);
    assert.ok(isRunDoorbell(doorbell));
    published.push(doorbell);
    await client.query(
      `UPDATE claw_tasks SET dispatch_reconcile_at = clock_timestamp() - INTERVAL '1 second'
        WHERE task_id = $1`,
      [doorbell.task_id],
    );
    await sweeper.reconcileAmbiguousDispatches();
    return 1;
  };

  const response = await app.inject({
    method: "POST", url: "/v1/sessions",
    payload: { name: "taken", message: { content: "hello" } },
  });
  assert.equal(response.statusCode, 503, response.body);
  assert.match(response.body, /unknown/);
});
