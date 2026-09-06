// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The two drains a ceiling has to reach without starving the queue behind it.
 *
 * A pre-limited candidate window is not a gate: a prefix that cannot fit is
 * re-read every pass while the admissible rows behind it are never examined.
 * And the chat claim paths hand a `queued` row to a worker with no soft check
 * at all, so a full fleet keeps taking work.
 */

import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { seedRun, startAdmissionCluster, type AdmissionCluster } from "./support/admission-cluster.js";

const skip = postgresSkipReason();

let harness: AdmissionCluster;

before(async () => {
  if (skip) return;
  harness = await startAdmissionCluster({
    ADMIT_HARD_GPU_NODES: "4",
    ADMIT_SOFT_RUNS: "1",
    // Two per page, so the non-fitting prefix fills the first page exactly --
    // which is what a window applied before anything tests fit truncates on.
    TASK_SCHEDULER_MAX_PROMOTE: "2",
  });
  await harness.app.db.db.query(
    `INSERT INTO claw_sessions (session_id, name, user_id, mode) VALUES ('s-drain','d','u1','claw')`,
  );
});
after(async () => { await harness?.stop(); });

describe("promotion pages past a prefix that cannot fit", { skip }, () => {
  test("a ready row behind two oversized ones is still promoted", async () => {
    await harness.app.db.db.query("DELETE FROM claw_tasks");
    const q = await harness.connect();
    await seedRun(q, { taskId: "dep", sessionId: "s-drain", status: "completed" });
    // Priority orders the page: the two that can never fit come first.
    for (const [id, gpu, priority] of [["big-1", 99, 9], ["big-2", 99, 8], ["small", 1, 1]] as const) {
      await q.query(
        `INSERT INTO claw_tasks
           (task_id, session_id, name, status, origin, executor, input, metadata, depends_on, priority, created_at)
         VALUES ($1,'s-drain','n','waiting_deps','dag_node','brain',$2::jsonb,'{}'::jsonb,ARRAY['dep'],$3,NOW())`,
        [id, JSON.stringify({ topology: { nodes: gpu } }), priority],
      );
    }

    assert.equal(await harness.app.scheduler.promoteReadyTasks(), 1, "the row that fits is reached");
    const r = await harness.app.db.db.query(
      "SELECT task_id FROM claw_tasks WHERE status = 'queued' ORDER BY task_id",
    );
    assert.deepEqual(r.rows.map((x) => (x as { task_id: string }).task_id), ["small"]);
  });

  test("cumulative demand is what the ceiling sees", async () => {
    await harness.app.db.db.query("DELETE FROM claw_tasks");
    const q = await harness.connect();
    await seedRun(q, { taskId: "dep2", sessionId: "s-drain", status: "completed" });
    for (const id of ["a", "b", "c"]) {
      await q.query(
        `INSERT INTO claw_tasks
           (task_id, session_id, name, status, origin, executor, input, metadata, depends_on, created_at)
         VALUES ($1,'s-drain','n','waiting_deps','dag_node','brain',$2::jsonb,'{}'::jsonb,ARRAY['dep2'],NOW())`,
        [id, JSON.stringify({ topology: { nodes: 2 } })],
      );
    }
    assert.equal(
      await harness.app.scheduler.promoteReadyTasks(), 2,
      "four GPU nodes of headroom take two rows of two, never three",
    );
  });
});

describe("cumulative demand, without a database", { skip }, () => {
  test("each acceptance raises the consumption the next candidate is tested against", () => {
    const usage = {
      runRoots: 0, executingRoots: 0, sandboxes: 0,
      executingSandboxes: 0, gpuNodes: 0, executingGpuNodes: 0,
    };
    const rows = ["a", "b", "c"].map((task_id) => ({
      task_id, dag_root_task_id: null, input: { topology: { nodes: 2 } },
    }));
    const accepted = harness.app.scheduler.acceptWithinHardHeadroom(rows as never, usage, new Set());
    assert.deepEqual(
      accepted.map((r) => r.task_id), ["a", "b"],
      "four GPU nodes of headroom, two rows of two -- the third is deferred, not failed",
    );
    assert.equal(usage.gpuNodes, 4, "the snapshot carries what the batch has taken");
  });
});

describe("the soft ceiling declines to hand a queued row to a worker", { skip }, () => {
  test("a queued row is deferred while the executing set is full", async () => {
    await harness.app.db.db.query("DELETE FROM claw_tasks");
    const q = await harness.connect();
    await seedRun(q, { taskId: "running-1", sessionId: "s-drain", status: "running" });
    await seedRun(q, { taskId: "waiting-1", sessionId: "s-drain", status: "queued" });
    assert.equal(
      await harness.app.admission.deferQueuedBySoftCeiling("waiting-1"), true,
      "one executing root against a soft ceiling of one",
    );
  });

  test("a preparing row is never deferred: it is already counted as executing", async () => {
    await harness.app.db.db.query("DELETE FROM claw_tasks");
    const q = await harness.connect();
    await seedRun(q, { taskId: "running-2", sessionId: "s-drain", status: "running" });
    await seedRun(q, { taskId: "held", sessionId: "s-drain", status: "preparing" });
    assert.equal(
      await harness.app.admission.deferQueuedBySoftCeiling("held"), false,
      "re-claiming a row after an unclaim adds nothing and must not be blocked",
    );
  });

  test("a free fleet defers nothing", async () => {
    await harness.app.db.db.query("DELETE FROM claw_tasks");
    const q = await harness.connect();
    await seedRun(q, { taskId: "waiting-2", sessionId: "s-drain", status: "queued" });
    assert.equal(await harness.app.admission.deferQueuedBySoftCeiling("waiting-2"), false);
  });
});
