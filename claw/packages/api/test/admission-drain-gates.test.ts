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

import type pg from "pg";
import Fastify from "fastify";
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
  test("a ready row behind twenty oversized ones is still promoted", async () => {
    await harness.app.db.db.query("DELETE FROM claw_tasks");
    const q = await harness.connect();
    await seedRun(q, { taskId: "dep", sessionId: "s-drain", status: "completed" });
    const candidates = [
      ...Array.from({ length: 20 }, (_, i) => [`big-${i}`, 99, 100 - i] as const),
      ["small", 1, 1] as const,
    ];
    for (const [id, gpu, priority] of candidates) {
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

  test("a parked external run stays committed and is gated when it resumes", async () => {
    await harness.app.db.db.query("DELETE FROM claw_tasks");
    const q = await harness.connect();
    await seedRun(q, {
      taskId: "parked", sessionId: "s-drain", status: "waiting_external", sandbox: true,
    });
    await q.query(
      "UPDATE claw_tasks SET metadata = jsonb_build_object('derived', jsonb_build_object('external_id', 'ext-1')) WHERE task_id = 'parked'",
    );

    const before = await harness.app.admission.loadUsage();
    assert.deepEqual(
      [before.runRoots, before.executingRoots, before.sandboxes, before.executingSandboxes],
      [1, 0, 1, 0],
    );

    const { resumeFromExternal } = await import("../src/tasks/external-resolver.js");
    assert.equal(await resumeFromExternal("ext-1"), 1);
    await seedRun(q, { taskId: "running-3", sessionId: "s-drain", status: "running" });
    assert.equal(await harness.app.admission.deferQueuedBySoftCeiling("parked"), true);
  });
});

/**
 * Cancel the candidate's parent the moment the selection has read it.
 *
 * The selection takes `FOR UPDATE` on the candidates and nothing at all on
 * their parents, so the graph can be abandoned underneath a decision that has
 * already been made. Driven from the pool rather than from a timer, because a
 * window measured in awaits is not a window a sleep can aim at.
 */
function abandonGraphAfterSelection(pool: pg.Pool, other: pg.Client, parentId: string): () => void {
  const connect = pool.connect.bind(pool) as (...args: unknown[]) => unknown;
  let armed = true;
  (pool as { connect: unknown }).connect = (...args: unknown[]) => {
    if (args.length) return connect(...args);
    return (connect() as Promise<pg.PoolClient>).then((client) => {
      const query = client.query.bind(client) as (...a: unknown[]) => Promise<unknown>;
      (client as { query: unknown }).query = async (text: unknown, ...rest: unknown[]) => {
        const result = await query(text, ...rest);
        if (armed && typeof text === "string" && /FOR UPDATE SKIP LOCKED/.test(text)) {
          armed = false;
          await other.query("UPDATE claw_tasks SET status = 'cancelled' WHERE task_id = $1", [parentId]);
        }
        return result;
      };
      return client;
    });
  };
  return () => { (pool as { connect: unknown }).connect = connect; };
}

describe("a promotion writes only the rows that are still ready", { skip }, () => {
  test("a candidate whose graph is abandoned after selection is left where it is", async () => {
    // The admission lock serialises admission decisions, not the task
    // lifecycle: between choosing this row and writing it, the parent it
    // depends on is cancelled. An unconditional write by id would queue the
    // child anyway, and a worker would then run a node of a graph nobody is
    // waiting for any more.
    await harness.app.db.db.query("DELETE FROM claw_tasks");
    const q = await harness.connect();
    await seedRun(q, { taskId: "abandoned-parent", sessionId: "s-drain", status: "completed" });
    await seedRun(q, {
      taskId: "orphan", sessionId: "s-drain", status: "waiting_deps",
      dependsOn: ["abandoned-parent"],
    });

    const restore = abandonGraphAfterSelection(
      harness.app.db.db.pool, q, "abandoned-parent",
    );
    let promoted: number;
    try {
      promoted = await harness.app.scheduler.promoteReadyTasks();
    } finally {
      restore();
    }

    assert.equal(promoted, 0, "the row stopped being ready before it was written");
    const r = await harness.app.db.db.query(
      "SELECT status FROM claw_tasks WHERE task_id = 'orphan'",
    );
    assert.equal(
      (r.rows[0] as { status: string }).status, "waiting_deps",
      "a node of an abandoned graph must not be resurrected to queued",
    );
  });
});

describe("the claim route answers a deferral as a retry, not as a dead row", { skip }, () => {
  test("a claim with no executing headroom is a 409 the worker may come back from", async () => {
    // The refusal a worker acts on. `deferred` and `unclaimable` are both
    // refusals of one claim, and only one of them says the row is finished:
    // reported as 422 the worker stops asking, and a row nothing is wrong with
    // waits for the queue timeout with a free slot in front of it.
    await harness.app.db.db.query("DELETE FROM claw_tasks");
    const q = await harness.connect();
    await seedRun(q, { taskId: "http-running", sessionId: "s-drain", status: "running" });
    await seedRun(q, { taskId: "http-waiting", sessionId: "s-drain", status: "queued" });

    const token = "cluster-internal-token";
    const previousToken = process.env.AUTH_INTERNAL_TOKEN;
    process.env.AUTH_INTERNAL_TOKEN = token;
    const app = Fastify();
    let res;
    try {
      const { registerInternalRunRoutes } = await import("../src/routes/internal-runs.js");
      await registerInternalRunRoutes(app);
      await app.ready();
      res = await app.inject({
        method: "POST",
        url: "/v1/internal/tasks/http-waiting/claim",
        headers: { authorization: `Bearer ${token}` },
        payload: { brain_id: "brain-http" },
      });
    } finally {
      await app.close();
      if (previousToken === undefined) delete process.env.AUTH_INTERNAL_TOKEN;
      else process.env.AUTH_INTERNAL_TOKEN = previousToken;
    }

    assert.equal(res.statusCode, 409, "no headroom yet is a retry, not a verdict on the row");
    assert.equal(res.json().error, "deferred");
    const row = (await harness.app.db.db.query(
      "SELECT status, lease_owner, claim_count FROM claw_tasks WHERE task_id = $1",
      ["http-waiting"],
    )).rows[0] as { status: string; lease_owner: string | null; claim_count: number };
    assert.equal(row.status, "queued", "the row the worker was refused is still runnable");
    assert.equal(row.lease_owner, null);
    assert.equal(row.claim_count, 0, "a deferral spends no generation");
  });
});
