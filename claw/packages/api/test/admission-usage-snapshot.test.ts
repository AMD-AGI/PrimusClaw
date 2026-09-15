// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The usage totals and the run-tree root set come from one snapshot.
 *
 * Under READ COMMITTED two statements on one connection still take two
 * snapshots, so a root committing its terminal transition between them yields a
 * reduced total against a root set that still lists it. A queued sibling then
 * reads `newRunRoots = 0` for a root that is no longer executing, and two roots
 * are promoted where the ceiling allowed one. The advisory lock does not cover
 * it: a run finishing takes no admission lock.
 */

import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import type pg from "pg";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { seedRun, startAdmissionCluster, type AdmissionCluster } from "./support/admission-cluster.js";
// Type-only, so it is erased: a value import would read `ADMIT_*` before the
// harness has set them.
import type { AdmissionUsage, AdmitLimits } from "../src/tasks/admission.js";

const skip = postgresSkipReason();

interface Ctx {
  harness: AdmissionCluster;
  finisher: pg.Client;
}

/**
 * A connection that lets a second writer commit between statements.
 *
 * This is the interleaving itself, not a simulation of it: whatever the
 * production read issues, the finish lands after its first statement.
 */
const interleaving = (client: { query: pg.Client["query"] }, onFirst: () => Promise<void>) => {
  let seen = 0;
  return {
    async query(text: string, params?: unknown[]) {
      const result = await client.query(text, params as never);
      if (++seen === 1) await onFirst();
      return result as { rows: unknown[]; rowCount: number | null };
    },
    statements: () => seen,
  };
};

/** One executing root, one queued sibling of it, and one queued root of its own. */
const seedExecutingRoot = async (ctx: Ctx) => {
  const q = ctx.harness.app.db.db;
  await q.query("DELETE FROM claw_tasks");
  await seedRun(q as never, { taskId: "r1", sessionId: "s1", status: "running", dagRoot: "r1" });
  await seedRun(q as never, { taskId: "r1-sib", sessionId: "s1", status: "queued", dagRoot: "r1" });
  await seedRun(q as never, { taskId: "r2", sessionId: "s2", status: "queued" });
};

/** The production read: one statement, so one snapshot, whatever commits mid-read. */
function registerSnapshotCases(ctx: () => Ctx): void {
  test("one statement carries both, so a mid-read finish cannot be observed", async () => {
    const c = ctx();
    await seedExecutingRoot(c);
    let finished = false;
    const probe = interleaving(c.harness.app.db.db as never, async () => {
      await c.finisher.query(
        "UPDATE claw_tasks SET status = 'completed', completed_at = NOW() WHERE task_id = 'r1'",
      );
      finished = true;
    });

    const { usage, roots } = await c.harness.app.admission.loadUsageWithRoots(
      "executing", probe as never,
    );

    assert.ok(finished, "the racing finish did commit");
    assert.equal(
      usage.executingRoots, roots.size,
      "the total and the root set describe the same instant",
    );
    assert.deepEqual([...roots], ["r1"]);
    assert.equal(probe.statements(), 1, "totals and roots are one statement, so one snapshot");
  });
}

/**
 * The same drain over two reads and over one, so the ceiling the split shape
 * breaks is visible as a number rather than as an argument.
 */
function registerTwoStatementDefectCases(ctx: () => Ctx): void {
  test("a finish between two reads would promote two roots past a ceiling of one", async () => {
    const c = ctx();
    await seedExecutingRoot(c);
    const { admission } = c.harness.app;
    const limits = admission.envAdmitLimits();

    const rootsFirst = await c.harness.app.db.db.query(
      `SELECT COALESCE(dag_root_task_id, task_id) AS root FROM claw_tasks
        WHERE executor = 'brain' AND status IN ('preparing','running','cancelling')`,
    );
    const staleRoots = new Set(rootsFirst.rows.map((r) => (r as { root: string }).root));
    await c.finisher.query(
      "UPDATE claw_tasks SET status = 'completed', completed_at = NOW() WHERE task_id = 'r1'",
    );
    const reducedUsage = await admission.loadUsage();

    const queued = await c.harness.app.db.db.query(
      "SELECT * FROM claw_tasks WHERE status = 'queued' ORDER BY task_id",
    );
    assert.equal(
      drainable(c, queued.rows, reducedUsage, staleRoots, limits), 2,
      "the two-statement read promotes both, which is the defect",
    );

    await seedExecutingRoot(c);
    const single = await admission.loadUsageWithRoots("executing");
    assert.equal(
      drainable(c, queued.rows, single.usage, single.roots, limits), 1,
      "one snapshot promotes only the sibling of the live root",
    );
  });
}

/** How many of these queued rows one drain would promote against this usage. */
function drainable(
  ctx: Ctx,
  queued: unknown[],
  usage: AdmissionUsage,
  countedRoots: Set<string>,
  limits: AdmitLimits,
): number {
  const { admission } = ctx.harness.app;
  const roots = new Set(countedRoots);
  let promoted = 0;
  for (const row of queued) {
    const ask = admission.askFromRow(row as never, roots);
    if (admission.softOverflow(usage, ask, limits)) continue;
    const typed = row as { dag_root_task_id: string | null; task_id: string };
    admission.chargeAccepted(usage, ask, typed.dag_root_task_id ?? typed.task_id, roots);
    promoted += 1;
  }
  return promoted;
}

describe("usage totals and roots read as one snapshot", { skip }, () => {
  const ctx = {} as Ctx;

  before(async () => {
    ctx.harness = await startAdmissionCluster({ ADMIT_SOFT_RUNS: "1", ADMIT_HARD_RUNS: "1" });
    ctx.finisher = await ctx.harness.connect();
  });
  after(async () => { await ctx.harness?.stop(); });

  registerSnapshotCases(() => ctx);
  registerTwoStatementDefectCases(() => ctx);
});
