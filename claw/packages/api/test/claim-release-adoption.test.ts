// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import type { RunTimeLedgerEntry, RunTimeReport } from "@claw/protocol";

import { db } from "../src/infra/db.js";
import { registerInternalRunRoutes } from "../src/routes/internal-runs.js";
import { registerInternalTaskRoutes } from "../src/routes/internal-tasks.js";
import { transitionStatus } from "../src/tasks/db.js";
import { runRow, seedRun, seedSession, startHarness, type Harness } from "./scenario-harness.js";

const TASK = "ktsk-release-adoption";
const SESSION = "session-release-adoption";
const BRAIN = "brain-release-adoption";
const TOKEN = "release-adoption-test-token";
const originalToken = process.env.AUTH_INTERNAL_TOKEN;
let h: Harness;
let app: FastifyInstance;

before(async () => {
  process.env.AUTH_INTERNAL_TOKEN = TOKEN;
  h = await startHarness();
  app = Fastify();
  await registerInternalTaskRoutes(app);
  await registerInternalRunRoutes(app);
  await app.ready();
});

beforeEach(async () => {
  await h.reset();
  await seedSession(h, SESSION);
  await seedRun(h, TASK, SESSION, { status: "queued", claimable: true, queuedAgoSec: 1 });
});

after(async () => {
  await app.close();
  await h.close();
  if (originalToken === undefined) delete process.env.AUTH_INTERNAL_TOKEN;
  else process.env.AUTH_INTERNAL_TOKEN = originalToken;
});

function post(action: string, payload: Record<string, unknown>) {
  return app.inject({
    method: "POST", url: `/v1/internal/tasks/${TASK}/${action}`,
    headers: { authorization: `Bearer ${TOKEN}` }, payload,
  });
}

function report(overrides: Partial<RunTimeReport> = {}): RunTimeReport {
  return {
    key: TASK, attemptId: "attempt-first", claimCount: 1, deliverySeq: 0, deliveryCount: 0,
    basis: { kind: "same_domain", domain: "brain" },
    cumulativeStateMs: { executing: 10 }, ...overrides,
  };
}

async function claim(expectedCount = 1): Promise<void> {
  const response = await post("claim", { brain_id: BRAIN });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().claim_count, expectedCount);
  assert.equal(response.json().request.callback_url, undefined);
  assert.ok(response.json().request.run_lease?.url);
  const row = await runRow(h, TASK);
  assert.equal(row.status, "preparing");
  assert.equal(row.attempt_id, null, "a claim has not yet allocated an executing attempt");
}

function release(runTime: RunTimeReport, overrides: Record<string, unknown> = {}) {
  return post("unclaim", {
    brain_id: BRAIN, claim_count: runTime.claimCount, reason: "retry",
    run_time: runTime, ...overrides,
  });
}

async function renew(runTime: RunTimeReport): Promise<void> {
  const response = await post("lease", {
    brain_id: BRAIN, attempt_id: runTime.attemptId, claim_count: runTime.claimCount,
    delivery_seq: runTime.deliverySeq, delivery_count: runTime.deliveryCount,
  });
  assert.equal(response.statusCode, 200);
}

async function assertSettled(status: "queued" | "failed" = "queued"): Promise<RunTimeLedgerEntry> {
  const row = await runRow(h, TASK);
  assert.equal(row.status, status);
  assert.equal(row.lease_owner, null);
  assert.equal(row.lease_expires_at, null);
  assert.equal(row.attempt_id, null);
  assert.equal(Number(row.attempt_generation), 1);
  assert.equal(Number(row.claim_count), 1);
  const ledger = (row.metadata as { run_phase: { ledger: RunTimeLedgerEntry } }).run_phase.ledger;
  assert.equal(ledger.attempts.length, 1);
  assert.equal(ledger.attempts[0].attemptId, "attempt-first");
  assert.equal(ledger.attempts[0].attemptGeneration, 1);
  assert.ok(ledger.attempts[0].endedAtDb, "the release closes the attempt it adopted");
  return ledger;
}

for (const reason of ["retry", "drain"] as const) {
  test(`${reason} releases a claimed attempt before its first successful heartbeat`, async () => {
    await claim();
    await new Promise((resolve) => setTimeout(resolve, 25));
    const runTime = report();

    assert.equal((await release(runTime, { reason })).statusCode, 200);

    const ledger = await assertSettled();
    assert.equal(ledger.knownMsByState.executing, 10, "the final coverage survives the release");
    const released = await runRow(h, TASK);
    assert.equal((released.metadata as Record<string, unknown>).last_release, reason);
    assert.equal((await release(runTime, { reason })).statusCode, 409);
    assert.deepEqual(await runRow(h, TASK), released, "a duplicate cannot allocate or bank twice");

    await claim(2);
    const replacement = await runRow(h, TASK);
    assert.equal(Number(replacement.attempt_generation), 1);
    assert.equal((await release(runTime, { claim_count: undefined })).statusCode, 409);
    assert.deepEqual(await runRow(h, TASK), replacement,
      "the report fences the old claim even when its outer claim count is omitted");
  });
}

const refusedReleases = [
  { name: "a different holder", reportCount: 1, overrides: { brain_id: "brain-other" } },
  { name: "a different outer claim", reportCount: 1, overrides: { claim_count: 2 } },
  { name: "a different report claim", reportCount: 2, overrides: { claim_count: 1 } },
  { name: "an omitted outer count with a stale report", reportCount: 0, overrides: { claim_count: undefined } },
];

for (const { name, reportCount, overrides } of refusedReleases) {
  test(`${name} cannot release or adopt an unrecorded attempt`, async () => {
    await claim();
    const before = await runRow(h, TASK);

    assert.equal((await release(report({ claimCount: reportCount }), overrides)).statusCode, 409);

    assert.deepEqual(await runRow(h, TASK), before, "identity, generation and ledger must all roll back");
  });
}

test("the report still fences a release with no outer claim count", async () => {
  await claim();

  assert.equal((await release(report(), { claim_count: undefined })).statusCode, 200);

  await assertSettled();
});

test("fail-claim can close a held attempt before its first successful heartbeat", async () => {
  await claim();

  const response = await post("fail-claim", {
    brain_id: BRAIN, claim_count: 1, reason: "claim_abandoned", run_time: report(),
  });

  assert.equal(response.statusCode, 200);
  await assertSettled("failed");
  assert.equal((await runRow(h, TASK)).failure_reason, "claim_abandoned");
});

test("a cancelling claim rolls back adoption when release cannot change its status", async () => {
  await claim();
  assert.ok(await transitionStatus(TASK, ["preparing"], "cancelling"));
  const before = await runRow(h, TASK);

  assert.equal((await release(report())).statusCode, 409);

  assert.deepEqual(await runRow(h, TASK), before);
});

test("another attempt cannot release the current claim's recorded attempt", async () => {
  await claim();
  const current = report();
  await renew(current);
  const before = await runRow(h, TASK);

  assert.equal((await release({ ...current, attemptId: "attempt-other" })).statusCode, 409);

  assert.deepEqual(await runRow(h, TASK), before);
});

test("a settled attempt cannot be adopted by a late release", async () => {
  await claim();
  const current = report();
  await renew(current);
  assert.equal((await post("settle-attempt", { brain_id: BRAIN, claim_count: 1 })).statusCode, 200);
  const settled = await runRow(h, TASK);
  assert.equal(settled.attempt_id, null);
  assert.equal(settled.settled_attempt_id, current.attemptId);

  assert.equal((await release(current)).statusCode, 409);

  assert.deepEqual(await runRow(h, TASK), settled);
});

test("a failed release write rolls back the adopted identity and ledger", async () => {
  await claim();
  const before = await runRow(h, TASK);
  const originalConnect = db.pool.connect;
  let adopted = false;
  let banked = false;
  db.pool.connect = (async () => {
    const client = await originalConnect();
    const query = client.query.bind(client);
    client.query = (async (sql: string, params?: unknown[]) => {
      if (/^\s*UPDATE claw_tasks SET status/.test(sql)) throw new Error("release write unavailable");
      const result = await query(sql, params);
      if (/SET attempt_id = \$2/.test(sql)) adopted = true;
      if (/SET metadata = jsonb_set/.test(sql)) banked = true;
      return result;
    }) as typeof client.query;
    return client;
  }) as typeof db.pool.connect;
  try {
    assert.equal((await release(report())).statusCode, 500);
    assert.ok(adopted && banked, "the failure follows the real adoption and ledger writes");
    assert.deepEqual(await runRow(h, TASK), before);
  } finally {
    db.pool.connect = originalConnect;
  }

  assert.equal((await release(report())).statusCode, 200);
  await assertSettled();
});
