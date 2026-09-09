// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import type { RunTimeLedgerEntry, RunTimeReport } from "@claw/protocol";
import { db } from "../src/infra/db.js";
import { registerInternalTaskRoutes } from "../src/routes/internal-tasks.js";
import { claimRunById, releaseClaim, settleFinishedClaim } from "../src/tasks/run-claim.js";
import { startHarness, seedSession, seedRun, runRow, type Harness } from "./scenario-harness.js";

const SESSION = "session-completion";
const TOKEN = "completion-test-token";
const BRAIN = "brain-completion";
const originalToken = process.env.AUTH_INTERNAL_TOKEN;
let h: Harness;
let app: FastifyInstance;

before(async () => {
  process.env.AUTH_INTERNAL_TOKEN = TOKEN;
  h = await startHarness();
  app = Fastify();
  await registerInternalTaskRoutes(app);
  await app.ready();
});

after(async () => {
  await app.close();
  await h.close();
  if (originalToken === undefined) delete process.env.AUTH_INTERNAL_TOKEN;
  else process.env.AUTH_INTERNAL_TOKEN = originalToken;
});

beforeEach(async () => {
  await h.reset();
  await seedSession(h, SESSION);
});

function report(taskId: string, overrides: Partial<RunTimeReport> = {}): RunTimeReport {
  return {
    key: taskId, attemptId: "attempt-1", claimCount: 0, deliverySeq: 7, deliveryCount: 1,
    basis: { kind: "same_domain", domain: "brain" },
    cumulativeStateMs: { executing: 10 }, ...overrides,
  };
}

function post(taskId: string, action: string, payload: Record<string, unknown>) {
  return app.inject({
    method: "POST", url: `/v1/internal/tasks/${taskId}/${action}`,
    headers: { authorization: `Bearer ${TOKEN}` }, payload,
  });
}

function done(taskId: string, runTime: RunTimeReport) {
  return post(taskId, "agent_done", {
    abort_reason: "completed", final_text: "saved result", captures: { answer: "42" },
    turns: 2, run_time: runTime,
  });
}

async function announce(taskId: string, runTime: RunTimeReport): Promise<void> {
  const response = await post(taskId, "event", {
    type: "statusUpdate", agent_status: "running", brain_id: BRAIN,
    attempt_id: runTime.attemptId, claim_count: runTime.claimCount,
    delivery_seq: runTime.deliverySeq, delivery_count: runTime.deliveryCount,
  });
  assert.equal(response.statusCode, 200);
  assert.equal((await runRow(h, taskId)).attempt_id, runTime.attemptId);
}

async function assertCompleted(taskId: string, attemptId: string, generation: number) {
  const row = await runRow(h, taskId);
  assert.equal(row.status, "completed");
  assert.equal(row.output, "saved result");
  assert.deepEqual(row.captures, { answer: "42" });
  assert.equal(row.attempt_id, attemptId);
  assert.equal(Number(row.attempt_generation), generation);
  const ledger = (row.metadata as { run_phase: { ledger: RunTimeLedgerEntry } }).run_phase.ledger;
  const attempt = ledger.attempts.find((entry) => entry.attemptId === attemptId);
  assert.ok(attempt?.endedAtDb, "the adopted attempt is durably closed with its result");
  assert.equal(attempt.attemptGeneration, generation);
  return row;
}

for (const status of ["preparing", "running"] as const) {
  test(`a ${status} run can finish before any attempt write succeeds`, async () => {
    const taskId = `completion-${status}`;
    await seedRun(h, taskId, SESSION, {
      status, origin: "task", dispatch: "fat", leaseExpiresInSec: 45,
    });
    const runTime = report(taskId);
    assert.equal((await runRow(h, taskId)).attempt_id, null);

    assert.equal((await done(taskId, runTime)).statusCode, 200);

    const completed = await assertCompleted(taskId, runTime.attemptId, 1);
    assert.equal(Number(completed.delivery_seq), runTime.deliverySeq);
    assert.equal(Number(completed.delivery_count), runTime.deliveryCount);
    assert.equal((await done(taskId, runTime)).statusCode, 200);
    assert.deepEqual(await runRow(h, taskId), completed, "a duplicate neither allocates nor banks again");
  });
}

test("a reclaimed doorbell finishes without accepting the previous claim's final report", async () => {
  const taskId = "completion-reclaim";
  await seedRun(h, taskId, SESSION, { claimable: true });
  const firstClaim = await claimRunById(taskId, BRAIN);
  assert.ok(typeof firstClaim === "object" && "claimCount" in firstClaim);
  assert.equal(firstClaim.claimCount, 1);
  const first = report(taskId, { claimCount: firstClaim.claimCount, deliverySeq: 0, deliveryCount: 0 });
  await announce(taskId, first);
  assert.equal(await releaseClaim(taskId, BRAIN, firstClaim.claimCount), true);
  const secondClaim = await claimRunById(taskId, BRAIN);
  assert.ok(typeof secondClaim === "object" && "claimCount" in secondClaim);
  assert.equal(secondClaim.claimCount, 2);
  const before = await runRow(h, taskId);

  assert.equal((await done(taskId, first)).statusCode, 200);
  assert.deepEqual(await runRow(h, taskId), before, "an old claim cannot finish its replacement");

  const second = { ...first, attemptId: "attempt-2", claimCount: secondClaim.claimCount };
  assert.equal((await done(taskId, second)).statusCode, 200);
  await assertCompleted(taskId, second.attemptId, 2);
});

test("an expired fat attempt can be replaced by a newer delivery's final report", async () => {
  const taskId = "completion-redelivery";
  await seedRun(h, taskId, SESSION, {
    status: "preparing", dispatch: "fat", leaseOwner: BRAIN, leaseExpiresInSec: 45,
  });
  const first = report(taskId);
  await announce(taskId, first);
  const second = { ...first, attemptId: "attempt-2", deliveryCount: 2 };
  const live = await runRow(h, taskId);
  assert.equal((await done(taskId, second)).statusCode, 200);
  assert.deepEqual(await runRow(h, taskId), live, "a live attempt cannot be replaced by a final report");
  await h.sql("UPDATE claw_tasks SET lease_expires_at = NOW() - INTERVAL '1 second' WHERE task_id = $1", [taskId]);

  assert.equal((await done(taskId, second)).statusCode, 200);

  await assertCompleted(taskId, second.attemptId, 2);
});

test("a completed delivery cannot readopt its settled token through agent_done", async () => {
  const taskId = "completion-settled";
  await seedRun(h, taskId, SESSION, {
    status: "preparing", dispatch: "fat", leaseOwner: BRAIN, leaseExpiresInSec: 45,
  });
  const first = report(taskId);
  await announce(taskId, first);
  assert.equal(await settleFinishedClaim(taskId, BRAIN, 0, undefined, true), true);
  const settled = await runRow(h, taskId);
  assert.equal(settled.attempt_id, null);

  assert.equal((await done(taskId, first)).statusCode, 200);
  assert.deepEqual(await runRow(h, taskId), settled);

  const second = { ...first, attemptId: "attempt-2", deliveryCount: 2 };
  assert.equal((await done(taskId, second)).statusCode, 200);
  await assertCompleted(taskId, second.attemptId, 2);
});

test("another token for the current delivery cannot complete a live attempt", async () => {
  const taskId = "completion-current";
  await seedRun(h, taskId, SESSION, { status: "preparing", dispatch: "fat" });
  const current = report(taskId);
  await announce(taskId, current);
  const before = await runRow(h, taskId);

  assert.equal((await done(taskId, { ...current, attemptId: "attempt-other" })).statusCode, 200);

  assert.deepEqual(await runRow(h, taskId), before);
});

test("an older delivery cannot adopt after a later attempt settled", async () => {
  const taskId = "completion-older-delivery";
  await seedRun(h, taskId, SESSION, {
    status: "preparing", dispatch: "fat", leaseOwner: BRAIN, leaseExpiresInSec: 45,
  });
  const current = report(taskId, { attemptId: "attempt-2", deliveryCount: 2 });
  await announce(taskId, current);
  assert.equal(await settleFinishedClaim(taskId, BRAIN, 0, undefined, true), true);
  const before = await runRow(h, taskId);
  assert.equal(before.attempt_id, null);
  assert.equal(before.settled_attempt_id, current.attemptId);

  assert.equal((await done(taskId, report(taskId))).statusCode, 200);

  assert.deepEqual(await runRow(h, taskId), before);
});

test("a final report cannot change the delivery of an already recorded attempt", async () => {
  const taskId = "completion-changed-token";
  await seedRun(h, taskId, SESSION, {
    status: "preparing", dispatch: "fat", leaseOwner: BRAIN, leaseExpiresInSec: -45,
  });
  const current = report(taskId);
  await announce(taskId, current);
  const before = await runRow(h, taskId);

  assert.equal((await done(taskId, { ...current, deliveryCount: 2 })).statusCode, 200);

  assert.deepEqual(await runRow(h, taskId), before);
});

test("a released claim cannot complete while the row is waiting to be claimed", async () => {
  const taskId = "completion-released";
  await seedRun(h, taskId, SESSION, { claimable: true });
  const claimed = await claimRunById(taskId, BRAIN);
  assert.ok(typeof claimed === "object" && "claimCount" in claimed);
  const runTime = report(taskId, { claimCount: claimed.claimCount, deliverySeq: 0, deliveryCount: 0 });
  await announce(taskId, runTime);
  assert.equal(await releaseClaim(taskId, BRAIN, claimed.claimCount), true);
  const released = await runRow(h, taskId);

  assert.equal((await done(taskId, runTime)).statusCode, 200);

  assert.deepEqual(await runRow(h, taskId), released);
});

test("a failed terminal write rolls back adoption and returns a retryable response", async () => {
  const taskId = "completion-rollback";
  await seedRun(h, taskId, SESSION, { status: "preparing", dispatch: "fat" });
  const before = await runRow(h, taskId);
  const originalConnect = db.pool.connect;
  db.pool.connect = (async () => {
    const client = await originalConnect();
    const query = client.query.bind(client);
    client.query = (async (sql: string, params?: unknown[]) => {
      if (/^\s*UPDATE claw_tasks SET status/.test(sql)) throw new Error("terminal write unavailable");
      return query(sql, params);
    }) as typeof client.query;
    return client;
  }) as typeof db.pool.connect;
  try {
    assert.equal((await done(taskId, report(taskId))).statusCode, 500);
    assert.deepEqual(await runRow(h, taskId), before, "failed delivery retains the original row");
  } finally {
    db.pool.connect = originalConnect;
  }

  assert.equal((await done(taskId, report(taskId))).statusCode, 200);
  await assertCompleted(taskId, "attempt-1", 1);
});
