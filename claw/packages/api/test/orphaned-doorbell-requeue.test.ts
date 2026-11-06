// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A brain container restarted in place gets its predecessor's runs requeued
 * at once, instead of after the lease and the reaper's grace (eleven minutes
 * on 2026-11-06). Against the scenario harness's real SQL.
 *
 *   O1 every live doorbell run leased to the id is requeued, with a fresh clock
 *   O2 rows leased to another brain, finished rows, and rows past their deadline
 *      are left alone
 *   O3 the route refuses a call without a brain id
 */
import "./reconcile-off-env.js";

import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";

import { startHarness, seedSession, seedRun, runRow, type Harness } from "./scenario-harness.js";

let h: Harness;
before(async () => { h = await startHarness(); });
beforeEach(async () => { await h.reset(); });
after(async () => { await h?.close(); });

test("O1 every live doorbell run leased to the id is requeued, with a fresh clock", async () => {
  const { requeueOrphanedDoorbellLeases } = await import("../src/tasks/sweeper.js");
  await seedSession(h, "s1");
  await seedSession(h, "s2");
  // Leases still live: the process died seconds ago, nothing has expired yet,
  // which is exactly why the expiry-driven reaper would not touch these.
  await seedRun(h, "running", "s1", {
    status: "running", dispatch: "doorbell", leaseOwner: "brain-abc",
    leaseExpiresInSec: 40, startedAgoSec: 600, deadlineInSec: 3600, claimCount: 1,
  });
  await seedRun(h, "preparing", "s2", {
    status: "preparing", dispatch: "doorbell", leaseOwner: "brain-abc",
    leaseExpiresInSec: 40, deadlineInSec: 3600, claimCount: 1,
  });

  assert.equal(await requeueOrphanedDoorbellLeases("brain-abc"), 2);
  for (const id of ["running", "preparing"]) {
    const row = await runRow(h, id);
    assert.equal(row.status, "queued", id);
    assert.equal(row.lease_owner, null, id);
    assert.equal(row.lease_expires_at, null, id);
    assert.equal(row.started_at, null, `${id}: the attempt clock restarts`);
    assert.notEqual(row.deadline_at, null, `${id}: the turn keeps its deadline`);
  }
});

test("O2 rows leased to another brain, finished rows, and rows past their deadline are left alone", async () => {
  const { requeueOrphanedDoorbellLeases } = await import("../src/tasks/sweeper.js");
  await seedSession(h, "s1");
  await seedSession(h, "s2");
  await seedSession(h, "s3");
  await seedSession(h, "s4");
  await seedRun(h, "elsewhere", "s1", {
    status: "running", dispatch: "doorbell", leaseOwner: "brain-xyz", leaseExpiresInSec: 40, deadlineInSec: 3600,
  });
  await seedRun(h, "done", "s2", {
    status: "completed", dispatch: "doorbell", leaseOwner: "brain-abc", deadlineInSec: 3600,
  });
  await seedRun(h, "spent", "s3", {
    status: "running", dispatch: "doorbell", leaseOwner: "brain-abc", leaseExpiresInSec: 40, deadlineInSec: -10,
  });
  await seedRun(h, "fat", "s4", {
    status: "running", dispatch: "fat", leaseOwner: "brain-abc", leaseExpiresInSec: 40, deadlineInSec: 3600,
  });

  assert.equal(await requeueOrphanedDoorbellLeases("brain-abc"), 0);
  assert.equal((await runRow(h, "elsewhere")).status, "running");
  assert.equal((await runRow(h, "done")).status, "completed");
  assert.equal((await runRow(h, "spent")).status, "running", "the deadline reaper owns a spent run");
  assert.equal((await runRow(h, "fat")).status, "running", "a fat run comes back through its own redelivery");
});

test("O3 the route requeues for the calling brain and refuses a call without one", async () => {
  const { registerInternalRunRoutes } = await import("../src/routes/internal-runs.js");
  const previous = process.env.AUTH_INTERNAL_TOKEN;
  process.env.AUTH_INTERNAL_TOKEN = "orphan-test-token";
  await seedSession(h, "s1");
  await seedRun(h, "running", "s1", {
    status: "running", dispatch: "doorbell", leaseOwner: "brain-abc", leaseExpiresInSec: 40, deadlineInSec: 3600,
  });
  const app = Fastify();
  await registerInternalRunRoutes(app);
  try {
    const auth = { authorization: "Bearer orphan-test-token" };
    const missing = await app.inject({ method: "POST", url: "/v1/internal/runs/release-orphans", headers: auth, payload: {} });
    assert.equal(missing.statusCode, 400);
    const ok = await app.inject({
      method: "POST", url: "/v1/internal/runs/release-orphans", headers: auth, payload: { brain_id: "brain-abc" },
    });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.deepEqual(ok.json(), { ok: true, requeued: 1 });
    assert.equal((await runRow(h, "running")).status, "queued");
  } finally {
    await app.close();
    if (previous === undefined) delete process.env.AUTH_INTERNAL_TOKEN;
    else process.env.AUTH_INTERNAL_TOKEN = previous;
  }
});
