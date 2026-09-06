// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The message parked behind a turn that never started.
 *
 * `dispatchPendingMessage` is reached from one place, the completion consumer,
 * and only when that completion opened the gate. A dispatch that fails before
 * execution emits no completion, so the queue behind it has no trigger left --
 * and the two compensation verdicts leave very different states for the repair
 * to read. `closed` is settled: the row is terminal, the caller rolled the gate
 * back, and the parked message is owed a dispatch. `unknown` is not settled at
 * all, and draining on it starts a second turn on a session whose first one may
 * still be about to run.
 *
 * Exactly once is the other half. The repair runs every tick, so a drain that
 * did not consume its row would replay the same message for as long as the row
 * is there.
 */

import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  startHarness, seedSession, runRow, sessionRow, type Harness,
} from "./scenario-harness.js";
import { closedDoorbellBarrier } from "./doorbell-barrier-stub.js";

let h: Harness;
before(async () => { h = await startHarness(); });
beforeEach(async () => { await h.reset(); });
after(async () => { await h?.close(); });

const SESSION = "s1";
const TURN = "m-1";

/** The server answered, so the publish certainly failed. */
function refusal(): Error {
  return Object.assign(new Error("no responders"), { code: "503" });
}

/** No answer at all: the message may be on the stream with only its ack lost. */
function timeout(): Error {
  return Object.assign(new Error("TIMEOUT"), { code: "TIMEOUT" });
}

async function seedTurnWithMessageBehindIt(): Promise<void> {
  await seedSession(h, SESSION, { gateOwner: TURN });
  await h.sql(
    "INSERT INTO claw_pending_messages (session_id, user_id, content) VALUES ($1, $2, $3)",
    [SESSION, "u-1", "the message behind this turn"],
  );
}

/**
 * Drive the real dispatch to the point where its publish fails.
 *
 * `stampRow` runs against the row the dispatch just opened, which is how a
 * receipt this replica cannot read gets onto it -- the state that makes the
 * compensation answer `unknown` rather than guess.
 */
async function dispatchAndFail(
  err: Error,
  stampRow?: (taskId: string) => Promise<void>,
): Promise<{ kind: string }> {
  const { dispatchTaskToBrain, sessionDispatchPorts } = await import("../src/sessions/dispatch.js");
  const { releaseSessionGateForTurn } = await import("../src/tasks/chat-run.js");
  const original = { ...sessionDispatchPorts };
  const realOpen = sessionDispatchPorts.openChatRun;
  sessionDispatchPorts.doorbellDispatch = closedDoorbellBarrier;
  sessionDispatchPorts.publishSse = () => {};
  sessionDispatchPorts.publishTask = async () => { throw err; };
  sessionDispatchPorts.openChatRun = async (args) => {
    const run = await realOpen(args);
    if (run && stampRow) await stampRow(run.taskId);
    return run;
  };
  try {
    return await dispatchTaskToBrain(
      {
        sessionId: SESSION, userId: "u-1", user: null, content: "hello", messageType: "text",
        toolIds: [], pluginId: undefined, requestImage: undefined, requestResource: undefined,
        requestTimeout: undefined, workspaceId: undefined, mcpServers: undefined,
        capturedUserEnvSnapshot: {}, capturedSessionEnv: {}, messageId: TURN,
      },
      // What POST /v1/sessions/:id/messages supplies as its rollback.
      async () => { await releaseSessionGateForTurn(SESSION, TURN); },
    );
  } finally {
    Object.assign(sessionDispatchPorts, original);
  }
}

/**
 * Run the repair with a drain that consumes its row, as the real one does.
 *
 * A stub that only counts cannot tell a drain that happened once from one that
 * happens on every tick for ever.
 */
async function sweepRepair(): Promise<string[]> {
  const { drainOrphanedPendingMessages, sweeperPorts } = await import("../src/tasks/sweeper.js");
  const drained: string[] = [];
  const original = sweeperPorts.drainPendingMessage;
  sweeperPorts.drainPendingMessage = async (sessionId: string) => {
    drained.push(sessionId);
    await h.sql(
      `DELETE FROM claw_pending_messages WHERE id = (
         SELECT id FROM claw_pending_messages WHERE session_id = $1 ORDER BY created_at LIMIT 1
       )`,
      [sessionId],
    );
  };
  try {
    await drainOrphanedPendingMessages();
  } finally {
    sweeperPorts.drainPendingMessage = original;
  }
  return drained;
}

async function openRunId(): Promise<string> {
  const rows = await h.sql("SELECT task_id FROM claw_tasks WHERE session_id = $1", [SESSION]);
  assert.equal(rows.length, 1, "the dispatch opened exactly one row");
  return rows[0].task_id as string;
}

async function parkedCount(): Promise<number> {
  return Number((await h.sql(
    "SELECT count(*)::int AS n FROM claw_pending_messages WHERE session_id = $1", [SESSION],
  ))[0].n);
}

test("a closed compensation hands the queue to the repair, which drains it once", async () => {
  await seedTurnWithMessageBehindIt();

  const result = await dispatchAndFail(refusal());
  assert.equal(result.kind, "publish_failed");
  assert.equal((await runRow(h, await openRunId())).status, "failed");
  assert.equal((await sessionRow(h, SESSION)).agent_status, "idle", "the rollback ran");

  assert.deepEqual(await sweepRepair(), [SESSION]);
  assert.equal(await parkedCount(), 0);
  assert.deepEqual(await sweepRepair(), [], "and the next tick finds nothing left to start");
});

test("an unknown compensation leaves the queue alone for as long as the row is open", async () => {
  await seedTurnWithMessageBehindIt();

  const result = await dispatchAndFail(timeout(), async (taskId) => {
    // A receipt written by a replica this one is older than. Nothing about the
    // row can be established from here, which is what `unknown` means.
    await h.sql(
      `UPDATE claw_tasks
          SET metadata = jsonb_set(metadata, '{dispatch_compensation}', '{"version":2}'::jsonb)
        WHERE task_id = $1`,
      [taskId],
    );
  });

  assert.equal(result.kind, "publish_unknown");
  const taskId = await openRunId();
  assert.equal((await runRow(h, taskId)).status, "preparing", "nothing settled it");
  assert.equal(
    (await sessionRow(h, SESSION)).agent_status, "running",
    "and no rollback ran, because the row may still execute",
  );

  assert.deepEqual(await sweepRepair(), [], "the repair must not start a second turn on it");
  assert.deepEqual(await sweepRepair(), [], "on this tick or any later one");
  assert.equal(await parkedCount(), 1);

  // Reconciliation is what eventually reaches a verdict; only then is the
  // message the repair's to start.
  await h.sql(
    `UPDATE claw_tasks SET status = 'failed', failure_reason = 'dispatch_failed',
            completed_at = NOW()
      WHERE task_id = $1`,
    [taskId],
  );
  await h.sql(
    `UPDATE claw_sessions SET agent_status = 'idle', agent_gate_message_id = NULL
      WHERE session_id = $1`,
    [SESSION],
  );

  assert.deepEqual(await sweepRepair(), [SESSION]);
  assert.deepEqual(await sweepRepair(), [], "exactly once, however many ticks follow");
});
