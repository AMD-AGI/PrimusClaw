// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * An app run whose holder went away is handed to another Brain, not closed as `worker_lost`.
 *
 * The case (hosting, 2026-11-08): a three-hour app run's Brain was drained by a release 3 h 16 min
 * in. The task stream keeps a message for 2 h 41 min, so there was nothing left to redeliver;
 * nobody took the run over, and the lost-lease reaper closed the task as `failed` / `worker_lost`
 * ten minutes later -- while the application finished normally in between and wrote
 * `final: true, returncode: 0` to its state directory. Here the same rows are put through the
 * sweeper's passes, in its tick's order, against a real Postgres (skipped without DATABASE_URL,
 * and a skip is not a pass).
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { after, before, beforeEach, describe } from "node:test";

import Fastify, { type FastifyInstance } from "fastify";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startAdmissionCluster, type AdmissionCluster } from "./support/admission-cluster.js";

const skip = postgresSkipReason();
const WORKLOAD = "claw-0001-sandbox-abcde";
const STATE_DIR = "/shared/users/u-1/.claw-apps/app-1";
/** The stream sequence of the message the drained holder was executing. */
const SEQ = 4242;
/** A lock value as Brain writes one. */
const HELD = new TextEncoder().encode(JSON.stringify({ holderId: "h", seq: SEQ, task: "app-1" }));

describe("an app run whose holder went away is taken over, not closed", { skip }, () => {
  let c: AdmissionCluster;
  let sweeper: typeof import("../src/tasks/sweeper.js");
  let state: typeof import("../src/tasks/app-run-state.js");
  let dispatcher: typeof import("../src/tasks/dispatcher.js");
  let grace: number;
  let routes: FastifyInstance;
  /** Sequences the task stream still holds; anything else is gone (the stream's max_age dropped it). */
  const inStream = new Set<number>();
  const asked: number[] = [];
  /** Tasks whose `lock.app.<task_id>` a Brain still holds. */
  const locked = new Set<string>();
  let realLockFree: (typeof import("../src/tasks/sweeper.js"))["appTakeoverPorts"]["runLockFree"];
  let realGone: (typeof import("../src/tasks/sweeper.js"))["appTakeoverPorts"]["taskMessageGone"];
  const published: Array<Record<string, any>> = [];
  const sql = async (text: string, params: unknown[] = []) => (await c.app.db.db.query(text, params)).rows as any[];

  before(async () => {
    c = await startAdmissionCluster({ APP_RUNS_ENABLED: "true", CLAW_DEPLOY_MODE: "kubernetes", LLM_KEY_SOURCE: "virtualKey" });
    sweeper = await import("../src/tasks/sweeper.js");
    state = await import("../src/tasks/app-run-state.js");
    dispatcher = await import("../src/tasks/dispatcher.js");
    grace = (await import("../src/config.js")).LEASE_LOST_GRACE_SEC;
    realGone = sweeper.appTakeoverPorts.taskMessageGone;
    // The real port, over a stream that answers like NATS does: 10037 for a message it no longer has.
    realLockFree = sweeper.appTakeoverPorts.runLockFree;
    // The real port, over a registry that holds the locks in `locked` and has none for anything else.
    sweeper.appTakeoverPorts.runLockFree = (taskId) => realLockFree(taskId, async (key) =>
      (locked.has(key.replace(/^lock\.app\./, "")) ? { operation: "PUT", value: HELD } : null));
    sweeper.appTakeoverPorts.taskMessageGone = (seq) => {
      asked.push(seq);
      return realGone(seq, async (n) => {
        if (inStream.has(n)) return { seq: n };
        throw Object.assign(new Error("no message found"), { code: "404", api_error: { err_code: 10037 } });
      });
    };
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
    inStream.clear();
    locked.clear();
    asked.length = 0;
    await sql(`INSERT INTO claw_sessions (session_id, name, user_id, mode, agent_status, config)
               VALUES ('s1', 't', 'u-1', 'claw', 'idle', '{"platform_key":"pk","_server_managed_credentials":true}'::jsonb)`);
    await sql("INSERT INTO claw_plugins (plugin_id, name) VALUES (8, 'p') ON CONFLICT DO NOTHING").catch(() => undefined);
  });

  /** An app run three hours in, held by brain-A, whose lease ran out `ageSec` ago. */
  async function seed(opts: { runState?: string; ageSec?: number; requeues?: number; deadlinePast?: boolean; status?: string }) {
    await sql(
      `INSERT INTO claw_tasks (task_id, session_id, name, status, origin, mode, executor,
                               lease_owner, lease_expires_at, heartbeat_at, claim_count, callback_url,
                               started_at, deadline_at, metadata, delivery_seq)
       VALUES ('app-1', 's1', 'app', $1, 'task', 'app', 'brain',
               'brain-A', NOW() - ($2::int * INTERVAL '1 second'), NOW() - ($2::int * INTERVAL '1 second') - INTERVAL '15 seconds', 3,
               'http://api/v1/internal/tasks/app-1', NOW() - INTERVAL '3 hours',
               CASE WHEN $3 THEN NOW() - INTERVAL '1 minute' ELSE NOW() + INTERVAL '2 days' END,
               CASE WHEN $4::int IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('app_takeover_requeues', $4::int) END, $5)`,
      [opts.status ?? "running", opts.ageSec ?? grace + 5, opts.deadlinePast === true, opts.requeues ?? null, SEQ],
    );
    await sql(
      `INSERT INTO claw_app_runs (task_id, session_id, plugin_id, manifest, state, state_dir, sandbox_workload_id, mcp_token_enc, grant_id)
       VALUES ('app-1', 's1', 8, '{}'::jsonb, $1, $2, $3, 'x', 'gr-1')`,
      [opts.runState ?? "running", STATE_DIR, WORKLOAD],
    );
  }
  const task = async () => (await sql(
    `SELECT status, failure_reason, lease_owner, lease_expires_at, started_at, deadline_at, claim_count, captures, metadata
       FROM claw_tasks WHERE task_id='app-1'`))[0];
  /** Time passes: the task was closed `sec` seconds ago. */
  const closedAgo = (sec: number) => sql(
    "UPDATE claw_tasks SET completed_at = NOW() - ($1::int * INTERVAL '1 second') WHERE task_id = 'app-1'", [sec]);
  const run = async () => (await sql("SELECT state, last_exit FROM claw_app_runs WHERE task_id='app-1'"))[0];

  /** The sweeper's passes that touch an app run with a dead lease, in its tick's order (checked below). */
  async function tick(): Promise<void> {
    await sweeper.settleEndedFinishOnlyRuns();
    await sweeper.requeueLostAppLeases();
    await sweeper.reapLostLeases();
    await sweeper.finishAbandonedAppRuns();
    await sweeper.giveUpExhaustedAppFinishes();
    await sweeper.requeueUnfinishedAppRuns();
  }

  /** The first lease of the Brain that took the new dispatch: its attempt, on the new message (a later stream sequence). */
  const takeoverLease = async () => ({
    brain_id: "brain-B", lease_seconds: 45, attempt_id: "att-takeover",
    claim_count: Number((await task()).claim_count), delivery_seq: SEQ + 1, delivery_count: 1,
  });
  const post = async (req: Record<string, any>, path: string, payload: object) => (await routes.inject({
    method: "POST", url: `/v1/internal/tasks/app-1/${path}`,
    headers: { authorization: `Bearer ${req.backend_internal_token}` }, payload,
  })).statusCode;

  test("the sweeper's tick hands a lost app lease over before the lost-lease reaper can close it", async () => {
    const src = await readFile(new URL("../src/tasks/sweeper.ts", import.meta.url), "utf8");
    const body = src.slice(src.indexOf("export async function sweeperTick"));
    const requeue = body.indexOf("requeueLostAppLeases)");
    const reap = body.indexOf("reapLostLeases)");
    assert.ok(requeue > 0, "sweeperTick runs requeueLostAppLeases");
    assert.ok(requeue < reap, "and before reapLostLeases");
  });

  test("a run whose holder was drained 3 h in is requeued for a takeover, not failed as worker_lost", async () => {
    await seed({});
    const before = await task();
    await tick();
    const t = await task();
    assert.equal(t.status, "queued", "handed to the scheduler again");
    assert.equal(t.failure_reason, null, "never closed");
    assert.equal(t.lease_owner, null);
    assert.equal(t.lease_expires_at, null);
    assert.equal(t.metadata.app_takeover_requeues, 1);
    assert.equal(t.metadata.app_finish_prior, undefined, "a takeover, not a finish-only dispatch");
    assert.equal(t.started_at.getTime(), before.started_at.getTime(), "the run has not started again");
    assert.equal(t.deadline_at.getTime(), before.deadline_at.getTime(), "nor been given a new budget");
    assert.equal((await run()).state, "running", "the run row is the new holder's to reconcile");

    // The scheduler's dispatch: an ordinary app dispatch, which the next Brain takes the run over from.
    assert.deepEqual(await dispatcher.dispatchTask("app-1"), { ok: true });
    const req = published.at(-1)!;
    assert.equal(req.mode, "app");
    assert.equal(req.app_finish_only, undefined);
    assert.equal(await post(req, "lease", await takeoverLease()), 200);
    const held = await task();
    assert.equal(held.lease_owner, "brain-B");
    const fence = { brainId: "brain-B", claimCount: Number(held.claim_count) };
    assert.equal((await state.patchAppRun("app-1", fence, {
      state: "finishing", last_exit: { at: "t", cause: "exit", final: true, returncode: 0, stop_reason: "time_exhausted" },
    }, "running")).ok, true, "the new holder drives the run row");
    assert.equal((await state.patchAppRun("app-1", { brainId: "brain-A", claimCount: 3 }, { state: "ended" })).ok, false,
      "the drained holder cannot");
  });

  test("inside the grace the run is left for a redelivery that may still be coming", async () => {
    await seed({ ageSec: 5 });
    await tick();
    const t = await task();
    assert.equal(t.status, "running");
    assert.equal(t.lease_owner, "brain-A");
  });

  for (const runState of ["provisioning", "starting", "running", "restarting"]) {
    test(`a run row in ${runState} is taken over`, async () => {
      await seed({ runState });
      assert.equal(await sweeper.requeueLostAppLeases(), 1);
      assert.equal((await task()).status, "queued");
    });
  }

  test("past the bound the run is closed as worker_lost, and its finish still reads the result it left", async () => {
    await seed({ requeues: sweeper.APP_TAKEOVER_REQUEUE_MAX });
    await tick();
    const lost = await task();
    assert.equal(lost.status, "failed", "closed by the lost-lease reaper, as before");
    assert.equal(lost.failure_reason, "worker_lost");
    await closedAgo(grace + 5);
    await tick();
    const closed = await task();
    assert.equal(closed.status, "queued", "reopened only to be finished");
    assert.equal(closed.metadata.app_finish_prior.failure_reason, "worker_lost");
    assert.equal((await run()).state, "finishing");
    assert.deepEqual(await dispatcher.dispatchTask("app-1"), { ok: true });
    const req = published.at(-1)!;
    assert.equal(req.app_finish_only, true);
    assert.equal(await post(req, "lease", await takeoverLease()), 200);
    const fence = { brainId: "brain-B", claimCount: Number((await task()).claim_count) };
    // The finish read `exit.json` through a reader: the application's own final result, as the
    // row holds it once written (the write path's secret scrub is not this suite's subject, and
    // this fixture has no secrets to open, so the row is set directly).
    await sql(`UPDATE claw_app_runs SET last_exit = '{"at":"t","cause":"exit","final":true,"returncode":0,"stop_reason":"time_exhausted"}'::jsonb
                WHERE task_id = 'app-1'`);
    assert.equal((await state.patchAppRun("app-1", fence, { state: "ended" }, "finishing")).ok, true);
    assert.equal(await post(req, "app_finish_done", { brain_id: "brain-B" }), 200);
    const t = await task();
    assert.equal(t.status, "completed", "a success, not the worker_lost the reaper wrote");
    assert.equal(t.failure_reason, null);
    assert.equal(t.captures.stop_reason, "time_exhausted", "the application's stop reason is kept");
    assert.equal(t.captures.session_dir, STATE_DIR);
  });

  test("a finish that did not find a successful final keeps the failure", async () => {
    await seed({ requeues: sweeper.APP_TAKEOVER_REQUEUE_MAX });
    await tick();
    await closedAgo(grace + 5);
    await tick();
    assert.deepEqual(await dispatcher.dispatchTask("app-1"), { ok: true });
    const req = published.at(-1)!;
    assert.equal(await post(req, "lease", await takeoverLease()), 200);
    const fence = { brainId: "brain-B", claimCount: Number((await task()).claim_count) };
    await sql(`UPDATE claw_app_runs SET last_exit = '{"at":"t","cause":"exit","final":true,"returncode":2,"stop_reason":"crashed"}'::jsonb
                WHERE task_id = 'app-1'`);
    assert.equal((await state.patchAppRun("app-1", fence, { state: "ended" }, "finishing")).ok, true);
    assert.equal(await post(req, "app_finish_done", { brain_id: "brain-B" }), 200);
    const t = await task();
    assert.equal(t.status, "failed");
    assert.equal(t.failure_reason, "worker_lost");
    assert.deepEqual(t.captures, {}, "captures are a success's");
  });

  test("while the stream still holds the message, the run is left to its redelivery and then closed as before", async () => {
    // A second dispatch beside a message that can still be redelivered would let that stale copy,
    // whose token the new dispatch replaces, take the run's lock first.
    await seed({});
    inStream.add(SEQ);
    await tick();
    assert.deepEqual(asked, [SEQ], "the stream was asked about the message the holder was executing");
    const t = await task();
    assert.equal(t.status, "failed", "not requeued: the lost-lease reaper closes it, as before this change");
    assert.equal(t.failure_reason, "worker_lost");
    assert.equal(t.metadata.app_takeover_requeues, undefined);
  });

  test("a Brain still holding the run's lock keeps the run, whatever its database lease says", async () => {
    // Its lease renewals stopped landing (the API unreachable from it), but it still refreshes
    // the lock and runs the app: a new dispatch would only wait behind that lock.
    await seed({});
    locked.add("app-1");
    assert.equal(await sweeper.requeueLostAppLeases(), 0);
    assert.equal((await task()).status, "running");
    locked.clear();
    assert.equal(await sweeper.requeueLostAppLeases(), 1, "once the lock is gone, the run is handed over");
  });

  test("the lock read: no entry or a release's tombstone is free; an entry, or a read that fails, is not", async () => {
    assert.equal(await realLockFree("app-1", async () => null), true);
    assert.equal(await realLockFree("app-1", async () => ({ operation: "DEL", value: new Uint8Array() })), true);
    assert.equal(await realLockFree("app-1", async () => ({ operation: "PURGE", value: new Uint8Array() })), true);
    assert.equal(await realLockFree("app-1", async () => ({ operation: "PUT", value: new Uint8Array() })), true, "an empty value, as Brain reads it");
    assert.equal(await realLockFree("app-1", async () => ({ operation: "PUT", value: HELD })), false);
    assert.equal(await realLockFree("app-1", async () => { throw new Error("TIMEOUT"); }), false);
    const keys: string[] = [];
    await realLockFree("ktsk_1", async (k) => { keys.push(k); return null; });
    assert.deepEqual(keys, ["lock.app.ktsk_1"], "the key Brain's pickLockKey gives an app run");
  });

  test("a row that names no message is not requeued: there is nothing to ask the stream about", async () => {
    await seed({});
    await sql("UPDATE claw_tasks SET delivery_seq = 0");
    assert.equal(await sweeper.requeueLostAppLeases(), 0);
  });

  test("a stream that cannot be read is not taken as a message gone", async () => {
    const gone = async () => { throw Object.assign(new Error("no message found"), { code: "404", api_error: { err_code: 10037 } }); };
    const noStream = async () => { throw Object.assign(new Error("stream not found"), { code: "404", api_error: { err_code: 10059 } }); };
    const timeout = async () => { throw new Error("TIMEOUT"); };
    const held = async () => ({ seq: SEQ });
    assert.equal(await realGone(SEQ, gone), true, "only the stream's own 'no message found'");
    assert.equal(await realGone(SEQ, noStream), false, "a missing stream is not a missing message");
    assert.equal(await realGone(SEQ, timeout), false);
    assert.equal(await realGone(SEQ, held), false);
    assert.equal(await realGone(0, gone), false, "no sequence, no answer");
  });

  const leftAlone: Array<{ name: string; seed: Parameters<typeof seed>[0]; setup?: string; why: string }> = [
    { name: "past the task's deadline", seed: { deadlinePast: true }, why: "the deadline closes it" },
    { name: "a run already finishing", seed: { runState: "finishing" }, why: "requeueUnfinishedAppRuns owns it" },
    { name: "a run already ended", seed: { runState: "ended" }, why: "nothing to take over" },
    { name: "a cancelling task", seed: { status: "cancelling" }, why: "a cancel is not resumed" },
    { name: "a finish-only dispatch", seed: {},
      setup: "UPDATE claw_tasks SET metadata = jsonb_build_object('app_finish_prior', jsonb_build_object('status', 'failed'))",
      why: "the finish-only passes own it" },
    { name: "a chat run", seed: {}, setup: "UPDATE claw_tasks SET mode = 'llm'", why: "only app runs" },
  ];
  for (const l of leftAlone) {
    test(`not taken over: ${l.name}`, async () => {
      await seed(l.seed);
      if (l.setup) await sql(l.setup);
      assert.equal(await sweeper.requeueLostAppLeases(), 0, l.why);
      assert.notEqual((await task()).status, "queued");
    });
  }
});
