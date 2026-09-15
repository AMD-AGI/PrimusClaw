// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a fat row records about its own publish, and what the sweeper may
 * conclude from it.
 *
 * The receipt is the only durable answer to "can a message for this row
 * exist?", and it outlives the process that published. Left permanently at
 * `not_attempted` it is a standing lie: the shared guard reads that state as
 * proof no message exists, so a publish that actually reached the stream could
 * be terminalized and its session rolled back underneath a Brain about to run
 * it. These pin the transitions and the two settlement forms that depend on
 * them.
 *
 * Deliberately run with the fleet assertion OFF: it is one of the guard's
 * evidence arms, so with it on every row is eligible and the receipt proves
 * nothing. What is under test here is the other two arms.
 */

import "./reconcile-off-env.js";

import { closedDoorbellBarrier } from "./doorbell-barrier-stub.js";
import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  startHarness, seedSession, seedRun, runRow, type Harness,
} from "./scenario-harness.js";

let h: Harness;
before(async () => { h = await startHarness(); });
beforeEach(async () => { await h.reset(); });
after(async () => { await h?.close(); });

async function receipt(taskId: string): Promise<Record<string, unknown>> {
  return (await runRow(h, taskId)).metadata as Record<string, unknown>;
}

async function seedFat(taskId: string, publish: string): Promise<void> {
  await seedRun(h, taskId, "s1", { status: "preparing", dispatch: "fat", startedAgoSec: 99_999 });
  await h.sql(
    `UPDATE claw_tasks
        SET metadata = metadata || jsonb_build_object(
              'dispatch_compensation',
              jsonb_build_object('version', 1, 'state', 'armed', 'publish', $2::text))
      WHERE task_id = $1`,
    [taskId, publish],
  );
}

test("a publish that is about to be attempted says so before it is made", async () => {
  const { recordPublishState } = await import("../src/tasks/chat-run.js");
  await seedSession(h, "s1");
  await seedFat("t1", "not_attempted");

  await recordPublishState("t1", "attempted");
  assert.deepEqual((await receipt("t1")).dispatch_compensation, {
    version: 1, state: "armed", publish: "attempted",
  });
});

test("a definite non-delivery is a durable row fact, not a process-local one", async () => {
  const { recordPublishState } = await import("../src/tasks/chat-run.js");
  await seedSession(h, "s1");
  await seedFat("t1", "attempted");

  await recordPublishState("t1", "refused");
  assert.equal(
    ((await receipt("t1")).dispatch_compensation as { publish?: string }).publish, "refused",
  );
});

test("a receipt a holder disarmed is not resurrected, and the writer is told", async () => {
  const { recordPublishState } = await import("../src/tasks/chat-run.js");
  await seedSession(h, "s1");
  await seedRun(h, "t1", "s1", { status: "running", dispatch: "fat" });

  await assert.rejects(
    recordPublishState("t1", "attempted"),
    "a caller about to publish must learn its receipt did not take",
  );
  assert.equal(
    (await receipt("t1")).dispatch_compensation, undefined,
    "a row with no armed receipt has a holder, and a publish write must not give it one",
  );
});

test("the row records which stream message carries it", async () => {
  const { recordDispatchSeq } = await import("../src/tasks/chat-run.js");
  await seedSession(h, "s1");
  await seedFat("t1", "attempted");

  await recordDispatchSeq("t1", 4242);
  assert.equal(Number((await receipt("t1")).dispatch_seq), 4242);
  await recordDispatchSeq("t1", 0);
  assert.equal(
    Number((await receipt("t1")).dispatch_seq), 4242,
    "a sequence the publisher never learned leaves the recorded one alone",
  );
});

test("an attempted publish is not reaped while its own message is still outstanding", async () => {
  // The whole point of the receipt: `attempted` is the one ambiguous state, and
  // the row must survive it until the durable says otherwise.
  const { reapOrphanedFatRuns, sweeperPorts } = await import("../src/tasks/sweeper.js");
  const original = sweeperPorts.deliverySettlement;

  await seedSession(h, "s1");
  await seedFat("t1", "attempted");
  await h.sql(
    "UPDATE claw_tasks SET metadata = metadata || '{\"dispatch_seq\":\"90\"}'::jsonb WHERE task_id = 't1'",
  );

  sweeperPorts.deliverySettlement = async () => ({ ackFloor: 50, lastSeq: 200 });
  try {
    assert.equal(await reapOrphanedFatRuns(), 0);
    assert.equal((await runRow(h, "t1")).status, "preparing");

    sweeperPorts.deliverySettlement = async () => ({ ackFloor: 120, lastSeq: 200 });
    assert.equal(await reapOrphanedFatRuns(), 1, "its own message has been settled");
    assert.equal((await runRow(h, "t1")).status, "failed");
  } finally {
    sweeperPorts.deliverySettlement = original;
  }
});

test("a publish that never began is reapable from row state alone", async () => {
  // `not_attempted` and `refused` both prove no message exists, so neither
  // needs the durable to be readable at all.
  const { reapOrphanedFatRuns, sweeperPorts } = await import("../src/tasks/sweeper.js");
  const original = sweeperPorts.deliverySettlement;
  sweeperPorts.deliverySettlement = async () => null;
  try {
    await seedSession(h, "s1");
    await seedFat("t1", "not_attempted");
    await seedFat("t2", "refused");
    await seedFat("t3", "attempted");

    assert.equal(await reapOrphanedFatRuns(), 2);
    assert.equal((await runRow(h, "t1")).status, "failed");
    assert.equal((await runRow(h, "t2")).status, "failed");
    assert.equal(
      (await runRow(h, "t3")).status, "preparing",
      "an ambiguous publish with an unreadable durable stays open",
    );
  } finally {
    sweeperPorts.deliverySettlement = original;
  }
});

test("a fat dispatch records the sequence its own publish returned, so the settled delivery behind it can be closed", async () => {
  // The consumer cases above hand the row a sequence by hand. This one is the
  // producer: the number has to come off the publish itself, because a row that
  // records nothing is answerable only on the whole stream -- and a run whose
  // message was delivered, acked and then abandoned by its worker sits at
  // `preparing` for ever while the user's turn never finishes.
  const { dispatchTaskToBrain, sessionDispatchPorts } = await import("../src/sessions/dispatch.js");
  const { reapOrphanedFatRuns, sweeperPorts } = await import("../src/tasks/sweeper.js");
  const originalPorts = { ...sessionDispatchPorts };
  const originalSettlement = sweeperPorts.deliverySettlement;

  await seedSession(h, "s1", { gateOwner: "m-1" });
  sessionDispatchPorts.doorbellDispatch = closedDoorbellBarrier;
  sessionDispatchPorts.publishSse = () => {};
  sessionDispatchPorts.publishTask = async () => 90;

  let taskId: string;
  try {
    const dispatched = await dispatchTaskToBrain(
      {
        sessionId: "s1", userId: "u-1", user: null, content: "hello", messageType: "text",
        toolIds: [], pluginId: undefined, requestImage: undefined, requestResource: undefined,
        requestTimeout: undefined, workspaceId: undefined, mcpServers: undefined,
        capturedUserEnvSnapshot: {}, capturedSessionEnv: {}, messageId: "m-1",
      },
      async () => { throw new Error("a dispatched turn must not roll back"); },
    );
    assert.equal(dispatched.kind, "dispatched");
    taskId = dispatched.kind === "dispatched" ? dispatched.runId! : "";
  } finally {
    Object.assign(sessionDispatchPorts, originalPorts);
  }

  // Old enough for the orphan scan to consider it at all; nothing else about
  // the row changes.
  await h.sql(
    "UPDATE claw_tasks SET started_at = NOW() - INTERVAL '99999 seconds' WHERE task_id = $1",
    [taskId],
  );
  try {
    sweeperPorts.deliverySettlement = async () => ({ ackFloor: 50, lastSeq: 200 });
    assert.equal(await reapOrphanedFatRuns(), 0, "its own message is still outstanding");
    assert.equal((await runRow(h, taskId)).status, "preparing");

    sweeperPorts.deliverySettlement = async () => ({ ackFloor: 150, lastSeq: 200 });
    assert.equal(
      await reapOrphanedFatRuns(), 1,
      "the durable settled this row's own message, so the abandoned turn is closed",
    );
    assert.equal((await runRow(h, taskId)).status, "failed");
  } finally {
    sweeperPorts.deliverySettlement = originalSettlement;
  }

  assert.equal(
    Number((await receipt(taskId)).dispatch_seq), 90,
    "and the number it was answered on is the one the publisher returned",
  );
});
