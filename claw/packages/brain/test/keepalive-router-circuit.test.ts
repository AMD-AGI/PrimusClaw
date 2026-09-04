// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import type { KV } from "nats";
import type { SandboxProvider } from "../src/sandbox/provider.js";

process.env.SANDBOX_KEEPALIVE_FAIL_LIMIT = "1";

const {
  registerSandbox,
  registeredSandboxCount,
  runKeepaliveTickForTest,
  unregisterSandbox,
} = await import("../src/sandbox/keepalive.js");
const { SandboxGoneError } = await import("../src/sandbox/errors.js");
const { bindSandboxProviders } = await import("../src/sandbox/factory.js");

function emptyKv(): KV {
  return {
    async keys() { return (async function* () {})(); },
    async get() { return null; },
    async delete() {},
    async put() { return 1; },
    async update() { return 1; },
  } as unknown as KV;
}

test("simultaneous gone responses open the circuit instead of stopping every sandbox", async () => {
  let stops = 0;
  const provider = {
    kind: "safe-workload",
    async exec() { throw new SandboxGoneError("router and workload lookup returned 404"); },
    async stop() { stops++; },
  } as unknown as SandboxProvider;
  const restore = bindSandboxProviders({ safeWorkload: provider, agentSandbox: provider });
  const sessions = ["s-1", "s-2"];
  try {
    for (const [index, sessionId] of sessions.entries()) {
      registerSandbox(sessionId, {
        provider: "safe-workload",
        workloadId: `wl-${index + 1}`,
        platformKey: "pk",
      });
    }

    await runKeepaliveTickForTest({ kv: emptyKv() });

    assert.equal(stops, 0, "a shared 404 stopped every workload in one tick");
    for (const sessionId of sessions) {
      assert.equal(registeredSandboxCount(sessionId), 1);
    }
  } finally {
    for (const sessionId of sessions) unregisterSandbox(sessionId);
    restore();
  }
});

test("a single gone response reaches the verdict and jumps the counter", async () => {
  // The circuit only suppresses eviction when more than one target reports gone
  // in the same sweep; with one, the failure has to reach the verdict and act.
  //
  // This exists because the sweep and the verdict now live in different places
  // -- the ping loop collects, handleKeepaliveFailures decides -- so "collected
  // but never adjudicated" is a real way to end up with a sweep that notices
  // everything and does nothing. Deleting the handleKeepaliveFailures call
  // leaves every other keepalive test green.
  //
  // Asserted on the verdict rather than on destroyHands: eviction needs the real
  // KV bucket, so a unit test cannot watch it -- which is also why the circuit
  // test above would pass even if nothing were ever adjudicated.
  const { lastVerdictForTest } = await import("../src/sandbox/keepalive.js") as any;
  let execs = 0;
  const provider = {
    kind: "safe-workload",
    async exec() { execs++; throw new SandboxGoneError("workload absent (HTTP 404)"); },
    async stop() {},
  } as unknown as SandboxProvider;
  const restore = bindSandboxProviders({ safeWorkload: provider, agentSandbox: provider });
  registerSandbox("s-solo", { provider: "safe-workload", workloadId: "wl-solo", platformKey: "pk" });
  try {
    await runKeepaliveTickForTest({ kv: emptyKv() });
    assert.ok(execs > 0, `precondition: the sandbox was pinged (execs=${execs})`);
    const v = lastVerdictForTest("s-solo");
    assert.ok(v, "the failure must reach the verdict at all");
    assert.equal(v.gone, true, "a lone gone is not suppressed");
    assert.equal(v.fails, 1, "and jumps straight to the limit");
  } finally {
    unregisterSandbox("s-solo");
    restore();
  }
});
