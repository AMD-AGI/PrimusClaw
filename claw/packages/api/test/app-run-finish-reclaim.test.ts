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

import Fastify, { type FastifyInstance } from "fastify";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startAdmissionCluster, type AdmissionCluster } from "./support/admission-cluster.js";

const skip = postgresSkipReason();

describe("app run finishing is re-claimed", { skip }, () => {
  let c: AdmissionCluster;
  let sweeper: typeof import("../src/tasks/sweeper.js");
  let state: typeof import("../src/tasks/app-run-state.js");
  let routes: FastifyInstance;
  let dispatcher: typeof import("../src/tasks/dispatcher.js");
  const published: Array<Record<string, any>> = [];
  const sql = async (text: string, params: unknown[] = []) => (await c.app.db.db.query(text, params)).rows as any[];

  before(async () => {
    c = await startAdmissionCluster({ APP_RUNS_ENABLED: "true", CLAW_DEPLOY_MODE: "kubernetes", LLM_KEY_SOURCE: "virtualKey" });
    sweeper = await import("../src/tasks/sweeper.js");
    dispatcher = await import("../src/tasks/dispatcher.js");
    dispatcher.taskPublisher.publish = (async (payload: unknown) => { published.push(JSON.parse(typeof payload === "string" ? payload : new TextDecoder().decode(payload as Uint8Array))); }) as never;
    const { registerInternalTaskRoutes } = await import("../src/routes/internal-tasks.js");
    routes = Fastify();
    await registerInternalTaskRoutes(routes);
    await routes.ready();
    state = await import("../src/tasks/app-run-state.js");
  });
  after(async () => { await routes?.close(); await c?.stop(); });
  beforeEach(async () => {
    for (const t of ["claw_app_runs", "claw_tasks", "claw_sessions"]) await sql(`DELETE FROM ${t}`);
    published.length = 0;
    await sql(`INSERT INTO claw_sessions (session_id, name, user_id, mode, agent_status, config)
               VALUES ('s1', 't', 'u-1', 'claw', 'idle', '{"platform_key":"pk","_server_managed_credentials":true}'::jsonb)`);
    await sql("INSERT INTO claw_plugins (plugin_id, name) VALUES (1, 'p') ON CONFLICT DO NOTHING").catch(() => undefined);
  });

  async function seed(runState: string, task: { status: string; leaseAgo?: number }) {
    await sql(
      `INSERT INTO claw_tasks (task_id, session_id, name, status, origin, mode, executor, lease_owner, lease_expires_at, claim_count, callback_url)
       VALUES ('app-1', 's1', 'app', $1, 'task', 'app', 'brain', 'brain-A',
               NOW() - ($2::int * INTERVAL '1 second'), 1, 'http://api/v1/internal/tasks/app-1')`,
      [task.status, task.leaseAgo ?? 3600],
    );
    await sql(
      `INSERT INTO claw_app_runs (task_id, session_id, plugin_id, manifest, state, mcp_token_enc, grant_id, last_exit)
       VALUES ('app-1', 's1', 1, '{}'::jsonb, $1, 'x', 'grant-1', '{"cause":"cancelled","final":false}'::jsonb)`,
      [runState],
    );
  }
  const task = async () => (await sql("SELECT status, lease_owner, lease_expires_at, claim_count FROM claw_tasks WHERE task_id='app-1'"))[0];

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
    assert.equal(requeued.status, "queued", "reopened only to be dispatched");
    assert.equal(requeued.lease_owner, null);
    assert.ok(new Date(String((await sql("SELECT deadline_at FROM claw_tasks"))[0].deadline_at)).getTime() > Date.now(), "a fresh deadline, so the backstop does not close it again");

    // The real dispatch: the scheduler's path, which publishes the execute request to a Brain.
    assert.deepEqual(await dispatcher.dispatchTask("app-1"), { ok: true });
    assert.equal(published.length, 1);
    assert.equal(published[0]!.app_finish_only, true, "the Brain is told this is a finish, not a run");
    const token = published[0]!.backend_internal_token as string;
    const post = async (path: string, payload: object) => {
      const r = await routes.inject({ method: "POST", url: `/v1/internal/tasks/app-1/${path}`, headers: { authorization: `Bearer ${token}` }, payload });
      return r.statusCode;
    };
    assert.equal(await post("lease", { brain_id: "brain-B", lease_seconds: 45 }), 200);
    const claim = Number((await task()).claim_count);

    // Not settled while the run is still finishing.
    assert.equal(await post("app_finish_done", { brain_id: "brain-B" }), 409);

    const stale = await state.patchAppRun("app-1", { brainId: "brain-A", claimCount: 1 }, { state: "ended" }, "finishing");
    assert.equal(stale.ok, false, "the old holder stays fenced out");
    const done = await state.patchAppRun("app-1", { brainId: "brain-B", claimCount: claim }, { grant_revoked: true, state: "ended" }, "finishing");
    assert.equal(done.ok, true);

    // The Brain's terminal report: only from the holder.
    assert.equal(await post("app_finish_done", { brain_id: "brain-X" }), 409);
    assert.equal(await post("app_finish_done", { brain_id: "brain-B" }), 200);

    const final = (await sql("SELECT status, failure_reason, error_message, lease_owner, metadata FROM claw_tasks WHERE task_id='app-1'"))[0];
    assert.equal(final.status, "cancelled", "the user's cancel stands: never running, never failed");
    assert.equal(final.failure_reason, "cancelled");
    assert.match(final.error_message, /cancelled/);
    assert.equal(final.lease_owner, null);
    assert.equal(final.metadata.app_finish_prior, undefined);
    const run = (await sql("SELECT state, grant_revoked_at FROM claw_app_runs WHERE task_id='app-1'"))[0];
    assert.equal(run.state, "ended");
    assert.ok(run.grant_revoked_at, "the grant is revoked");
    assert.equal(await sweeper.requeueUnfinishedAppRuns(), 0, "an ended run is not handed round again");
    assert.equal(published.length, 1, "no second dispatch");
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

  async function seedFinishOnly(opts: { status?: string; prior: string; runState: string; lastExit?: object; requeues?: number; leaseAgo?: number }) {
    await seed(opts.runState, { status: opts.status ?? "preparing", leaseAgo: opts.leaseAgo ?? 3600 });
    await sql(
      `UPDATE claw_tasks SET completed_at = NOW() - interval '1 hour',
              metadata = jsonb_build_object('app_finish_requeues', $2::int,
                'app_finish_prior', jsonb_build_object('status', $1::text, 'failure_reason', 'cancelled', 'error_message', 'cancelled by user'))
        WHERE task_id='app-1'`,
      [opts.prior, opts.requeues ?? 1],
    );
    if (opts.lastExit) await sql("UPDATE claw_app_runs SET last_exit = $1::jsonb", [JSON.stringify(opts.lastExit)]);
  }

  test("the run row ended but app_finish_done never landed: the sweeper restores the cancel, before the reapers can fail it", async () => {
    await seedFinishOnly({ prior: "cancelled", runState: "ended" });
    // The tick's order: the settle pass is first. Run the reapers after it, as the tick does.
    assert.equal(await sweeper.settleEndedFinishOnlyRuns(), 1);
    await sweeper.reapLostLeases();
    const row = (await sql("SELECT status, failure_reason, lease_owner, metadata FROM claw_tasks"))[0];
    assert.equal(row.status, "cancelled", "not failed / worker_lost");
    assert.equal(row.failure_reason, "cancelled");
    assert.equal(row.metadata.app_finish_prior, undefined);
  });

  test("an application's own successful final survives: a failed task becomes completed, a cancel stays a cancel", async () => {
    const ok = { cause: "exit", final: true, returncode: 0 };
    await seedFinishOnly({ prior: "failed", runState: "ended", lastExit: ok });
    assert.equal(await sweeper.settleEndedFinishOnlyRuns(), 1);
    let row = (await sql("SELECT status, failure_reason FROM claw_tasks"))[0];
    assert.equal(row.status, "completed");
    assert.equal(row.failure_reason, null);

    await sql("DELETE FROM claw_app_runs"); await sql("DELETE FROM claw_tasks");
    await seedFinishOnly({ prior: "cancelled", runState: "ended", lastExit: ok });
    await sweeper.settleEndedFinishOnlyRuns();
    row = (await sql("SELECT status FROM claw_tasks"))[0];
    assert.equal(row.status, "cancelled");

    await sql("DELETE FROM claw_app_runs"); await sql("DELETE FROM claw_tasks");
    await seedFinishOnly({ prior: "failed", runState: "ended", lastExit: { cause: "cancelled", final: false } });
    await sweeper.settleEndedFinishOnlyRuns();
    row = (await sql("SELECT status FROM claw_tasks"))[0];
    assert.equal(row.status, "failed", "no success on the row: the prior failure stands");
  });

  test("the holder's app_finish_done also keeps a successful final", async () => {
    await seedFinishOnly({ prior: "failed", runState: "ended", lastExit: { cause: "exit", final: true, returncode: 0 } });
    await sql("UPDATE claw_tasks SET lease_owner='brain-B', lease_expires_at = NOW() + interval '1 minute'");
    assert.equal(await sweeper.settleFinishedAppRun("app-1", "brain-B"), true);
    assert.equal((await sql("SELECT status FROM claw_tasks"))[0].status, "completed");
  });

  test("at the requeue cap the task gets its prior state back and the exhaustion is not silent", async () => {
    await seedFinishOnly({ status: "failed", prior: "cancelled", runState: "finishing", requeues: 5 });
    assert.equal(await sweeper.requeueUnfinishedAppRuns(), 0, "not handed round again");
    assert.equal(await sweeper.giveUpExhaustedAppFinishes(), 1);
    const row = (await sql("SELECT status, failure_reason, metadata FROM claw_tasks"))[0];
    assert.equal(row.status, "cancelled", "the user's cancel, not the last reaper's worker_lost");
    assert.equal(row.metadata.app_finish_prior, undefined);
    assert.equal(await sweeper.giveUpExhaustedAppFinishes(), 0, "said once");
  });

  test("the reopen and the restore keep the task's own timeline (started_at, completed_at, deadline_at)", async () => {
    await seed("finishing", { status: "cancelled" });
    await sql(`UPDATE claw_tasks SET started_at = '2026-10-28T15:00:00Z', completed_at = NOW() - interval '1 hour',
                      deadline_at = '2026-10-28T16:00:00Z' WHERE task_id='app-1'`);
    const before = (await sql("SELECT started_at, completed_at, deadline_at FROM claw_tasks"))[0];
    assert.equal(await sweeper.requeueUnfinishedAppRuns(), 1);
    const mid = (await sql("SELECT deadline_at FROM claw_tasks"))[0];
    assert.notEqual(new Date(mid.deadline_at).getTime(), new Date(before.deadline_at).getTime(), "reopened with a fresh deadline");
    await sql("UPDATE claw_app_runs SET state='ended'");
    assert.equal(await sweeper.settleEndedFinishOnlyRuns(), 1);
    const after = (await sql("SELECT status, started_at, completed_at, deadline_at, metadata FROM claw_tasks"))[0];
    assert.equal(after.status, "cancelled");
    for (const k of ["started_at", "completed_at", "deadline_at"] as const) {
      assert.equal(new Date(after[k]).getTime(), new Date(before[k]).getTime(), `${k} is the original`);
    }
    assert.equal(after.metadata.app_finish_prior, undefined);
  });

  test("a hand-over is taken at once; a lease given back by an ordinary nak still waits its grace", async () => {
    await seedFinishOnly({ prior: "cancelled", runState: "finishing", status: "preparing" });
    // An ordinary nak: owner cleared, expiry stamped now, no hand-over mark. Its redelivery is coming.
    await sql("UPDATE claw_tasks SET lease_owner = NULL, lease_expires_at = NOW(), completed_at = NULL");
    assert.equal(await sweeper.requeueUnfinishedAppRuns(), 0, "not reopened under its own redelivery");
    assert.equal((await task()).status, "preparing");

    // The Brain says it cannot finish (the real route, only from the holder), then gives the lease back.
    await sql("UPDATE claw_tasks SET lease_owner = 'brain-B', lease_expires_at = NOW() + interval '1 minute'");
    assert.equal(await sweeper.markFinishOnlyHandedOver("app-1", "brain-X"), false, "only the holder");
    assert.equal(await sweeper.markFinishOnlyHandedOver("app-1", "brain-B"), true);
    await sql("UPDATE claw_tasks SET lease_owner = NULL, lease_expires_at = NOW()");
    assert.equal(await sweeper.requeueUnfinishedAppRuns(), 1, "taken at once, no grace");
    const row = (await sql("SELECT status, metadata FROM claw_tasks"))[0];
    assert.equal(row.status, "queued");
    assert.equal(row.metadata.app_finish_handed_over, undefined, "the mark is spent");
    // Control: a dispatched row nobody has taken yet is not touched.
    await sql("UPDATE claw_tasks SET status='preparing', lease_owner = NULL, lease_expires_at = NULL");
    assert.equal(await sweeper.requeueUnfinishedAppRuns(), 0);
  });

  test("giving up at the cap reaches the same verdict as the other restore: a successful final is completed", async () => {
    await seedFinishOnly({ status: "failed", prior: "failed", runState: "finishing", requeues: 5,
      lastExit: { cause: "exit", final: true, returncode: 0 } });
    assert.equal(await sweeper.giveUpExhaustedAppFinishes(), 1);
    assert.equal((await sql("SELECT status FROM claw_tasks"))[0].status, "completed");
  });
});
