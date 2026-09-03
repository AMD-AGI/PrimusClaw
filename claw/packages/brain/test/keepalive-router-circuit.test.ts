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
