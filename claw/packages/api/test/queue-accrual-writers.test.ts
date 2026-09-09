// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Every call site that writes `claw_tasks.status`, driven where it really runs.
 *
 * 04b §7 says the queued accrual is exactly as complete as this list: one
 * function contributes it to every status change, and a caller issuing its own
 * UPDATE does not merely bypass a helper -- it silently drops that run's whole
 * queued segment, or leaves a stale `queued_at` for the next exit to bank hours
 * of wait that never happened. Neither shows on the row afterwards.
 *
 * A source-level guard (status-writer-guard.test.ts) proves no other file
 * contains the statement. This proves the writers that do reach it behave, and
 * it drives each one through its production entry point rather than through the
 * shared function underneath -- a table over the function itself would pass for
 * a call site that no longer calls it.
 *
 * Three shapes, because a writer relates to the queue in one of three ways:
 * it takes a row off the queue, it puts one on, or it moves a row that was
 * never on it and must leave what the row has already banked alone.
 */
import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { TASK_POISON_DELIVERY_COUNT } from "../src/config.js";
import { applyTaskStatusTransition } from "../src/tasks/db.js";
import { dispatchTask } from "../src/tasks/dispatcher.js";
import { applyAgentDone, cancelTask } from "../src/tasks/lifecycle.js";
import { claimRunById, failHeldClaim, releaseClaim } from "../src/tasks/run-claim.js";
import { cascadeFailures, promoteReadyTasks } from "../src/tasks/scheduler.js";
import { commitSessionDeletion } from "../src/sessions/teardown.js";
import {
  closeChatRun, failChatRunDispatch, interruptUnstartedChatRuns, markChatRunRunning,
} from "../src/tasks/chat-run.js";
import {
  reapExpiredDoorbellRuns, reapExpiredQueuedRuns, reapLostLeases, reapStaleTasks,
  reapStuckDagRoots, reapWaitExternal, requeueLostDoorbellLeases,
} from "../src/tasks/sweeper.js";
import { RUN_BUDGET_BACKSTOP_GRACE_SEC, RUN_QUEUE_MAX_SEC } from "../src/tasks/run-budget.js";
import { startHarness, seedRun, seedSession, runRow, type Harness } from "./scenario-harness.js";

const SESSION = "s-writers";
const BRAIN = "brain-1";
const WAITED_SEC = 3;

let h: Harness;

before(async () => { h = await startHarness(); });
after(async () => { await h.close(); });
beforeEach(async () => { await h.reset(); await seedSession(h, SESSION); });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One §7 call site, and what the row must look like for it to act. */
interface Writer {
  name: string;
  seed?: Partial<Parameters<typeof seedRun>[3]>;
  /** Rows and edges this writer needs beside the one under test. */
  arrange?: (taskId: string) => Promise<void>;
  run: (taskId: string) => Promise<unknown>;
  status: string;
  failureReason?: string;
}

/** A second row in the same DAG, in whatever state the writer needs it. */
async function seedPeer(
  taskId: string, opts: { status: string; dagRoot: string; node: string; agoSec?: number },
): Promise<void> {
  await seedRun(h, taskId, SESSION, { status: opts.status, queuedAgoSec: null });
  await h.sql(
    `UPDATE claw_tasks
        SET dag_root_task_id = $2, dag_node_id = $3, dag_id = 'dag-1',
            created_at = NOW() - ($4::int * INTERVAL '1 second'),
            completed_at = CASE WHEN status IN ('failed','completed','cancelled')
                                THEN NOW() ELSE completed_at END
      WHERE task_id = $1`,
    [taskId, opts.dagRoot, opts.node, opts.agoSec ?? 0],
  );
}

const edge = (from: string, to: string, root: string) => h.sql(
  `INSERT INTO claw_task_edges (dag_root_task_id, from_task_id, to_task_id) VALUES ($1, $2, $3)`,
  [root, from, to]);

const idOf = (name: string) => `ktsk-${name.replace(/\W+/g, "-").slice(0, 40)}`;

async function drive(w: Writer, seed: Partial<Parameters<typeof seedRun>[3]>): Promise<string> {
  const taskId = idOf(w.name);
  await seedRun(h, taskId, SESSION, { ...seed, ...w.seed });
  await w.arrange?.(taskId);
  await w.run(taskId);
  const row = await runRow(h, taskId);
  assert.equal(row.status, w.status, `${w.name}: the writer under test did not move the row`);
  if (w.failureReason) {
    assert.equal(row.failure_reason, w.failureReason,
      `${w.name}: another writer reached the row first, so this one is untested`);
  }
  return taskId;
}

/** Writers that take a row off the queue: each must bank the segment it ends. */
function exitWriters(): Writer[] {
  return [
    {
      name: "dispatchTask (the dispatch CAS)",
      // The real dispatcher, not the shared transition it calls: a chat row is
      // CAS'd into preparing and then put straight back, which is exactly the
      // pair of transitions the scheduler performs on one.
      seed: { leaseOwner: null },
      run: (id) => dispatchTask(id),
      status: "queued",
    },
    {
      name: "applyAgentDone",
      run: (id) => applyAgentDone(id, { task_id: id, abort_reason: "completed" }),
      status: "completed",
    },
    { name: "cancelTask", run: (id) => cancelTask(id), status: "cancelled" },
    {
      name: "cancelTask (the DAG-root branch)",
      seed: { leaseOwner: null },
      arrange: (id) => h.sql(
        `UPDATE claw_tasks SET dag_node_id='__dag_root__', dag_root_task_id=$1 WHERE task_id=$1`,
        [id]),
      run: (id) => cancelTask(id),
      status: "cancelled",
    },
    {
      name: "takeClaim",
      seed: { claimable: true, leaseOwner: null },
      run: (id) => claimRunById(id, BRAIN),
      status: "preparing",
    },
    {
      // Reached only from `preparing`, because `takeClaim` moves the row first;
      // the exit off the queue is the pair, and the failure reason is what says
      // this writer is the one that closed it.
      name: "markUnclaimable",
      seed: { leaseOwner: null },
      run: (id) => claimRunById(id, BRAIN),
      status: "failed",
      failureReason: "unclaimable",
    },
    {
      name: "failHeldClaim",
      seed: { claimCount: 1 },
      run: (id) => failHeldClaim(id, BRAIN, "claim_abandoned", 1),
      status: "failed",
      failureReason: "claim_abandoned",
    },
    {
      name: "failExhaustedClaim",
      seed: { claimable: true, leaseOwner: null, claimCount: TASK_POISON_DELIVERY_COUNT - 1 },
      run: (id) => claimRunById(id, BRAIN),
      status: "failed",
      failureReason: "max_retries_exceeded",
    },
    {
      name: "releaseClaim (the queued to queued case)",
      run: (id) => releaseClaim(id, BRAIN, undefined, "retry"),
      status: "queued",
    },
    {
      name: "closeChatRun",
      run: (id) => closeChatRun(SESSION, `msg-${id}`, "completed"),
      status: "completed",
    },
    {
      name: "failChatRunDispatch",
      seed: { leaseOwner: null },
      run: (id) => failChatRunDispatch(id, "the wakeup could not be published"),
      status: "failed",
      failureReason: "dispatch_failed",
    },
    {
      name: "interruptUnstartedChatRuns",
      run: () => interruptUnstartedChatRuns(SESSION),
      status: "cancelled",
    },
  ];
}

/** The sweeper and DAG halves of the same list, kept apart by size alone. */
function reaperExitWriters(): Writer[] {
  return [
    {
      name: "reapStuckDagRoots (the child cascade)",
      arrange: async (id) => {
        await seedPeer("ktsk-dagroot", {
          status: "running", dagRoot: "ktsk-dagroot", node: "__dag_root__", agoSec: 2 * 60 * 60,
        });
        await seedPeer("ktsk-dagchild-failed", {
          status: "failed", dagRoot: "ktsk-dagroot", node: "n-failed",
        });
        await h.sql(
          `UPDATE claw_tasks SET dag_root_task_id='ktsk-dagroot', dag_node_id='n-queued'
            WHERE task_id=$1`, [id]);
      },
      run: () => reapStuckDagRoots(),
      status: "failed",
      failureReason: "deps_failed",
    },
    {
      name: "reapExpiredQueuedRuns",
      seed: { queuedAgoSec: RUN_QUEUE_MAX_SEC + 5 },
      run: () => reapExpiredQueuedRuns(),
      status: "failed",
      failureReason: "queue_timeout",
    },
    {
      name: "reapExpiredDoorbellRuns",
      seed: { leaseOwner: null, deadlineInSec: -(RUN_BUDGET_BACKSTOP_GRACE_SEC + 60) },
      run: () => reapExpiredDoorbellRuns(),
      status: "failed",
      failureReason: "run_budget_exhausted",
    },
    {
      // The spare row a retried dispatch opened: never claimed, no lease, and
      // paired to the reaped row by session and message id together.
      name: "closeUnclaimedDispatchSiblings",
      seed: { leaseOwner: null, messageId: "msg-sibling" },
      arrange: () => seedRun(h, "ktsk-lostlease", SESSION, {
        status: "running", dispatch: "fat", messageId: "msg-sibling",
        leaseOwner: BRAIN, leaseExpiresInSec: -3_600, queuedAgoSec: null,
      }),
      run: () => reapLostLeases(),
      status: "failed",
      failureReason: "dispatch_retried",
    },
    {
      name: "cascadeFailures",
      arrange: async (id) => {
        await seedPeer("ktsk-upstream-failed", {
          status: "failed", dagRoot: "ktsk-upstream-failed", node: "n-up",
        });
        await edge("ktsk-upstream-failed", id, "ktsk-upstream-failed");
      },
      run: () => cascadeFailures(),
      status: "failed",
      failureReason: "deps_failed",
    },
    {
      name: "cancelTask's downstream cascade",
      arrange: async (id) => {
        await seedPeer("ktsk-upstream-live", {
          status: "queued", dagRoot: "ktsk-upstream-live", node: "n-up-live",
        });
        await edge("ktsk-upstream-live", id, "ktsk-upstream-live");
      },
      run: () => cancelTask("ktsk-upstream-live"),
      status: "cancelled",
    },
    {
      name: "commitSessionDeletion",
      run: () => commitSessionDeletion(SESSION),
      status: "cancelled",
      failureReason: "session_deleted",
    },
  ];
}

/** Writers that put a row back on the queue: each must reopen the segment. */
function entryWriters(): Writer[] {
  return [
    {
      name: "promoteReadyTasks",
      seed: { status: "waiting_deps", leaseOwner: null },
      run: () => promoteReadyTasks(),
      status: "queued",
    },
    {
      name: "requeueLostDoorbellLeases",
      seed: { status: "running", leaseOwner: BRAIN, leaseExpiresInSec: -3_600 },
      run: () => requeueLostDoorbellLeases(),
      status: "queued",
    },
  ];
}

/**
 * Writers that move a row the queue never held.
 *
 * What they must not do is disturb what the row already banked: the accrual arm
 * is evaluated against the pre-UPDATE row, so a writer reaching the function
 * with a status other than `queued` contributes zero and leaves the total where
 * the exit that closed the last segment left it.
 */
function passthroughWriters(): Writer[] {
  return [
    {
      name: "markChatRunRunning",
      run: () => markChatRunRunning(SESSION),
      status: "running",
    },
    {
      name: "reapStaleTasks",
      // Chat rows are excluded unless RUN_ROWS_SWEEPABLE, and the never-claimed
      // arm wants a null lease behind a `started_at` older than the timeout.
      seed: { status: "cancelling", origin: "task", leaseOwner: null, dispatch: "fat" },
      arrange: (id) => h.sql(
        `UPDATE claw_tasks SET started_at = NOW() - INTERVAL '2 hours' WHERE task_id = $1`, [id]),
      run: () => reapStaleTasks(),
      status: "cancelled",
      failureReason: "cancelled",
    },
    {
      name: "reapLostLeases",
      seed: { status: "running", dispatch: "fat", leaseOwner: BRAIN, leaseExpiresInSec: -3_600 },
      run: () => reapLostLeases(),
      status: "failed",
      failureReason: "worker_lost",
    },
    {
      name: "reapWaitExternal",
      seed: { status: "waiting_external", leaseOwner: null },
      arrange: (id) => h.sql(
        `UPDATE claw_tasks
            SET metadata = metadata || '{"derived":{"wait_external_timeout_sec":1}}'::jsonb,
                queued_at = clock_timestamp() - INTERVAL '30 seconds'
          WHERE task_id = $1`, [id]),
      run: () => reapWaitExternal(),
      status: "failed",
      failureReason: "external_timeout",
    },
  ];
}

test("§7 every writer that takes a row off the queue banks the segment it ends", async () => {
  for (const writer of [...exitWriters(), ...reaperExitWriters()]) {
    await h.reset();
    await seedSession(h, SESSION);
    const taskId = await drive(writer, {
      status: "queued", queuedAgoSec: WAITED_SEC, leaseOwner: BRAIN,
    });
    const banked = Number((await runRow(h, taskId)).queued_ms_accrued);
    assert.ok(banked >= WAITED_SEC * 1_000,
      `${writer.name}: expected the wait banked, got ${banked}ms`);
  }
});

test("§7 every writer that puts a row back on the queue reopens the segment", async () => {
  // The other half of the same statement. A writer that moved a row to `queued`
  // without the re-stamp would leave whatever `queued_at` the row was carrying,
  // and the next exit would bank the whole gap since then as queue time.
  for (const writer of entryWriters()) {
    await h.reset();
    await seedSession(h, SESSION);
    const taskId = await drive(writer, { queuedAgoSec: 3 * 60 * 60, leaseOwner: null });

    assert.equal(Number((await runRow(h, taskId)).queued_ms_accrued), 0,
      `${writer.name}: the row was not on the queue, so there was no segment to bank`);
    await sleep(120);
    await applyTaskStatusTransition("preparing", { expected: ["queued"], params: [taskId] });
    const banked = Number((await runRow(h, taskId)).queued_ms_accrued);
    assert.ok(banked >= 100 && banked < 60_000,
      `${writer.name}: the new segment starts here, not three hours ago; got ${banked}ms`);
  }
});

test("§7 a writer moving a row the queue never held leaves the accrual alone", async () => {
  for (const writer of passthroughWriters()) {
    await h.reset();
    await seedSession(h, SESSION);
    const taskId = idOf(writer.name);
    // A real earlier segment, banked by the exit that closed it, so the
    // assertion below is that this writer preserves a number rather than that
    // both it and a bypass would leave a zero.
    await seedRun(h, taskId, SESSION, {
      status: "queued", queuedAgoSec: WAITED_SEC, leaseOwner: BRAIN, ...writer.seed,
    });
    await h.sql(
      `UPDATE claw_tasks SET status = 'queued', queued_at = clock_timestamp()
         - ($2::int * INTERVAL '1 second') WHERE task_id = $1`, [taskId, WAITED_SEC]);
    await applyTaskStatusTransition(writer.seed?.status ?? "running", {
      expected: ["queued"], params: [taskId],
    });
    const before = Number((await runRow(h, taskId)).queued_ms_accrued);
    assert.ok(before >= WAITED_SEC * 1_000, `${writer.name}: the earlier segment must be banked`);

    await writer.arrange?.(taskId);
    await writer.run(taskId);

    const row = await runRow(h, taskId);
    assert.equal(row.status, writer.status, `${writer.name}: the writer did not move the row`);
    if (writer.failureReason) assert.equal(row.failure_reason, writer.failureReason);
    assert.equal(Number(row.queued_ms_accrued), before,
      `${writer.name}: a row that was not queued contributes nothing, and loses nothing`);
  }
});
