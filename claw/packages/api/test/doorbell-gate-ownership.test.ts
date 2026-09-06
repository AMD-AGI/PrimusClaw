// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Who holds the session gate, and who may hand it back.
 *
 * Occupancy answers a different question from ownership. The immediate path
 * commits `agent_status = 'running'` and inserts the run row several awaits
 * later, so a release evaluated in that window opens the gate under a live
 * turn; and timestamps cannot close it, because NOW() is transaction-start
 * time and a newer turn's flip can carry a stamp older than the compensated
 * row's `completed_at`. These pin the marker that names the turn instead.
 *
 * The enforcement flag is read at import, so the two values need two
 * processes. This file is the enforcing half; gate-ownership-legacy covers the
 * other, where every reader must behave exactly as it does today.
 */

import "./reconcile-on-env.js";

import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { startHarness, seedSession, seedRun, sessionRow, type Harness } from "./scenario-harness.js";

let h: Harness;
before(async () => { h = await startHarness(); });
beforeEach(async () => { await h.reset(); });
after(async () => { await h?.close(); });

test("a Stop timer armed for one turn cannot idle the turn that replaced it", async () => {
  // The timer fires thirty seconds after a stop. By then the user may have sent
  // another message, and that turn owns the gate now.
  const { forceIdleAfterInterrupt } = await import("../src/tasks/chat-run.js");
  await seedSession(h, "s1", { gateOwner: "m-2" });

  assert.equal(await forceIdleAfterInterrupt("s1", "m-1"), false);
  assert.equal((await sessionRow(h, "s1")).agent_status, "running");
});

test("a Stop timer idles the turn its own marker names", async () => {
  const { forceIdleAfterInterrupt } = await import("../src/tasks/chat-run.js");
  await seedSession(h, "s1", { gateOwner: "m-1" });

  assert.equal(await forceIdleAfterInterrupt("s1", "m-1"), true);
  const row = await sessionRow(h, "s1");
  assert.equal(row.agent_status, "idle");
  assert.equal(row.agent_gate_message_id, null, "the gate is handed back unowned");
});

test("a gate taken before the marker existed is left to the backstop", async () => {
  // NULL fails closed rather than matching: no run-scoped caller owns it, and
  // reapStuckSessions is the reaper for that bounded population.
  const { forceIdleAfterInterrupt } = await import("../src/tasks/chat-run.js");
  await seedSession(h, "s1", { gateOwner: null });

  assert.equal(await forceIdleAfterInterrupt("s1", "m-1"), false);
  assert.equal((await sessionRow(h, "s1")).agent_status, "running");
});

test("an unsettled fat delivery keeps the gate shut even with no lease", async () => {
  // A fat run has null holder columns for the whole of delivery, the workspace
  // gate and the lock wait, so reading an absent lease as an absent holder is
  // how a second turn gets dispatched on top of a live one.
  const { forceIdleAfterInterrupt } = await import("../src/tasks/chat-run.js");
  await seedSession(h, "s1", { gateOwner: "m-1" });
  await seedRun(h, "fat", "s1", { status: "preparing", dispatch: "fat", leaseOwner: null });

  assert.equal(await forceIdleAfterInterrupt("s1", "m-1"), false);
  assert.equal((await sessionRow(h, "s1")).agent_status, "running");
});

test("the gate opens once that delivery's row is terminal", async () => {
  const { forceIdleAfterInterrupt } = await import("../src/tasks/chat-run.js");
  await seedSession(h, "s1", { gateOwner: "m-1" });
  await seedRun(h, "fat", "s1", { status: "failed", dispatch: "fat", leaseOwner: null });

  assert.equal(await forceIdleAfterInterrupt("s1", "m-1"), true);
});

test("a completion releases only the gate its own turn took", async () => {
  const { releaseSessionGateIfLastRun } = await import("../src/events/consumer.js");
  await seedSession(h, "s1", { gateOwner: "m-2" });

  assert.equal(await releaseSessionGateIfLastRun("s1", "m-1", false), false);
  assert.equal((await sessionRow(h, "s1")).agent_status, "running");
  assert.equal(await releaseSessionGateIfLastRun("s1", "m-2", false), true);
  assert.equal((await sessionRow(h, "s1")).agent_gate_message_id, null);
});

test("a lost run's reaper releases the gate by the pair, not by the session", async () => {
  // reapLostLeases hands (session, message) pairs to the release, so a run it
  // closed cannot open a gate a newer turn is holding.
  const { reapLostLeases } = await import("../src/tasks/sweeper.js");
  await seedSession(h, "s1", { gateOwner: "m-2" });
  await seedRun(h, "lost", "s1", {
    status: "running", dispatch: "fat", leaseOwner: "brain-a",
    leaseExpiresInSec: -3600, messageId: "m-1",
  });

  await reapLostLeases();
  assert.equal(
    (await sessionRow(h, "s1")).agent_status, "running",
    "the reaped run is not the turn holding this gate",
  );
});
