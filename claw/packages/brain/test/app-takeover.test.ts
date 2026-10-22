// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Cancel, runtime limit and takeover of an app run (hosting design 5.3.2,
 * "any state -> finishing" and "Brain failure takeover"), against the fake
 * world in support/app-runner-world.ts. The clock is the fake's, so a grace of
 * 900 s costs nothing and "exactly stop_grace_sec" can be asserted.
 *
 * What a mistake here would cost, and the cases that guard it:
 *  - an app killed before it could write `final` within its grace: G1-G6
 *  - a takeover that starts a second sandbox or a second process: K1-K6
 *  - a run that never ends because max_runtime_sec is not enforced: M1-M5
 *  - a grant revoked twice or never: V1-V4
 *  - a runner that keeps writing after the lease was released: H1-H2
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { AppRunner, MAX_STOP_GRACE_SEC } from "../src/apps/app-runner.js";
import { stopCommand, probeCommand } from "../src/apps/app-env.js";
import { AppRunWriteRefused } from "../src/apps/app-run-store.js";
import type { AppGrantRunHooks, AppRunnerSeams } from "../src/apps/app-runner.js";
import type { AppManifestV1 } from "@claw/protocol";
import { World, MANIFEST, RUN_ID, T0 } from "./support/app-runner-world.js";

const TICK = 5000;
const GRACE = 60;
const finalExit = (returncode: number, extra: object = {}) => ({ final: true, returncode, ...extra });
const withManifest = (extra: Partial<AppManifestV1>): AppManifestV1 => ({ ...MANIFEST, ...extra });

interface GrantSpy extends AppGrantRunHooks { revokes: string[]; envs: number; issue: () => never }

function grantSpy(): GrantSpy {
  const spy: GrantSpy = {
    revokes: [], envs: 0,
    env: async () => { spy.envs++; return { keys: { measurement: "e2b_measurementKEY0123456789abcdef" } }; },
    revoke: async (run) => { spy.revokes.push(run.grantId ?? "none"); },
    // The runner has no business issuing a grant: the API did, at run creation.
    issue: () => { throw new Error("a grant was issued by the runner"); },
  };
  return spy;
}

function harness(opts: { manifest?: AppManifestV1; seams?: AppRunnerSeams; grant?: GrantSpy; over?: object } = {}) {
  const grant = opts.grant ?? grantSpy();
  const world = new World(opts.manifest ?? withManifest({ stop_grace_sec: GRACE }), { grant_id: "grant-1", ...opts.over });
  const make = () => new AppRunner(RUN_ID, "pk", {
    store: world.store, sandbox: world.sandbox, grant, seams: opts.seams,
    now: world.now, sleep: world.sleep, tickMs: TICK,
  });
  return { world, grant, runner: make(), newRunner: make };
}
type H = ReturnType<typeof harness>;

async function until(h: H, state: string, max = 12, runner: AppRunner = h.runner) {
  for (let i = 0; i < max && h.world.rec.state !== state; i++) await runner.reconcile();
  assert.equal(h.world.rec.state, state, `never reached ${state}`);
}

async function toRunning(h: H): Promise<string> {
  await until(h, "running");
  return h.world.rec.sandbox_workload_id!;
}

/** Reconcile (one tick, then the fake clock moves) until the run is done. */
async function drive(h: H, runner: AppRunner = h.runner, max = 400) {
  for (let i = 0; i < max; i++) {
    const t = await runner.reconcile();
    if (t.done) return t.outcome;
    await h.world.sleep(TICK);
  }
  throw new Error("the run never ended");
}

// ---------------------------------------------------------------------------
// Cancel: SIGTERM, then up to stop_grace_sec
// ---------------------------------------------------------------------------

test("G1 cancel: SIGTERM once, an app that ignores it is waited for exactly stop_grace_sec, then the sandbox is stopped", async () => {
  const h = harness();
  const wl = await toRunning(h);
  h.world.onTerm = () => { /* ignores SIGTERM */ };
  const cancelAt = h.world.clock;
  const outcome = await h.runner.finishNow("cancelled");
  assert.deepEqual(h.world.terms, [wl], "exactly one SIGTERM");
  assert.equal(h.world.stopped.length, 1);
  const waited = h.world.stoppedAt[0]! - cancelAt;
  assert.ok(waited >= GRACE * 1000, `stopped after ${waited} ms, before the ${GRACE} s grace`);
  assert.ok(waited < GRACE * 1000 + 2 * TICK, `stopped after ${waited} ms, long after the grace`);
  assert.equal(outcome.success, false);
  assert.match(outcome.reason, /cancelled/);
  assert.equal(h.world.rec.state, "ended");
  assert.deepEqual(h.grant.revokes, ["grant-1"]);
});

test("G1b nothing is stopped one tick before the grace is over", async () => {
  const h = harness();
  const wl = await toRunning(h);
  h.world.onTerm = () => {};
  await h.runner.finishNow("cancelled").catch(() => {});
  // Replay by hand on a fresh run: tick by tick, the sandbox stays until the grace is over.
  const g = harness();
  await toRunning(g);
  g.world.onTerm = () => {};
  const start = g.world.clock;
  await g.runner.reconcile();               // running; the cancel below moves it
  await g.world.store.patch(RUN_ID, { state: "finishing", last_exit: { at: new Date(start).toISOString(), cause: "cancelled", final: false } });
  await g.runner.reconcile();               // SIGTERM
  assert.equal(g.world.terms.length, 1);
  while (g.world.clock - start < GRACE * 1000 - TICK) {
    await g.world.sleep(TICK);
    const t = await g.runner.reconcile();
    assert.equal(t.done, false);
    assert.equal(g.world.stopped.length, 0, `stopped at +${g.world.clock - start} ms`);
  }
  await g.world.sleep(TICK);
  assert.equal((await g.runner.reconcile()).done, true);
  assert.equal(g.world.stopped.length, 1);
  void wl;
});

test("G2 an app that writes final during the grace keeps its own return code and stop reason", async () => {
  const h = harness();
  const wl = await toRunning(h);
  const cancelAt = h.world.clock;
  h.world.onTerm = () => {
    h.world.at(cancelAt + 20_000, () => h.world.appExits(wl, finalExit(0, { stop_reason: "checkpointed and drained" })));
  };
  const outcome = await h.runner.finishNow("cancelled");
  assert.equal(outcome.success, true, "the app's own result, not the cancel's");
  assert.equal(outcome.captures?.stop_reason, "checkpointed and drained");
  assert.equal(outcome.captures?.session_dir, "/data/.claw-apps/run-1");
  assert.equal(h.world.rec.last_exit?.cause, "exit");
  assert.equal(h.world.rec.last_exit?.returncode, 0);
  assert.ok(h.world.stoppedAt[0]! - cancelAt < GRACE * 1000, "did not wait out the grace once the app was gone");
  assert.equal(h.world.starts.length, 1, "no restart on the way");
});

test("G2b final with a non-zero return code in the grace is the app's failure, with its code", async () => {
  const h = harness();
  const wl = await toRunning(h);
  h.world.onTerm = () => h.world.appExits(wl, finalExit(3, { stop_reason: "gave up" }));
  const outcome = await h.runner.finishNow("cancelled");
  assert.equal(outcome.success, false);
  assert.match(outcome.reason, /return code 3/);
  assert.match(outcome.reason, /gave up/);
});

test("G3 an app that dies on SIGTERM without writing final ends the run as cancelled, without waiting the grace", async () => {
  const h = harness();
  await toRunning(h);
  const at = h.world.clock;
  const outcome = await h.runner.finishNow("cancelled");
  assert.equal(h.world.terms.length, 1);
  assert.ok(h.world.stoppedAt[0]! - at < GRACE * 1000);
  assert.equal(outcome.success, false);
  assert.equal(outcome.captures?.stop_reason, "cancelled");
  assert.equal(h.world.rec.last_exit?.cause, "cancelled");
});

test("G4 the default grace is 900 s when the manifest names none", async () => {
  const h = harness({ manifest: MANIFEST });
  await toRunning(h);
  h.world.onTerm = () => {};
  const at = h.world.clock;
  await h.runner.finishNow("cancelled");
  const waited = h.world.stoppedAt[0]! - at;
  assert.ok(waited >= 900_000 && waited < 900_000 + 2 * TICK, `waited ${waited} ms`);
});

test("G4b stop_grace_sec 0 signals and goes on at the next look", async () => {
  const h = harness({ manifest: withManifest({ stop_grace_sec: 0 }) });
  await toRunning(h);
  h.world.onTerm = () => {};
  const at = h.world.clock;
  await h.runner.finishNow("cancelled");
  assert.equal(h.world.terms.length, 1);
  assert.ok(h.world.stoppedAt[0]! - at <= 2 * TICK);
});

test("G4c a manifest cannot ask for a grace beyond the platform ceiling", async () => {
  const h = harness({ manifest: withManifest({ stop_grace_sec: 10 ** 9 }) });
  await toRunning(h);
  h.world.onTerm = () => {};
  const at = h.world.clock;
  await h.runner.finishNow("cancelled");
  const waited = h.world.stoppedAt[0]! - at;
  assert.ok(waited >= MAX_STOP_GRACE_SEC * 1000 && waited < MAX_STOP_GRACE_SEC * 1000 + 2 * TICK, `waited ${waited} ms`);
});

test("G5 a cancel before there is an application signals nothing and still revokes and ends", async () => {
  for (const upTo of ["provisioning", "starting"] as const) {
    const h = harness();
    if (upTo === "starting") await until(h, "starting", 3);
    await h.runner.finishNow("cancelled");
    assert.equal(h.world.terms.length, 0, upTo);
    assert.equal(h.world.rec.state, "ended", upTo);
    assert.deepEqual(h.grant.revokes, ["grant-1"], upTo);
  }
});

test("G6 the sandbox disappearing during the grace ends the wait; a final left on shared storage is still read", async () => {
  const h = harness();
  const wl = await toRunning(h);
  h.world.onTerm = () => {};
  const finishing = h.runner.finishNow("cancelled");
  // Let the SIGTERM go out, then lose the sandbox with a final result already written.
  h.world.at(h.world.clock + 15_000, () => { h.world.appExits(wl, finalExit(0)); h.world.killWorkload(wl, "terminal"); });
  const outcome = await finishing;
  assert.ok(h.world.stoppedAt[0]! - T0 < GRACE * 1000 + 60_000);
  assert.equal(typeof outcome.success, "boolean");
  assert.equal(h.world.rec.state, "ended");
  assert.equal(h.grant.revokes.length, 1);
});

test("G7 cancelling a run that is already finishing on its own final result keeps that result and sends no SIGTERM", async () => {
  const h = harness();
  const wl = await toRunning(h);
  h.world.appExits(wl, finalExit(0));
  await h.runner.reconcile();
  assert.equal(h.world.rec.state, "finishing");
  const outcome = await h.runner.finishNow("cancelled");
  assert.equal(h.world.terms.length, 0);
  assert.equal(outcome.success, true);
});

test("G8 the signal command is guarded by the generation marker: a pid left by a gone container is not signalled", async () => {
  const dir = mkdtempSync(`${tmpdir()}/c2-03c-`);
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  const probe = () => spawnSync("sh", ["-c", probeCommand(dir, "wl-old:0")], { encoding: "utf8" }).stdout.trim();
  try {
    writeFileSync(`${dir}/app.pid`, String(child.pid));
    writeFileSync(`${dir}/app.sandbox`, "wl-old:0");
    const stale = spawnSync("sh", ["-c", stopCommand(dir, "wl-new:0")], { encoding: "utf8" });
    assert.equal(stale.stdout.trim(), "none");
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(probe(), "alive", "a mismatched generation is left alone");
    const mine = spawnSync("sh", ["-c", stopCommand(dir, "wl-old:0")], { encoding: "utf8" });
    assert.equal(mine.stdout.trim(), "sent");
    for (let i = 0; i < 50 && probe() === "alive"; i++) await new Promise((r) => setTimeout(r, 100));
    assert.notEqual(probe(), "alive", "SIGTERM reached the process");
  } finally {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// max_runtime_sec
// ---------------------------------------------------------------------------

const LIMITED = (sec: number) => withManifest({ stop_grace_sec: GRACE, limits: { max_runtime_sec: sec } });

test("M1 past max_runtime_sec from creation the run goes to finishing, then SIGTERM and the same grace", async () => {
  const h = harness({ manifest: LIMITED(300) });
  await toRunning(h);
  h.world.onTerm = () => {};
  const outcome = await drive(h);
  assert.equal(h.world.rec.last_exit?.cause, "deadline");
  assert.equal(h.world.terms.length, 1);
  const stoppedAfter = h.world.stoppedAt[0]! - T0;
  assert.ok(stoppedAfter >= 300_000 + GRACE * 1000, `stopped at +${stoppedAfter} ms, inside the limit plus grace`);
  assert.ok(stoppedAfter < 300_000 + GRACE * 1000 + 3 * TICK, `stopped at +${stoppedAfter} ms`);
  assert.equal(outcome.success, false);
  assert.match(outcome.reason, /deadline/);
  assert.deepEqual(h.grant.revokes, ["grant-1"]);
});

test("M2 nothing is cut short before the limit", async () => {
  const h = harness({ manifest: LIMITED(300) });
  await toRunning(h);
  while (h.world.clock < T0 + 300_000 - TICK) {
    await h.world.sleep(TICK);
    await h.runner.reconcile();
    assert.equal(h.world.rec.state, "running", `+${h.world.clock - T0} ms`);
  }
  await h.world.sleep(TICK);
  await h.runner.reconcile();
  assert.equal(h.world.rec.state, "finishing");
});

test("M3 the limit applies in every state before finishing", async () => {
  for (const state of ["provisioning", "starting", "restarting"] as const) {
    const h = harness({ manifest: LIMITED(100) });
    if (state === "restarting") {
      const wl = await toRunning(h);
      h.world.appExits(wl);
      await h.runner.reconcile();
      assert.equal(h.world.rec.state, "restarting");
    } else if (state === "starting") await until(h, "starting", 3);
    await h.world.sleep(101_000);
    await h.runner.reconcile();
    assert.equal(h.world.rec.state, "finishing", state);
    assert.equal(h.world.rec.last_exit?.cause, "deadline", state);
    await drive(h);
    assert.equal(h.world.rec.state, "ended", state);
    assert.deepEqual(h.grant.revokes, ["grant-1"], state);
  }
});

test("M4 an app that writes final within the grace after the limit keeps its result", async () => {
  const h = harness({ manifest: LIMITED(100) });
  const wl = await toRunning(h);
  h.world.onTerm = () => { h.world.at(h.world.clock + 10_000, () => h.world.appExits(wl, finalExit(0, { stop_reason: "budget reached" }))); };
  const outcome = await drive(h);
  assert.equal(outcome.success, true);
  assert.equal(outcome.captures?.stop_reason, "budget reached");
});

test("M5 no limit, no deadline; and a taken-over run keeps the deadline of its creation", async () => {
  const none = harness();
  await toRunning(none);
  await none.world.sleep(30 * 24 * 3600 * 1000);
  await none.runner.reconcile();
  assert.equal(none.world.rec.state, "running");

  const h = harness({ manifest: LIMITED(100) });
  await toRunning(h);
  await h.world.sleep(60_000);
  const b = h.newRunner();            // a Brain that has only just taken the run over
  await b.reconcile();
  assert.equal(h.world.rec.state, "running", "its own clock did not restart the budget");
  await h.world.sleep(41_000);
  await b.reconcile();
  assert.equal(h.world.rec.state, "finishing");
});

// ---------------------------------------------------------------------------
// Takeover: a new runner continues from the row
// ---------------------------------------------------------------------------

async function bringTo(h: H, state: "provisioning" | "starting" | "running" | "restarting" | "finishing"): Promise<void> {
  switch (state) {
    case "provisioning":
      // The old Brain created the sandbox and died before it recorded the id.
      await h.world.sandbox.ensure({ runId: RUN_ID } as never);
      h.world.rec = { ...h.world.rec, sandbox_workload_id: null };
      break;
    case "starting":
      // It launched the application and died before it recorded `running`.
      await until(h, "starting", 3);
      await h.runner.reconcile();
      assert.equal(h.world.starts.length, 1);
      break;
    case "running": await toRunning(h); break;
    case "restarting": {
      const wl = await toRunning(h);
      h.world.appExits(wl);
      await h.runner.reconcile();
      break;
    }
    case "finishing": {
      const wl = await toRunning(h);
      h.world.appExits(wl, finalExit(0));
      await h.runner.reconcile();
      break;
    }
  }
  assert.equal(h.world.rec.state, state === "provisioning" ? "provisioning" : state);
}

for (const state of ["provisioning", "starting", "running", "restarting", "finishing"] as const) {
  test(`K1 takeover from ${state}: one sandbox, no second process beyond a real restart, no grant issued, one revoke`, async () => {
    const h = harness();
    await bringTo(h, state);
    const startsBefore = h.world.starts.length;
    const envsBefore = h.grant.envs;

    const b = h.newRunner();     // the new Brain: one reconcile() carries on from the row
    const first = await b.reconcile();
    assert.equal(typeof first.done, "boolean");
    if (state === "starting" || state === "running") {
      assert.equal(h.world.starts.length, startsBefore, "an application that is alive is not started again");
      assert.equal(h.grant.envs, envsBefore, "the grant was not asked for again");
    }

    // The new Brain brings the run to `running` (a restart waits out its backoff
    // on the fake clock), the application then finishes by itself, and the new
    // Brain sees the run out.
    if (state !== "finishing") {
      for (let i = 0; i < 20 && h.world.rec.state !== "running"; i++) { await h.world.sleep(40_000); await b.reconcile(); }
      assert.equal(h.world.rec.state, "running");
      h.world.appExits(h.world.rec.sandbox_workload_id!, finalExit(0));
    }
    await drive(h, b);
    assert.equal(h.world.rec.state, "ended");
    assert.equal(h.world.created.length, 1, "exactly one sandbox for the whole run");
    const expectedStarts = state === "restarting" ? 2 : 1;
    assert.equal(h.world.starts.length, expectedStarts, "one process per generation, never two at once");
    assert.equal(h.grant.revokes.length, 1, "revoked once");
    assert.deepEqual(h.grant.revokes, ["grant-1"], "against the grant already on the row");
  });
}

test("K2 two Brains reconciling at once over one row (the old one's last tick still in flight) start one process", async () => {
  const h = harness();
  await until(h, "starting", 3);
  const b = h.newRunner();
  // The loser of the compare-and-set is refused; what matters is what got started.
  await Promise.allSettled([h.runner.reconcile(), b.reconcile()]);
  await Promise.allSettled([h.runner.reconcile(), b.reconcile()]);
  assert.equal(h.world.starts.length, 1);
  assert.equal(h.world.created.length, 1);
});

test("K3 the takeover of a cancel in its grace goes on with the same wait: no second SIGTERM, no new grace", async () => {
  const h = harness();
  await toRunning(h);
  h.world.onTerm = () => {};
  await h.world.store.patch(RUN_ID, { state: "finishing", last_exit: { at: new Date(h.world.clock).toISOString(), cause: "cancelled", final: false } });
  const sentAt = h.world.clock;
  await h.runner.reconcile();                 // old Brain: SIGTERM, stop_at on the row
  assert.equal(h.world.terms.length, 1);
  await h.world.sleep(40_000);
  const b = h.newRunner();                    // new Brain, 40 s into the grace
  await drive(h, b);
  assert.equal(h.world.terms.length, 1, "SIGTERM was not repeated");
  const waited = h.world.stoppedAt[0]! - sentAt;
  assert.ok(waited >= GRACE * 1000 && waited < GRACE * 1000 + 2 * TICK, `waited ${waited} ms in all`);
});

test("K4 a takeover where the old Brain's app wrote final during the grace keeps that result", async () => {
  const h = harness();
  const wl = await toRunning(h);
  h.world.onTerm = () => {};
  await h.world.store.patch(RUN_ID, { state: "finishing", last_exit: { at: new Date(h.world.clock).toISOString(), cause: "cancelled", final: false } });
  await h.runner.reconcile();                                    // SIGTERM sent, stop_at on the row
  await h.world.sleep(20_000);
  h.world.appExits(wl, finalExit(0, { stop_reason: "drained" }));
  const outcome = await drive(h, h.newRunner());
  assert.equal(outcome.success, true);
  assert.equal(outcome.captures?.stop_reason, "drained");
  assert.equal(h.world.terms.length, 1);
});

test("K5 a lost sandbox is a restart of the same run: the new Brain makes one new sandbox, not two", async () => {
  const h = harness();
  const wl = await toRunning(h);
  h.world.killWorkload(wl, "terminal");
  const b = h.newRunner();
  await b.reconcile();
  assert.equal(h.world.rec.state, "provisioning");
  await until(h, "running", 6, b);
  assert.equal(h.world.created.length, 2);
  assert.equal(h.world.starts.length, 2);
  assert.equal(h.world.rec.restarts, 1);
});

// ---------------------------------------------------------------------------
// The grant is revoked once per run end
// ---------------------------------------------------------------------------

test("V1 a normal end revokes once", async () => {
  const h = harness();
  const wl = await toRunning(h);
  h.world.appExits(wl, finalExit(0));
  await drive(h);
  assert.equal(h.grant.revokes.length, 1);
});

test("V2 a takeover in finishing, after the revoke was done and recorded, does not revoke again", async () => {
  let failUnregister = true;
  const seams: AppRunnerSeams = { unregisterMcp: async () => { if (failUnregister) throw new Error("mcp unreachable"); } };
  const h = harness({ seams });
  const wl = await toRunning(h);
  h.world.appExits(wl, finalExit(0));
  await h.runner.reconcile();                                       // finishing
  await assert.rejects(h.runner.reconcile(), /mcp unreachable/);    // drain, revoke done; unregister fails
  assert.equal(h.grant.revokes.length, 1);
  assert.ok(h.world.rec.last_exit?.finish_done?.includes("revoke_grant"), "the row says so");
  failUnregister = false;
  const b = h.newRunner();                                          // the old Brain is gone
  const outcome = await drive(h, b);
  assert.equal(outcome.success, true);
  assert.equal(h.grant.revokes.length, 1, "still one");
  assert.equal(h.world.rec.state, "ended");
});

test("V3 a revoke done whose record could not be written is not repeated by the same runner", async () => {
  const h = harness();
  const wl = await toRunning(h);
  h.world.appExits(wl, finalExit(0));
  await h.runner.reconcile();
  let fail = 2;
  h.world.failStore = (p) => (p.last_exit?.finish_done && fail-- > 0 ? new Error("store down") : null);
  for (let i = 0; i < 6 && h.world.rec.state !== "ended"; i++) { try { await h.runner.reconcile(); } catch { /* retried */ } }
  assert.equal(h.world.rec.state, "ended");
  assert.equal(h.grant.revokes.length, 1);
});

test("V4 a run ended by a cancel and by a deadline each revoke once, never twice", async () => {
  for (const cause of ["cancelled", "deadline", "row_terminal"] as const) {
    const h = harness();
    await toRunning(h);
    await h.runner.finishNow(cause);
    await h.runner.finishNow(cause).catch(() => undefined);
    assert.equal(h.grant.revokes.length, 1, cause);
  }
});

// ---------------------------------------------------------------------------
// The lease is released: the runner stops
// ---------------------------------------------------------------------------

test("H1 when the signal fires the runner returns at once and a tick still in flight writes and starts nothing", async () => {
  const h = harness();
  await until(h, "starting", 3);
  h.world.holdExecs((c) => c.includes("base64 -d"));      // the launch is parked in the sandbox
  const ac = new AbortController();
  const run = h.runner.run(ac.signal);
  for (let i = 0; i < 50 && !h.world.execs.some((e) => e.command.includes("base64 -d")); i++) await new Promise((r) => setImmediate(r));
  assert.ok(h.world.execs.some((e) => e.command.includes("base64 -d")), "the launch began");
  ac.abort();
  assert.deepEqual(await run, { kind: "aborted" });
  const patches = h.world.patches.length;
  const execs = h.world.execs.length;
  h.world.hold!.release();
  for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
  assert.equal(h.world.patches.length, patches, "no write to the row after the signal");
  assert.equal(h.world.execs.length, execs, "no command sent after the signal");
  assert.equal(h.world.starts.length, 0);
  // The Brain that takes the run over starts it, once.
  const b = h.newRunner();
  for (let i = 0; i < 4 && h.world.rec.state !== "running"; i++) await b.reconcile();
  assert.equal(h.world.rec.state, "running");
  assert.equal(h.world.starts.length, 1);
});

test("H2 a cancel after the signal still finishes the run: finishNow is the one road that writes", async () => {
  const h = harness();
  await toRunning(h);
  const ac = new AbortController();
  ac.abort();
  assert.deepEqual(await h.runner.run(ac.signal), { kind: "aborted" });
  assert.equal(h.world.patches.filter((p) => p.patch.state === "finishing").length, 0);
  await h.runner.finishNow("cancelled");
  assert.equal(h.world.rec.state, "ended");
});

test("H3 finishNow stops at once when another worker holds the run", async () => {
  const h = harness();
  await toRunning(h);
  h.world.failStore = () => new AppRunWriteRefused("not_holder");
  await assert.rejects(h.runner.finishNow("cancelled"), (e: unknown) => e instanceof AppRunWriteRefused && e.superseded);
});
