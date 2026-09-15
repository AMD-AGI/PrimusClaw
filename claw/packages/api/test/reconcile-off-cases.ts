// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a deployment that has not asserted the fleet contract may still do to a
 * fat row, and what it must leave alone.
 *
 * The mirror of the reconciliation suites that begin `import
 * "./reconcile-on-env.js"`: the same rows, the same calls, the opposite
 * verdicts. Every case leaves the per-tick delivery observation unreadable and
 * puts the row's receipt at the one ambiguous publish state, so no evidence arm
 * of the shared guard holds and what is proven is the switch rather than the
 * observation.
 *
 * Registered from two `.test.ts` files -- the variable absent, and set to
 * `"false"` -- because the setting is read once at config import and one
 * process can therefore only be one environment. The gate half of the same
 * boundary lives in doorbell-gate-ownership-legacy.test.ts.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { seedSession, seedRun, runRow, sessionRow, type Harness } from "./scenario-harness.js";

/** The explicit marker. `seedRun`'s `dispatch: "fat"` writes the legacy shape, which has no key. */
async function markFat(h: Harness, taskId: string): Promise<void> {
  await h.sql(
    `UPDATE claw_tasks SET metadata = metadata || '{"dispatch":"fat"}'::jsonb WHERE task_id = $1`,
    [taskId],
  );
}

/** The receipt state no arm of the guard can answer from the row alone. */
async function armAttempted(h: Harness, taskId: string): Promise<void> {
  await h.sql(
    `UPDATE claw_tasks
        SET metadata = metadata || jsonb_build_object(
              'dispatch_compensation',
              jsonb_build_object('version', 1, 'state', 'armed', 'publish', 'attempted'))
      WHERE task_id = $1`,
    [taskId],
  );
}

async function receiptOf(h: Harness, taskId: string): Promise<Record<string, unknown> | undefined> {
  const meta = (await runRow(h, taskId)).metadata as Record<string, unknown>;
  return meta.dispatch_compensation as Record<string, unknown> | undefined;
}

/** Run `body` with the sweeper's durable read answering `observation`, then restore the port. */
async function withSettlement<T>(
  observation: { ackFloor: number; lastSeq: number } | null,
  body: () => Promise<T>,
): Promise<T> {
  const { sweeperPorts } = await import("../src/tasks/sweeper.js");
  const original = sweeperPorts.deliverySettlement;
  sweeperPorts.deliverySettlement = async () => observation;
  try {
    return await body();
  } finally {
    sweeperPorts.deliverySettlement = original;
  }
}

async function captureInterruptEvents(
  sessionId: string,
): Promise<Array<Record<string, unknown>>> {
  const { chatRunPorts, interruptSessionRuns } = await import("../src/tasks/chat-run.js");
  const seen: Array<Record<string, unknown>> = [];
  const original = chatRunPorts.publishSessionEvent;
  chatRunPorts.publishSessionEvent = async (_s: string, event: Record<string, unknown>) => {
    seen.push(event);
  };
  try {
    await interruptSessionRuns(sessionId);
  } finally {
    chatRunPorts.publishSessionEvent = original;
  }
  return seen;
}

/** An aged, unheld, ambiguously published row: everything a reap wants except the evidence. */
async function seedAgedOrphan(h: Harness, taskId: string, explicitFat: boolean): Promise<void> {
  await seedRun(h, taskId, "s1", {
    status: "preparing", dispatch: "fat", startedAgoSec: 99_999,
  });
  if (explicitFat) await markFat(h, taskId);
  await armAttempted(h, taskId);
}

/** A holder and the spare row a replayed dispatch left beside it, sharing one message id. */
async function seedHolderAndSpare(h: Harness, explicitFat: boolean): Promise<void> {
  await seedRun(h, "held", "s1", {
    status: "running", dispatch: "fat", messageId: "m-1",
    leaseOwner: "brain-a", leaseExpiresInSec: 600, claimCount: 1,
  });
  await markFat(h, "held");
  await seedRun(h, "spare", "s1", {
    status: "preparing", dispatch: "fat", messageId: "m-1", leaseOwner: null,
  });
  if (explicitFat) await markFat(h, "spare");
  await armAttempted(h, "spare");
}

/** Rows the durable receipt cannot answer for, which the reaper must leave open. */
function registerOrphanReapCases(harness: () => Harness): void {
  for (const [shape, explicitFat] of [["legacy", false], ["explicitly fat", true]] as const) {
    test(`an aged ${shape} orphan the durable cannot answer for is left open`, async () => {
      const h = harness();
      const { reapOrphanedFatRuns } = await import("../src/tasks/sweeper.js");
      await seedSession(h, "s1");
      await seedAgedOrphan(h, "orphan", explicitFat);

      await withSettlement(null, async () => {
        assert.equal(await reapOrphanedFatRuns(), 0);
      });
      const row = await runRow(h, "orphan");
      assert.equal(row.status, "preparing");
      assert.equal(row.failure_reason, null);
      assert.equal(row.completed_at, null);
      assert.deepEqual(await receiptOf(h, "orphan"), {
        version: 1, state: "armed", publish: "attempted",
      });
    });
  }

  test("a row the durable has settled is closed whatever the switch says", async () => {
    const h = harness();
    const { reapOrphanedFatRuns } = await import("../src/tasks/sweeper.js");
    await seedSession(h, "s1");
    await seedAgedOrphan(h, "settled", true);
    await h.sql(
      `UPDATE claw_tasks SET metadata = metadata || '{"dispatch_seq":"90"}'::jsonb
        WHERE task_id = 'settled'`,
    );

    await withSettlement({ ackFloor: 120, lastSeq: 200 }, async () => {
      assert.equal(await reapOrphanedFatRuns(), 1);
    });
    const row = await runRow(h, "settled");
    assert.equal(row.status, "failed");
    assert.equal(row.failure_reason, "dispatch_unconfirmed");
    assert.notEqual(row.completed_at, null);
    assert.deepEqual(await receiptOf(h, "settled"), {
      version: 1,
      state: "terminal",
      failure_reason: "dispatch_unconfirmed",
      error_message: (row.error_message ?? null) as string,
    });
  });

  test("a sequence the durable has not reached leaves the row open", async () => {
    const h = harness();
    const { reapOrphanedFatRuns } = await import("../src/tasks/sweeper.js");
    await seedSession(h, "s1");
    await seedAgedOrphan(h, "outstanding", true);
    await h.sql(
      `UPDATE claw_tasks SET metadata = metadata || '{"dispatch_seq":"90"}'::jsonb
        WHERE task_id = 'outstanding'`,
    );

    await withSettlement({ ackFloor: 50, lastSeq: 200 }, async () => {
      assert.equal(await reapOrphanedFatRuns(), 0);
    });
    assert.equal((await runRow(h, "outstanding")).status, "preparing");
  });
}

/** A Stop against a row nobody holds, which still goes through the handshake. */
function registerStopHandshakeCases(harness: () => Harness): void {
  for (const [shape, explicitFat] of [["legacy", false], ["explicitly fat", true]] as const) {
    test(`a Stop on a ${shape} row nobody holds parks it at cancelling`, async () => {
      const h = harness();
      await seedSession(h, "s1");
      await seedRun(h, "stopped", "s1", {
        status: "preparing", dispatch: "fat", leaseOwner: null, messageId: "m-1",
      });
      if (explicitFat) await markFat(h, "stopped");
      await armAttempted(h, "stopped");

      await captureInterruptEvents("s1");
      const row = await runRow(h, "stopped");
      assert.equal(row.status, "cancelling");
      assert.equal(row.failure_reason, null);
      assert.equal(row.completed_at, null);
      assert.deepEqual(await receiptOf(h, "stopped"), {
        version: 1, state: "armed", publish: "attempted",
      }, "the handshake writes no terminal receipt");
    });
  }

  test("cancelling one unheld fat row by name still takes the handshake branch", async () => {
    const h = harness();
    const { cancelTask } = await import("../src/tasks/lifecycle.js");
    await seedSession(h, "s1");
    await seedRun(h, "fat", "s1", {
      status: "preparing", dispatch: "fat", leaseOwner: null, messageId: "m-1",
    });
    await markFat(h, "fat");
    await armAttempted(h, "fat");

    await cancelTask("fat");
    assert.equal((await runRow(h, "fat")).status, "cancelling");
  });
}

/** What a holder's own completion does to the unheld sibling of its turn. */
function registerSiblingClosureCases(harness: () => Harness): void {
  for (const [shape, explicitFat] of [["legacy", false], ["explicitly fat", true]] as const) {
    test(`a holder's own completion leaves its unheld ${shape} sibling open`, async () => {
      const h = harness();
      const { closeChatRun } = await import("../src/tasks/chat-run.js");
      await seedSession(h, "s1", { gateOwner: "m-1" });
      await seedHolderAndSpare(h, explicitFat);

      await closeChatRun("s1", "m-1", "completed", undefined, { taskId: "held" });
      assert.equal((await runRow(h, "held")).status, "completed");
      const spare = await runRow(h, "spare");
      assert.equal(spare.status, "preparing");
      assert.equal(spare.failure_reason, null);
    });
  }

  test("and the gate opens over that sibling, because the release only counts other turns", async () => {
    const h = harness();
    const { closeChatRun } = await import("../src/tasks/chat-run.js");
    const { releaseSessionGateIfLastRun } = await import("../src/events/consumer.js");
    await seedSession(h, "s1", { gateOwner: "m-1" });
    await seedHolderAndSpare(h, true);

    await closeChatRun("s1", "m-1", "completed", undefined, { taskId: "held" });
    // The spare carries the completing turn's own message id, so the release's
    // `IS DISTINCT FROM` exclusion never sees it -- with or without the switch.
    assert.equal(await releaseSessionGateIfLastRun("s1", "m-1", false), true);
    assert.equal((await sessionRow(h, "s1")).agent_status, "idle");
    assert.equal((await runRow(h, "spare")).status, "preparing");
  });
}

/** The three publish outcomes: acknowledgement lost, refused, and raced by a Stop. */
function registerPublishOutcomeCases(harness: () => Harness): void {
  test("a publish whose acknowledgement was lost leaves the row open and armed", async () => {
    const h = harness();
    const { publishCertainlyFailed } = await import("../src/infra/nats.js");
    const { failChatRunDispatch } = await import("../src/tasks/chat-run.js");
    await seedSession(h, "s1");
    await seedRun(h, "amb", "s1", { status: "preparing", dispatch: "fat", messageId: "m-1" });
    await markFat(h, "amb");
    await armAttempted(h, "amb");

    const timeout = Object.assign(new Error("TIMEOUT"), { code: "TIMEOUT" });
    assert.equal(publishCertainlyFailed(timeout), false, "the classification the caller reads");
    assert.equal(await failChatRunDispatch("amb", "TIMEOUT"), "unknown");
    assert.equal((await runRow(h, "amb")).status, "preparing");
    assert.deepEqual(await receiptOf(h, "amb"), {
      version: 1, state: "armed", publish: "attempted",
    });
  });

  test("a publish the server refused still terminalizes the row", async () => {
    const h = harness();
    const { publishCertainlyFailed } = await import("../src/infra/nats.js");
    const { failChatRunDispatch, recordPublishState } = await import("../src/tasks/chat-run.js");
    await seedSession(h, "s1");
    await seedRun(h, "refused", "s1", { status: "preparing", dispatch: "fat", messageId: "m-1" });
    await markFat(h, "refused");
    await armAttempted(h, "refused");

    const err = Object.assign(new Error("no stream matches"), {
      code: "404",
      api_error: { code: 404, err_code: 10060, description: "no stream matches subject" },
    });
    assert.equal(publishCertainlyFailed(err), true);
    await recordPublishState("refused", "refused");

    assert.equal(await failChatRunDispatch("refused", "no stream matches subject"), "closed");
    const row = await runRow(h, "refused");
    assert.equal(row.status, "failed");
    assert.equal(row.failure_reason, "dispatch_failed");
    assert.equal(row.error_message, "no stream matches subject");
    assert.notEqual(row.completed_at, null);
    assert.deepEqual(await receiptOf(h, "refused"), {
      version: 1,
      state: "terminal",
      failure_reason: "dispatch_failed",
      error_message: "no stream matches subject",
    });
  });

  test("and one that raced a Stop into cancelling", async () => {
    const h = harness();
    const { failChatRunDispatch, recordPublishState, SWEEPABLE_RUN_STATUSES } =
      await import("../src/tasks/chat-run.js");
    await seedSession(h, "s1");
    await seedRun(h, "raced", "s1", { status: "preparing", dispatch: "fat", messageId: "m-1" });
    await markFat(h, "raced");
    await armAttempted(h, "raced");
    await h.sql("UPDATE claw_tasks SET status = 'cancelling' WHERE task_id = 'raced'");
    await recordPublishState("raced", "refused");

    // The request path's default status list excludes `cancelling`; the reaper's
    // list is the one that reaches a row a Stop has already moved.
    const verdict = await failChatRunDispatch(
      "raced", "no stream matches subject", "dispatch_failed",
      { statuses: SWEEPABLE_RUN_STATUSES },
    );
    assert.equal(verdict, "closed");
    const row = await runRow(h, "raced");
    assert.equal(row.status, "cancelled");
    assert.equal(row.failure_reason, "cancelled_before_dispatch_confirmed");
    const receipt = await receiptOf(h, "raced");
    assert.equal(receipt?.state, "terminal");
    assert.equal(receipt?.failure_reason, "cancelled_before_dispatch_confirmed");
  });
}

/** The finalizer against a receipt that is already terminal. */
function registerFinalizerReceiptCases(harness: () => Harness): void {
  test("the finalizer adopts an already-terminal receipt with the switch off", async () => {
    const h = harness();
    const { finalizeDispatchCompensations } = await import("../src/tasks/sweeper.js");
    await seedSession(h, "s1");
    await seedRun(h, "t1", "s1", { status: "failed", dispatch: "fat" });
    await h.sql(
      `UPDATE claw_tasks SET failure_reason = 'cancelled', error_message = 'stopped'
        WHERE task_id = 't1'`,
    );
    await h.sql(
      `UPDATE claw_tasks
          SET metadata = metadata || jsonb_build_object('dispatch_compensation', $2::jsonb)
        WHERE task_id = $1`,
      ["t1", JSON.stringify({ version: 1, state: "armed", publish: "refused" })],
    );

    assert.equal(await finalizeDispatchCompensations(), 1);
    assert.deepEqual(await receiptOf(h, "t1"), {
      version: 1, state: "complete", failure_reason: "cancelled", error_message: "stopped",
    });
  });

  test("and the write-free pass still reports a receipt it may not act on", async () => {
    const h = harness();
    const { finalizeDispatchCompensations, auditRefusedCompensations } =
      await import("../src/tasks/sweeper.js");
    await seedSession(h, "s1");
    await seedRun(h, "t1", "s1", { status: "failed", dispatch: "fat" });
    const foreign = { version: 2, state: "armed", publish: "not_attempted" };
    await h.sql(
      `UPDATE claw_tasks
          SET metadata = metadata || jsonb_build_object('dispatch_compensation', $2::jsonb)
        WHERE task_id = $1`,
      ["t1", JSON.stringify(foreign)],
    );
    const before = await runRow(h, "t1");

    assert.equal(await finalizeDispatchCompensations(), 0);
    assert.equal(await auditRefusedCompensations(), 1);
    assert.deepEqual(await runRow(h, "t1"), before);
  });
}

/** Doorbell rows reaching the same passes the fat path does. */
function registerDoorbellRowCases(harness: () => Harness): void {
  test("a leased doorbell row still takes the handshake", async () => {
    const h = harness();
    const { cancelTask } = await import("../src/tasks/lifecycle.js");
    await seedSession(h, "s1");
    await seedRun(h, "bell", "s1", {
      status: "running", dispatch: "doorbell", messageId: "m-1",
      leaseOwner: "brain-a", leaseExpiresInSec: 600, claimCount: 1,
    });

    await cancelTask("bell");
    assert.equal((await runRow(h, "bell")).status, "cancelling");
  });

  test("a requeued doorbell row still terminalizes at once", async () => {
    const h = harness();
    await seedSession(h, "s1");
    await seedRun(h, "requeued", "s1", {
      status: "queued", dispatch: "doorbell", messageId: "m-1", claimCount: 1,
    });

    const events = await captureInterruptEvents("s1");
    const row = await runRow(h, "requeued");
    assert.equal(row.status, "cancelled");
    assert.equal(row.failure_reason, "cancelled");
    assert.equal(row.error_message, "interrupted before a worker claimed the run");
    assert.deepEqual(
      events.map((e) => e.type),
      ["AssistantMessage", "ResultMessage", "exec_complete"],
    );
    for (const event of events) {
      assert.equal(event.task_id, "requeued", `${event.type as string} names no row`);
    }
  });

  test("a doorbell spare is still closed by the sibling pass", async () => {
    const h = harness();
    const { reapLostLeases } = await import("../src/tasks/sweeper.js");
    await seedSession(h, "s1");
    // The reaped row is fat: a live doorbell row is handed to the requeue pass
    // instead, so it never reaches the sibling closer at all.
    await seedRun(h, "lost", "s1", {
      status: "running", dispatch: "fat", messageId: "m-1",
      leaseOwner: "brain-a", leaseExpiresInSec: -100_000, claimCount: 1,
    });
    await seedRun(h, "spare", "s1", {
      status: "queued", dispatch: "doorbell", messageId: "m-1", leaseOwner: null, claimCount: 0,
    });

    await withSettlement(null, async () => { await reapLostLeases(); });
    assert.equal((await runRow(h, "lost")).failure_reason, "worker_lost");
    const spare = await runRow(h, "spare");
    assert.equal(spare.status, "failed");
    assert.equal(spare.failure_reason, "dispatch_retried");
    assert.notEqual(spare.completed_at, null);
  });

  test("and a doorbell spare is still closed by a holder's completion", async () => {
    const h = harness();
    const { closeChatRun } = await import("../src/tasks/chat-run.js");
    await seedSession(h, "s1");
    await seedRun(h, "held", "s1", {
      status: "running", dispatch: "doorbell", messageId: "m-1",
      leaseOwner: "brain-a", leaseExpiresInSec: 600, claimCount: 1,
    });
    await seedRun(h, "spare", "s1", {
      status: "queued", dispatch: "doorbell", messageId: "m-1", leaseOwner: null, claimCount: 0,
    });

    await closeChatRun("s1", "m-1", "completed", undefined, { taskId: "held" });
    assert.equal((await runRow(h, "spare")).failure_reason, "duplicate_dispatch_row");
  });
}

export function registerReconcileOffCases(harness: () => Harness): void {
  registerOrphanReapCases(harness);
  registerStopHandshakeCases(harness);
  registerSiblingClosureCases(harness);
  registerPublishOutcomeCases(harness);
  registerFinalizerReceiptCases(harness);
  registerDoorbellRowCases(harness);
}
