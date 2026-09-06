// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A dispatch whose publish outcome was never decided, and the rollback
 * precondition that has to see it.
 *
 * Three separate ways the old shape lied. A rollback check counted only queued
 * doorbell rows, so a claimed run executing right now read as nothing
 * outstanding. Reconciliation had no horizon, so the first tick after an insert
 * could terminalize a healthy dispatch still on its way to the stream. And a
 * session idled by publish-failure cleanup with a message still parked behind
 * it had no trigger left, because the only caller of the drain is a completion
 * that a pre-execution failure never emits.
 */

import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  startHarness, seedSession, seedRun, runRow, sessionRow, type Harness,
} from "./scenario-harness.js";

let h: Harness;
before(async () => { h = await startHarness(); });
beforeEach(async () => { await h.reset(); });
after(async () => { await h?.close(); });

async function markReconcile(taskId: string, dueInSec: number, action?: string): Promise<void> {
  await h.sql(
    `UPDATE claw_tasks
        SET dispatch_reconcile_at = NOW() + ($2::int * INTERVAL '1 second'),
            dispatch_reconcile_action = $3
      WHERE task_id = $1`,
    [taskId, dueInSec, action ?? null],
  );
}

test("a claimed incompatible run keeps the rollback precondition unsatisfied", async () => {
  // The queued-only check reads zero here, which is exactly the reading that
  // let an incompatible binary bind the durable while a run was executing.
  const { countIncompatibleDoorbellRuns } = await import("../src/tasks/run-claim.js");
  await seedSession(h, "s1");
  await seedRun(h, "claimed", "s1", {
    status: "preparing", dispatch: "doorbell", leaseOwner: "brain-a",
    leaseExpiresInSec: 600, claimCount: 1,
  });
  await h.sql(
    `UPDATE claw_tasks SET metadata = metadata || '{"doorbell_semantics":"2"}'::jsonb
      WHERE task_id = 'claimed'`,
  );

  const queuedOnly = await h.sql(
    `SELECT COUNT(*)::int AS n FROM claw_tasks WHERE status = 'queued'`,
  );
  assert.equal(Number(queuedOnly[0].n), 0, "nothing is queued, which is the misleading reading");
  assert.equal(await countIncompatibleDoorbellRuns(1), 1, "but a run it cannot execute is live");
});

test("a compatible run does not count against an incoming binary", async () => {
  const { countIncompatibleDoorbellRuns } = await import("../src/tasks/run-claim.js");
  await seedSession(h, "s1");
  await seedRun(h, "ok", "s1", { status: "running", dispatch: "doorbell" });

  assert.equal(await countIncompatibleDoorbellRuns(1), 0, "a row with no key is the version 1 it is");
  await seedRun(h, "fat", "s1", { status: "running", dispatch: "fat", messageId: "m-fat" });
  assert.equal(await countIncompatibleDoorbellRuns(1), 0, "and a fat row is not a doorbell row");
});

test("a dispatch still inside its horizon is not taken by a sweep", async () => {
  // Without the horizon the first tick after an insert terminalizes a healthy
  // dispatch whose only fault was outlasting a sweeper interval.
  const { reconcileAmbiguousDispatches } = await import("../src/tasks/sweeper.js");
  await seedSession(h, "s1");
  await seedRun(h, "inflight", "s1", { status: "queued", dispatch: "doorbell" });
  await markReconcile("inflight", 300);

  assert.equal(await reconcileAmbiguousDispatches(), 0);
  const row = await runRow(h, "inflight");
  assert.equal(row.status, "queued", "the row is untouched while the publisher may still resume");
  assert.notEqual(row.dispatch_reconcile_at, null, "and it keeps its marker");
});

test("once the horizon elapses the row is settled and the marker cleared", async () => {
  const { reconcileAmbiguousDispatches } = await import("../src/tasks/sweeper.js");
  await seedSession(h, "s1");
  await seedRun(h, "stale", "s1", { status: "queued", dispatch: "doorbell" });
  await markReconcile("stale", -1);

  assert.equal(await reconcileAmbiguousDispatches(), 1);
  const row = await runRow(h, "stale");
  assert.equal(row.status, "failed");
  assert.equal(row.dispatch_reconcile_at, null);
  assert.equal(row.dispatch_reconcile_action, null);
});

test("taking a row extends its horizon, so a publisher that resumes owns nothing", async () => {
  // The take is what invalidates every outstanding publisher compare-and-swap.
  const { reconcileAmbiguousDispatches } = await import("../src/tasks/sweeper.js");
  await seedSession(h, "s1");
  await seedRun(h, "held", "s1", {
    status: "running", dispatch: "doorbell", leaseOwner: "brain-a",
    leaseExpiresInSec: 600, claimCount: 1,
  });
  await markReconcile("held", -1, "idle_existing_session");

  await reconcileAmbiguousDispatches();
  const row = await runRow(h, "held");
  assert.equal(row.status, "running", "a row execution owns is never rolled back");
  assert.equal(row.dispatch_reconcile_at, null, "it just loses the marker");
  assert.equal(
    (await sessionRow(h, "s1")).agent_status, "running",
    "and its session is not idled under a live turn",
  );
});

test("a message parked behind a gate nothing will reopen is drained exactly once", async () => {
  // dispatchPendingMessage is reached from one place, the completion consumer,
  // and only when that completion opened the gate. A dispatch that fails before
  // execution emits no completion, so without this repair the turn is parked
  // for ever.
  const { drainOrphanedPendingMessages, sweeperPorts } = await import("../src/tasks/sweeper.js");
  const drained: string[] = [];
  const original = sweeperPorts.drainPendingMessage;
  sweeperPorts.drainPendingMessage = async (sessionId: string) => { drained.push(sessionId); };
  try {
    await seedSession(h, "s1", { agentStatus: "idle" });
    await h.sql(
      "INSERT INTO claw_pending_messages (session_id, user_id, content) VALUES ($1, $2, $3)",
      ["s1", "u-1", "still waiting"],
    );

    assert.equal(await drainOrphanedPendingMessages(), 1);
    assert.deepEqual(drained, ["s1"]);
  } finally {
    sweeperPorts.drainPendingMessage = original;
  }
});

test("the repair never stacks a turn onto a session a run still occupies", async () => {
  const { drainOrphanedPendingMessages, sweeperPorts } = await import("../src/tasks/sweeper.js");
  const drained: string[] = [];
  const original = sweeperPorts.drainPendingMessage;
  sweeperPorts.drainPendingMessage = async (sessionId: string) => { drained.push(sessionId); };
  try {
    await seedSession(h, "s1", { agentStatus: "idle" });
    await seedRun(h, "live", "s1", { status: "running", dispatch: "doorbell" });
    await h.sql(
      "INSERT INTO claw_pending_messages (session_id, user_id, content) VALUES ($1, $2, $3)",
      ["s1", "u-1", "still waiting"],
    );

    assert.equal(await drainOrphanedPendingMessages(), 0);
    assert.deepEqual(drained, []);
  } finally {
    sweeperPorts.drainPendingMessage = original;
  }
});

test("a busy session's queue is left to the completion that will open its gate", async () => {
  const { drainOrphanedPendingMessages, sweeperPorts } = await import("../src/tasks/sweeper.js");
  const drained: string[] = [];
  const original = sweeperPorts.drainPendingMessage;
  sweeperPorts.drainPendingMessage = async (sessionId: string) => { drained.push(sessionId); };
  try {
    await seedSession(h, "s1", { agentStatus: "running" });
    await h.sql(
      "INSERT INTO claw_pending_messages (session_id, user_id, content) VALUES ($1, $2, $3)",
      ["s1", "u-1", "still waiting"],
    );

    assert.equal(await drainOrphanedPendingMessages(), 0);
    assert.deepEqual(drained, []);
  } finally {
    sweeperPorts.drainPendingMessage = original;
  }
});

/** What a queued-row rollback check would have read, so the two can be compared. */
async function queuedIncompatibleCount(version: number): Promise<number> {
  return Number((await h.sql(
    `SELECT COUNT(*)::int AS n FROM claw_tasks
      WHERE COALESCE(metadata->>'dispatch', '') = 'doorbell'
        AND status = 'queued'
        AND COALESCE((metadata->>'doorbell_semantics')::int, 1) > $1::int`,
    [version],
  ))[0].n);
}

test("a holder that drains and unclaims never lets the precondition read clear", async () => {
  // The whole interleaving, because the misleading reading is a moment rather
  // than a state: the row leaves the queue on the claim and comes back to it on
  // the unclaim, and a check taken in between says nothing is outstanding while
  // the run is executing.
  const { claimRunById, countIncompatibleDoorbellRuns, releaseClaim } =
    await import("../src/tasks/run-claim.js");
  await seedSession(h, "s1");
  await seedRun(h, "ahead", "s1", { claimable: true, prompt: "needs the newer binary" });
  await h.sql(
    `UPDATE claw_tasks SET metadata = metadata || '{"doorbell_semantics":"2"}'::jsonb
      WHERE task_id = 'ahead'`,
  );

  assert.equal(await countIncompatibleDoorbellRuns(1), 1, "queued and unrunnable by version 1");

  const claimed = await claimRunById("ahead", "brain-capable", 2);
  assert.ok(typeof claimed === "object" && "request" in claimed, "the capable replica takes it");
  assert.equal((await runRow(h, "ahead")).status, "preparing");
  assert.equal(
    await queuedIncompatibleCount(1), 0,
    "this is the reading that let an incompatible binary bind the durable",
  );
  assert.equal(await countIncompatibleDoorbellRuns(1), 1, "while the run is executing");

  assert.equal(
    await releaseClaim("ahead", "brain-capable", claimed.claimCount, "drain"), true,
    "the holder shuts down and hands the row back",
  );
  assert.equal((await runRow(h, "ahead")).status, "queued");
  assert.equal(
    await countIncompatibleDoorbellRuns(1), 1,
    "and it is outstanding again the instant the last capable replica goes away",
  );
});
