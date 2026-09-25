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
import { bindSandboxStopRetry, handsStopCeilingMs } from "../src/sandbox/reaper.js";
import { inspectSandboxJobs } from "../src/sandbox/job-probe.js";
import { SANDBOX_KEEPALIVE_SWEEP_SPAN_SEC } from "../src/config.js";
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

test("the teardown backoff outlasts the sweep interval", async () => {
  // A backoff at or below one interval has expired by the time the next sweep
  // reaches the record, so it defers nothing and the cost it exists to bound is
  // paid every sweep anyway. Pinned because the first version of this backoff
  // was exactly one interval and read as working while doing nothing.
  const { SANDBOX_KEEPALIVE_INTERVAL_SEC, BRAIN_REGISTRY_TTL_MS } = await import("../src/config.js");
  const { TEARDOWN_RETRY_BACKOFF_MS } = await import("../src/sandbox/keepalive.js");
  assert.ok(
    TEARDOWN_RETRY_BACKOFF_MS > SANDBOX_KEEPALIVE_INTERVAL_SEC * 1000,
    `a ${TEARDOWN_RETRY_BACKOFF_MS}ms backoff does not outlast a `
      + `${SANDBOX_KEEPALIVE_INTERVAL_SEC}s sweep interval`,
  );
  assert.ok(
    TEARDOWN_RETRY_BACKOFF_MS < BRAIN_REGISTRY_TTL_MS,
    `a ${TEARDOWN_RETRY_BACKOFF_MS}ms backoff at or above the `
      + `${BRAIN_REGISTRY_TTL_MS}ms bucket TTL abandons the stop before it retries`,
  );
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

    const { TEARDOWN_RETRY_BACKOFF_MS } = await import("../src/sandbox/keepalive.js");
    now += TEARDOWN_RETRY_BACKOFF_MS + 1_000;
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

test("the idle-expiry budget bars teardowns rather than merely being declared", async () => {
  // The budget is what keeps one unresponsive control plane from spending the
  // whole sweep on teardowns while the phase that renews every live record
  // waits behind it. Asserting the declared ceiling covers the phase says
  // nothing, since the ceiling is a sum that contains it: the observable is
  // that an exhausted budget actually stops teardowns from starting.
  const handles = 6;
  const store = new Map<string, { value: Uint8Array; revision: number }>();
  for (let i = 0; i < handles; i++) {
    store.set(`hands.sess-budget-${i}`, {
      value: sc.encode(JSON.stringify({ ...CLOSING_HANDLE, workloadId: `wl-${i}` })),
      revision: 5,
    });
  }
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
    async put() { return 1; },
    async update(k: string, value: Uint8Array, rev: number) {
      store.set(k, { value, revision: rev + 1 });
      return rev + 1;
    },
  } as unknown as KV;
  bindHandsKv(kv);
  let stops = 0;
  const provider = {
    kind: "safe-workload",
    async exec() { return { exitCode: 0, stdout: "", stderr: "" }; },
    async get() { return { running: true, state: "running" }; },
    async stop() { stops += 1; },
  } as unknown as SandboxProvider;
  const restore = bindSandboxProviders({ safeWorkload: provider, agentSandbox: provider });
  const restoreRetry = bindSandboxStopRetry({ attempts: 1, delayMs: 0 });
  try {
    await runKeepaliveTickForTest({
      kv, countActiveShells: async () => 0, idleExpiryBudgetMs: 0,
    });
    assert.equal(
      stops, 0,
      `an exhausted budget still started ${stops} of ${handles} teardowns`,
    );
    assert.equal(store.size, handles, "a deferred teardown must leave its record alone");
  } finally {
    restoreRetry();
    restore();
    for (const key of store.keys()) unregisterSandbox(key.replace("hands.", ""));
  }
});

test("the declared sweep span covers a sweep's real worst case", () => {
  // Every phase that awaits per-target work has to appear in the span, and each
  // term has to name the real cost of the work it lets start. A teardown is a
  // stop with retries, so a term naming one attempt understates the phase by
  // the retry count -- and the refresh gap and the reclaim horizon are both
  // derived from this span.
  //
  // The stop is also not where a teardown ends: the dag-handle release and the
  // multi-node cascade are awaited after it, and a ceiling that stops at the
  // stop understates a teardown by however long those two take.
  assert.equal(
    handsStopCeilingMs(),
    3 * 30_000 + 2 * 1_000 + 15_000 + 30_000,
    "the ceiling is the stop's attempts and waits, plus the release and the cascade",
  );
  assert.ok(
    keepaliveIdleExpiryPhaseCeilingSec() * 1000 > handsStopCeilingMs(),
    "the idle-expiry term has to cover the teardown it lets start",
  );
  assert.ok(
    SANDBOX_KEEPALIVE_SWEEP_SPAN_SEC > keepaliveSweepCeilingSec(),
    `the shipped span ${SANDBOX_KEEPALIVE_SWEEP_SPAN_SEC}s does not cover a worst-case `
      + `tick of ${keepaliveSweepCeilingSec()}s`,
  );
});

test("the idle-expiry budget bars idle reclamations, not only closing teardowns", async () => {
  // The closing-handle case shares the budget with idle expiries, so a guard
  // that only wraps teardowns still keeps that case green. Idle expiries are
  // the other starter of destroyHands in this phase, and removing only their
  // budget check used to leave CI green.
  const now = 1_000_000_000;
  const idleSince = now - 3_600_000;
  const handles = 4;
  const store = new Map<string, { value: Uint8Array; revision: number }>();
  for (let i = 0; i < handles; i++) {
    store.set(`hands.sess-idle-${i}`, {
      value: sc.encode(JSON.stringify({
        status: "ready",
        provider: "safe-workload",
        workloadId: `wl-idle-${i}`,
        platformKey: "pk",
        namespace: "ns",
        handsUrl: "http://sandbox:9100/mcp",
        token: "tok",
        keepalive: false,
        idleSince,
        idleEpoch: idleSince,
        idleRev: 3,
        quiescedAt: idleSince,
        bgCheckedAt: now - 1_000,
        bgRunning: 0,
        bgEpoch: idleSince,
        bgIdleSince: idleSince,
        bgIdleRev: 3,
        bgRev: 4,
      })),
      revision: 5,
    });
  }
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
    async put() { return 1; },
    async update(k: string, value: Uint8Array, rev: number) {
      store.set(k, { value, revision: rev + 1 });
      return rev + 1;
    },
  } as unknown as KV;
  bindHandsKv(kv);
  let stops = 0;
  const provider = {
    kind: "safe-workload",
    async exec() { return { exitCode: 0, stdout: "", stderr: "" }; },
    async get() { return { running: true, state: "running" }; },
    async stop() { stops += 1; },
  } as unknown as SandboxProvider;
  const restore = bindSandboxProviders({ safeWorkload: provider, agentSandbox: provider });
  const restoreRetry = bindSandboxStopRetry({ attempts: 1, delayMs: 0 });
  try {
    await runKeepaliveTickForTest({
      kv,
      countActiveShells: async () => 0,
      idleExpiryBudgetMs: 0,
      now: () => now,
    });
    assert.equal(
      stops, 0,
      `an exhausted budget still started ${stops} of ${handles} idle reclamations`,
    );
    assert.equal(store.size, handles, "a deferred idle expiry must leave its record alone");
  } finally {
    restoreRetry();
    restore();
    for (const key of store.keys()) unregisterSandbox(key.replace("hands.", ""));
  }
});
