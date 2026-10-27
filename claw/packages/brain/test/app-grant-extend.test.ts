// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `AppRunner.extendGrant` and the `extend` grant hook: when the hook is called,
 * what is persisted, and that a failing hook never reaches the run.
 *
 * pino writes through `process.stdout.write` only while it is the prototype's,
 * so the capture is installed before the runner is imported.
 */
import test from "node:test";
import assert from "node:assert/strict";

const captured: string[] = [];
const realWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
  captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8"));
  return (realWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
}) as typeof process.stdout.write;

const { AppRunner, noopAppGrant } = await import("../src/apps/app-runner.js");
const { World, MANIFEST, RUN_ID } = await import("./support/app-runner-world.js");
import type { AppGrantRun, AppGrantRunHooks } from "../src/apps/app-runner.js";

const T_OLD = "2026-01-01T04:00:00.000Z";
const T_NEW = "2026-01-01T06:00:00.000Z";

function harness(over: object, extend: AppGrantRunHooks["extend"]) {
  const calls: Array<{ run: AppGrantRun; expiresAt: string }> = [];
  const grant: AppGrantRunHooks = {
    ...noopAppGrant,
    extend: async (run, expiresAt) => { calls.push({ run, expiresAt }); return extend(run, expiresAt); },
  };
  const world = new World(MANIFEST, { grant_id: "grt-1", grant_expires_at: T_OLD, ...over });
  const runner = new AppRunner(RUN_ID, "pk", {
    store: world.store, sandbox: world.sandbox, grant, now: world.now, sleep: world.sleep, tickMs: 5000,
  });
  return { world, runner, calls };
}
const echo: AppGrantRunHooks["extend"] = async (_r, expiresAt) => ({ expiresAt });

test("X1 a later time is passed to the hook and the time it returns is what is stored", async () => {
  const h = harness({}, async () => ({ expiresAt: "2026-01-01T05:00:00.000Z" }));
  const r = await h.runner.extendGrant(T_NEW);
  assert.deepEqual(r, { extended: true, expiresAt: "2026-01-01T05:00:00.000Z" });
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0]!.expiresAt, T_NEW);
  assert.deepEqual(h.calls[0]!.run, {
    runId: RUN_ID, sessionId: "sess-1", grantId: "grt-1", manifest: MANIFEST,
    platformKey: "pk", workspaceId: "ws-1", expiresAt: T_OLD,
  });
  assert.equal(h.world.rec.grant_expires_at, "2026-01-01T05:00:00.000Z", "the hook's answer, not the asked time");
});

test("X2 a time equal to or earlier than the stored one never reaches the hook", async () => {
  const h = harness({}, echo);
  for (const t of [T_OLD, "2026-01-01T03:00:00.000Z", "not a time"]) {
    const r = await h.runner.extendGrant(t);
    assert.deepEqual(r, { extended: false, reason: "not_later" }, t);
  }
  assert.equal(h.calls.length, 0);
  assert.equal(h.world.rec.grant_expires_at, T_OLD);
  assert.equal(h.world.patches.length, 0);
});

test("X3 a revoked grant is not extended and the hook is not called", async () => {
  const h = harness({ grant_revoked_at: "2026-01-01T01:00:00.000Z" }, echo);
  assert.deepEqual(await h.runner.extendGrant(T_NEW), { extended: false, reason: "revoked" });
  assert.equal(h.calls.length, 0);
  assert.equal(h.world.rec.grant_expires_at, T_OLD);
});

test("X4 a hook that throws is a warning; the old expiry is kept and nothing is thrown", async () => {
  const h = harness({}, async () => { throw new Error("grant service down"); });
  captured.length = 0;
  const r = await h.runner.extendGrant(T_NEW);
  assert.deepEqual(r, { extended: false, reason: "failed" });
  assert.equal(h.calls.length, 1, "the hook was tried");
  assert.equal(h.world.rec.grant_expires_at, T_OLD);
  assert.equal(h.world.patches.length, 0);
  const warn = captured.join("").split("\n").filter((l) => l.includes("app_run.grant_extend_failed"));
  assert.equal(warn.length, 1);
  assert.equal(JSON.parse(warn[0]!).level, 40, "pino warn");
  // The run itself is untouched and still runs.
  assert.equal(h.world.rec.state, "provisioning");
  await h.runner.reconcile();
  assert.equal(h.world.rec.state, "starting");
});

test("X5 a failing row write keeps the old expiry and does not throw", async () => {
  const h = harness({}, echo);
  h.world.failStore = (p) => (p.grant_expires_at ? new Error("api down") : null);
  assert.deepEqual(await h.runner.extendGrant(T_NEW), { extended: false, reason: "failed" });
  assert.equal(h.world.rec.grant_expires_at, T_OLD);
});

test("X6 a hook answer that is not later than the stored expiry is not stored", async () => {
  const h = harness({}, async () => ({ expiresAt: T_OLD }));
  assert.deepEqual(await h.runner.extendGrant(T_NEW), { extended: false, reason: "failed" });
  assert.equal(h.world.rec.grant_expires_at, T_OLD);
});

test("X7 a run with no expiry is not given one (it does not lapse); a run with no grant calls nothing", async () => {
  const a = harness({ grant_expires_at: null }, echo);
  assert.deepEqual(await a.runner.extendGrant(T_NEW), { extended: false, reason: "no_expiry" });
  assert.equal(a.calls.length, 0);
  assert.equal(a.world.rec.grant_expires_at, null, "a grant that never lapses is not shortened");
  const b = harness({ grant_id: null }, echo);
  assert.deepEqual(await b.runner.extendGrant(T_NEW), { extended: false, reason: "no_grant" });
  assert.equal(b.calls.length, 0);
});

test("X9 a run that is finishing or ended is never extended, whether or not the revoke was recorded", async () => {
  for (const state of ["finishing", "ended"]) {
    const h = harness({ state }, echo);
    assert.deepEqual(await h.runner.extendGrant(T_NEW), { extended: false, reason: "finishing" }, state);
    assert.equal(h.calls.length, 0);
  }
});

test("X10 finishing records the revoke on the row, and the grant cannot be extended afterwards", async () => {
  const revokes: string[] = [];
  const grant: AppGrantRunHooks = { ...noopAppGrant, revoke: async (run) => { revokes.push(run.grantId ?? ""); } };
  const world = new World(MANIFEST, { grant_id: "grt-1", grant_expires_at: T_OLD, state: "finishing", last_exit: { at: "2026-01-01T00:00:00Z", cause: "exit", final: true, returncode: 0 }, sandbox_workload_id: null });
  const runner = new AppRunner(RUN_ID, "pk", { store: world.store, sandbox: world.sandbox, grant, now: world.now, sleep: world.sleep, tickMs: 5000 });
  for (let i = 0; i < 6 && world.rec.state !== "ended"; i++) await runner.reconcile();
  assert.equal(world.rec.state, "ended");
  assert.deepEqual(revokes, ["grt-1"], "revoked once");
  assert.ok(world.rec.grant_revoked_at, "the row says so");
  assert.ok(world.patches.some((p) => p.patch.grant_revoked === true));
  // Even if a caller got in after the row was ended, nothing is extended.
  world.rec = { ...world.rec, state: "running" };
  const late = await runner.extendGrant(T_NEW);
  assert.deepEqual(late, { extended: false, reason: "revoked" });
});

test("X11 a run with no grant records no revoke", async () => {
  const world = new World(MANIFEST, { grant_id: null, state: "finishing", last_exit: { at: "2026-01-01T00:00:00Z", cause: "exit", final: true, returncode: 0 }, sandbox_workload_id: null });
  const runner = new AppRunner(RUN_ID, "pk", { store: world.store, sandbox: world.sandbox, now: world.now, sleep: world.sleep, tickMs: 5000 });
  for (let i = 0; i < 6 && world.rec.state !== "ended"; i++) await runner.reconcile();
  assert.ok(!world.patches.some((p) => p.patch.grant_revoked === true));
});

test("X8 the default hook returns the time it was given", async () => {
  assert.deepEqual(await noopAppGrant.extend({} as never, T_NEW), { expiresAt: T_NEW });
  const world = new World(MANIFEST, { grant_id: "grt-1", grant_expires_at: T_OLD });
  const runner = new AppRunner(RUN_ID, "pk", { store: world.store, sandbox: world.sandbox, now: world.now, sleep: world.sleep });
  assert.deepEqual(await runner.extendGrant(T_NEW), { extended: true, expiresAt: T_NEW });
  assert.equal(world.rec.grant_expires_at, T_NEW);
});
