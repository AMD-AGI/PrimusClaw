// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The AppRunner's state machine, against the fake world in
 * support/app-runner-world.ts: a fake row, a fake SaFE and a fake EnvD, and a
 * fake clock, so no sandbox exists anywhere.
 *
 * What is checked is the design's transition table (5.3.2) row by row, and the
 * five things a mistake here would cost: a run restarted after `final: true`,
 * restarts past `max_restarts`, a second application process beside a live one,
 * the MCP token or a key in a log, an event or the stored `last_exit`, and the
 * llm/script paths changing (the existing suites).
 *
 * pino writes through `process.stdout.write` only while it is still the
 * prototype's (see fixtures/run-identity-logs.ts), so the capture below is
 * installed before anything imports the runner.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { validateAppManifest } from "@claw/protocol";

const captured: string[] = [];
const realWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
  captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8"));
  return (realWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
}) as typeof process.stdout.write;

const { AppRunner, outcomeOf, backoffMs, parseExit, noopAppGrant } = await import("../src/apps/app-runner.js");
const { AppRunWriteRefused } = await import("../src/apps/app-run-store.js");
const { buildAppEnv } = await import("../src/apps/app-env.js");
const W = await import("./support/app-runner-world.js");
const { World, MANIFEST, RUN_ID, STATE_DIR, TOKEN, KEY_M, KEY_S, T0 } = W;

import type { AppGrantRunHooks, AppRunnerSeams } from "../src/apps/app-runner.js";
import type { AppManifestV1 } from "@claw/protocol";

test("the fixture manifest is valid, or every case below is vacuous", () => {
  assert.deepEqual(validateAppManifest(MANIFEST), []);
});
const PLATFORM_KEY = "ak-platform-key-0123456789";


function harness(opts: {
  manifest?: AppManifestV1; grant?: AppGrantRunHooks; seams?: AppRunnerSeams; over?: object;
} = {}) {
  const world = new World(opts.manifest ?? MANIFEST, opts.over);
  const runner = () => new AppRunner(RUN_ID, PLATFORM_KEY, {
    store: world.store, sandbox: world.sandbox, grant: opts.grant, seams: opts.seams,
    now: world.now, sleep: world.sleep, tickMs: 5000,
  });
  return { world, runner: runner(), newRunner: runner };
}
type H = ReturnType<typeof harness>;

/** Reconcile until the row is in `state`, at most `max` ticks. */
async function until(h: H, state: string, max = 12) {
  for (let i = 0; i < max && h.world.rec.state !== state; i++) await h.runner.reconcile();
  assert.equal(h.world.rec.state, state, `never reached ${state}`);
}

/** Bring the run to `running` with the application alive. */
async function toRunning(h: H) {
  await until(h, "running");
  assert.equal(h.world.starts.length, 1);
  return h.world.rec.sandbox_workload_id!;
}

const finalExit = (returncode: number, extra: object = {}) => ({ final: true, returncode, ...extra });

// ---------------------------------------------------------------------------
// The transition table (5.3.2), one row per test
// ---------------------------------------------------------------------------

test("T1 provisioning -> starting: the sandbox is ensured and its id kept", async () => {
  const h = harness();
  const r = await h.runner.reconcile();
  assert.deepEqual(r, { done: false });
  assert.equal(h.world.rec.state, "starting");
  assert.equal(h.world.rec.sandbox_workload_id, "wl-1");
  assert.deepEqual(h.world.created, ["wl-1"]);
  assert.equal(h.world.starts.length, 0, "nothing is started in the provisioning tick");
});

test("T2 starting: state_dir expanded once and persisted, files written, app started detached", async () => {
  const h = harness();
  await h.runner.reconcile();
  await h.runner.reconcile();
  const { world } = h;
  assert.equal(world.rec.state_dir, STATE_DIR);
  assert.equal(world.files.get(`${STATE_DIR}/input.json`), JSON.stringify(world.rec.input));
  assert.equal(world.files.get(`${STATE_DIR}/boot/start.sh`), "#!/bin/sh\necho boot\n");
  assert.equal(world.starts.length, 1);
  const start = world.starts[0]!;
  assert.match(start.command, /setsid 'python' '-m' 'app' '--name' 'it'\\''s' >>app\.log 2>&1 <\/dev\/null & echo \$! >app\.pid/);
  assert.equal(start.tag, "wl-1:0");

  // The state dir is expanded only the first time, not on every start.
  const expansions = () => world.execs.filter((e) => e.command.includes("USER_DATA_PATH")).length;
  assert.equal(expansions(), 1);
  await h.runner.reconcile();
  assert.equal(expansions(), 1);
});

test("T3 starting -> running once the process answers the probe", async () => {
  const h = harness();
  await until(h, "starting");
  await h.runner.reconcile();
  assert.equal(h.world.rec.state, "starting", "the launch tick does not also claim the process is up");
  await h.runner.reconcile();
  assert.equal(h.world.rec.state, "running");
});

test("T4 running with a live process: nothing changes and nothing is started", async () => {
  const h = harness();
  await toRunning(h);
  for (let i = 0; i < 5; i++) await h.runner.reconcile();
  assert.equal(h.world.rec.state, "running");
  assert.equal(h.world.starts.length, 1);
  assert.equal(h.world.rec.restarts, 0);
});

test("T5 running -> finishing -> ended when exit.json is final with return code 0: success", async () => {
  const h = harness();
  const wl = await toRunning(h);
  h.world.appExits(wl, finalExit(0, { stop_reason: "target reached" }));
  await h.runner.reconcile();
  assert.equal(h.world.rec.state, "finishing");
  assert.equal(h.world.rec.restarts, 0);
  const r = await h.runner.reconcile();
  assert.deepEqual(r, { done: true, outcome: { success: true, reason: "app finished", captures: { session_dir: STATE_DIR, stop_reason: "target reached" } } });
  assert.equal(h.world.rec.state, "ended");
  assert.equal(h.world.starts.length, 1);
  assert.deepEqual(h.world.stopped, [wl]);
});

for (const rc of [1, 2, 137, 255]) {
  test(`T6 final:true with return code ${rc}: finishing as failed, zero restarts, never started again`, async () => {
    const h = harness();
    const wl = await toRunning(h);
    h.world.appExits(wl, finalExit(rc));
    await h.runner.reconcile();
    assert.equal(h.world.rec.state, "finishing");
    const r = await h.runner.reconcile();
    assert.equal(r.done, true);
    assert.equal(r.done && r.outcome.success, false);
    assert.match(r.done ? r.outcome.reason : "", new RegExp(`return code ${rc}`));
    assert.equal(h.world.rec.restarts, 0, "a final exit is never a restart");
    assert.equal(h.world.starts.length, 1, "FINAL must not be run a second time");
    // Many more ticks change nothing.
    for (let i = 0; i < 4; i++) await h.runner.reconcile();
    assert.equal(h.world.starts.length, 1);
  });
}

test("T7 running -> restarting -> starting when the process died without final, after the backoff", async () => {
  const h = harness();
  const wl = await toRunning(h);
  h.world.appExits(wl); // no exit.json at all
  await h.runner.reconcile();
  assert.equal(h.world.rec.state, "restarting");
  assert.equal(h.world.rec.restarts, 1);
  assert.equal(h.world.rec.last_exit?.cause, "exit");

  // backoff_sec[0] = 10 s: nothing happens before it, and the app is not started.
  h.world.clock += 9_000;
  await h.runner.reconcile();
  assert.equal(h.world.rec.state, "restarting");
  h.world.clock += 1_000;
  await h.runner.reconcile();
  assert.equal(h.world.rec.state, "starting");
  await h.runner.reconcile();
  assert.equal(h.world.starts.length, 2);
  assert.equal(h.world.starts[1]!.tag, `${wl}:1`);
  await h.runner.reconcile();
  assert.equal(h.world.rec.state, "running");
});

test("T8 restart n waits backoff_sec[min(n-1, length-1)]", () => {
  assert.equal(backoffMs(MANIFEST, 1), 10_000);
  assert.equal(backoffMs(MANIFEST, 2), 30_000);
  assert.equal(backoffMs(MANIFEST, 9), 30_000, "past the end of the list it stays on the last entry");
  assert.equal(backoffMs({ ...MANIFEST, restart: { max_restarts: 1, backoff_sec: [] } }, 1), 0);
  assert.equal(backoffMs({ ...MANIFEST, restart: undefined }, 1), 0);
});

test("T9 final absent x (max_restarts + 1): finishing as failed, restarts == max, app started max+1 times", async () => {
  const h = harness(); // max_restarts: 2
  let wl = await toRunning(h);
  for (let crash = 1; crash <= 3; crash++) {
    h.world.appExits(wl); // crashes, and writes no exit.json
    await h.runner.reconcile();
    if (crash <= 2) {
      assert.equal(h.world.rec.state, "restarting", `crash ${crash}`);
      assert.equal(h.world.rec.restarts, crash);
      h.world.clock += 60_000;
      await until(h, "running");
      wl = h.world.rec.sandbox_workload_id!;
    }
  }
  assert.equal(h.world.rec.state, "finishing");
  assert.equal(h.world.rec.restarts, 2, "never above max_restarts");
  assert.equal(h.world.rec.last_exit?.cause, "restarts_exhausted");
  const r = await h.runner.reconcile();
  assert.equal(r.done && r.outcome.success, false);
  assert.equal(h.world.starts.length, 3, "initial start + max_restarts restarts, and no more");
  for (let i = 0; i < 4; i++) await h.runner.reconcile();
  assert.equal(h.world.starts.length, 3);
});

test("T10 final:false is not final: it restarts", async () => {
  const h = harness();
  const wl = await toRunning(h);
  h.world.appExits(wl, { final: false, returncode: 1 });
  await h.runner.reconcile();
  assert.equal(h.world.rec.state, "restarting");
});

test("T11 a manifest with no restart policy fails the run on the first non-final exit", async () => {
  const h = harness({ manifest: { ...MANIFEST, restart: undefined } });
  const wl = await toRunning(h);
  h.world.appExits(wl);
  await h.runner.reconcile();
  assert.equal(h.world.rec.state, "finishing");
  assert.equal(h.world.rec.restarts, 0);
});

for (const phase of ["terminal", "absent"] as const) {
  test(`T12 sandbox lost (${phase}) while running -> provisioning, counted as a restart, then a new sandbox`, async () => {
    const h = harness();
    const wl = await toRunning(h);
    h.world.killWorkload(wl, phase);
    await h.runner.reconcile();
    assert.equal(h.world.rec.state, "provisioning");
    assert.equal(h.world.rec.restarts, 1);
    assert.equal(h.world.rec.sandbox_workload_id, null);
    assert.equal(h.world.rec.last_exit?.cause, "sandbox_lost");
    await until(h, "running");
    assert.equal(h.world.rec.sandbox_workload_id, "wl-2");
    assert.equal(h.world.starts.length, 2);
    assert.equal(h.world.starts[1]!.wl, "wl-2");
  });
}

test("T13 sandbox lost in starting and in restarting also goes to provisioning, counted", async () => {
  const h = harness();
  await until(h, "starting");
  h.world.killWorkload(h.world.rec.sandbox_workload_id!, "terminal");
  await h.runner.reconcile();
  assert.equal(h.world.rec.state, "provisioning");
  assert.equal(h.world.rec.restarts, 1);

  const g = harness();
  const wl = await toRunning(g);
  g.world.appExits(wl);
  await g.runner.reconcile();
  assert.equal(g.world.rec.state, "restarting");
  g.world.killWorkload(wl, "absent");
  await g.runner.reconcile();
  assert.equal(g.world.rec.state, "provisioning");
  assert.equal(g.world.rec.restarts, 2);
});

test("T14 a lost sandbox past max_restarts ends the run as failed, never above the bound, never starting again", async () => {
  const h = harness({ manifest: { ...MANIFEST, restart: { max_restarts: 1, backoff_sec: [1] } } });
  let wl = await toRunning(h);
  h.world.killWorkload(wl, "terminal");
  await h.runner.reconcile();
  await until(h, "running");
  wl = h.world.rec.sandbox_workload_id!;
  assert.equal(h.world.rec.restarts, 1);
  h.world.killWorkload(wl, "terminal");
  await h.runner.reconcile();
  // The budget is spent: one more sandbox only to look for a final exit, restarts unchanged.
  assert.equal(h.world.rec.state, "provisioning");
  assert.equal(h.world.rec.restarts, 1);
  assert.equal(h.world.rec.last_exit?.recovery, true);
  await until(h, "finishing");
  assert.equal(h.world.rec.restarts, 1);
  assert.equal(h.world.rec.last_exit?.cause, "restarts_exhausted");
  assert.equal(h.world.starts.length, 2, "the recovery sandbox starts nothing");
  const r = await h.runner.reconcile();
  assert.equal(r.done && r.outcome.success, false);
});

test("T14b a final exit hidden by a lost sandbox is found even with the budget spent: success, not 'exhausted'", async () => {
  const h = harness({ manifest: { ...MANIFEST, restart: { max_restarts: 0, backoff_sec: [] } } });
  const wl = await toRunning(h);
  h.world.appExits(wl, finalExit(0));
  h.world.killWorkload(wl, "terminal");
  await h.runner.reconcile();
  assert.equal(h.world.rec.state, "provisioning");
  await until(h, "finishing");
  assert.equal(h.world.rec.last_exit?.final, true);
  const r = await h.runner.reconcile();
  assert.deepEqual(r, { done: true, outcome: { success: true, reason: "app finished", captures: { session_dir: STATE_DIR } } });
  assert.equal(h.world.starts.length, 1, "FINAL is not run again");
  assert.equal(h.world.rec.restarts, 0);
});

test("T14c losing the recovery sandbox too ends the run as failed: one look, not a loop", async () => {
  const h = harness({ manifest: { ...MANIFEST, restart: { max_restarts: 0, backoff_sec: [] } } });
  const wl = await toRunning(h);
  h.world.killWorkload(wl, "terminal");
  await h.runner.reconcile();
  assert.equal(h.world.rec.state, "provisioning");
  await h.runner.reconcile(); // provisioning -> starting
  h.world.killWorkload(h.world.rec.sandbox_workload_id!, "terminal");
  await h.runner.reconcile();
  assert.equal(h.world.rec.state, "finishing");
  assert.equal(h.world.rec.last_exit?.cause, "restarts_exhausted");
  assert.deepEqual(h.world.created, ["wl-1", "wl-2"]);
});

test("T14d a sandbox lost before the app ever started (no state dir) has nothing to recover", async () => {
  const h = harness({ manifest: { ...MANIFEST, restart: { max_restarts: 0, backoff_sec: [] } } });
  await h.runner.reconcile(); // provisioning -> starting, state_dir still null
  h.world.killWorkload(h.world.rec.sandbox_workload_id!, "terminal");
  await h.runner.reconcile();
  assert.equal(h.world.rec.state, "finishing");
});

test("T15 a sandbox lost after the app finished ends the run, it does not repeat it", async () => {
  const h = harness();
  const wl = await toRunning(h);
  // The app wrote its final exit.json to shared storage and the sandbox died before the next tick.
  h.world.appExits(wl, finalExit(0));
  h.world.killWorkload(wl, "terminal");
  await h.runner.reconcile(); // lost -> provisioning (counted)
  assert.equal(h.world.rec.state, "provisioning");
  await until(h, "finishing");
  assert.equal(h.world.starts.length, 1, "FINAL is not run again in the replacement sandbox");
  const r = await h.runner.reconcile();
  assert.equal(r.done && r.outcome.success, true);
});

test("T16 finishing: seams in order, revoke before the sandbox is stopped, then ended", async () => {
  const order: string[] = [];
  const grant: AppGrantRunHooks = { env: async () => ({}), revoke: async (run) => { order.push(`revoke:${run.runId}`); }, extend: noopAppGrant.extend };
  const seams: AppRunnerSeams = {
    drainEvents: async () => { order.push("drain"); },
    unregisterMcp: async () => { order.push("unregister"); },
    stopApplication: async () => { order.push("stop-app"); },
  };
  const h = harness({ grant, seams });
  const wl = await toRunning(h);
  const origStop = h.world.sandbox.stop;
  h.world.sandbox.stop = async (i) => { order.push("stop-sandbox"); return origStop(i); };
  h.world.appExits(wl, finalExit(0));
  await until(h, "ended");
  assert.deepEqual(order, ["drain", `revoke:${RUN_ID}`, "unregister", "stop-sandbox"], "no stopApplication for a normal end");
});

test("T17 a run that is already ended answers from its row, and does nothing", async () => {
  const h = harness({ over: { state: "ended", last_exit: { at: "x", cause: "exit", final: true, returncode: 0 } } });
  const r = await h.runner.reconcile();
  assert.deepEqual(r, { done: true, outcome: { success: true, reason: "app finished" } });
  assert.equal(h.world.execs.length, 0);
  assert.equal(h.world.stopped.length, 0);
});

// ---------------------------------------------------------------------------
// A second process is never started beside a live one
// ---------------------------------------------------------------------------

test("S1 reconcile racing itself starts the app once", async () => {
  const h = harness();
  await until(h, "starting");
  const [a, b, c] = await Promise.all([h.runner.reconcile(), h.runner.reconcile(), h.runner.reconcile()]);
  assert.deepEqual(a, b);
  assert.deepEqual(b, c);
  assert.equal(h.world.starts.length, 1);
  // Not merely one process: one launch attempt. The sandbox-side guard of S2 would
  // also keep the process count at one while two ticks each tried to start it.
  assert.equal(h.world.execs.filter((e) => e.command.includes("setsid")).length, 1, "ticks overlapped");
});

test("S2 two Brains deciding at once: the start command itself refuses a second process", async () => {
  const h = harness();
  await until(h, "starting");
  const other = h.newRunner(); // a second AppRunner on the same row, as after a takeover
  const [a, b] = await Promise.all([h.runner.reconcile(), other.reconcile()]);
  void a; void b;
  assert.equal(h.world.starts.length, 1, "the second start found the first one alive and did not launch");
  assert.ok(h.world.execs.some((e) => e.command.includes("setsid")));
});

test("S3 a Brain that takes the run over mid-run continues it without starting a second app", async () => {
  const h = harness();
  const wl = await toRunning(h);
  const successor = h.newRunner();
  for (let i = 0; i < 3; i++) await successor.reconcile();
  assert.equal(h.world.starts.length, 1);
  assert.equal(h.world.rec.state, "running");
  h.world.appExits(wl, finalExit(0));
  await until({ ...h, runner: successor } as H, "ended");
  assert.equal(h.world.starts.length, 1);
});

test("S4 a takeover during starting (before the start) starts it exactly once", async () => {
  const h = harness();
  await until(h, "starting");
  const successor = h.newRunner();
  await successor.reconcile();
  await successor.reconcile();
  await h.runner.reconcile();
  assert.equal(h.world.starts.length, 1);
});

test("S5 a stale pid file from a gone container does not make a new sandbox look started", async () => {
  const h = harness();
  const wl = await toRunning(h);
  h.world.killWorkload(wl, "terminal");
  const pid = h.world.files.get(`${STATE_DIR}/app.pid`)!;
  await h.runner.reconcile(); // -> provisioning
  await until(h, "starting");
  // The replacement container happens to have an unrelated process with the same pid.
  h.world.strangers.add(`${h.world.rec.sandbox_workload_id}:${pid}`);
  await until(h, "running");
  assert.equal(h.world.starts.length, 2, "the app was started in the new sandbox");
});

test("S6 a probe that could not be made changes nothing: not a restart, not a start", async () => {
  const h = harness();
  await toRunning(h);
  h.world.failExec = { left: 3, when: (c) => c.includes("echo none") };
  for (let i = 0; i < 3; i++) await h.runner.reconcile();
  assert.equal(h.world.rec.state, "running");
  assert.equal(h.world.rec.restarts, 0);
  assert.equal(h.world.starts.length, 1);
});

test("S7 an exit.json that could not be read is not 'no final': no restart, the next tick reads it", async () => {
  const h = harness();
  const wl = await toRunning(h);
  h.world.appExits(wl, finalExit(0));
  h.world.failExec = { left: 2, when: (c) => c.includes("exit.json") };
  await h.runner.reconcile();
  await h.runner.reconcile();
  assert.equal(h.world.rec.state, "running", "still waiting, not restarting");
  assert.equal(h.world.rec.restarts, 0);
  await h.runner.reconcile();
  assert.equal(h.world.rec.state, "finishing");
  assert.equal(h.world.starts.length, 1);
});

test("S8 a half-written exit.json is retried; one that stays garbage counts as no final", async () => {
  const h = harness();
  const wl = await toRunning(h);
  h.world.appExits(wl, "{\"final\": tr");
  await h.runner.reconcile();
  await h.runner.reconcile();
  assert.equal(h.world.rec.state, "running");
  h.world.files.set(`${STATE_DIR}/exit.json`, JSON.stringify(finalExit(0)));
  await h.runner.reconcile();
  assert.equal(h.world.rec.state, "finishing", "completed in time: the real answer wins");

  const g = harness();
  const wl2 = await toRunning(g);
  g.world.appExits(wl2, "not json");
  for (let i = 0; i < 3; i++) await g.runner.reconcile();
  assert.equal(g.world.rec.state, "restarting");
});

test("S9 launches that keep failing in one sandbox count as the app failing, and are bounded", async () => {
  const h = harness({ manifest: { ...MANIFEST, restart: { max_restarts: 1, backoff_sec: [1] } } });
  await until(h, "starting");
  h.world.failExec = { left: 100, when: (c) => c.includes("setsid") };
  for (let i = 0; i < 3; i++) await h.runner.reconcile();
  assert.equal(h.world.rec.state, "restarting");
  assert.equal(h.world.rec.restarts, 1);
  h.world.clock += 5_000;
  await h.runner.reconcile();
  for (let i = 0; i < 3; i++) await h.runner.reconcile();
  assert.equal(h.world.rec.state, "finishing", "no more than max_restarts");
  assert.equal(h.world.starts.length, 0);
});

// ---------------------------------------------------------------------------
// The environment: exactly per env_map, and the secrets stay out of everything else
// ---------------------------------------------------------------------------

test("E1 the environment is exactly what env_map says, with the platform's names last", async () => {
  const h = harness();
  await until(h, "running");
  const env = h.world.starts[0]!.env;
  assert.deepEqual(env, {
    STATIC: "1",
    OVERRIDE_ME: "from-manifest", // nothing in the run input (knobs.mode = "from-input") reaches the env
    APP_RUN_ID: RUN_ID,
    APP_CREATED_AT: new Date(T0).toISOString(),
    APP_STATE_DIR: STATE_DIR,
    APP_INPUT_FILE: `${STATE_DIR}/input.json`,
    APP_EVENTS_DIR: `${STATE_DIR}/events`,
    APP_MCP_PORT: "8765",
    APP_MCP_TOKEN: TOKEN,
    APP_KEY_MEASUREMENT: KEY_M,
    CLAW_SESSION_ID: "sess-1",
    NODE_NAME: "node-7",
  });
});

test("E2 only declared facilities are injected: no mcp block, no mcp variables; unmapped means unset", () => {
  const base = {
    runId: "r", sessionId: "s", createdAt: "t", stateDir: "/d", mcpToken: TOKEN,
    grantKeys: {}, grantLimits: null, nodeName: null,
  };
  const noMcp = { ...MANIFEST, mcp: undefined, env: undefined, events: undefined };
  const env = buildAppEnv({ ...base, manifest: noMcp });
  assert.equal(env.APP_MCP_PORT, undefined);
  assert.equal(env.APP_MCP_TOKEN, undefined);
  assert.equal(env.APP_EVENTS_DIR, undefined);
  assert.equal(env.NODE_NAME, undefined, "no node name known: unset, not empty");
  assert.equal(Object.values(env).some((v) => v.includes(TOKEN)), false);
  const bare = buildAppEnv({ ...base, manifest: { ...noMcp, env_map: undefined } });
  assert.deepEqual(bare, { CLAW_SESSION_ID: "s" });
});

test("E3 the grant hook adds keys and limits through env_map; its keys beat the stored ones", async () => {
  const seen: unknown[] = [];
  const grant: AppGrantRunHooks = {
    env: async (run) => { seen.push(run); return { keys: { subrun: KEY_S, measurement: "e2b_overridden-by-the-hook-0123456" }, limits: { max_sandboxes: 4, max_gpus: 8 } }; },
    revoke: async () => undefined,
    extend: noopAppGrant.extend,
  };
  const h = harness({ grant });
  await until(h, "running");
  const env = h.world.starts[0]!.env;
  assert.equal(env.APP_KEY_SUBRUN, KEY_S);
  assert.equal(env.APP_KEY_MEASUREMENT, "e2b_overridden-by-the-hook-0123456");
  assert.equal(env.APP_GRANT_LIMITS, JSON.stringify({ max_sandboxes: 4, max_gpus: 8 }));
  assert.deepEqual(seen, [{
    runId: RUN_ID, sessionId: "sess-1", grantId: null, manifest: MANIFEST,
    platformKey: PLATFORM_KEY, workspaceId: "ws-1",
    sandboxSpec: { handle: "app", image: "img:1" },
  }]);
});

test("E4 the default grant hooks do nothing", async () => {
  assert.deepEqual(await noopAppGrant.env({} as never), {});
  assert.equal(await noopAppGrant.revoke({} as never), undefined);
  const h = harness();
  await until(h, "running");
  assert.equal(h.world.starts[0]!.env.APP_GRANT_LIMITS, undefined);
  assert.equal(h.world.starts[0]!.env.APP_KEY_SUBRUN, undefined);
});

test("E5 the grant is revoked once, at finishing, before the sandbox stops; a failing revoke is retried and then given up on", async () => {
  let calls = 0;
  const grant: AppGrantRunHooks = { env: async () => ({}), revoke: async () => { calls++; throw new Error("auth down"); }, extend: noopAppGrant.extend };
  const h = harness({ grant });
  const wl = await toRunning(h);
  h.world.appExits(wl, finalExit(0));
  await h.runner.reconcile(); // -> finishing
  for (let i = 0; i < 4; i++) await assert.rejects(() => h.runner.reconcile(), /auth down/);
  assert.deepEqual(h.world.stopped, [], "the sandbox is not stopped while the revoke is still being retried");
  const r = await h.runner.reconcile(); // fifth failure: abandoned, the run still ends
  assert.equal(r.done, true);
  assert.equal(calls, 5);
  assert.deepEqual(h.world.stopped, [wl]);
});

test("E6 the MCP token and the keys never appear in a log line, a command, or the stored last_exit", async () => {
  captured.length = 0;
  const h = harness();
  const wl = await toRunning(h);
  // The application, hostile or careless, puts the credentials into its own exit record.
  h.world.appExits(wl, finalExit(3, { stop_reason: `crashed holding ${TOKEN}`, error: `key ${KEY_M} rejected` }));
  await until(h, "ended");

  const text = captured.join("");
  for (const secret of [TOKEN, KEY_M, KEY_S]) {
    assert.equal(text.includes(secret), false, "a secret value reached a log line");
    for (const e of h.world.execs) assert.equal(e.command.includes(secret), false, "a secret value is in a command string");
    assert.equal(JSON.stringify(h.world.rec.last_exit).includes(secret), false, "a secret value is in last_exit");
    assert.equal(JSON.stringify(h.world.patches).includes(secret), false, "a secret value was sent to the API");
  }
  // ...and the run does have them where they belong: the start's env map.
  assert.equal(h.world.starts[0]!.env.APP_MCP_TOKEN, TOKEN);
  assert.ok(text.includes("app_run.transition"), "the capture works, or this proves nothing");
  assert.match(h.world.rec.last_exit?.stop_reason ?? "", /crashed holding \[redacted\]/);
});

test("E7 a failing start does not echo the secrets either", async () => {
  captured.length = 0;
  const h = harness();
  await until(h, "starting");
  const orig = h.world.sandbox.exec;
  h.world.sandbox.exec = async (inst, cmd, t, o) => {
    if (cmd.includes("setsid")) return { exitCode: 1, stdout: "", stderr: `boom ${TOKEN} ${KEY_M}` };
    return orig(inst, cmd, t, o);
  };
  for (let i = 0; i < 3; i++) await h.runner.reconcile();
  const text = captured.join("");
  assert.ok(text.includes("app_run.start_failed"));
  assert.equal(text.includes(TOKEN), false);
  assert.equal(text.includes(KEY_M), false);
});

// ---------------------------------------------------------------------------
// run(): the loop, and what the seams are
// ---------------------------------------------------------------------------

test("R1 run() drives the whole life to ended and reports the outcome", async () => {
  const h = harness();
  const ctrl = new AbortController();
  const origSleep = h.world.sleep;
  let ticks = 0;
  const runner = new AppRunner(RUN_ID, "pk", {
    store: h.world.store, sandbox: h.world.sandbox, now: h.world.now, tickMs: 5000,
    sleep: async (ms) => {
      ticks++;
      if (ticks === 4) h.world.appExits(h.world.rec.sandbox_workload_id!, finalExit(0));
      await origSleep(ms);
    },
  });
  const result = await runner.run(ctrl.signal);
  assert.deepEqual(result, { kind: "ended", outcome: { success: true, reason: "app finished", captures: { session_dir: STATE_DIR } } });
  assert.equal(h.world.rec.state, "ended");
});

test("R2 run() stops at once when the signal fires, and leaves the sandbox alone", async () => {
  const h = harness();
  const ctrl = new AbortController();
  const wl = await toRunning(h);
  ctrl.abort();
  assert.deepEqual(await h.runner.run(ctrl.signal), { kind: "aborted" });
  assert.deepEqual(h.world.stopped, []);
  assert.equal(h.world.alive(wl), true);
});

test("R3 run() reports a lost lease: the API refuses the write because another worker holds the run", async () => {
  const h = harness();
  h.world.failStore = () => new AppRunWriteRefused("not_holder");
  const result = await h.runner.run(new AbortController().signal);
  assert.deepEqual(result, { kind: "superseded" });
});

test("R4 finishNow(cancelled) finishes a running run: SIGTERM, revoke, stop sandbox", async () => {
  const order: string[] = [];
  const grant: AppGrantRunHooks = { env: async () => ({}), revoke: async () => { order.push("revoke"); }, extend: noopAppGrant.extend };
  const h = harness({ grant });
  const wl = await toRunning(h);
  const outcome = await h.runner.finishNow("cancelled");
  assert.equal(outcome.success, false);
  assert.match(outcome.reason, /cancelled/);
  assert.deepEqual(order, ["revoke"]);
  assert.deepEqual(h.world.stopped, [wl]);
  assert.equal(h.world.rec.state, "ended");
});

test("R5 finishing also stops a sandbox the row never recorded", async () => {
  const h = harness();
  await until(h, "provisioning", 1);
  // A create that SaFE accepted but whose id never reached the row.
  h.world.workloads.set("wl-orphan", "running");
  await h.runner.finishNow("cancelled");
  assert.deepEqual(h.world.stopped, ["wl-orphan"]);
});

test("R6 the running seams are called while the app is alive, and a failing seam does not break the machine", async () => {
  let tails = 0, registers = 0;
  const seams: AppRunnerSeams = {
    tailEvents: async () => { tails++; throw new Error("events down"); },
    registerMcp: async () => { registers++; },
  };
  const h = harness({ seams });
  await toRunning(h);
  await h.runner.reconcile();
  await h.runner.reconcile();
  assert.ok(tails >= 2 && registers >= 2);
  assert.equal(h.world.rec.state, "running");
});

test("P1 parseExit: only a boolean true is final", () => {
  assert.equal(parseExit('{"final":true,"returncode":0}')?.final, true);
  for (const doc of ['{}', '{"final":false}', '{"final":"true"}', '{"final":1}', '{"final":null}', '{"returncode":0}']) {
    assert.equal(parseExit(doc)?.final, false, doc);
  }
  assert.equal(parseExit("[]"), null);
  assert.equal(parseExit("garbage"), null);
  assert.equal(parseExit('{"final":true,"returncode":"3"}')?.returncode, null);
});

test("P2 outcomeOf: success needs final and return code 0", () => {
  assert.equal(outcomeOf({ at: "t", cause: "exit", final: true, returncode: 0 }).success, true);
  assert.equal(outcomeOf({ at: "t", cause: "exit", final: true, returncode: 1 }).success, false);
  assert.equal(outcomeOf({ at: "t", cause: "exit", final: true, returncode: null }).success, false);
  assert.equal(outcomeOf({ at: "t", cause: "restarts_exhausted", final: false, returncode: 0 }).success, false);
  assert.equal(outcomeOf(null).success, false);
});

// ---------------------------------------------------------------------------
// Weilei's review round: platform failures, the state dir, supersession, takeover scrubbing
// ---------------------------------------------------------------------------

test("P1 a platform failure while building the environment is not the application failing: no restart is spent", async () => {
  // max_restarts 0: one counted failure would end the run.
  const h = harness({ manifest: { ...MANIFEST, restart: undefined } });
  await until(h, "starting");
  let down = 10;
  const secrets = h.world.store.secrets;
  h.world.store.secrets = async (id) => { if (down-- > 0) throw new Error("API unavailable"); return secrets(id); };
  for (let i = 0; i < 6; i++) await h.runner.reconcile().catch(() => undefined);
  assert.equal(h.world.rec.state, "starting", "still starting, not finishing");
  assert.equal(h.world.rec.restarts, 0);
  assert.equal(h.world.starts.length, 0);
  assert.notEqual(h.world.rec.last_exit?.cause, "start_failed");
  down = 0;
  await h.runner.reconcile();
  await h.runner.reconcile();
  assert.equal(h.world.starts.length, 1, "once the platform answers, the app starts");
  assert.equal(h.world.rec.state, "running");
});

test("P2 a failing grant hook is the platform's failure too", async () => {
  let down = true;
  const grant: AppGrantRunHooks = { env: async () => { if (down) throw new Error("grant service down"); return {}; }, revoke: async () => undefined };
  const h = harness({ manifest: { ...MANIFEST, restart: undefined }, grant });
  await until(h, "starting");
  for (let i = 0; i < 6; i++) await h.runner.reconcile().catch(() => undefined);
  assert.equal(h.world.rec.state, "starting");
  assert.equal(h.world.rec.restarts, 0);
  down = false;
  await h.runner.reconcile();
  assert.equal(h.world.starts.length, 1);
});

test("P3 a real start failure still counts", async () => {
  const h = harness({ manifest: { ...MANIFEST, restart: undefined } });
  await until(h, "starting");
  h.world.failExec = { left: 100, when: (c) => c.includes("setsid") };
  for (let i = 0; i < 3; i++) await h.runner.reconcile();
  assert.equal(h.world.rec.state, "finishing");
});

test("P4 a state_dir that cannot be expanded is counted, and the run ends instead of sitting in starting", async () => {
  const h = harness({ manifest: { ...MANIFEST, restart: { max_restarts: 1, backoff_sec: [1] } } });
  await until(h, "starting");
  h.world.stateDirExit = 4; // USER_DATA_PATH is empty in the sandbox
  for (let i = 0; i < 40 && h.world.rec.state !== "ended"; i++) { h.world.clock += 5_000; await h.runner.reconcile().catch(() => undefined); }
  assert.equal(h.world.rec.state, "ended");
  assert.equal(h.world.rec.last_exit?.cause, "restarts_exhausted");
  assert.equal(h.world.starts.length, 0);
});

test("P5 finishNow stops at once when another worker holds the run", async () => {
  const h = harness();
  await toRunning(h);
  // Already finishing: the loop inside finishNow is what drives the steps, and its writes are refused.
  h.world.rec = { ...h.world.rec, state: "finishing", last_exit: { at: "2026-01-01T00:00:00Z", cause: "cancelled", final: false } };
  h.world.failStore = () => new AppRunWriteRefused("not_holder");
  const before = h.world.patches.length;
  await assert.rejects(h.runner.finishNow("cancelled"), (e: unknown) => e instanceof AppRunWriteRefused && e.superseded);
  assert.equal(h.world.patches.length - before, 1, "one refused write, not sixty");
});

test("P6 a worker that takes over a running run scrubs the secrets from what it stores", async () => {
  const h = harness();
  const wl = await toRunning(h);
  const takeover = h.newRunner(); // a fresh worker: it has never launched anything
  h.world.appExits(wl, { final: false, returncode: 2, error: `crashed with token ${TOKEN} in the message` });
  await takeover.reconcile();
  assert.equal(h.world.rec.state, "restarting");
  assert.ok(!JSON.stringify(h.world.rec.last_exit).includes(TOKEN), "the token is not stored");
  assert.match(String(h.world.rec.last_exit?.error), /\[redacted\]/);
});

test("P7 markEnded closes the row without a sandbox, and reports a refusal instead of throwing", async () => {
  const h = harness();
  assert.equal(await h.runner.markEnded("no key"), true);
  assert.equal(h.world.rec.state, "ended");
  const again = harness();
  again.world.failStore = () => new AppRunWriteRefused("not_holder");
  assert.equal(await again.runner.markEnded("no key"), false);
});

test("fixed E2B urls and the template list are injected when supplied", () => {
  const env = buildAppEnv({
    runId: "r", sessionId: "s", createdAt: "t", stateDir: "/d", mcpToken: TOKEN,
    grantKeys: {}, grantLimits: { max_sandboxes: 2 }, nodeName: null,
    sandboxTemplates: { measurement: { "1": "r1-runner-g1" } },
    e2bApiUrl: "http://e2b.local", e2bSandboxUrl: "http://e2b.local/sandboxes",
    manifest: { ...MANIFEST, env: undefined, env_map: { sandbox_templates: "APP_TEMPLATES", grant_limits: "APP_GRANT_LIMITS" } },
  });
  assert.equal(env.E2B_API_URL, "http://e2b.local");
  assert.equal(env.E2B_SANDBOX_URL, "http://e2b.local/sandboxes");
  assert.equal(env.APP_TEMPLATES, JSON.stringify({ measurement: { "1": "r1-runner-g1" } }), "the grant's names, not the manifest's array");
  assert.equal(env.APP_GRANT_LIMITS, JSON.stringify({ max_sandboxes: 2 }));
  assert.equal(env.CLAW_SESSION_ID, "s");
});

test("a missing grant is signed again and the application restarts with the new key", async () => {
  const world = new World(MANIFEST, {
    grant_id: "gr-01arz3ndektsv4rrffq69g5fav",
    user_id: "user-1",
    grant_limits: { max_sandboxes: 2, max_gpus: 4, gpu_hours: 1, max_runtime_sec: 3600 },
    grant_expires_at: "2026-01-02T00:00:00.000Z",
  });
  let armed = true;
  let reissues = 0;
  const fresh = "e2b_newkey0123456789abcdef0123456789abcd";
  const grant: AppGrantRunHooks = {
    env: async () => ({}),
    revoke: async () => undefined,
    extend: noopAppGrant.extend,
    inspect: async () => (world.rec.state === "running" && armed ? (armed = false, "missing") : "active"),
    reissue: async (run) => {
      reissues += 1;
      assert.equal(run.userId, "user-1");
      assert.equal(run.platformKey, "pk");
      assert.equal(run.grantId, "gr-01arz3ndektsv4rrffq69g5fav");
      return { keys: { measurement: fresh }, expiresAt: "2026-01-02T00:00:00.000Z" };
    },
  };
  const runner = new AppRunner(RUN_ID, "pk", {
    store: world.store, sandbox: world.sandbox, grant, now: world.now, sleep: world.sleep, tickMs: 5000,
  });
  for (let i = 0; i < 12 && world.rec.state !== "running"; i++) await runner.reconcile();
  assert.equal(world.rec.state, "running");
  assert.equal(reissues, 0, "a live copy is not signed again on the way up");
  await runner.reconcile();
  assert.equal(reissues, 1);
  assert.equal(world.terms.length, 1);
  assert.equal(world.rec.state, "running");
  assert.equal(world.rec.restarts, 0, "a grant restart is not an application crash");
  assert.equal(world.rec.last_exit?.grant_restart, undefined);
  const signed = world.patches.filter((p) => p.patch.grant_keys);
  assert.equal(signed.length, 1);
  assert.equal(signed[0]!.patch.last_exit?.grant_restart, true, "the new keys and the restart mark are one write");
  assert.equal(world.starts.length, 2);
  assert.equal(world.starts[1]!.env.APP_KEY_MEASUREMENT, fresh);
  assert.equal(reissues, 1, "an active copy is not signed again");
});

test("a grant restart with max_restarts 0 starts again, and a final exit does not end the run", async () => {
  const manifest = { ...MANIFEST, restart: { max_restarts: 0, backoff_sec: [] } };
  const world = new World(manifest, {
    grant_id: "gr-01arz3ndektsv4rrffq69g5fav",
    user_id: "user-1",
    grant_limits: { max_sandboxes: 2, max_gpus: 4, gpu_hours: 1, max_runtime_sec: 3600 },
    grant_expires_at: "2026-01-02T00:00:00.000Z",
  });
  let armed = true;
  world.onTerm = (wl) => world.appExits(wl, { final: true, returncode: 0 });
  const grant: AppGrantRunHooks = {
    env: async () => ({}),
    revoke: async () => undefined,
    extend: noopAppGrant.extend,
    inspect: async () => (world.rec.state === "running" && armed ? (armed = false, "missing") : "active"),
    reissue: async () => ({ keys: { measurement: "e2b_newkey0123456789abcdef0123456789abcd" }, expiresAt: "2026-01-02T00:00:00.000Z" }),
  };
  const runner = new AppRunner(RUN_ID, "pk", {
    store: world.store, sandbox: world.sandbox, grant, now: world.now, sleep: world.sleep, tickMs: 5000,
  });
  for (let i = 0; i < 12 && world.rec.state !== "running"; i++) await runner.reconcile();
  await runner.reconcile();
  assert.equal(world.rec.state, "running");
  assert.equal(world.rec.restarts, 0);
  assert.notEqual(world.rec.last_exit?.cause, "restarts_exhausted");
  assert.equal(world.starts.length, 2);
});

test("a grant restart whose sandbox is already gone takes the lost-sandbox road", async () => {
  const world = new World(MANIFEST, {
    grant_id: "gr-01arz3ndektsv4rrffq69g5fav",
    grant_limits: { max_sandboxes: 1, max_gpus: 1, gpu_hours: 1, max_runtime_sec: 3600 },
  });
  const grant: AppGrantRunHooks = {
    env: async () => ({}),
    revoke: async () => undefined,
    extend: noopAppGrant.extend,
    inspect: async () => "active",
    reissue: async () => { throw new Error("the sandbox is gone; the grant is not signed again"); },
  };
  const runner = new AppRunner(RUN_ID, "pk", {
    store: world.store, sandbox: world.sandbox, grant, now: world.now, sleep: world.sleep, tickMs: 5000,
  });
  for (let i = 0; i < 12 && world.rec.state !== "running"; i++) await runner.reconcile();
  world.rec = {
    ...world.rec,
    last_exit: { at: "2026-01-01T00:00:00.000Z", cause: "exit", final: false, grant_restart: true },
  };
  world.killWorkload(world.liveWorkload(), "absent");
  await runner.reconcile();
  assert.equal(world.rec.last_exit?.grant_restart, undefined);
  assert.equal(world.rec.state, "provisioning");
  assert.equal(world.rec.restarts, 1);
});

test("a revoked grant is not signed again", async () => {
  const h = harness({
    over: { grant_id: "gr-01arz3ndektsv4rrffq69g5fav", grant_revoked_at: "2026-01-01T00:00:00.000Z" },
    grant: {
      env: async () => ({}),
      revoke: async () => undefined,
      extend: noopAppGrant.extend,
      inspect: async () => "missing",
      reissue: async () => { throw new Error("revoked grants are not re-signed"); },
    },
  });
  await toRunning(h);
  await h.runner.reconcile();
  assert.equal(h.world.rec.state, "running");
  assert.equal(h.world.starts.length, 1);
});

test("P6 the session owner's platform key, which the sandbox carries as the model credential, is scrubbed too", async () => {
  const h = harness();
  const wl = await toRunning(h);
  const takeover = h.newRunner();
  h.world.appExits(wl, { final: false, returncode: 2, error: `401 from gateway for key ${PLATFORM_KEY}` });
  await takeover.reconcile();
  assert.ok(!JSON.stringify(h.world.rec.last_exit).includes(PLATFORM_KEY), "the platform key is not stored");
  assert.match(String(h.world.rec.last_exit?.error), /\[redacted\]/);
});

test("P6 the platform key is scrubbed even when the store's secrets cannot be read, and no text goes out half-scrubbed", async () => {
  const h = harness();
  const wl = await toRunning(h);
  const takeover = h.newRunner();
  h.world.store.secrets = async () => { throw new Error("API unavailable"); };
  h.world.appExits(wl, { final: false, returncode: 2, error: `401 for key ${PLATFORM_KEY} and token ${TOKEN}` });
  await takeover.reconcile().catch(() => undefined);
  const stored = JSON.stringify(h.world.rec.last_exit ?? {});
  assert.ok(!stored.includes(PLATFORM_KEY), "the platform key is not stored");
  assert.ok(!stored.includes(TOKEN), "nor is anything else the unread set would have caught");
});

// ---------------------------------------------------------------------------
// C2-09 review follow-ups: the status announcement, the drain, the scrub gate
// ---------------------------------------------------------------------------

const settle = () => new Promise<void>((r) => setImmediate(r));

test("S1 every state change is announced through one path, including finishNow's and markEnded's", async () => {
  const states: string[] = [];
  const seams: AppRunnerSeams = { stateChanged: async (rec) => { states.push(rec.state); } };
  const h = harness({ seams });
  await toRunning(h);
  await settle();
  assert.deepEqual(states, ["starting", "running"]);
  await h.runner.finishNow("cancelled");
  await settle();
  assert.deepEqual(states, ["starting", "running", "finishing", "ended"], "finishNow's own write to finishing is announced");

  const closed: string[] = [];
  const bare = harness({ seams: { stateChanged: async (rec) => { closed.push(rec.state); } } });
  assert.equal(await bare.runner.markEnded("no key"), true);
  await settle();
  assert.deepEqual(closed, ["ended"], "markEnded is announced");
});

test("S1b a stateChanged that fails or hangs does not stop or slow the machine", async () => {
  const hang = harness({ seams: { stateChanged: () => new Promise<void>(() => undefined) } });
  await toRunning(hang);
  const boom = harness({ seams: { stateChanged: async () => { throw new Error("nats down"); } } });
  await toRunning(boom);
});

test("S2 a sandbox that is gone is not drained (and says so); a live one is", async () => {
  let drains = 0;
  const seams: AppRunnerSeams = { drainEvents: async () => { drains++; } };
  const live = harness({ seams });
  await toRunning(live);
  await live.runner.finishNow("cancelled");
  assert.equal(drains, 1);

  drains = 0;
  const gone = harness({ seams });
  const wl = await toRunning(gone);
  gone.world.killWorkload(wl, "terminal");
  await gone.runner.finishNow("cancelled");
  assert.equal(drains, 0, "no drain against a workload SaFE says is terminal");
  assert.equal(gone.world.rec.state, "ended");
});

test("S3 the seams get a scrub only once the run's secrets are loaded", async () => {
  const seen: Array<((t: string) => string) | undefined> = [];
  const seams: AppRunnerSeams = { tailEvents: async (ctx) => { seen.push(ctx.scrub); } };
  const h = harness({ seams });
  await toRunning(h);
  await h.runner.reconcile();
  const armed = seen.at(-1);
  assert.ok(armed, "armed once the secrets are known");
  assert.doesNotMatch(armed(`x ${TOKEN} y`), new RegExp(TOKEN));
  assert.doesNotMatch(armed(`x ${PLATFORM_KEY} y`), new RegExp(PLATFORM_KEY), "the event tailer's scrub covers the platform key");

  // Another Brain takes the run over while the API cannot open the secrets.
  h.world.store.secrets = async () => { throw new Error("secrets unavailable"); };
  const taken = h.newRunner();
  seen.length = 0;
  await taken.reconcile();
  assert.equal(seen.length, 1);
  assert.equal(seen[0], undefined, "no scrub, so a seam that needs one must not read");
});

test("S4 the ended announcement is out before finishNow returns; a hung one is given up on after the bound", async () => {
  const order: string[] = [];
  const slow: AppRunnerSeams = {
    stateChanged: async (rec) => { if (rec.state === "ended") { await new Promise((r) => setTimeout(r, 30)); order.push("appStatus ended"); } },
  };
  const h = harness({ seams: slow });
  await toRunning(h);
  await h.runner.finishNow("cancelled");
  order.push("finishNow returned");
  assert.deepEqual(order, ["appStatus ended", "finishNow returned"]);

  const hung = new World(MANIFEST);
  const runner = new AppRunner(RUN_ID, "pk", {
    store: hung.store, sandbox: hung.sandbox, seams: { stateChanged: (rec) => (rec.state === "ended" ? new Promise<void>(() => undefined) : Promise.resolve()) },
    now: hung.now, sleep: hung.sleep, tickMs: 5000, statusTimeoutMs: 20,
  });
  const started = Date.now();
  assert.equal(await runner.markEnded("no key"), true);
  assert.ok(Date.now() - started < 2000, "gave up on the hung announcement");
});
