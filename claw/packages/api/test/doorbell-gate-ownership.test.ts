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

test("a completion that names no turn hands back the gate that names none either", async () => {
  // `message_id` is optional on the wire, so a completion can arrive with no
  // turn to compare against. Under `=` it matched no row at all -- not even a
  // gate as anonymous as itself -- and the session stayed shut until
  // reapStuckSessions timed it out an hour later.
  const { releaseSessionGateIfLastRun } = await import("../src/events/consumer.js");
  await seedSession(h, "s1", { gateOwner: null });

  assert.equal(await releaseSessionGateIfLastRun("s1", null, false), true);
  const row = await sessionRow(h, "s1");
  assert.equal(row.agent_status, "idle");
  assert.equal(row.agent_gate_message_id, null);
});

test("a completion that names no turn does not clear a gate that names one", async () => {
  // Occupancy cannot stand in for ownership here. `takeSessionGate` commits
  // before the row that would occupy the session is written, so a completion
  // delayed into that window sees an empty occupancy check -- and if that were
  // enough it would clear the *next* turn's marker and admit a second message
  // on top of a live run. No open row is seeded, which is exactly that window.
  const { releaseSessionGateIfLastRun } = await import("../src/events/consumer.js");
  await seedSession(h, "s1", { gateOwner: "m-2" });

  assert.equal(await releaseSessionGateIfLastRun("s1", null, false), false);
  const row = await sessionRow(h, "s1");
  assert.equal(row.agent_status, "running");
  assert.equal(row.agent_gate_message_id, "m-2");
});

test("an unnamed completion does not release while another turn is open", async () => {
  // And occupancy is what keeps that safe: with nothing to compare, the open
  // row is the only evidence of a holder, so the unnamed completion cannot
  // clear a marker naming a turn that is still running.
  const { releaseSessionGateIfLastRun } = await import("../src/events/consumer.js");
  await seedSession(h, "s1", { gateOwner: "m-2" });
  await seedRun(h, "open", "s1", { status: "running", messageId: "m-2" });

  assert.equal(await releaseSessionGateIfLastRun("s1", null, false), false);
  const row = await sessionRow(h, "s1");
  assert.equal(row.agent_status, "running");
  assert.equal(row.agent_gate_message_id, "m-2");
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

test("an unnamed completion hands back the named gate of the row it names", async () => {
  // The recovery that keeps ownership affordable. `message_id` is optional on
  // the wire, but the row the report names was opened under the same id the
  // gate was taken with, so the consumer reads it back before it asks the gate
  // about it. Without that, every unnamed completion of a named turn would wait
  // out reapStuckSessions with the user's next message parked behind it.
  const { consumeEventDelivery, tombstoneReader } = await import("../src/events/consumer.js");
  const { resetDeletedSessionCache } = await import("../src/sessions/deleted-cache.js");
  const { sc } = await import("../src/infra/nats.js");
  await seedSession(h, "s1", { gateOwner: "m-1" });
  await seedRun(h, "t1", "s1", { status: "running", dispatch: "doorbell", messageId: "m-1" });

  const original = { ...tombstoneReader };
  Object.assign(tombstoneReader, { has: async () => false });
  resetDeletedSessionCache();
  try {
    await consumeEventDelivery({
      subject: "events.s1",
      // Deliberately no `message_id`: the shape a Brain that predates the echo
      // sends, and the shape an A2A send that never had one produces.
      data: sc.encode(JSON.stringify({
        type: "exec_complete", session_id: "s1", task_id: "t1",
        user_id: "u-1", prompt: "hello", final_text: "hi", failed: false,
        error_count: 0, skills_used: {},
      })),
      ack: () => {}, nak: () => {},
    }).catch(() => {});
  } finally {
    Object.assign(tombstoneReader, original);
    resetDeletedSessionCache();
  }

  const row = await sessionRow(h, "s1");
  assert.equal(row.agent_status, "idle", "the gate its own turn held was not handed back");
  assert.equal(row.agent_gate_message_id, null);
});

test("an unnamed completion does not release over another anonymous run", async () => {
  // The trap in matching NULL against NULL twice. A legacy turn carries no
  // message id, so an unnamed completion matches the unnamed gate -- and if
  // occupancy also excluded rows by a NULL id, every other anonymous row would
  // read as "this same turn" and stop occupying the session. The gate would
  // then open over a run that is still executing.
  const { releaseSessionGateIfLastRun } = await import("../src/events/consumer.js");
  await seedSession(h, "s1", { gateOwner: null });
  await seedRun(h, "mine", "s1", { status: "running" });
  await seedRun(h, "other", "s1", { status: "running" });

  assert.equal(
    await releaseSessionGateIfLastRun("s1", null, false, "mine"), false,
    "the other anonymous run still occupies the session",
  );
  assert.equal((await sessionRow(h, "s1")).agent_status, "running");
});

test("an unnamed completion releases once its own row is the only one left", async () => {
  const { releaseSessionGateIfLastRun } = await import("../src/events/consumer.js");
  await seedSession(h, "s1", { gateOwner: null });
  await seedRun(h, "mine", "s1", { status: "running" });

  assert.equal(await releaseSessionGateIfLastRun("s1", null, false, "mine"), true);
  assert.equal((await sessionRow(h, "s1")).agent_status, "idle");
});

test("an unnamed completion does not release over an active A2A run", async () => {
  // The occupancy read is by origin, and an A2A client that sends twice with no
  // id leaves two rows no completion can tell apart -- closeChatRun closes
  // neither, rightly. Counting only chat rows there would hand the session back
  // while accepted A2A work is still executing, and GetTask would answer that
  // the task is done.
  const { releaseSessionGateIfLastRun } = await import("../src/events/consumer.js");
  await seedSession(h, "s1", { gateOwner: null });
  await seedRun(h, "mine", "s1", { status: "running" });
  await h.sql("UPDATE claw_tasks SET origin = 'a2a' WHERE task_id = 'mine'");
  await seedRun(h, "other", "s1", { status: "running" });
  await h.sql("UPDATE claw_tasks SET origin = 'a2a' WHERE task_id = 'other'");

  assert.equal(await releaseSessionGateIfLastRun("s1", null, false, "mine"), false);
  assert.equal((await sessionRow(h, "s1")).agent_status, "running");
});
