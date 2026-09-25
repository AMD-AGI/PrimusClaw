// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Behavioural coverage for the sixth-round wiring the source-regex tests miss:
 * destroyHandsForReuse must forward activeMessageId into opts, keepalive failure
 * eviction must skip MN cascade, and within-window idle holds must be renewed
 * again at the end of tick after the ping/failure phases.
 *
 * FAIL_LIMIT is read once at config import. Set it before any dynamic brain
 * import so the failure-eviction path can call destroyHands in this file.
 */
process.env.SANDBOX_KEEPALIVE_FAIL_LIMIT = "1";

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { StringCodec, type KV } from "nats";

import { filterToRegExp } from "./nats-kv-stub.js";
import type { SandboxProvider } from "../src/sandbox/provider.js";

const {
  destroyHandsForReuse,
} = await import("../src/sandbox/ensure-hands.js");
const {
  bindClusterReclaimForTest,
  bindSandboxStopRetry,
  destroyHands,
} = await import("../src/sandbox/reaper.js");
const { bindHandsKv } = await import("../src/sandbox/registry.js");
const { bindSandboxProviders } = await import("../src/sandbox/factory.js");
const {
  runKeepaliveTickForTest,
  resetBackgroundWorkStateForTest,
  registerSandbox,
  registeredSandboxCount,
  unregisterSandbox,
} = await import("../src/sandbox/keepalive.js");

const sc = StringCodec();

afterEach(() => {
  resetBackgroundWorkStateForTest();
});

test("destroyHandsForReuse forwards activeMessageId so MN cascade skips", async (t) => {
  // If the wrapper drops activeMessageId, destroyHands cascades and this
  // reclaim is invoked. Source-regex tests on call sites stay green either way.
  const reclaimed: string[] = [];
  const restoreReclaim = bindClusterReclaimForTest(async (_sid, _key, messageId) => {
    if (messageId) reclaimed.push(messageId);
    return messageId ? 1 : 0;
  });
  t.after(restoreReclaim);

  const makeKv = (workloadId: string) => {
    const ENTRY = {
      provider: "safe-workload" as const,
      workloadId,
      platformKey: "pk",
      namespace: "ns",
      messageId: "msg-in-flight",
      token: "tok",
    };
    const deleted: string[] = [];
    const kv = {
      async get(key: string) {
        if (deleted.includes(key)) return null;
        return { key, value: sc.encode(JSON.stringify(ENTRY)), revision: 1 };
      },
      async delete(key: string) { deleted.push(key); },
      async put() { return 1; },
      async update() { return 2; },
    } as unknown as KV;
    return { kv, ENTRY };
  };

  const provider = {
    kind: "safe-workload",
    async stop() {},
  } as unknown as SandboxProvider;
  const restoreProviders = bindSandboxProviders({
    safeWorkload: provider, agentSandbox: provider,
  });
  t.after(restoreProviders);
  const restoreRetry = bindSandboxStopRetry({ attempts: 1, delayMs: 0 });
  t.after(restoreRetry);

  const skipped = makeKv("wl-rebuild");
  bindHandsKv(skipped.kv);
  await destroyHandsForReuse("sess-reuse", skipped.ENTRY, skipped.ENTRY.token, "msg-in-flight");
  assert.deepEqual(reclaimed, [], "activeMessageId must reach destroyHands opts");

  const cascaded = makeKv("wl-cascade");
  bindHandsKv(cascaded.kv);
  await destroyHands("sess-cascade", cascaded.ENTRY, cascaded.ENTRY.token);
  assert.deepEqual(reclaimed, ["msg-in-flight"], "without activeMessageId cascade runs");
});

function failEvictKv(opts: {
  sessionId: string;
  messageId: string;
  runLease?: boolean;
  runScope?: string;
}): { kv: KV; key: string } {
  const key = `hands.${opts.sessionId}`;
  const leaseKey = `lock.${opts.runScope ?? opts.sessionId}`;
  const ENTRY = {
    status: "ready",
    provider: "safe-workload",
    workloadId: `wl-${opts.sessionId}`,
    platformKey: "pk",
    namespace: "ns",
    handsUrl: "http://sandbox:9100/mcp",
    token: "tok",
    keepalive: true,
    messageId: opts.messageId,
    ...(opts.runScope ? { runScope: opts.runScope } : {}),
  };
  const store = new Map<string, { value: Uint8Array; revision: number }>([
    [key, { value: sc.encode(JSON.stringify(ENTRY)), revision: 1 }],
  ]);
  if (opts.runLease) {
    store.set(leaseKey, { value: sc.encode("{}"), revision: 1 });
  }
  const kv = {
    async get(k: string) {
      const found = store.get(k);
      return found ? { key: k, value: found.value, revision: found.revision } : null;
    },
    async keys(filter = ">") {
      const re = filterToRegExp(filter);
      return (async function* () {
        for (const k of store.keys()) if (re.test(k)) yield k;
      })();
    },
    async put(k: string, v: Uint8Array) {
      const next = (store.get(k)?.revision ?? 0) + 1;
      store.set(k, { value: v, revision: next });
      return next;
    },
    async update(k: string, value: Uint8Array, rev: number) {
      const found = store.get(k);
      if (!found || found.revision !== rev) {
        throw Object.assign(new Error("wrong last sequence"), { code: "10071" });
      }
      store.set(k, { value, revision: rev + 1 });
      return rev + 1;
    },
    async delete(k: string) { store.delete(k); },
  } as unknown as KV;
  return { kv, key };
}

test("keepalive failure eviction skips MN cascade only while a run lease is held", async (t) => {
  // Without a lease the handle messageId is stale: cascade must run so the
  // cluster is not left to workload timeout after hands is deleted.
  const reclaimed: string[] = [];
  const restoreReclaim = bindClusterReclaimForTest(async (_sid, _key, messageId) => {
    if (messageId) reclaimed.push(messageId);
    return messageId ? 1 : 0;
  });
  t.after(restoreReclaim);

  let stops = 0;
  const provider = {
    kind: "safe-workload",
    async get() { return { running: false, healthy: false, state: "absent" }; },
    async stop() { stops += 1; },
  } as unknown as SandboxProvider;
  const restoreProviders = bindSandboxProviders({
    safeWorkload: provider, agentSandbox: provider,
  });
  t.after(restoreProviders);
  const restoreRetry = bindSandboxStopRetry({ attempts: 1, delayMs: 0 });
  t.after(restoreRetry);

  const live = failEvictKv({
    sessionId: "sess-fail-leased",
    messageId: "msg-leased",
    runLease: true,
  });
  bindHandsKv(live.kv);
  t.after(() => unregisterSandbox("sess-fail-leased"));
  await runKeepaliveTickForTest({ kv: live.kv, countActiveShells: async () => 0 });
  assert.ok(stops >= 1, "FAIL_LIMIT=1 must destroyHands on a lone gone ping");
  assert.deepEqual(reclaimed, [], "a held run lease must skip cascade");

  stops = 0;
  reclaimed.length = 0;
  const stale = failEvictKv({
    sessionId: "sess-fail-stale",
    messageId: "msg-stale",
    runLease: false,
  });
  bindHandsKv(stale.kv);
  t.after(() => unregisterSandbox("sess-fail-stale"));
  await runKeepaliveTickForTest({ kv: stale.kv, countActiveShells: async () => 0 });
  assert.ok(stops >= 1, "stale handles are still evicted");
  assert.deepEqual(reclaimed, ["msg-stale"], "no lease means cascade must reclaim");
});

test("failure eviction is not vetoed by a live sibling sandbox of the same session", async (t) => {
  // A DAG session can hold two sandboxes. One of them confirmed dead is a
  // verdict on that identity; the other staying registered is no reason to
  // keep it -- or to keep its admission slot and KV record alive for ever.
  const SESSION = "sess-dag-two";
  const DEAD = `wl-${SESSION}`;
  const SIBLING = "wl-sibling";
  const { kv } = failEvictKv({ sessionId: SESSION, messageId: "msg-dag", runLease: false });
  bindHandsKv(kv);

  const stopped: string[] = [];
  const provider = {
    kind: "safe-workload",
    async get(inst: { id: string }) {
      return inst.id === DEAD
        ? { running: false, healthy: false, state: "absent" }
        : { running: true, healthy: true, state: "running" };
    },
    async stop(inst: { id: string }) { stopped.push(inst.id); },
  } as unknown as SandboxProvider;
  const restoreProviders = bindSandboxProviders({
    safeWorkload: provider, agentSandbox: provider,
  });
  const restoreRetry = bindSandboxStopRetry({ attempts: 1, delayMs: 0 });
  const restoreReclaim = bindClusterReclaimForTest(async () => 0);
  t.after(() => {
    restoreProviders();
    restoreRetry();
    restoreReclaim();
    unregisterSandbox(SESSION);
  });

  const base = { provider: "safe-workload" as const, platformKey: "pk", namespace: "ns" };
  registerSandbox(SESSION, { ...base, workloadId: DEAD });
  registerSandbox(SESSION, { ...base, workloadId: SIBLING });

  await runKeepaliveTickForTest({ kv, countActiveShells: async () => 0 });

  assert.deepEqual(stopped, [DEAD], "the dead sandbox is evicted, the live sibling is not");
  assert.equal(registeredSandboxCount(SESSION), 1, "only the sibling stays registered");
});

test("tick renews within-window idle holds after the ping phase", async (t) => {
  // Mid-census renewIdleHolds is not enough when ping/failure outlast the TTL.
  // A within-window park must be refreshed again at tick end.
  const SESSION = "sess-idle-hold";
  const KEY = `hands.${SESSION}`;
  const now = Date.now();
  const idleSince = now - 60_000;
  const BINDING = {
    status: "ready",
    provider: "safe-workload",
    workloadId: "wl-hold",
    platformKey: "pk",
    namespace: "ns",
    handsUrl: "http://sandbox:9100/mcp",
    token: "tok",
    keepalive: false,
    // Fresh idle clock + shared idle verdict: collectIdleTarget parks this
    // as within-window (not a ping target, not an unknown probe).
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
  };
  let holdUpdates = 0;
  const store = new Map<string, { value: Uint8Array; revision: number }>([
    [KEY, { value: sc.encode(JSON.stringify(BINDING)), revision: 3 }],
  ]);
  // A separate keepalive:true target so tick runs the ping phase before the
  // end-of-tick hold renew.
  const PING_SESSION = "sess-ping";
  const PING_KEY = `hands.${PING_SESSION}`;
  store.set(PING_KEY, {
    value: sc.encode(JSON.stringify({
      status: "ready",
      provider: "safe-workload",
      workloadId: "wl-ping",
      platformKey: "pk",
      namespace: "ns",
      handsUrl: "http://sandbox:9100/mcp",
      token: "tok",
      keepalive: true,
    })),
    revision: 1,
  });

  const kv = {
    async get(key: string) {
      const found = store.get(key);
      return found ? { key, value: found.value, revision: found.revision } : null;
    },
    async keys(filter = ">") {
      const re = filterToRegExp(filter);
      return (async function* () {
        for (const k of store.keys()) if (re.test(k)) yield k;
      })();
    },
    async put(key: string, v: Uint8Array) {
      const next = (store.get(key)?.revision ?? 0) + 1;
      store.set(key, { value: v, revision: next });
      return next;
    },
    async update(key: string, value: Uint8Array, rev: number) {
      const found = store.get(key);
      if (!found || found.revision !== rev) {
        throw Object.assign(new Error("wrong last sequence"), { code: "10071" });
      }
      if (key === KEY) holdUpdates += 1;
      store.set(key, { value, revision: rev + 1 });
      return rev + 1;
    },
    async delete() {},
  } as unknown as KV;
  bindHandsKv(kv);

  const provider = {
    kind: "safe-workload",
    async get() { return { running: true, healthy: true, state: "running" }; },
    async stop() {},
  } as unknown as SandboxProvider;
  const restoreProviders = bindSandboxProviders({
    safeWorkload: provider, agentSandbox: provider,
  });
  t.after(() => {
    restoreProviders();
    unregisterSandbox(PING_SESSION);
    unregisterSandbox(SESSION);
  });
  resetBackgroundWorkStateForTest();

  await runKeepaliveTickForTest({ kv, countActiveShells: async () => 0 });
  // Walk within-window renew + mid-census renewIdleHolds + end-of-tick renew.
  assert.ok(
    holdUpdates >= 3,
    `within-window hold must renew on walk, mid-census, and tick end, got ${holdUpdates}`,
  );
});
