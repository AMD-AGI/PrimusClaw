// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";

import { LEASE_LOST_GRACE_SEC } from "../src/config.js";
import { registerInternalRunRoutes } from "../src/routes/internal-runs.js";
import { registerInternalTaskRoutes } from "../src/routes/internal-tasks.js";
import { parkSettledHandsPorts } from "../src/tasks/park-settled-hands.js";
import { reapLostLeases, sweeperPorts } from "../src/tasks/sweeper.js";
import { runRow, seedRun, seedSession, sessionRow, startHarness, type Harness } from "./scenario-harness.js";

const TASK = "ktsk-fat-retry";
const SESSION = "s-fat-retry";
const TOKEN = "test-internal-token";
const FIRST = {
  attempt_id: "att-first", claim_count: 0, delivery_seq: 7, delivery_count: 1,
  brain_id: "brain-first",
};
const NEXT = { ...FIRST, attempt_id: "att-next", delivery_count: 2, brain_id: "brain-next" };

let h: Harness;
let app: FastifyInstance;
const events: Record<string, unknown>[] = [];
const originalToken = process.env.AUTH_INTERNAL_TOKEN;
const originalPublish = sweeperPorts.publishSessionEvent;
const originalPark = parkSettledHandsPorts.parkHandsAfterRun;

before(async () => {
  process.env.AUTH_INTERNAL_TOKEN = TOKEN;
  h = await startHarness();
  app = Fastify();
  await registerInternalTaskRoutes(app);
  await registerInternalRunRoutes(app);
  await app.ready();
  sweeperPorts.publishSessionEvent = async (_sessionId, event) => { events.push(event); };
  parkSettledHandsPorts.parkHandsAfterRun = async () => ({ outcome: "gone" });
});

beforeEach(async () => {
  events.length = 0;
  await h.reset();
  await seedSession(h, SESSION);
});

after(async () => {
  if (originalToken === undefined) delete process.env.AUTH_INTERNAL_TOKEN;
  else process.env.AUTH_INTERNAL_TOKEN = originalToken;
  sweeperPorts.publishSessionEvent = originalPublish;
  parkSettledHandsPorts.parkHandsAfterRun = originalPark;
  await app.close();
  await h.close();
});

function post(action: "event" | "lease" | "settle-attempt", payload: Record<string, unknown>) {
  return app.inject({
    method: "POST", url: `/v1/internal/tasks/${TASK}/${action}`,
    headers: { authorization: `Bearer ${TOKEN}` },
    payload,
  });
}

async function startAttempt(): Promise<void> {
  await seedRun(h, TASK, SESSION, { status: "preparing", dispatch: "fat" });
  assert.equal((await post("event", {
    type: "statusUpdate", agent_status: "running", ...FIRST,
  })).statusCode, 200);
  assert.equal((await post("lease", FIRST)).statusCode, 200);
}

async function settleRetry(): Promise<void> {
  assert.equal((await post("settle-attempt", {
    brain_id: FIRST.brain_id, claim_count: FIRST.claim_count, release_lease: true,
  })).statusCode, 200);
}

test("a fat retry without redelivery remains reapable after the lease grace", async () => {
  await startAttempt();
  const [before] = await h.sql("SELECT clock_timestamp() AS at");

  await settleRetry();

  const [after] = await h.sql("SELECT clock_timestamp() AS at");
  const released = await runRow(h, TASK);
  assert.equal(released.status, "running");
  assert.equal(released.lease_owner, null);
  assert.equal(released.attempt_id, null);
  assert.equal(released.settled_attempt_id, FIRST.attempt_id);
  assert.ok(released.lease_expires_at instanceof Date, "the settlement keeps a reaper timestamp");
  assert.ok(released.lease_expires_at >= (before.at as Date));
  assert.ok(released.lease_expires_at <= (after.at as Date), "the released lease expires immediately");
  assert.equal(await reapLostLeases(), 0, "a replacement still has the full lease grace to arrive");

  await h.sql(
    `UPDATE claw_tasks
        SET lease_expires_at = lease_expires_at - ($2::int * INTERVAL '1 second')
      WHERE task_id = $1`,
    [TASK, LEASE_LOST_GRACE_SEC + 1],
  );

  assert.equal(await reapLostLeases(), 1);
  const reaped = await runRow(h, TASK);
  assert.equal(reaped.status, "failed");
  assert.equal(reaped.failure_reason, "worker_lost");
  assert.ok(reaped.completed_at instanceof Date);
  assert.equal((await sessionRow(h, SESSION)).agent_status, "idle");
  assert.equal(events.find((event) => event.type === "exec_complete")?.failure_reason, "worker_lost");
});

test("a new fat attempt renews immediately after its predecessor releases the lease", async () => {
  await startAttempt();
  await settleRetry();

  assert.equal((await post("lease", NEXT)).statusCode, 200);

  const live = await runRow(h, TASK);
  assert.equal(live.attempt_id, NEXT.attempt_id);
  assert.equal(Number(live.attempt_generation), 2);
  assert.equal(live.lease_owner, NEXT.brain_id);
  assert.equal(Number(live.delivery_count), NEXT.delivery_count);
  assert.equal(await reapLostLeases(), 0);
});

test("a fat attempt cannot renew the expired lease its settlement left behind", async () => {
  await startAttempt();
  await settleRetry();
  const released = await runRow(h, TASK);

  assert.equal((await post("lease", FIRST)).statusCode, 409);

  assert.deepEqual(await runRow(h, TASK), released);
});
