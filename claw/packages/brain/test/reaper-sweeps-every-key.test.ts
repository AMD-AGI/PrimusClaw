// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The reaper's `hands.*` sweeps, and the admin checkpoint listing, must walk
 * every key -- and walking every key must not widen what they destroy.
 *
 * Each read the entry it had just been handed while the `keys()` listing was
 * still open, and the deployed nats.js client ends an open listing when the
 * bucket is asked anything else (see kv-listing-stub.ts). So each saw exactly
 * the bucket's first key: the health sweep checked and collected one sandbox
 * per pass, the multi-node sweep reclaimed one deleted session's clusters, and
 * the admin listing reported one checkpoint.
 *
 * Draining the listing first makes every entry visible to two destructive
 * sweeps that, in production, had effectively never seen more than one. So
 * these tests put the entry that must be acted on AND the entries that must be
 * left alone somewhere other than first, and assert on which workloads were
 * stopped, which keys were deleted and which sessions were reclaimed -- not on
 * whether something was.
 */
import "./sweeper-evict-env.js";

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { StringCodec, type KV } from "nats";

import { listingEndsOnOtherOps } from "./kv-listing-stub.js";
import { filterToRegExp } from "./nats-kv-stub.js";
import {
  bindClusterReclaimForTest, sweepIdleMultiNodeClustersForTest, sweepStaleHandsForTest,
} from "../src/sandbox/reaper.js";
import { bindHandsKv } from "../src/sandbox/registry.js";
import { bindSandboxProviders } from "../src/sandbox/factory.js";
import { retentionKey } from "../src/sandbox/retain-container.js";
import { registerAdminCheckpointRoutes } from "../src/routes/admin.js";
import {
  SANDBOX_PENDING_ABANDONED_AFTER_MS, SANDBOX_SWEEPER_EVICT_AFTER_FAILURES,
} from "../src/config.js";
import type { SandboxProvider } from "../src/sandbox/provider.js";

const sc = StringCodec();
const REVISION = 7;

let restoreProviders: (() => void) | null = null;
let restoreReclaim: (() => void) | null = null;
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  restoreProviders?.();
  restoreProviders = null;
  restoreReclaim?.();
  restoreReclaim = null;
});

/**
 * A bucket in insertion order, behind the listing the deployed client has.
 * `lock.<scope>` keys live in the same bucket, as run leases do.
 */
function bucket(entries: Array<[string, unknown]>): { kv: KV; deleted: string[] } {
  const values = new Map(entries.map(([k, v]) => [k, JSON.stringify(v)]));
  const deleted: string[] = [];
  const raw = {
    async keys(filter = ">") {
      const re = filterToRegExp(filter);
      const matched = [...values.keys()].filter((k) => re.test(k));
      return (async function* () { yield* matched; })();
    },
    async get(key: string) {
      const v = values.get(key);
      return v === undefined
        ? null
        : { key, value: sc.encode(v), revision: REVISION, operation: "PUT" };
    },
    async put() { return 1; },
    async create() { return 1; },
    async update() { return REVISION + 1; },
    async delete(key: string) { deleted.push(key); values.delete(key); },
  };
  return { kv: listingEndsOnOtherOps(raw) as unknown as KV, deleted };
}

function recordStops(): string[] {
  const stopped: string[] = [];
  const provider = {
    kind: "safe-workload",
    async stop(inst: { id: string }) { stopped.push(inst.id); },
    async exec() { return { exitCode: 0, stdout: "", stderr: "" }; },
  } as unknown as SandboxProvider;
  restoreProviders = bindSandboxProviders({ safeWorkload: provider, agentSandbox: provider });
  return stopped;
}

/** Health answers ok only for the hosts named; records every host asked. */
function health(healthyHosts: string[]): string[] {
  const asked: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    const host = new URL(String(input)).hostname;
    asked.push(host);
    return { ok: healthyHosts.includes(host), status: healthyHosts.includes(host) ? 200 : 503 } as Response;
  }) as typeof fetch;
  return asked;
}

function ready(name: string, extra: Record<string, unknown> = {}) {
  return {
    status: "ready",
    provider: "safe-workload",
    workloadId: `wl-${name}`,
    platformKey: "pk",
    namespace: "ns",
    handsUrl: `http://${name}:9100/mcp`,
    token: `tok-${name}`,
    ...extra,
  };
}

function pending(name: string, ageMs: number, runScope: string) {
  return {
    status: "pending",
    provider: "safe-workload",
    workloadId: `wl-${name}`,
    platformKey: "pk",
    namespace: "ns",
    token: `tok-${name}`,
    runScope,
    createdAt: new Date(Date.now() - ageMs).toISOString(),
  };
}

// --- the health sweep ---------------------------------------------------

test("the health sweep examines every entry and stops only the ones it may", async () => {
  assert.equal(SANDBOX_SWEEPER_EVICT_AFTER_FAILURES, 1,
    "with eviction disabled the destroy path never runs and this asserts nothing");
  assert.ok(SANDBOX_PENDING_ABANDONED_AFTER_MS > 0, "the pending collector is off");
  const old = SANDBOX_PENDING_ABANDONED_AFTER_MS + 60_000;
  const { kv, deleted } = bucket([
    // First, and healthy: before the fix this was the only entry a pass read.
    ["hands.s-first", ready("first")],
    // Unhealthy with no run behind it: the one ready sandbox this pass evicts.
    ["hands.s-dead", ready("dead")],
    // Unhealthy, but a run holds its lease (under its DAG root, not the
    // session): a busy container can miss a health check, and the run owns it.
    ["hands.s-busy", ready("busy", { runScope: "dag-root-1" })],
    ["lock.dag-root-1", { holder: "replica-2" }],
    // A retention's projection, unhealthy: never probed, never stopped.
    [retentionKey("http://retained:9100/mcp"),
      ready("retained", { protected: true, reason: "protected" })],
    // PENDING: abandoned (old, lease free) is collected; recent is not; old
    // but with its run still holding the lease is not; old with no scope
    // cannot be checked and is not.
    ["hands.s-abandoned", pending("abandoned", old, "ws.free")],
    ["hands.s-queued", pending("queued", 60_000, "ws.queued")],
    ["hands.s-waiting", pending("waiting", old, "ws.held")],
    ["lock.ws.held", { holder: "replica-3" }],
    ["hands.s-unscoped", { ...pending("unscoped", old, ""), runScope: undefined }],
  ]);
  bindHandsKv(kv);
  const asked = health(["first"]);
  const stopped = recordStops();
  restoreReclaim = bindClusterReclaimForTest(async () => 0);

  await sweepStaleHandsForTest();

  assert.deepEqual(asked, ["first", "dead", "busy"],
    "every ready entry after the first is health-checked; the retention and the "
    + "pending entries are not");
  assert.deepEqual(stopped, ["wl-dead", "wl-abandoned"],
    "exactly the unhealthy sandbox nobody runs in and the abandoned pending one");
  assert.deepEqual(deleted.sort(), ["hands.s-abandoned", "hands.s-dead"]);
});

test("an unreadable run lease does not licence an eviction", async () => {
  const { kv: inner, deleted } = bucket([
    ["hands.s-first", ready("first")],
    ["hands.s-unknown", ready("unknown", { runScope: "ws.unreadable" })],
  ]);
  const kv = new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === "get") {
        return async (key: string) => {
          if (key === "lock.ws.unreadable") throw new Error("kv unavailable");
          return (Reflect.get(target, prop, receiver) as (k: string) => unknown)(key);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  bindHandsKv(kv);
  health(["first"]);
  const stopped = recordStops();

  await sweepStaleHandsForTest();

  assert.deepEqual(stopped, [], "a KV blip read as 'no run' stops a live run's sandbox");
  assert.deepEqual(deleted, []);
});

test("a second health pass started while one is running does nothing", async () => {
  const { kv } = bucket([["hands.s-slow", ready("slow")]]);
  bindHandsKv(kv);
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let checks = 0;
  globalThis.fetch = (async () => {
    checks += 1;
    await gate;
    return { ok: true, status: 200 } as Response;
  }) as typeof fetch;

  const first = sweepStaleHandsForTest();
  try {
    // Let the first pass reach its health check.
    while (checks === 0) await new Promise((r) => setTimeout(r, 5));
    // An unguarded second pass would park on the same gate; bound the wait so
    // that shows as a failure rather than a hung test.
    const second = await Promise.race([
      sweepStaleHandsForTest().then(() => "returned"),
      new Promise((r) => setTimeout(() => r("still running"), 500)),
    ]);
    assert.equal(second, "returned", "the second pass should have declined to start");
    assert.equal(checks, 1,
      "an overlapping pass health-checks the same sandbox again and counts its "
      + "failures twice, reaching the eviction threshold early");
  } finally {
    release();
    await first;
  }
  await sweepStaleHandsForTest();
  assert.equal(checks, 2, "the guard is released when the pass ends");
});

// --- the multi-node sweep -----------------------------------------------

function parked(extra: Record<string, unknown> = {}) {
  return {
    provider: "safe-workload",
    workloadId: "wl",
    platformKey: "pk",
    namespace: "ns",
    keepalive: false,
    sessionDeleted: true,
    idleSince: Date.now() - 3_600_000,
    ...extra,
  };
}

test("the multi-node sweep reclaims every deleted session, and only those", async () => {
  const { kv } = bucket([
    // An ordinary idle park: idle reclaim cascades from destroyHands for it.
    ["hands.s-idle", parked({ sessionDeleted: undefined })],
    ["hands.s-deleted-1", parked()],
    // Deleted, but a run holds the lease under its runScope.
    ["hands.s-deleted-busy", parked({ runScope: "dag-root-9" })],
    ["lock.dag-root-9", { holder: "replica-1" }],
    // Deleted, still keepalive: not parked, not this sweep's.
    ["hands.s-deleted-live", parked({ keepalive: true })],
    [retentionKey("http://retained:9100/mcp"), parked({ protected: true })],
    ["hands.s-deleted-2", parked()],
    // Deleted with no SaFE key: nothing could be deleted with it.
    ["hands.s-deleted-nokey", parked({ platformKey: "" })],
  ]);
  bindHandsKv(kv);
  const reclaimed: string[] = [];
  restoreReclaim = bindClusterReclaimForTest(async (sessionId: string) => {
    reclaimed.push(sessionId);
    return 1;
  });

  await sweepIdleMultiNodeClustersForTest();

  assert.deepEqual(reclaimed, ["s-deleted-1", "s-deleted-2"]);
});

test("a second multi-node pass started while one is running does nothing", async () => {
  const { kv } = bucket([["hands.s-deleted", parked()]]);
  bindHandsKv(kv);
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let calls = 0;
  restoreReclaim = bindClusterReclaimForTest(async () => {
    calls += 1;
    await gate;
    return 1;
  });

  const first = sweepIdleMultiNodeClustersForTest();
  try {
    while (calls === 0) await new Promise((r) => setTimeout(r, 5));
    const second = await Promise.race([
      sweepIdleMultiNodeClustersForTest().then(() => "returned"),
      new Promise((r) => setTimeout(() => r("still running"), 500)),
    ]);
    assert.equal(second, "returned", "the second pass should have declined to start");
    assert.equal(calls, 1, "the same session's clusters were asked to be reclaimed twice at once");
  } finally {
    release();
    await first;
  }
  await sweepIdleMultiNodeClustersForTest();
  assert.equal(calls, 2, "the guard is released when the pass ends");
});

// --- the admin checkpoint listing ---------------------------------------

test("the admin checkpoint listing reports every checkpoint, up to its limit", async () => {
  process.env.CLAW_ADMIN_TOKEN = "t0ken-for-test";
  const entries: Array<[string, unknown]> = [];
  for (let i = 0; i < 205; i++) {
    entries.push([`task-ckpt.sess-${i}.msg-${i}`, {
      session_id: `sess-${i}`, message_id: `msg-${i}`, turns_completed: i,
    }]);
  }
  const { kv: kvCkpt } = bucket(entries);
  const { kv } = bucket([]);
  const app = Fastify();
  const sem = { inflight: 0, queued: 0, capacity: 1 };
  await registerAdminCheckpointRoutes(app, {
    kv, kvCkpt, decode: (d) => sc.decode(d),
    workspaceSyncSemaphore: sem, workspaceSigtermSyncSemaphore: sem,
  });
  try {
    const res = await app.inject({
      method: "GET", url: "/admin/checkpoint/recent",
      headers: { authorization: "Bearer t0ken-for-test" },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { count: number; items: Array<{ turns_completed: number }> };
    assert.equal(body.count, 200, "one checkpoint per call, before; the limit, now");
    assert.deepEqual(body.items.map((r) => r.turns_completed),
      Array.from({ length: 200 }, (_, i) => i),
      "the first 200 keys in listing order, each read");
  } finally {
    await app.close();
    delete process.env.CLAW_ADMIN_TOKEN;
  }
});
