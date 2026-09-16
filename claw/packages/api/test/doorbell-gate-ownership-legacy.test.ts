// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The same gate, in a process that has not asserted the fleet contract.
 *
 * This is the half that matters during a rolling deployment: a replica that
 * predates the marker takes the gate without naming its turn and releases it
 * without clearing it, so a value one turn wrote can survive under a later turn
 * an old replica owns. Until every replica is new, every new replica must still
 * WRITE the marker and no reader may act on it, so releases behave exactly as
 * they do today. The enforcing half is doorbell-gate-ownership.test.ts.
 */

import "./reconcile-off-env.js";

import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { startHarness, seedSession, seedRun, sessionRow, type Harness } from "./scenario-harness.js";

let h: Harness;
before(async () => { h = await startHarness(); });
beforeEach(async () => { await h.reset(); });
after(async () => { await h?.close(); });

test("the contract is unasserted in this process, so the cases below mean what they say", async () => {
  const { gateOwnershipEnforced } = await import("../src/tasks/chat-run.js");
  assert.equal(gateOwnershipEnforced(), false);
});

test("an old replica's stale marker does not stop a release", async () => {
  // The old writer left a marker naming a turn that is long gone. Acting on it
  // would wedge the gate for good; today's predicate ignores it.
  const { forceIdleAfterInterrupt } = await import("../src/tasks/chat-run.js");
  await seedSession(h, "s1", { gateOwner: "m-stale" });

  assert.equal(await forceIdleAfterInterrupt("s1", "m-1"), true);
});

test("an unleased fat row still lets the gate be broken, as it does today", async () => {
  // The occupancy extension is part of the same assertion: enabling it while
  // old replicas are still running would wedge every gate they own.
  const { forceIdleAfterInterrupt } = await import("../src/tasks/chat-run.js");
  await seedSession(h, "s1", { gateOwner: "m-1" });
  await seedRun(h, "fat", "s1", { status: "preparing", dispatch: "fat", leaseOwner: null });

  assert.equal(await forceIdleAfterInterrupt("s1", "m-1"), true);
});

test("a live lease still stays its hand", async () => {
  const { forceIdleAfterInterrupt } = await import("../src/tasks/chat-run.js");
  await seedSession(h, "s1", { gateOwner: "m-1" });
  await seedRun(h, "held", "s1", {
    status: "running", dispatch: "doorbell", leaseOwner: "brain-a", leaseExpiresInSec: 600,
  });

  assert.equal(await forceIdleAfterInterrupt("s1", "m-1"), false);
});

test("a completion releases the gate whatever the marker says", async () => {
  const { releaseSessionGateIfLastRun } = await import("../src/events/consumer.js");
  await seedSession(h, "s1", { gateOwner: "m-2" });

  assert.equal(await releaseSessionGateIfLastRun("s1", "m-1", false), true);
});

test("but a new replica writes the marker even so, so the flip has something to read", async () => {
  const { takeSessionGate } = await import("../src/tasks/chat-run.js");
  await seedSession(h, "s1", { agentStatus: "idle", gateOwner: null });

  await takeSessionGate("s1", "m-7");
  const row = await sessionRow(h, "s1");
  assert.equal(row.agent_status, "running");
  assert.equal(row.agent_gate_message_id, "m-7");
});

async function oldReplicaTakesGate(sessionId: string): Promise<void> {
  await h.sql(
    `UPDATE claw_sessions SET agent_status = 'running', updated_at = NOW()
      WHERE session_id = $1 AND deleted_at IS NULL`,
    [sessionId],
  );
}

test("an old writer's completion still opens the gate a newer turn took, as it does today", async () => {
  // The marker names the newer turn and is ignored, so the release lands. That
  // is the exposure the flip closes; until the fleet asserts it, closing it
  // here would wedge every gate an old replica owns.
  const { releaseSessionGateIfLastRun } = await import("../src/events/consumer.js");
  const { takeSessionGate } = await import("../src/tasks/chat-run.js");
  await seedSession(h, "s1", { agentStatus: "idle", gateOwner: null });
  await oldReplicaTakesGate("s1");
  await takeSessionGate("s1", "m-new");

  assert.equal(await releaseSessionGateIfLastRun("s1", "m-old", false), true);
  assert.equal((await sessionRow(h, "s1")).agent_status, "idle");
});

test("an old Stop timer with no marker still idles a newer preparing turn", async () => {
  const { forceIdleAfterInterrupt, takeSessionGate } = await import("../src/tasks/chat-run.js");
  await seedSession(h, "s1", { agentStatus: "idle", gateOwner: null });
  await takeSessionGate("s1", "m-new");
  await seedRun(h, "newer", "s1", {
    status: "preparing", dispatch: "fat", leaseOwner: null, messageId: "m-new",
  });

  assert.equal(await forceIdleAfterInterrupt("s1", null), true);
  assert.equal((await sessionRow(h, "s1")).agent_status, "idle");
});
