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

const skip = postgresSkipReason();

describe("usage totals and roots read as one snapshot", { skip }, () => {
  let harness: AdmissionCluster;
  let finisher: pg.Client;

  before(async () => {
    harness = await startAdmissionCluster({ ADMIT_SOFT_RUNS: "1", ADMIT_HARD_RUNS: "1" });
    finisher = await harness.connect();
  });
  after(async () => { await harness?.stop(); });

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

  const seedExecutingRoot = async () => {
    const q = harness.app.db.db;
    await q.query("DELETE FROM claw_tasks");
    // One executing root and one of its queued siblings, plus a queued row of a
    // root of its own -- the pair the stale root set lets through together.
    await seedRun(q as never, { taskId: "r1", sessionId: "s1", status: "running", dagRoot: "r1" });
    await seedRun(q as never, { taskId: "r1-sib", sessionId: "s1", status: "queued", dagRoot: "r1" });
    await seedRun(q as never, { taskId: "r2", sessionId: "s2", status: "queued" });
  };

  test("one statement carries both, so a mid-read finish cannot be observed", async () => {
    await seedExecutingRoot();
    let finished = false;
    const probe = interleaving(harness.app.db.db as never, async () => {
      await finisher.query(
        "UPDATE claw_tasks SET status = 'completed', completed_at = NOW() WHERE task_id = 'r1'",
      );
      finished = true;
    });

    const { usage, roots } = await harness.app.admission.loadUsageWithRoots(
      "executing", probe as never,
    );

    assert.ok(finished, "the racing finish did commit");
    // The invariant the two-statement shape breaks: what the totals counted and
    // what the root set names describe the same instant.
    assert.equal(
      usage.executingRoots, roots.size,
      "the total and the root set describe the same instant",
    );
    assert.deepEqual([...roots], ["r1"]);
    assert.equal(probe.statements(), 1, "totals and roots are one statement, so one snapshot");
  });

  test("a finish between two reads would promote two roots past a ceiling of one", async () => {
    await seedExecutingRoot();
    const { admission } = harness.app;
    const limits = admission.envAdmitLimits();

    // The pre-fix shape, written out: the root set read first, the totals read
    // after the finish commits.
    const rootsFirst = await harness.app.db.db.query(
      `SELECT COALESCE(dag_root_task_id, task_id) AS root FROM claw_tasks
        WHERE executor = 'brain' AND status IN ('preparing','running','cancelling')`,
    );
    const staleRoots = new Set(rootsFirst.rows.map((r) => (r as { root: string }).root));
    await finisher.query(
      "UPDATE claw_tasks SET status = 'completed', completed_at = NOW() WHERE task_id = 'r1'",
    );
    const reducedUsage = await admission.loadUsage();

    const queued = await harness.app.db.db.query(
      "SELECT * FROM claw_tasks WHERE status = 'queued' ORDER BY task_id",
    );
    let promoted = 0;
    const roots = new Set(staleRoots);
    for (const row of queued.rows) {
      const ask = admission.askFromRow(row as never, roots);
      if (admission.softOverflow(reducedUsage, ask, limits)) continue;
      admission.chargeAccepted(
        reducedUsage, ask,
        (row as { dag_root_task_id: string | null; task_id: string }).dag_root_task_id
          ?? (row as { task_id: string }).task_id,
        roots,
      );
      promoted += 1;
    }
    assert.equal(promoted, 2, "the two-statement read promotes both, which is the defect");

    // The same drain over one snapshot promotes one.
    await seedExecutingRoot();
    const single = await admission.loadUsageWithRoots("executing");
    let promotedOnce = 0;
    for (const row of queued.rows) {
      const ask = admission.askFromRow(row as never, single.roots);
      if (admission.softOverflow(single.usage, ask, limits)) continue;
      admission.chargeAccepted(
        single.usage, ask,
        (row as { dag_root_task_id: string | null; task_id: string }).dag_root_task_id
          ?? (row as { task_id: string }).task_id,
        single.roots,
      );
      promotedOnce += 1;
    }
    assert.equal(promotedOnce, 1, "one snapshot promotes only the sibling of the live root");
  });
});
