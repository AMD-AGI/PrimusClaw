// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * An app run whose task was closed before its holder moved it to `finishing`
 * is finished by the sweeper.
 *
 * The case: a session was deleted 13 s after an app run was submitted. The
 * deletion closes the task at once (`cancelled`, `session_deleted`), the API
 * renews no lease on a closed task, and the holder's first finishing write came
 * after its lease had run out, so it was refused and the run row stayed in
 * `provisioning` for ever. `requeueUnfinishedAppRuns` hands a finish to a live
 * Brain only for a run row in `finishing`, so nothing ever stopped the run's
 * sandbox. Here the same rows are made by the real deletion, and the sweeper's
 * passes are run as its tick runs them, against a real Postgres (skipped without
 * DATABASE_URL, and a skip is not a pass).
 *
 * The points of the first 15 s after submission at which a deletion can catch
 * the run, as the API sees them: before any Brain took it (no lease, nothing
 * created), with a Brain holding it before a workload id was recorded, with the
 * id recorded and the workload queued (the case above), and once the sandbox
 * was up (`starting`, `running`).
 */
import assert from "node:assert/strict";
import test, { after, before, beforeEach, describe } from "node:test";

import Fastify, { type FastifyInstance } from "fastify";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startAdmissionCluster, type AdmissionCluster } from "./support/admission-cluster.js";

const skip = postgresSkipReason();
const WORKLOAD = "claw-0001-sandbox-abcde";

describe("an app run closed before it reached finishing is finished by the sweeper", { skip }, () => {
  let c: AdmissionCluster;
  let sweeper: typeof import("../src/tasks/sweeper.js");
  let state: typeof import("../src/tasks/app-run-state.js");
  let dispatcher: typeof import("../src/tasks/dispatcher.js");
  let teardown: typeof import("../src/sessions/teardown.js");
  let grace: number;
  let routes: FastifyInstance;
  const published: Array<Record<string, any>> = [];
  const sql = async (text: string, params: unknown[] = []) => (await c.app.db.db.query(text, params)).rows as any[];

  before(async () => {
    c = await startAdmissionCluster({ APP_RUNS_ENABLED: "true", CLAW_DEPLOY_MODE: "kubernetes", LLM_KEY_SOURCE: "virtualKey" });
    sweeper = await import("../src/tasks/sweeper.js");
    state = await import("../src/tasks/app-run-state.js");
    dispatcher = await import("../src/tasks/dispatcher.js");
    teardown = await import("../src/sessions/teardown.js");
    grace = (await import("../src/config.js")).LEASE_LOST_GRACE_SEC;
    dispatcher.taskPublisher.publish = (async (payload: unknown) => { published.push(JSON.parse(typeof payload === "string" ? payload : new TextDecoder().decode(payload as Uint8Array))); }) as never;
    const { registerInternalTaskRoutes } = await import("../src/routes/internal-tasks.js");
    routes = Fastify();
    await registerInternalTaskRoutes(routes);
    await routes.ready();
  });
  after(async () => { await routes?.close(); await c?.stop(); });
  beforeEach(async () => {
    for (const t of ["claw_app_runs", "claw_tasks", "claw_sessions"]) await sql(`DELETE FROM ${t}`);
    published.length = 0;
    await sql(`INSERT INTO claw_sessions (session_id, name, user_id, mode, agent_status, config)
               VALUES ('s1', 't', 'u-1', 'claw', 'idle', '{"platform_key":"pk","_server_managed_credentials":true}'::jsonb)`);
    await sql("INSERT INTO claw_plugins (plugin_id, name) VALUES (8, 'p') ON CONFLICT DO NOTHING").catch(() => undefined);
  });

  /** An app run as admission and a Brain leave it. `lease` false: no Brain has taken it yet. */
  async function seed(opts: { status: string; runState: string; lease?: boolean; workload?: string | null; lastExit?: object | null }) {
    const leased = opts.lease !== false;
    await sql(
      `INSERT INTO claw_tasks (task_id, session_id, name, status, origin, mode, executor,
                               lease_owner, lease_expires_at, heartbeat_at, claim_count, callback_url, started_at)
       VALUES ('app-1', 's1', 'app', $1, 'task', 'app', 'brain',
               $2, CASE WHEN $3 THEN NOW() + INTERVAL '30 seconds' END, CASE WHEN $3 THEN NOW() END, 1,
               'http://api/v1/internal/tasks/app-1', CASE WHEN $3 THEN NOW() END)`,
      [opts.status, leased ? "brain-A" : null, leased],
    );
    await sql(
      `INSERT INTO claw_app_runs (task_id, session_id, plugin_id, manifest, state, sandbox_workload_id, mcp_token_enc, grant_id, last_exit)
       VALUES ('app-1', 's1', 8, '{}'::jsonb, $1, $2, 'x', 'gr-1', $3::jsonb)`,
      [opts.runState, opts.workload === undefined ? WORKLOAD : opts.workload, opts.lastExit ? JSON.stringify(opts.lastExit) : null],
    );
  }
  /** Time passes: the lease ran out, and the task was closed, `sec` seconds ago. */
  const aged = (sec: number) => sql(
    `UPDATE claw_tasks SET lease_expires_at = CASE WHEN lease_expires_at IS NOT NULL THEN NOW() - ($1::int * INTERVAL '1 second') END,
                           completed_at = CASE WHEN completed_at IS NOT NULL THEN NOW() - ($1::int * INTERVAL '1 second') END
      WHERE task_id = 'app-1'`,
    [sec],
  );
  const run = async () => (await sql("SELECT state, sandbox_workload_id, last_exit, grant_revoked_at FROM claw_app_runs WHERE task_id='app-1'"))[0];
  const task = async () => (await sql("SELECT status, failure_reason, lease_owner, claim_count, metadata FROM claw_tasks WHERE task_id='app-1'"))[0];

  /** The sweeper's app passes, in its tick's order (see the tick order test below). */
  async function tick(): Promise<{ moved: number; requeued: number }> {
    await sweeper.settleEndedFinishOnlyRuns();
    await sweeper.reapLostLeases();
    const moved = await sweeper.finishAbandonedAppRuns();
    await sweeper.giveUpExhaustedAppFinishes();
    const requeued = await sweeper.requeueUnfinishedAppRuns();
    return { moved, requeued };
  }

  /** A Brain takes the finish-only dispatch and finishes the run; returns the task as it is left. */
  async function finishOnlyBrainFinishes() {
    assert.deepEqual(await dispatcher.dispatchTask("app-1"), { ok: true });
    const req = published.at(-1)!;
    assert.equal(req.app_finish_only, true, "the Brain is told this is a finish, not a run");
    const post = async (path: string, payload: object) => (await routes.inject({
      method: "POST", url: `/v1/internal/tasks/app-1/${path}`,
      headers: { authorization: `Bearer ${req.backend_internal_token}` }, payload,
    })).statusCode;
    assert.equal(await post("lease", { brain_id: "brain-B", lease_seconds: 45 }), 200);
    const fence = { brainId: "brain-B", claimCount: Number((await task()).claim_count) };
    // The finishing steps' writes: the grant revoke, then ended (stop_sandbox stops every
    // live workload carrying the run's CLAW_APP_RUN_ID, the recorded one or not).
    assert.equal((await state.patchAppRun("app-1", fence, { grant_revoked: true }, "finishing")).ok, true);
    assert.equal((await state.patchAppRun("app-1", fence, { state: "ended" }, "finishing")).ok, true);
    assert.equal(await post("app_finish_done", { brain_id: "brain-B" }), 200);
    return task();
  }

  test("the session deleted 13 s in, workload queued and recorded: finished once the lease is gone for the grace", async () => {
    await seed({ status: "running", runState: "provisioning" });
    await teardown.commitSessionDeletion("s1");
    assert.deepEqual(
      { status: (await task()).status, reason: (await task()).failure_reason },
      { status: "cancelled", reason: "session_deleted" },
      "the deletion closed the task under its holder",
    );

    // While the holder's lease lasts it may still finish the run itself.
    assert.deepEqual(await tick(), { moved: 0, requeued: 0 }, "the holder's lease is live");
    // The lease ran out; the grace has not.
    await aged(1);
    assert.deepEqual(await tick(), { moved: 0, requeued: 0 }, "inside the grace a holder is never preempted");
    assert.equal((await run()).state, "provisioning");
    // The holder could no longer write anything, which is how the run was stranded.
    const refused = await state.patchAppRun("app-1", { brainId: "brain-A", claimCount: 1 }, { state: "finishing", last_exit: { at: "t", cause: "cancelled", final: false } });
    assert.deepEqual(refused, { ok: false, reason: "not_holder", current: "provisioning" });

    await aged(grace + 5);
    assert.deepEqual(await tick(), { moved: 1, requeued: 1 }, "moved to finishing and handed to a live Brain in the same tick");
    const r = await run();
    assert.equal(r.state, "finishing");
    assert.equal(r.sandbox_workload_id, WORKLOAD, "the recorded workload is kept for the finish to stop");
    assert.equal(r.last_exit.cause, "row_terminal");
    assert.equal(r.last_exit.final, false);
    const reopened = await task();
    assert.equal(reopened.status, "queued", "reopened only to be dispatched");
    assert.equal(reopened.metadata.app_finish_prior.failure_reason, "session_deleted");

    const finished = await finishOnlyBrainFinishes();
    assert.equal(finished.status, "cancelled", "the deletion's cancel stands");
    assert.equal(finished.failure_reason, "session_deleted");
    assert.equal(finished.metadata.app_finish_prior, undefined);
    const ended = await run();
    assert.equal(ended.state, "ended");
    assert.ok(ended.grant_revoked_at, "the grant is revoked, not left to lapse");
    assert.deepEqual(await tick(), { moved: 0, requeued: 0 }, "an ended run is left alone");
    assert.equal(published.length, 1, "one dispatch");
  });

  const deletedAt: Array<{ name: string; status: string; runState: string; lease?: boolean; workload?: string | null }> = [
    { name: "before any Brain took it", status: "queued", runState: "provisioning", lease: false, workload: null },
    { name: "with a Brain creating its sandbox, no workload id recorded yet", status: "preparing", runState: "provisioning", workload: null },
    { name: "with the workload queued and recorded", status: "running", runState: "provisioning" },
    { name: "once the sandbox was up and the application starting", status: "running", runState: "starting" },
    { name: "with the application running", status: "running", runState: "running" },
    { name: "between restarts", status: "running", runState: "restarting" },
  ];
  for (const d of deletedAt) {
    test(`the session deleted ${d.name}: the run is finished, and the task stays a deletion`, async () => {
      await seed({ status: d.status, runState: d.runState, lease: d.lease, workload: d.workload });
      await teardown.commitSessionDeletion("s1");
      assert.equal((await task()).status, "cancelled");
      await aged(grace + 5);
      assert.deepEqual(await tick(), { moved: 1, requeued: 1 });
      assert.equal((await run()).state, "finishing");
      const finished = await finishOnlyBrainFinishes();
      assert.equal(finished.status, "cancelled");
      assert.equal(finished.failure_reason, "session_deleted");
      assert.equal((await run()).state, "ended");
    });
  }

  for (const status of ["cancelling", "cancelled", "failed"]) {
    test(`a ${status} task whose holder is gone: its running run is moved to finishing`, async () => {
      await seed({ status, runState: "running" });
      await sql("UPDATE claw_tasks SET completed_at = CASE WHEN status <> 'cancelling' THEN NOW() END");
      await aged(grace + 5);
      assert.equal(await sweeper.finishAbandonedAppRuns(), 1);
      assert.equal((await run()).state, "finishing");
    });
  }

  const leftAlone: Array<{ name: string; setup: string[]; runState?: string; why: string }> = [
    { name: "a live lease", setup: ["UPDATE claw_tasks SET lease_expires_at = NOW() + INTERVAL '20 seconds'"],
      why: "its holder may still finish it" },
    { name: "a lease gone for less than the grace", setup: ["UPDATE claw_tasks SET lease_expires_at = NOW() - INTERVAL '2 seconds'"],
      why: "a takeover is never preempted" },
    { name: "a task closed less than the grace ago", setup: ["UPDATE claw_tasks SET completed_at = NOW()"],
      why: "the same wait the requeue makes" },
    { name: "an open task", setup: ["UPDATE claw_tasks SET status = 'running', completed_at = NULL"],
      why: "an open task with a dead lease is the lost-lease reaper's" },
    { name: "a finish-only dispatch", setup: [`UPDATE claw_tasks SET status = 'failed', metadata = jsonb_build_object('app_finish_prior', jsonb_build_object('status', 'cancelled'))`],
      why: "the finish-only passes own it" },
    { name: "a run already finishing", setup: [], runState: "finishing", why: "the requeue owns it" },
    { name: "a run already ended", setup: [], runState: "ended", why: "nothing is left to finish" },
  ];
  for (const l of leftAlone) {
    test(`left alone: ${l.name}`, async () => {
      await seed({ status: "cancelled", runState: l.runState ?? "provisioning" });
      await aged(grace + 5);
      await sql("UPDATE claw_tasks SET completed_at = NOW() - ($1::int * INTERVAL '1 second')", [grace + 5]);
      for (const s of l.setup) await sql(s);
      const before = await run();
      assert.equal(await sweeper.finishAbandonedAppRuns(), 0, l.why);
      assert.deepEqual(await run(), before, "the run row is untouched");
    });
  }

  test("the restart history is not carried into the finish; a shared-storage read already made is", async () => {
    await seed({
      status: "cancelled", runState: "restarting",
      lastExit: { at: "2026-11-06T10:00:00Z", cause: "exit", final: false, returncode: 1, recovery: true, stop_at: "2026-11-06T10:00:01Z", grant_restart: true },
    });
    await sql("UPDATE claw_tasks SET completed_at = NOW()");
    await aged(grace + 5);
    assert.equal(await sweeper.finishAbandonedAppRuns(), 1);
    const exit = (await run()).last_exit;
    assert.deepEqual(Object.keys(exit).sort(), ["at", "cause", "final", "recovery"]);
    assert.equal(exit.cause, "row_terminal");
    assert.equal(exit.recovery, true, "the reader sandbox is not made a second time");
  });
});
