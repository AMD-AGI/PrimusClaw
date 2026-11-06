// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A doorbell run whose brain was lost with its node goes back to the queue a
 * minute after its last renewal, not after the lock TTL and the reaper's grace
 * (eleven minutes on 2026-11-06) -- but never on the word of an API that could
 * not have heard the renewals.
 *
 *   K1 the fast pass requeues a lease past the short grace and leaves a fresher
 *      one; the slow reaper would have left both
 *   K2 the defaults put the requeue no earlier than brain's dead-holder window
 *   K3 a pass acts only after a whole lease of clean observation, and starts
 *      over after one that failed or was slow
 */
import "./reconcile-off-env.js";

import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { startHarness, seedSession, seedRun, runRow, type Harness } from "./scenario-harness.js";

let h: Harness;
before(async () => { h = await startHarness(); });
beforeEach(async () => { await h.reset(); });
after(async () => { await h?.close(); });

test("K1 the fast pass requeues a lease past the short grace and leaves a fresher one", async () => {
  const { requeueLostDoorbellLeases } = await import("../src/tasks/sweeper.js");
  const { DOORBELL_DEAD_LEASE_GRACE_SEC, LEASE_LOST_GRACE_SEC } = await import("../src/config.js");
  assert.ok(LEASE_LOST_GRACE_SEC > DOORBELL_DEAD_LEASE_GRACE_SEC + 20, "the fast grace is the shorter one");
  await seedSession(h, "s1");
  await seedSession(h, "s2");
  await seedRun(h, "lost", "s1", {
    status: "running", dispatch: "doorbell", leaseOwner: "brain-gone",
    leaseExpiresInSec: -(DOORBELL_DEAD_LEASE_GRACE_SEC + 10), deadlineInSec: 3600, claimCount: 1,
  });
  await seedRun(h, "late", "s2", {
    status: "running", dispatch: "doorbell", leaseOwner: "brain-slow",
    leaseExpiresInSec: -(DOORBELL_DEAD_LEASE_GRACE_SEC - 10), deadlineInSec: 3600, claimCount: 1,
  });

  assert.equal(await requeueLostDoorbellLeases(), 0, "the slow reaper waits out its long grace");
  assert.equal(await requeueLostDoorbellLeases(DOORBELL_DEAD_LEASE_GRACE_SEC, "test"), 1);
  const lost = await runRow(h, "lost");
  assert.equal(lost.status, "queued");
  assert.equal(lost.lease_owner, null);
  assert.equal((await runRow(h, "late")).status, "running", "inside the grace: left to renew");
});

test("K2 the defaults put the requeue no earlier than brain's dead-holder window", async () => {
  const { DOORBELL_DEAD_LEASE_GRACE_SEC, RUN_LEASE_TTL_MS, RUN_LEASE_HEARTBEAT_MS } = await import("../src/config.js");
  // The earliest requeue after the holder's last renewal: its lease was written
  // at most one heartbeat before it died. Brain takes the lock over at 60 s.
  const earliestSec = (RUN_LEASE_TTL_MS - RUN_LEASE_HEARTBEAT_MS) / 1000 + DOORBELL_DEAD_LEASE_GRACE_SEC;
  assert.ok(earliestSec >= 60, `requeue as early as ${earliestSec}s would find the lock too fresh to take`);
});

test("K3 a pass acts only after a whole lease of clean observation", async () => {
  const { LeaseObservation } = await import("../src/tasks/sweeper.js");
  const o = new LeaseObservation(45_000, 15_000);
  assert.equal(o.ready(0), false, "a process that has heard nothing judges nothing");
  o.record(0, 5, false);
  assert.equal(o.ready(44_999), false);
  assert.equal(o.ready(45_000), true);
  o.record(50_000, 5, true);
  assert.equal(o.ready(60_000), false, "a failed round trip: renewals may have been failing too");
  o.record(60_000, 5, false);
  assert.equal(o.ready(104_999), false);
  assert.equal(o.ready(105_000), true);
  o.record(110_000, 20_000, false);
  assert.equal(o.ready(130_000), false, "a round trip slower than a heartbeat restarts the window");
});
