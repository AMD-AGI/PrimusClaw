// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Two runs on one session, and the last one to finish has to hand the gate back.
 *
 * A completion opens the gate, its drain starts dispatching the next parked
 * message, and a user message posted in that window finds the gate idle and
 * takes it. The drain then takes the gate by force under its own turn, so two
 * runs overlap and the marker names the one dispatched second. Whichever ends
 * first leaves the gate to the other; the other must then release it even when
 * the marker names the turn that has already ended, or nothing drains the queue
 * until `reapStuckSessions` times the session out an hour later.
 */

import "./reconcile-on-env.js";

import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { startHarness, seedSession, seedRun, sessionRow, type Harness } from "./scenario-harness.js";

let h: Harness;
before(async () => { h = await startHarness(); });
beforeEach(async () => { await h.reset(); });
after(async () => { await h?.close(); });

const SESSION = "s1";
/** The item-ready wake the drain dispatched. */
const WAKE = { taskId: "run-wake", messageId: "claw-pending-214" };
/** The user's question, posted while that drain was still dispatching. */
const USER = { taskId: "run-user", messageId: "claw-1793713235824" };
type Run = typeof WAKE;

const DRAIN_READ = "FROM claw_pending_messages WHERE session_id";

async function withLiveSession<T>(body: () => Promise<T>): Promise<T> {
  const { tombstoneReader } = await import("../src/events/consumer.js");
  const { resetDeletedSessionCache } = await import("../src/sessions/deleted-cache.js");
  const original = { ...tombstoneReader };
  Object.assign(tombstoneReader, { has: async () => false });
  resetDeletedSessionCache();
  try {
    return await body();
  } finally {
    Object.assign(tombstoneReader, original);
    resetDeletedSessionCache();
  }
}

/** Deliver the run's `exec_complete`; answers whether that completion drained the queue. */
async function complete(run: Run): Promise<boolean> {
  const { consumeEventDelivery } = await import("../src/events/consumer.js");
  const { sc } = await import("../src/infra/nats.js");
  const before = h.statements.length;
  await withLiveSession(() => consumeEventDelivery({
    subject: `events.${SESSION}`,
    data: sc.encode(JSON.stringify({
      type: "exec_complete", session_id: SESSION, message_id: run.messageId, task_id: run.taskId, user_id: "u-1",
    })),
    ack: () => {}, nak: () => {},
    // The drain reads queue columns this fixture does not carry and throws there;
    // reaching that read is what is asserted.
  }).catch(() => {}));
  return h.statements.slice(before).some((s) => s.includes(DRAIN_READ));
}

/**
 * The overlap as production reached it: the user's POST took the idle gate, then
 * the drain's dispatch took it again under the wake. `gateOwner` overrides who
 * ends up named, for the interleavings where the forced take did not land last.
 */
async function overlap(gateOwner?: string): Promise<void> {
  const { takeSessionGate } = await import("../src/tasks/chat-run.js");
  await seedSession(h, SESSION, { agentStatus: "idle" });
  await takeSessionGate(SESSION, USER.messageId);
  await seedRun(h, USER.taskId, SESSION, { status: "running", messageId: USER.messageId });
  await seedRun(h, WAKE.taskId, SESSION, { status: "running", messageId: WAKE.messageId });
  await takeSessionGate(SESSION, gateOwner ?? WAKE.messageId);
}

async function gate(): Promise<{ status: unknown; owner: unknown }> {
  const row = await sessionRow(h, SESSION);
  return { status: row.agent_status, owner: row.agent_gate_message_id };
}

async function liveRunVerdict(run: Run): Promise<string> {
  const { assertLiveRun } = await import("../src/assistant/tools.js");
  const { db } = await import("../src/infra/db.js");
  try {
    await assertLiveRun((text, params) => db.query(text, params), {
      sid: SESSION, task_id: run.taskId, mid: run.messageId, role: "router",
    } as never);
    return "live";
  } catch (err) {
    return (err as { code?: string }).code ?? String(err);
  }
}

const interleavings: Array<{ name: string; marker: Run; first: Run; last: Run }> = [
  { name: "the evidence: the wake is named and ends first", marker: WAKE, first: WAKE, last: USER },
  { name: "the wake is named and ends last", marker: WAKE, first: USER, last: WAKE },
  { name: "the user is named and ends first", marker: USER, first: USER, last: WAKE },
  { name: "the user is named and ends last", marker: USER, first: WAKE, last: USER },
];

for (const { name, marker, first, last } of interleavings) {
  test(`overlapping runs (${name}): the last to finish releases the gate and drains`, async () => {
    await overlap(marker.messageId);
    assert.equal((await gate()).owner, marker.messageId);

    assert.equal(await complete(first), false, "the first to end leaves the gate to the run still going");
    assert.deepEqual(await gate(), { status: "running", owner: marker.messageId });

    assert.equal(await complete(last), true, "the last to end drains what was parked behind both");
    assert.deepEqual(await gate(), { status: "idle", owner: null });
  });
}

test("the run still going may speak once the turn named on the gate has ended", async () => {
  // The evidence: the user's run was refused `turn_superseded` by a gate naming
  // the wake, which had already completed. No newer turn had taken over.
  await overlap();
  await complete(WAKE);
  assert.equal(await liveRunVerdict(USER), "live");
});

test("a run is still superseded by a named turn that is live", async () => {
  await overlap();
  assert.equal(await liveRunVerdict(USER), "turn_superseded");
  assert.equal(await liveRunVerdict(WAKE), "live");
});

test("a run is still superseded by a named turn whose row is not written yet", async () => {
  // `takeSessionGate` commits before `dispatchTaskToBrain` writes the row, so a
  // marker naming no row is a turn about to start, not one that has ended.
  await seedSession(h, SESSION, { gateOwner: "claw-next" });
  await seedRun(h, USER.taskId, SESSION, { status: "running", messageId: USER.messageId });
  assert.equal(await liveRunVerdict(USER), "turn_superseded");
  assert.equal(await complete(USER), false);
  assert.deepEqual(await gate(), { status: "running", owner: "claw-next" });
});

test("an ended named turn does not release a gate another run still occupies", async () => {
  await seedSession(h, SESSION, { gateOwner: WAKE.messageId });
  await seedRun(h, WAKE.taskId, SESSION, { status: "completed", messageId: WAKE.messageId });
  await seedRun(h, USER.taskId, SESSION, { status: "running", messageId: USER.messageId });
  await seedRun(h, "run-third", SESSION, { status: "running", messageId: "claw-third" });
  assert.equal(await complete(USER), false);
  assert.deepEqual(await gate(), { status: "running", owner: WAKE.messageId });
});

test("a named turn whose replay is still open has not ended", async () => {
  // A replayed turn opens a second row under the same message id; the first one
  // failing is not the turn ending.
  await seedSession(h, SESSION, { gateOwner: WAKE.messageId });
  await seedRun(h, WAKE.taskId, SESSION, { status: "failed", messageId: WAKE.messageId });
  await seedRun(h, "run-wake-replay", SESSION, { status: "running", messageId: WAKE.messageId });
  await seedRun(h, USER.taskId, SESSION, { status: "running", messageId: USER.messageId });
  assert.equal(await liveRunVerdict(USER), "turn_superseded");
});

/**
 * Every other way a run ends has to hand the gate back on the same terms as the
 * completion does. Each case leaves the wake named on the gate, already ended,
 * and the user's run the last one in the session; the path under test ends that
 * run and must open the gate, or the session waits for `reapStuckSessions`.
 */
async function wakeEndedUserLast(userStatus: string, extra: Partial<Parameters<typeof seedRun>[3]> = {}): Promise<void> {
  await seedSession(h, SESSION, { gateOwner: WAKE.messageId });
  await seedRun(h, WAKE.taskId, SESSION, { status: "completed", messageId: WAKE.messageId });
  await seedRun(h, USER.taskId, SESSION, { status: userStatus, messageId: USER.messageId, ...extra });
}

test("a Stop on the run still going opens a gate naming the turn that ended", async () => {
  const { releaseSessionGateIfUnoccupied } = await import("../src/tasks/chat-run.js");
  await wakeEndedUserLast("cancelled");
  await releaseSessionGateIfUnoccupied(SESSION, USER.messageId);
  assert.deepEqual(await gate(), { status: "idle", owner: null });
});

test("forcing idle after an interrupt opens a gate naming the turn that ended", async () => {
  const { forceIdleAfterInterrupt } = await import("../src/tasks/chat-run.js");
  await wakeEndedUserLast("cancelled");
  assert.equal(await forceIdleAfterInterrupt(SESSION, USER.messageId), true);
  assert.deepEqual(await gate(), { status: "idle", owner: null });
});

test("a queue timeout of the last run opens a gate naming the turn that ended", async () => {
  const { reapExpiredQueuedRuns, sweeperPorts } = await import("../src/tasks/sweeper.js");
  const original = { ...sweeperPorts };
  Object.assign(sweeperPorts, { publishSessionEvent: async () => {} });
  try {
    await wakeEndedUserLast("queued", { dispatch: "doorbell", queuedAgoSec: 3 * 60 * 60 });
    assert.equal(await reapExpiredQueuedRuns(), 1);
    assert.deepEqual(await gate(), { status: "idle", owner: null });
  } finally {
    Object.assign(sweeperPorts, original);
  }
});

test("a reconciled dispatch of the last run opens a gate naming the turn that ended", async () => {
  const { reconcileAmbiguousDispatches } = await import("../src/tasks/sweeper.js");
  await wakeEndedUserLast("failed");
  await h.sql(
    `UPDATE claw_tasks SET dispatch_reconcile_at = NOW() - INTERVAL '1 minute',
                           dispatch_reconcile_action = 'idle_existing_session'
      WHERE task_id = $1`,
    [USER.taskId],
  );
  assert.equal(await reconcileAmbiguousDispatches(), 1);
  assert.deepEqual(await gate(), { status: "idle", owner: null });
});

test("an ended marker over an empty session does not refuse an unforced take", async () => {
  const { takeSessionGateIfUnowned } = await import("../src/tasks/chat-run.js");
  await seedSession(h, SESSION, { agentStatus: "idle", gateOwner: WAKE.messageId });
  await seedRun(h, WAKE.taskId, SESSION, { status: "completed", messageId: WAKE.messageId });
  await seedRun(h, "run-next", SESSION, { status: "queued", messageId: "claw-next" });
  assert.equal(await takeSessionGateIfUnowned(SESSION, "claw-next"), true);
  assert.deepEqual(await gate(), { status: "running", owner: "claw-next" });
});

test("an ended marker over a run still going keeps refusing an unforced take", async () => {
  const { takeSessionGateIfUnowned } = await import("../src/tasks/chat-run.js");
  await wakeEndedUserLast("running");
  assert.equal(await takeSessionGateIfUnowned(SESSION, "claw-next"), false);
  assert.deepEqual(await gate(), { status: "running", owner: WAKE.messageId });
});

test("the stuck-session reaper clears the marker along with the status", async () => {
  const { reapStuckSessions, sweeperPorts } = await import("../src/tasks/sweeper.js");
  const original = { ...sweeperPorts };
  Object.assign(sweeperPorts, { deliverySettlement: async () => null });
  try {
    await seedSession(h, SESSION, { gateOwner: WAKE.messageId, updatedAgoSec: 7 * 24 * 60 * 60 });
    await seedRun(h, WAKE.taskId, SESSION, { status: "failed", messageId: WAKE.messageId });
    assert.equal(await reapStuckSessions(), 1);
    assert.deepEqual(await gate(), { status: "idle", owner: null });
  } finally {
    Object.assign(sweeperPorts, original);
  }
});
