// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * An app run left in `finishing` by a holder that lost its lease is re-claimed.
 *
 * The task row is closed by a cancel and by the lost-lease reaper while the
 * holder's finish writes are refused (`not_holder`), so the run row stays
 * `finishing` with a live grant and no claimable task. Over a real Postgres;
 * skipped without DATABASE_URL, and a skip is not a pass.
 */
import assert from "node:assert/strict";
import test, { after, before, beforeEach, describe } from "node:test";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startAdmissionCluster, type AdmissionCluster } from "./support/admission-cluster.js";

const skip = postgresSkipReason();

describe("app run finishing is re-claimed", { skip }, () => {
  let c: AdmissionCluster;
  let sweeper: typeof import("../src/tasks/sweeper.js");
  let state: typeof import("../src/tasks/app-run-state.js");
  const sql = async (text: string, params: unknown[] = []) => (await c.app.db.db.query(text, params)).rows as any[];

  before(async () => {
    c = await startAdmissionCluster({ APP_RUNS_ENABLED: "true" });
    sweeper = await import("../src/tasks/sweeper.js");
    state = await import("../src/tasks/app-run-state.js");
  });
  after(async () => { await c?.stop(); });
  beforeEach(async () => {
    for (const t of ["claw_app_runs", "claw_tasks", "claw_sessions"]) await sql(`DELETE FROM ${t}`);
    await sql("INSERT INTO claw_sessions (session_id, name, user_id, mode, agent_status) VALUES ('s1', 't', 'u-1', 'claw', 'running')");
    await sql("INSERT INTO claw_plugins (plugin_id, name) VALUES (1, 'p') ON CONFLICT DO NOTHING").catch(() => undefined);
  });

  async function seed(runState: string, task: { status: string; leaseAgo?: number }) {
    await sql(
      `INSERT INTO claw_tasks (task_id, session_id, name, status, origin, mode, executor, lease_owner, lease_expires_at, claim_count)
       VALUES ('app-1', 's1', 'app', $1, 'task', 'app', 'brain', 'brain-A',
               NOW() - ($2::int * INTERVAL '1 second'), 1)`,
      [task.status, task.leaseAgo ?? 3600],
    );
    await sql(
      `INSERT INTO claw_app_runs (task_id, session_id, plugin_id, manifest, state, mcp_token_enc, grant_id, last_exit)
       VALUES ('app-1', 's1', 1, '{}'::jsonb, $1, 'x', 'grant-1', '{"cause":"cancelled","final":false}'::jsonb)`,
      [runState],
    );
  }
  const task = async () => (await sql("SELECT status, lease_owner, lease_expires_at FROM claw_tasks WHERE task_id='app-1'"))[0];

  test("a cancelled task whose holder lost its lease mid-finish is handed to the next holder, who completes the finish", async () => {
    await seed("finishing", { status: "cancelling" });
    // The holder's lease is long gone: its finish writes are refused.
    const lost = await state.patchAppRun("app-1", { brainId: "brain-A", claimCount: 1 }, { grant_revoked: true });
    assert.equal(lost.ok, false, "the holder that lost its lease must be refused");
    // The sweeper closes the task, as it does for any lost lease.
    await sweeper.reapLostLeases();
    assert.equal((await task()).status, "cancelled");

    // The row has been closed for longer than the grace by the time the pass looks.
    await sql("UPDATE claw_tasks SET completed_at = NOW() - interval '1 hour' WHERE task_id='app-1'");
    assert.equal(await sweeper.requeueUnfinishedAppRuns(), 1);
    const requeued = await task();
    assert.equal(requeued.status, "queued", "back on the queue for a live Brain");
    assert.equal(requeued.lease_owner, null);

    // A live Brain takes it (the scheduler's dispatch and the lease acceptance, as they leave the row).
    await sql("UPDATE claw_tasks SET status='running', lease_owner='brain-B', lease_expires_at = NOW() + interval '1 minute', claim_count = 2 WHERE task_id='app-1'");
    const stale = await state.patchAppRun("app-1", { brainId: "brain-A", claimCount: 1 }, { state: "ended" }, "finishing");
    assert.equal(stale.ok, false, "the old holder stays fenced out");
    const done = await state.patchAppRun("app-1", { brainId: "brain-B", claimCount: 2 }, { grant_revoked: true, state: "ended" }, "finishing");
    assert.equal(done.ok, true);
    const run = (await sql("SELECT state, grant_revoked_at FROM claw_app_runs WHERE task_id='app-1'"))[0];
    assert.equal(run.state, "ended");
    assert.ok(run.grant_revoked_at, "the grant is revoked");
    assert.equal(await sweeper.requeueUnfinishedAppRuns(), 0, "an ended run is not handed round again");
  });

  test("a live holder, an ended run and a running run are left alone", async () => {
    await seed("finishing", { status: "cancelling", leaseAgo: -300 });
    assert.equal(await sweeper.requeueUnfinishedAppRuns(), 0, "its holder's lease is live");
    await sql("UPDATE claw_tasks SET status='cancelled', lease_expires_at = NOW() - interval '1 hour'");
    await sql("UPDATE claw_app_runs SET state='ended'");
    assert.equal(await sweeper.requeueUnfinishedAppRuns(), 0, "the run already ended");
    await sql("UPDATE claw_app_runs SET state='running'");
    assert.equal(await sweeper.requeueUnfinishedAppRuns(), 0, "a running run is not a finish to resume");
  });

  test("the hand-over is bounded", async () => {
    await seed("finishing", { status: "failed" });
    await sql("UPDATE claw_tasks SET metadata = jsonb_build_object('app_finish_requeues', 5)");
    assert.equal(await sweeper.requeueUnfinishedAppRuns(), 0);
  });
});
