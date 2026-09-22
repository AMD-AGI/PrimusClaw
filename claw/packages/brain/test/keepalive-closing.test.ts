// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { StringCodec } from "nats";
import type { KV } from "nats";
import {
  runKeepaliveTickForTest,
  resetBackgroundWorkStateForTest,
  unregisterSandbox,
} from "../src/sandbox/keepalive.js";
import { bindHandsKv } from "../src/sandbox/registry.js";
import { bindSandboxProviders } from "../src/sandbox/factory.js";
import { bindSandboxStopRetry } from "../src/sandbox/reaper.js";
import { SandboxJobsUnavailableError } from "../src/sandbox/job-probe.js";
import { filterToRegExp } from "./nats-kv-stub.js";
import type { SandboxProvider } from "../src/sandbox/provider.js";

const sc = StringCodec();
const SESSION = "sess-closing";

afterEach(() => {
  resetBackgroundWorkStateForTest();
  unregisterSandbox(SESSION);
});

function storeKv(initial: Record<string, unknown>): { kv: KV; store: Map<string, { value: Uint8Array; revision: number }> } {
  const store = new Map<string, { value: Uint8Array; revision: number }>();
  const key = `hands.${SESSION}`;
  store.set(key, { value: sc.encode(JSON.stringify(initial)), revision: 5 });
  const kv = {
    async keys(filter = ">") {
      const matched = [...store.keys()].filter((k) => filterToRegExp(filter).test(k));
      return (async function* () { yield* matched; })();
    },
    async get(k: string) {
      const hit = store.get(k);
      if (!hit) return null;
      return { key: k, value: hit.value, revision: hit.revision };
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

test("an expired idle handle CAS-es to closing before stop", async () => {
  const { kv, store } = storeKv({
    status: "ready",
    provider: "safe-workload",
    workloadId: "wl-1",
    platformKey: "pk",
    namespace: "ns",
    handsUrl: "http://sandbox:9100/mcp",
    token: "tok",
    keepalive: false,
    idleSince: 0,
    quiescedAt: 0,
  });
  bindHandsKv(kv);
  const stopped: string[] = [];
  const provider = {
    kind: "safe-workload",
    async exec() { return { exitCode: 0, stdout: "", stderr: "" }; },
    async get() { return { running: true, state: "running" }; },
    async stop(inst: { id?: string }) { stopped.push(String(inst.id ?? "")); },
  } as unknown as SandboxProvider;
  const restore = bindSandboxProviders({ safeWorkload: provider, agentSandbox: provider });
  const restoreRetry = bindSandboxStopRetry({ attempts: 1, delayMs: 0 });
  try {
    await runKeepaliveTickForTest({ kv, countActiveShells: async () => 0 });
    await new Promise((r) => setImmediate(r));
    await runKeepaliveTickForTest({ kv, countActiveShells: async () => 0 });
    assert.ok(stopped.includes("wl-1"), "closing must stop the sandbox identity");
    assert.equal(store.has(`hands.${SESSION}`), false, "successful stop clears the handle");
  } finally {
    restoreRetry();
    restore();
  }
});

test("a closing handle is not treated as idle-empty work", async () => {
  const { kv, store } = storeKv({
    status: "closing",
    provider: "safe-workload",
    workloadId: "wl-1",
    platformKey: "pk",
    namespace: "ns",
    handsUrl: "http://sandbox:9100/mcp",
    token: "tok",
    keepalive: false,
    idleSince: 0,
    quiescedAt: 0,
  });
  bindHandsKv(kv);
  const stopped: string[] = [];
  const provider = {
    kind: "safe-workload",
    async exec() { return { exitCode: 0, stdout: "", stderr: "" }; },
    async get() { return { running: true, state: "running" }; },
    async stop(inst: { id?: string }) { stopped.push(String(inst.id ?? "")); },
  } as unknown as SandboxProvider;
  const restore = bindSandboxProviders({ safeWorkload: provider, agentSandbox: provider });
  const restoreRetry = bindSandboxStopRetry({ attempts: 1, delayMs: 0 });
  try {
    await runKeepaliveTickForTest({ kv, countActiveShells: async () => 0 });
    assert.ok(stopped.includes("wl-1"), "closing retries stop");
    const left = store.get(`hands.${SESSION}`);
    if (left) {
      const info = JSON.parse(sc.decode(left.value)) as { status?: string };
      assert.notEqual(info.status, "ready", "closing must not return to ready");
    }
  } finally {
    restoreRetry();
    restore();
  }
});

test("a sandbox without GET /api/jobs is not reclaimed after the idle window", async () => {
  // JobsUnavailable cannot prove an empty roster. Hard timeout is the backstop.
  const { kv, store } = storeKv({
    status: "ready",
    provider: "safe-workload",
    workloadId: "wl-1",
    platformKey: "pk",
    namespace: "ns",
    handsUrl: "http://sandbox:9100/mcp",
    token: "tok",
    keepalive: false,
    idleSince: 0,
    quiescedAt: 0,
  });
  bindHandsKv(kv);
  const stopped: string[] = [];
  const provider = {
    kind: "safe-workload",
    async exec() { return { exitCode: 0, stdout: "", stderr: "" }; },
    async get() { return { running: true, state: "running" }; },
    async stop(inst: { id?: string }) { stopped.push(String(inst.id ?? "")); },
  } as unknown as SandboxProvider;
  const restore = bindSandboxProviders({ safeWorkload: provider, agentSandbox: provider });
  const restoreRetry = bindSandboxStopRetry({ attempts: 1, delayMs: 0 });
  try {
    const absent = async () => {
      throw new SandboxJobsUnavailableError(404);
    };
    await runKeepaliveTickForTest({ kv, countActiveShells: absent });
    await new Promise((r) => setImmediate(r));
    await runKeepaliveTickForTest({ kv, countActiveShells: absent });
    assert.equal(stopped.length, 0, "jobs unavailable must not authorise idle destroy");
    assert.equal(store.has(`hands.${SESSION}`), true);
  } finally {
    restoreRetry();
    restore();
  }
});

test("JobsUnavailable never closes over a concurrent ready write", async () => {
  // A transient Router 404 maps to JobsUnavailable. That path must not destroy.
  const key = `hands.${SESSION}`;
  const store = new Map<string, { value: Uint8Array; revision: number }>();
  store.set(key, {
    value: sc.encode(JSON.stringify({
      status: "ready",
      provider: "safe-workload",
      workloadId: "wl-jobs",
      platformKey: "pk",
      namespace: "ns",
      handsUrl: "http://sandbox:9100/mcp",
      token: "tok",
      keepalive: false,
      idleSince: 0,
      quiescedAt: 0,
    })),
    revision: 5,
  });
  const closingAt: number[] = [];
  const kv = {
    async keys(filter = ">") {
      const matched = [...store.keys()].filter((k) => filterToRegExp(filter).test(k));
      return (async function* () { yield* matched; })();
    },
    async get(k: string) {
      const hit = store.get(k);
      if (!hit) return null;
      return { key: k, value: hit.value, revision: hit.revision };
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
      const parsed = JSON.parse(sc.decode(value)) as { status?: string };
      if (parsed.status === "closing") closingAt.push(rev);
      store.set(k, { value, revision: rev + 1 });
      return rev + 1;
    },
  } as unknown as KV;
  bindHandsKv(kv);
  const stopped: string[] = [];
  const provider = {
    kind: "safe-workload",
    async exec() { return { exitCode: 0, stdout: "", stderr: "" }; },
    async get() { return { running: true, state: "running" }; },
    async stop(inst: { id?: string }) { stopped.push(String(inst.id ?? "")); },
  } as unknown as SandboxProvider;
  const restore = bindSandboxProviders({ safeWorkload: provider, agentSandbox: provider });
  const restoreRetry = bindSandboxStopRetry({ attempts: 1, delayMs: 0 });
  try {
    let probed = false;
    const countActiveShells = async () => {
      if (!probed) {
        probed = true;
        const hit = store.get(key)!;
        store.set(key, {
          value: sc.encode(JSON.stringify({
            status: "ready",
            provider: "safe-workload",
            workloadId: "wl-jobs",
            platformKey: "pk",
            namespace: "ns",
            handsUrl: "http://sandbox:9100/mcp",
            token: "tok",
            keepalive: true,
          })),
          revision: hit.revision + 1,
        });
      }
      throw new SandboxJobsUnavailableError(404);
    };
    await runKeepaliveTickForTest({ kv, countActiveShells });
    await new Promise((r) => setImmediate(r));
    await runKeepaliveTickForTest({ kv, countActiveShells });
    assert.deepEqual(closingAt, [], "JobsUnavailable must not close");
    assert.equal(stopped.length, 0, "the concurrent ready sandbox must not be destroyed");
    assert.ok(store.has(key));
  } finally {
    restoreRetry();
    restore();
  }
});

test("an in-window unknown probe renews the handle without clearing quiescedAt", async () => {
  const now = 1_000_000;
  const idleSince = now - 60_000;
  const quiescedAt = idleSince;
  const { kv, store } = storeKv({
    status: "ready",
    provider: "safe-workload",
    workloadId: "wl-unk",
    platformKey: "pk",
    namespace: "ns",
    handsUrl: "http://sandbox:9100/mcp",
    token: "tok",
    keepalive: false,
    idleSince,
    quiescedAt,
    workSeenAt: idleSince,
  });
  bindHandsKv(kv);
  const provider = {
    kind: "safe-workload",
    async exec() { return { exitCode: 0, stdout: "", stderr: "" }; },
    async get() { return { running: true, state: "running" }; },
    async stop() {},
  } as unknown as SandboxProvider;
  const restore = bindSandboxProviders({ safeWorkload: provider, agentSandbox: provider });
  try {
    await runKeepaliveTickForTest({
      kv,
      countActiveShells: async () => { throw new Error("router briefly unreachable"); },
      now: () => now,
    });
    const left = store.get(`hands.${SESSION}`);
    assert.ok(left);
    const info = JSON.parse(sc.decode(left.value)) as {
      idleSince?: number; quiescedAt?: number;
    };
    assert.equal(info.idleSince, idleSince, "park stamp stays the idle-period identity");
    assert.equal(info.quiescedAt, quiescedAt, "unknown must not clear the reuse-window anchor");
  } finally {
    restore();
  }
});

test("a tombstoned hands key during reclaim is treated as already gone", async () => {
  const key = `hands.${SESSION}`;
  const store = new Map<string, { value: Uint8Array; revision: number; operation?: string }>();
  store.set(key, {
    value: sc.encode(JSON.stringify({
      status: "ready",
      provider: "safe-workload",
      workloadId: "wl-tomb",
      platformKey: "pk",
      namespace: "ns",
      handsUrl: "http://sandbox:9100/mcp",
      token: "tok",
      keepalive: false,
      idleSince: 0,
      quiescedAt: 0,
    })),
    revision: 5,
  });
  const kv = {
    async keys(filter = ">") {
      const matched = [...store.keys()].filter((k) => filterToRegExp(filter).test(k));
      return (async function* () { yield* matched; })();
    },
    async get(k: string) {
      const hit = store.get(k);
      if (!hit) return null;
      return { key: k, value: hit.value, revision: hit.revision, operation: hit.operation };
    },
    async delete(k: string) { store.delete(k); },
    async put() { return 1; },
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
  bindHandsKv(kv);
  const stopped: string[] = [];
  const provider = {
    kind: "safe-workload",
    async exec() { return { exitCode: 0, stdout: "", stderr: "" }; },
    async get() { return { running: true, state: "running" }; },
    async stop(inst: { id?: string }) { stopped.push(String(inst.id ?? "")); },
  } as unknown as SandboxProvider;
  const restore = bindSandboxProviders({ safeWorkload: provider, agentSandbox: provider });
  const restoreRetry = bindSandboxStopRetry({ attempts: 1, delayMs: 0 });
  try {
    const countActiveShells = async () => {
      store.set(key, { value: new Uint8Array(0), revision: 6, operation: "DEL" });
      return 0;
    };
    await runKeepaliveTickForTest({ kv, countActiveShells });
    await new Promise((r) => setImmediate(r));
    await runKeepaliveTickForTest({ kv, countActiveShells });
    assert.equal(stopped.length, 0, "a tombstone must not be parsed into a reclaim payload");
  } finally {
    restoreRetry();
    restore();
  }
});

test("idle reclaim CAS uses the enrollment revision after a concurrent ready write", async () => {
  // During the destructive probe, another writer clears idle markers and bumps
  // the revision (ensureHands). Reclaim must CAS against the enrollment
  // revision so that write wins; adopting the latest revision would destroy the
  // sandbox that just became busy.
  const key = `hands.${SESSION}`;
  const store = new Map<string, { value: Uint8Array; revision: number }>();
  store.set(key, {
    value: sc.encode(JSON.stringify({
      status: "ready",
      provider: "safe-workload",
      workloadId: "wl-race",
      platformKey: "pk",
      namespace: "ns",
      handsUrl: "http://sandbox:9100/mcp",
      token: "tok",
      keepalive: false,
      idleSince: 0,
      quiescedAt: 0,
    })),
    revision: 5,
  });
  const closingAt: number[] = [];
  const kv = {
    async keys(filter = ">") {
      const matched = [...store.keys()].filter((k) => filterToRegExp(filter).test(k));
      return (async function* () { yield* matched; })();
    },
    async get(k: string) {
      const hit = store.get(k);
      if (!hit) return null;
      return { key: k, value: hit.value, revision: hit.revision };
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
      const parsed = JSON.parse(sc.decode(value)) as { status?: string };
      if (parsed.status === "closing") closingAt.push(rev);
      store.set(k, { value, revision: rev + 1 });
      return rev + 1;
    },
  } as unknown as KV;
  bindHandsKv(kv);
  const stopped: string[] = [];
  const provider = {
    kind: "safe-workload",
    async exec() { return { exitCode: 0, stdout: "", stderr: "" }; },
    async get() { return { running: true, state: "running" }; },
    async stop(inst: { id?: string }) { stopped.push(String(inst.id ?? "")); },
  } as unknown as SandboxProvider;
  const restore = bindSandboxProviders({ safeWorkload: provider, agentSandbox: provider });
  const restoreRetry = bindSandboxStopRetry({ attempts: 1, delayMs: 0 });
  try {
    let probed = false;
    const countActiveShells = async () => {
      if (!probed) {
        probed = true;
        // Simulate ensureHands: clear idle markers, bump past enrollment rev 5.
        const hit = store.get(key)!;
        store.set(key, {
          value: sc.encode(JSON.stringify({
            status: "ready",
            provider: "safe-workload",
            workloadId: "wl-race",
            platformKey: "pk",
            namespace: "ns",
            handsUrl: "http://sandbox:9100/mcp",
            token: "tok",
            keepalive: true,
          })),
          revision: hit.revision + 1,
        });
      }
      return 0;
    };
    await runKeepaliveTickForTest({ kv, countActiveShells });
    await new Promise((r) => setImmediate(r));
    await runKeepaliveTickForTest({ kv, countActiveShells });
    assert.deepEqual(closingAt, [], "closing must not land on a bumped ready revision");
    assert.equal(stopped.length, 0, "the concurrent ready sandbox must not be destroyed");
    assert.ok(store.has(key), "handle remains for the live turn");
    const left = JSON.parse(sc.decode(store.get(key)!.value)) as { status?: string; keepalive?: boolean };
    assert.equal(left.status, "ready");
    assert.equal(left.keepalive, true);
  } finally {
    restoreRetry();
    restore();
  }
});

test("a recorded terminalReason stops the sandbox instead of leaking it", async () => {
  const { kv, store } = storeKv({
    status: "ready",
    provider: "safe-workload",
    workloadId: "wl-term",
    platformKey: "pk",
    namespace: "ns",
    terminalReason: "sandbox_instance_replaced",
  });
  bindHandsKv(kv);
  const stopped: string[] = [];
  const provider = {
    kind: "safe-workload",
    async exec() { return { exitCode: 0, stdout: "", stderr: "" }; },
    async get() { return { running: true, state: "running" }; },
    async stop(inst: { id?: string }) { stopped.push(String(inst.id ?? "")); },
  } as unknown as SandboxProvider;
  const restore = bindSandboxProviders({ safeWorkload: provider, agentSandbox: provider });
  const restoreRetry = bindSandboxStopRetry({ attempts: 1, delayMs: 0 });
  try {
    await runKeepaliveTickForTest({ kv, countActiveShells: async () => 0 });
    assert.ok(stopped.includes("wl-term"), "terminalReason must stop the sandbox");
    assert.equal(store.has(`hands.${SESSION}`), false);
  } finally {
    restoreRetry();
    restore();
  }
});

test("a handle without platformKey does not reset its idle clock", async () => {
  const { kv, store } = storeKv({
    status: "ready",
    provider: "safe-workload",
    workloadId: "wl-1",
    namespace: "ns",
    keepalive: false,
    idleSince: 1,
    quiescedAt: 1,
  });
  bindHandsKv(kv);
  const stopped: string[] = [];
  const provider = {
    kind: "safe-workload",
    async exec() { return { exitCode: 0, stdout: "", stderr: "" }; },
    async get() { return { running: true, state: "running" }; },
    async stop(inst: { id?: string }) { stopped.push(String(inst.id ?? "")); },
  } as unknown as SandboxProvider;
  const restore = bindSandboxProviders({ safeWorkload: provider, agentSandbox: provider });
  try {
    await runKeepaliveTickForTest({ kv, countActiveShells: async () => 0, now: () => 1_000_000 });
    assert.equal(stopped.length, 0);
    const left = store.get(`hands.${SESSION}`);
    assert.ok(left);
    const info = JSON.parse(sc.decode(left.value)) as { idleSince?: number };
    assert.equal(info.idleSince, 1, "incomplete identity must not refresh idleSince");
  } finally {
    restore();
  }
});

test("an absent workload is reaped without a frontend sandbox failure", async () => {
  const { kv } = storeKv({
    status: "ready",
    provider: "safe-workload",
    workloadId: "wl-1",
    platformKey: "pk",
    namespace: "ns",
    handsUrl: "http://sandbox:9100/mcp",
    token: "tok",
    keepalive: false,
    idleSince: 0,
    quiescedAt: 0,
  });
  bindHandsKv(kv);
  const events: Array<{ status?: string; reason?: string }> = [];
  const stopped: string[] = [];
  const provider = {
    kind: "safe-workload",
    async exec() { return { exitCode: 0, stdout: "", stderr: "" }; },
    async get() { return { running: false, state: "absent" }; },
    async stop(inst: { id?: string }) { stopped.push(String(inst.id ?? "")); },
  } as unknown as SandboxProvider;
  const restore = bindSandboxProviders({ safeWorkload: provider, agentSandbox: provider });
  const restoreRetry = bindSandboxStopRetry({ attempts: 1, delayMs: 0 });
  try {
    const { SandboxTerminalProbeError } = await import("../src/sandbox/job-probe.js");
    const deps = {
      kv,
      countActiveShells: async () => {
        throw new SandboxTerminalProbeError("absent", "sandbox_workload_absent");
      },
      emitSandboxFailure: async (_sid, evt) => { events.push(evt); },
    };
    // Two sweeps: the probe publishes absence as a verdict, and the sweep that
    // reads it back releases the handle under the ordinary reclaim guards.
    await runKeepaliveTickForTest(deps);
    await new Promise((r) => setImmediate(r));
    await runKeepaliveTickForTest(deps);
    assert.ok(stopped.includes("wl-1"));
    assert.equal(events.length, 0, "absent is not a frontend sandbox failure");
  } finally {
    restoreRetry();
    restore();
  }
});

test("a terminal jobs answer closes and records the reason in one reclaim CAS", async () => {
  const { kv, store } = storeKv({
    status: "ready",
    provider: "safe-workload",
    workloadId: "wl-term-cas",
    platformKey: "pk",
    namespace: "ns",
    handsUrl: "http://sandbox:9100/mcp",
    token: "tok",
    keepalive: false,
    idleSince: 0,
    quiescedAt: 0,
  });
  bindHandsKv(kv);
  const key = `hands.${SESSION}`;
  const closingWrites: Array<{ status?: string; terminalReason?: string }> = [];
  const origUpdate = kv.update.bind(kv);
  kv.update = async (k: string, value: Uint8Array, rev: number) => {
    const parsed = JSON.parse(sc.decode(value)) as { status?: string; terminalReason?: string };
    if (parsed.status === "closing") closingWrites.push(parsed);
    return origUpdate(k, value, rev);
  };
  const events: Array<{ status?: string; reason?: string }> = [];
  const stopped: string[] = [];
  const provider = {
    kind: "safe-workload",
    async exec() { return { exitCode: 0, stdout: "", stderr: "" }; },
    async get() { return { running: true, state: "running" }; },
    async stop(inst: { id?: string }) { stopped.push(String(inst.id ?? "")); },
  } as unknown as SandboxProvider;
  const restore = bindSandboxProviders({ safeWorkload: provider, agentSandbox: provider });
  const restoreRetry = bindSandboxStopRetry({ attempts: 1, delayMs: 0 });
  try {
    const { SandboxTerminalProbeError } = await import("../src/sandbox/job-probe.js");
    await runKeepaliveTickForTest({
      kv,
      countActiveShells: async () => {
        throw new SandboxTerminalProbeError("terminal", "sandbox_workload_terminal");
      },
      emitSandboxFailure: async (_sid, evt) => { events.push(evt); },
      now: () => 1_000_000,
    });
    assert.equal(closingWrites.length, 1, "one closing write, not terminalReason then closing");
    assert.equal(closingWrites[0]?.status, "closing");
    assert.equal(closingWrites[0]?.terminalReason, "sandbox_workload_terminal");
    assert.ok(stopped.includes("wl-term-cas"), "destroy must run after the combined CAS");
    assert.equal(events.length, 1);
    assert.equal(events[0]?.reason, "sandbox_workload_terminal");
    assert.equal(store.has(key), false);
  } finally {
    restoreRetry();
    restore();
  }
});
