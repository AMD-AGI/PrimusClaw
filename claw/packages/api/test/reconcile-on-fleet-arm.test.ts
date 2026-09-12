// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the fleet assertion is, once it is asserted.
 *
 * `RUN_FAT_PREPARING_RECONCILE` is not a switch over one sweeper pass. It is
 * the first arm of the shared no-delivery guard:
 *
 *     $fleet OR $settled OR receipt IN ('not_attempted','refused') OR not-fat
 *
 * so asserting it does not adjust the other arms, it makes them irrelevant --
 * every unheld fat row is eligible on the assertion alone, whatever its receipt
 * says and whether or not the durable can be read at all. That is the whole
 * content of the deployment's promise: every Brain able to receive
 * `tasks.execute` takes a durable SQL holder before its execution gate, so a
 * fat row with no holder has no worker, and nothing is owed to a message that
 * cannot be about to run.
 *
 * The suites that pin the other two arms say in their own headers that they run
 * with this off, because with it on the arm they are about cannot be observed.
 * This is the mirror they are the mirror of, and it had no test: the arm that
 * decides every reap once the flip lands was the one arm nothing watched.
 *
 * The boundary case matters more than the enabling ones. The assertion is about
 * rows with no holder; a held row is somebody's, and no promise about Brains
 * taking leases can make it safe to close one.
 */

import "./reconcile-on-env.js";

import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { startHarness, seedSession, seedRun, runRow, type Harness } from "./scenario-harness.js";

let h: Harness;
before(async () => { h = await startHarness(); });
beforeEach(async () => { await h.reset(); });
after(async () => { await h?.close(); });

/** An unheld fat row with a stated receipt, `startedAgoSec` past the timeout by default. */
async function seedFat(taskId: string, publish: string, startedAgoSec = 99_999): Promise<void> {
  await seedRun(h, taskId, "s1", { status: "preparing", dispatch: "fat", startedAgoSec });
  await h.sql(
    `UPDATE claw_tasks
        SET metadata = metadata || jsonb_build_object(
              'dispatch_compensation',
              jsonb_build_object('version', 1, 'state', 'armed', 'publish', $2::text))
      WHERE task_id = $1`,
    [taskId, publish],
  );
}

test("the process under test has asserted the contract, which is what the cases below turn on", async () => {
  const { RUN_FAT_PREPARING_RECONCILE } = await import("../src/config.js");
  const { gateOwnershipEnforced } = await import("../src/tasks/chat-run.js");

  assert.equal(RUN_FAT_PREPARING_RECONCILE, true);
  assert.equal(gateOwnershipEnforced(), true);
});

test("an ambiguous receipt no longer holds a row open, because the fleet has answered for it", async () => {
  // The exact case doorbell-publish-receipt.test.ts pins the other way with the
  // assertion off: there an `attempted` publish and an unreadable durable leave
  // the row at `preparing`, because neither remaining arm can say the message
  // does not exist. Here the first arm says it for them.
  const { reapOrphanedFatRuns, sweeperPorts } = await import("../src/tasks/sweeper.js");
  const original = sweeperPorts.deliverySettlement;
  sweeperPorts.deliverySettlement = async () => null;
  try {
    await seedSession(h, "s1");
    await seedFat("t1", "attempted");

    assert.equal(await reapOrphanedFatRuns(), 1, "the assertion is sufficient on its own");
    assert.equal((await runRow(h, "t1")).status, "failed");
  } finally {
    sweeperPorts.deliverySettlement = original;
  }
});

test("nor does a message the durable has not settled yet", async () => {
  // The other arm, refuted the same way: the row's own sequence sits above the
  // ack floor, which with the assertion off is the reason it survives a sweep.
  const { reapOrphanedFatRuns, sweeperPorts } = await import("../src/tasks/sweeper.js");
  const original = sweeperPorts.deliverySettlement;
  sweeperPorts.deliverySettlement = async () => ({ ackFloor: 50, lastSeq: 200 });
  try {
    await seedSession(h, "s1");
    await seedFat("t1", "attempted");
    await h.sql(
      "UPDATE claw_tasks SET metadata = metadata || '{\"dispatch_seq\":\"90\"}'::jsonb WHERE task_id = 't1'",
    );

    assert.equal(await reapOrphanedFatRuns(), 1);
    assert.equal((await runRow(h, "t1")).status, "failed");
  } finally {
    sweeperPorts.deliverySettlement = original;
  }
});

test("but a row a worker holds is nobody's to close, assertion or not", async () => {
  // The boundary, and the one that must not move with the flip. The promise is
  // about rows with no holder. A leased row has a worker by the same evidence
  // the assertion trusts, and reaping it would close a run that is executing --
  // the failure the flag's own documentation warns a premature flip produces.
  const { reapOrphanedFatRuns, sweeperPorts } = await import("../src/tasks/sweeper.js");
  const original = sweeperPorts.deliverySettlement;
  sweeperPorts.deliverySettlement = async () => null;
  try {
    await seedSession(h, "s1");
    await seedRun(h, "held", "s1", {
      status: "running", dispatch: "fat", startedAgoSec: 99_999,
      leaseOwner: "brain-a", leaseExpiresInSec: 600, claimCount: 1,
    });

    assert.equal(await reapOrphanedFatRuns(), 0, "a held row is not an orphan");
    assert.equal((await runRow(h, "held")).status, "running");
  } finally {
    sweeperPorts.deliverySettlement = original;
  }
});

// Not here: a case for the first-lease budget bound. One was written -- two
// rows from the same helper differing only in age -- and it passed with the
// `started_at < NOW() - BRAIN_TASK_TIMEOUT_SEC` clause deleted, so whatever
// keeps a young row alive is not that clause and the case would have been
// pinning something unnamed. The bound is still worth a test; it needs the
// actual excluding condition identified first.
