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

test("a sandbox without GET /api/jobs is not idle-reclaimed", async () => {
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
  try {
    const absent = async () => {
      throw new SandboxJobsUnavailableError(404);
    };
    await runKeepaliveTickForTest({ kv, countActiveShells: absent });
    await new Promise((r) => setImmediate(r));
    await runKeepaliveTickForTest({ kv, countActiveShells: absent });
    assert.equal(stopped.length, 0, "Brain must not stop a sandbox with no jobs API");
    assert.ok(store.has(`hands.${SESSION}`), "handle remains for the workload timeout");
  } finally {
    restore();
  }
});
