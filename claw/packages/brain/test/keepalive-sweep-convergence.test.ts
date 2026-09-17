// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// The sweep has to finish, and the span it declares has to be one it keeps.
//
// Three properties, each of which a sweep violated: a stop that cannot succeed
// was retried on every sweep and re-paid its whole cost; the probe the idle
// expiry awaits carried a budget over one of its two round trips; and the
// declared span omitted the phase that awaits both a probe and a stop per
// handle, so the refresh gaps and the reclaim horizon derived from it were
// derived from a number the sweep exceeds.

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { StringCodec } from "nats";
import type { KV } from "nats";
import {
  runKeepaliveTickForTest,
  resetBackgroundWorkStateForTest,
  unregisterSandbox,
  keepaliveSweepCeilingSec,
  keepaliveIdleExpiryPhaseCeilingSec,
} from "../src/sandbox/keepalive.js";
import { bindHandsKv } from "../src/sandbox/registry.js";
import { bindSandboxProviders } from "../src/sandbox/factory.js";
import { bindSandboxStopRetry } from "../src/sandbox/reaper.js";
import { inspectSandboxJobs } from "../src/sandbox/job-probe.js";
import { filterToRegExp } from "./nats-kv-stub.js";
import type { SandboxProvider } from "../src/sandbox/provider.js";

const sc = StringCodec();
const SESSION = "sess-convergence";

afterEach(() => {
  resetBackgroundWorkStateForTest();
  unregisterSandbox(SESSION);
});

function storeKv(initial: Record<string, unknown>): {
  kv: KV;
  store: Map<string, { value: Uint8Array; revision: number }>;
} {
  const store = new Map<string, { value: Uint8Array; revision: number }>();
  store.set(`hands.${SESSION}`, {
    value: sc.encode(JSON.stringify(initial)),
    revision: 5,
  });
  const kv = {
    async keys(filter = ">") {
      const matched = [...store.keys()].filter((k) => filterToRegExp(filter).test(k));
      return (async function* () { yield* matched; })();
    },
    async get(k: string) {
      const hit = store.get(k);
      return hit ? { key: k, value: hit.value, revision: hit.revision } : null;
    },
    async delete(k: string) { store.delete(k); },
    async put(k: string, value: Uint8Array) {
      const next = (store.get(k)?.revision ?? 0) + 1;
      store.set(k, { value, revision: next });
      return next;
    },
    async update(k: string, value: Uint8Array, rev: number) {
      const hit = store.get(k);
      if (!hit || hit.revision !== rev) {
        const err = new Error("wrong last sequence");
        (err as { code?: string }).code = "BAD_REVISION";
        throw err;
      }
      store.set(k, { value, revision: rev + 1 });
      return rev + 1;
    },
  } as unknown as KV;
  return { kv, store };
}

const CLOSING_HANDLE = {
  status: "closing",
  provider: "safe-workload" as const,
  workloadId: "wl-stuck",
  platformKey: "pk",
  namespace: "ns",
  handsUrl: "http://sandbox:9100/mcp",
  token: "tok",
  keepalive: false,
  idleSince: 0,
  quiescedAt: 0,
};

test("a stop that cannot succeed is not retried on every sweep", async () => {
  // A control plane that refuses every stop leaves the handle `closing`, and a
  // `closing` handle is walked again next sweep. Retried unconditionally, the
  // sweep re-pays the stop's full cost for a set that never shrinks, and the
  // ping phase behind it is what pays for that.
  const { kv } = storeKv({ ...CLOSING_HANDLE });
  bindHandsKv(kv);
  let stops = 0;
  const provider = {
    kind: "safe-workload",
    async exec() { return { exitCode: 0, stdout: "", stderr: "" }; },
    async get() { return { running: true, state: "running" }; },
    async stop() { stops += 1; throw new Error("control plane unavailable"); },
  } as unknown as SandboxProvider;
  const restore = bindSandboxProviders({ safeWorkload: provider, agentSandbox: provider });
  const restoreRetry = bindSandboxStopRetry({ attempts: 1, delayMs: 0 });
  try {
    for (let sweep = 0; sweep < 4; sweep++) {
      await runKeepaliveTickForTest({ kv, countActiveShells: async () => 0 });
      await new Promise((r) => setImmediate(r));
    }
    assert.equal(
      stops, 1,
      "a failed stop has to wait out a backoff; retrying it every sweep never converges",
    );
  } finally {
    restoreRetry();
    restore();
  }
});

test("a stop retried after its backoff still gets its next attempt", async () => {
  // The backoff defers the retry, it does not abandon it. A handle that stops
  // being retried at all is a sandbox nothing is left to tear down.
  const { kv, store } = storeKv({ ...CLOSING_HANDLE });
  bindHandsKv(kv);
  let stops = 0;
  const provider = {
    kind: "safe-workload",
    async exec() { return { exitCode: 0, stdout: "", stderr: "" }; },
    async get() { return { running: true, state: "running" }; },
    async stop() {
      stops += 1;
      if (stops === 1) throw new Error("control plane unavailable");
    },
  } as unknown as SandboxProvider;
  const restore = bindSandboxProviders({ safeWorkload: provider, agentSandbox: provider });
  const restoreRetry = bindSandboxStopRetry({ attempts: 1, delayMs: 0 });
  try {
    let now = 1_000_000;
    const deps = { kv, countActiveShells: async () => 0, now: () => now };
    await runKeepaliveTickForTest(deps);
    await new Promise((r) => setImmediate(r));
    assert.equal(stops, 1, "the first sweep attempts the stop");

    now += 60_000;
    await runKeepaliveTickForTest(deps);
    await new Promise((r) => setImmediate(r));
    assert.equal(stops, 2, "past the backoff the stop is attempted again");
    assert.equal(
      store.has(`hands.${SESSION}`), false,
      "the stop that succeeded has to clear the handle",
    );
  } finally {
    restoreRetry();
    restore();
  }
});

test("the jobs probe budget covers the status read, not only the roster fetch", async () => {
  // The probe makes two round trips: a control-plane status read, then the
  // roster fetch. With a deadline on only the second, a control plane that
  // answers slowly spends its own timeout on top of the budget, and the idle
  // expiry phase that awaits this probe is bounded by neither number.
  const provider = {
    kind: "safe-workload",
    async exec() { return { exitCode: 0, stdout: "", stderr: "" }; },
    async get() {
      await new Promise((r) => setTimeout(r, 5_000));
      return { running: true, state: "running" };
    },
    async stop() {},
  } as unknown as SandboxProvider;
  const restore = bindSandboxProviders({ safeWorkload: provider, agentSandbox: provider });
  try {
    const started = Date.now();
    await assert.rejects(
      inspectSandboxJobs(
        {
          provider: "safe-workload",
          workloadId: "wl-slow",
          platformKey: "pk",
          namespace: "ns",
          sessionId: SESSION,
        },
        250,
      ),
      /budget|deadline|timed out|aborted/i,
    );
    const elapsed = Date.now() - started;
    assert.ok(
      elapsed < 2_000,
      `the status read has to run inside the probe budget, took ${elapsed}ms`,
    );
  } finally {
    restore();
  }
});

test("the declared sweep span covers the idle-expiry phase", () => {
  // Every phase that awaits per-target work has to appear in the span, or the
  // span is a number the sweep routinely exceeds -- and the refresh gaps and
  // the reclaim horizon are both derived from it.
  const expiry = keepaliveIdleExpiryPhaseCeilingSec();
  assert.ok(expiry > 0, "the idle-expiry phase awaits a probe and a stop per handle");
  assert.ok(
    keepaliveSweepCeilingSec() >= expiry,
    "the span has to include the phase that tears handles down",
  );
});
