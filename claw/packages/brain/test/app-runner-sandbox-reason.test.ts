// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Why an app run has no sandbox, on its row: `last_exit.sandbox_reason` and
 * `sandbox_message`, which the API reads to say a run ended because the platform
 * never gave it a sandbox (`app.outcome.cause` `sandbox_*`). Against the fake
 * world (support/app-runner-world.ts). Written when an attempt fails, carried
 * into a deadline or a cancel that ends the run while it is still waiting,
 * cleared once a sandbox is Running, and written once for a create that keeps
 * failing rather than on every tick.
 */
import test from "node:test";
import assert from "node:assert/strict";

const { AppRunner } = await import("../src/apps/app-runner.js");
const { SandboxProvisionTerminalError } = await import("../src/sandbox/errors.js");
const { World, MANIFEST, RUN_ID, T0 } = await import("./support/app-runner-world.js");

const PLATFORM_KEY = "ak-platform-key-sandbox-reason-77";

function harness(manifest = MANIFEST) {
  const world = new World(manifest);
  const runner = new AppRunner(RUN_ID, PLATFORM_KEY, {
    store: world.store, sandbox: world.sandbox, now: world.now, sleep: world.sleep, tickMs: 5000,
  });
  return { world, runner };
}

const tick = (r: InstanceType<typeof AppRunner>) => r.reconcile().catch(() => undefined);

test("a refused create: the code and the platform's words (the key masked) go on the row, and end the run with it", async () => {
  const { world, runner } = harness({ ...MANIFEST, restart: { max_restarts: 0, backoff_sec: [1] } });
  world.sandbox.ensure = async () => {
    throw new SandboxProvisionTerminalError("sandbox_rejected", `The platform refused to create the sandbox (HTTP 400): denied, key ${PLATFORM_KEY}\nsecond line`);
  };
  await tick(runner);
  assert.equal(world.rec.state, "finishing");
  assert.equal(world.rec.last_exit?.cause, "restarts_exhausted");
  assert.equal(world.rec.last_exit?.sandbox_reason, "sandbox_rejected");
  assert.equal(world.rec.last_exit?.sandbox_gone, undefined, "a sandbox never given was not lost");
  const said = world.rec.last_exit?.sandbox_message ?? "";
  assert.match(said, /^The platform refused to create the sandbox \(HTTP 400\): denied, key /);
  assert.ok(!said.includes(PLATFORM_KEY), said);
  assert.ok(!said.includes("\n"), "one line");
});

test("a create that keeps failing is written once, and the deadline that ends the run carries it", async () => {
  const { world, runner } = harness({ ...MANIFEST, limits: { max_runtime_sec: 60 } });
  let calls = 0;
  world.sandbox.ensure = async () => { calls += 1; throw new Error("Create Hands failed: HTTP 503 upstream reset"); };
  for (let i = 0; i < 4; i++) await tick(runner);
  assert.equal(calls, 4);
  const writes = world.patches.filter((p) => p.patch.last_exit?.sandbox_reason === "sandbox_create_failed");
  assert.equal(writes.length, 1, "recorded once, not on every failing tick");
  assert.equal(world.rec.state, "provisioning");
  world.clock = T0 + 61_000;
  await tick(runner);
  assert.equal(world.rec.state, "finishing");
  assert.deepEqual(
    { cause: world.rec.last_exit?.cause, reason: world.rec.last_exit?.sandbox_reason, message: world.rec.last_exit?.sandbox_message },
    { cause: "deadline", reason: "sandbox_create_failed", message: "Create Hands failed: HTTP 503 upstream reset" },
  );
});

test("a failure that is not the create's is not written", async () => {
  const { world, runner } = harness();
  world.sandbox.ensure = async () => { throw new Error("app sandbox lookup failed: HTTP 502"); };
  await tick(runner);
  assert.equal(world.patches.length, 0);
});

test("cleared once a sandbox is Running; a later cancel carries nothing", async () => {
  const { world, runner } = harness();
  const real = world.sandbox.ensure;
  let fail = true;
  world.sandbox.ensure = async (run, opts) => {
    if (fail) throw new Error("Create Hands failed: HTTP 503 upstream reset");
    return real(run, opts);
  };
  await tick(runner);
  assert.equal(world.rec.last_exit?.sandbox_reason, "sandbox_create_failed");
  fail = false;
  await tick(runner);
  assert.equal(world.rec.state, "starting");
  assert.equal(world.rec.last_exit?.sandbox_reason, undefined);
  assert.equal(world.rec.last_exit?.sandbox_message, undefined);
  const outcome = await runner.finishNow("cancelled");
  assert.equal(outcome.success, false);
  assert.equal(world.rec.last_exit?.cause, "cancelled");
  assert.equal(world.rec.last_exit?.sandbox_reason, undefined);
});

test("a cancel while the run still waits for a sandbox carries why it waits", async () => {
  const { world, runner } = harness();
  world.sandbox.ensure = async () => { throw new Error("Create Hands failed: HTTP 503 upstream reset"); };
  await tick(runner);
  world.sandbox.ensure = async () => { throw new Error("not called"); };
  await runner.finishNow("cancelled");
  assert.equal(world.rec.state, "ended");
  assert.equal(world.rec.last_exit?.cause, "cancelled");
  assert.equal(world.rec.last_exit?.sandbox_reason, "sandbox_create_failed");
});

test("a wait the run's own stop cut short is not counted: the row stays provisioning for the stop to finish", async () => {
  // reconcile() without run(): nothing has marked the runner halted, so the only thing
  // keeping this from `countedRestart` (max_restarts 0: finishing, restarts_exhausted) is the runner itself.
  const { world, runner } = harness({ ...MANIFEST, restart: { max_restarts: 0, backoff_sec: [1] } });
  world.sandbox.ensure = async () => {
    throw new SandboxProvisionTerminalError("sandbox_wait_interrupted", "workload w-1 startup was interrupted before it became ready");
  };
  await tick(runner);
  assert.equal(world.patches.length, 0, "nothing written");
  assert.equal(world.rec.state, "provisioning");
  const outcome = await runner.finishNow("deadline");
  assert.equal(outcome.success, false);
  assert.equal(world.rec.state, "ended");
  assert.equal(world.rec.last_exit?.cause, "deadline");
});
