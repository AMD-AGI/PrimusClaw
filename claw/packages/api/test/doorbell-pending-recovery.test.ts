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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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

test("a message parked behind a failed turn is drained too, not only an idle one", async () => {
  // The backstop used to look only at `idle`, while the consumer it backs up
  // drains on a failed completion as well -- `releaseSessionGateIfLastRun`
  // writes `failed` and still reports the gate open. So the queue behind
  // exactly the completions most likely to need recovery was the queue it
  // could not reach. One way in: a refusal publishes its completion but its
  // queue row survives; that completion drains the row again, the second
  // refusal's completion is discarded as a duplicate, and the session is left
  // `failed` with everything behind it waiting on an event already spent.
  await h.reset();
  await seedTurnWithMessageBehindIt();
  await h.sql(
    "UPDATE claw_sessions SET agent_status = 'failed', agent_gate_message_id = NULL WHERE session_id = $1",
    [SESSION],
  );

  assert.deepEqual(await sweepRepair(), [SESSION], "the parked message is picked up");
});

test("but not while that session still has a turn of its own running", async () => {
  // What actually holds the queue shut here is the occupancy test -- the live
  // chat row -- not the status list: widening the list to include `running`
  // leaves this green, because the NOT EXISTS still excludes the session. That
  // is the guard worth pinning, since it is the one standing between a
  // backstop and a second turn stacked onto a live one. The status list is
  // pinned by the case above, which goes red the moment `failed` leaves it.
  await h.reset();
  await seedTurnWithMessageBehindIt();
  await h.sql(
    "UPDATE claw_sessions SET agent_status = 'failed', agent_gate_message_id = NULL WHERE session_id = $1",
    [SESSION],
  );
  await h.sql(
    `INSERT INTO claw_tasks (task_id, session_id, name, origin, executor, mode, status, metadata)
     VALUES ('ktsk-live-behind', $1, 'chat', 'chat', 'brain', 'llm', 'running',
             jsonb_build_object('message_id','m-live'))`,
    [SESSION],
  );

  assert.deepEqual(await sweepRepair(), [], "a live turn still holds the queue shut");
});

test("a session acquired between the sweep's read and its dispatch is skipped", () => {
  // The SELECT is a snapshot of a batch; a send can take any of those sessions
  // before the loop reaches it. Asked again immediately before dispatching, so
  // the window is one statement rather than the whole batch.
  //
  // Pinned on the statement because the race needs two transactions interleaved
  // at a point this harness cannot hold open. What is asserted is that the
  // question is asked at all, and that it asks about occupancy rather than
  // only about status -- a status test alone would still admit a session whose
  // run had just been opened.
  const src = readFileSync(
    fileURLToPath(new URL("../src/tasks/sweeper.ts", import.meta.url)), "utf8",
  );
  const fn = src.slice(src.indexOf("export async function drainOrphanedPendingMessages"));
  const body = fn.slice(0, fn.indexOf("\nexport "));
  const recheck = body.slice(body.indexOf("drained = 0"));
  assert.match(recheck, /SELECT 1 FROM claw_sessions/, "eligibility is re-read in the loop");
  assert.match(recheck, /NOT EXISTS\s*\(\s*SELECT 1 FROM claw_tasks/, "and it asks about occupancy");
  assert.ok(
    recheck.indexOf("stillFree") < recheck.indexOf("drainPendingMessage"),
    "the question comes before the dispatch it gates",
  );
  // And the comment states the limit rather than a bound that is not there. An
  // earlier version cited the admission lock as serialising creation; that lock
  // is skipped when every ceiling is zero, which is the default, so it
  // serialises nothing on a default deployment.
  //
  // Asserted as what the comment now says, not as what it must not say: the
  // correction quotes the claim it is correcting, and a pattern looking for the
  // claim cannot tell the two apart.
  assert.match(
    recheck, /skipped when every ceiling is zero/,
    "the residual window is described as open, with the reason the old bound did not hold",
  );
});
