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

/**
 * An old replica taking the gate: the column is flipped and the marker is not.
 *
 * That is the writer this whole flip has to survive, so the race is built from
 * it rather than from a seeded row.
 */
async function oldReplicaTakesGate(sessionId: string): Promise<void> {
  await h.sql(
    `UPDATE claw_sessions SET agent_status = 'running', updated_at = NOW()
      WHERE session_id = $1 AND deleted_at IS NULL`,
    [sessionId],
  );
}

test("an old writer's completion cannot open the gate a newer turn took from it", async () => {
  // The newer turn is between its gate flip and its row insert, which is the
  // window that has no row to argue from -- only the marker.
  const { releaseSessionGateIfLastRun } = await import("../src/events/consumer.js");
  const { takeSessionGate } = await import("../src/tasks/chat-run.js");
  await seedSession(h, "s1", { agentStatus: "idle", gateOwner: null });
  await oldReplicaTakesGate("s1");
  await takeSessionGate("s1", "m-new");

  assert.equal(await releaseSessionGateIfLastRun("s1", "m-old", false), false);
  const row = await sessionRow(h, "s1");
  assert.equal(row.agent_status, "running");
  assert.equal(row.agent_gate_message_id, "m-new", "and the newer turn still owns it");
});

test("an old Stop timer with no marker cannot idle a newer turn that is preparing", async () => {
  // The timer predates the column, so it captured nothing to compare. What
  // stays its hand is the newer turn's own row, which under this assertion
  // counts as a holder even before a lease exists.
  const { forceIdleAfterInterrupt, takeSessionGate } = await import("../src/tasks/chat-run.js");
  await seedSession(h, "s1", { agentStatus: "idle", gateOwner: null });
  await takeSessionGate("s1", "m-new");
  await seedRun(h, "newer", "s1", {
    status: "preparing", dispatch: "fat", leaseOwner: null, messageId: "m-new",
  });

  assert.equal(await forceIdleAfterInterrupt("s1", null), false);
  assert.equal((await sessionRow(h, "s1")).agent_status, "running");
});

test("a lost run's reaper hands its own session's gate back unowned", async () => {
  // The pair matched, so the gate does open -- and it must stop naming the turn
  // that died holding it. A marker left behind answers for the next turn: an
  // old writer flips the column without touching it, and the dead turn's late
  // completion then matches and opens a gate it does not hold.
  const { reapLostLeases } = await import("../src/tasks/sweeper.js");
  const { releaseSessionGateIfLastRun } = await import("../src/events/consumer.js");
  await seedSession(h, "s1", { gateOwner: "m-1" });
  await seedRun(h, "lost", "s1", {
    status: "running", dispatch: "fat", leaseOwner: "brain-a",
    leaseExpiresInSec: -3600, messageId: "m-1",
  });

  await reapLostLeases();
  const reaped = await sessionRow(h, "s1");
  assert.equal(reaped.agent_status, "idle", "the reaped run's own gate is handed back");
  assert.equal(
    reaped.agent_gate_message_id, null,
    "a dead turn must not still name itself as the holder",
  );

  await oldReplicaTakesGate("s1");
  assert.equal(
    await releaseSessionGateIfLastRun("s1", "m-1", false), false,
    "the reaped turn's completion cannot open the gate the next turn took",
  );
  assert.equal((await sessionRow(h, "s1")).agent_status, "running");
});
