// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A busy roster read by the expired-retry teardown holds the destroy on every
 * replica, even when the record moved while the probe was in the air.
 *
 * The retry path observed the positive count and wrote it once under the
 * revision it read before the probe, swallowing the conflict. Any write in
 * between -- a TTL renewal, a redelivery, another replica -- dropped the
 * positive count, and another replica, which has only the record to go on,
 * then counted three empty sweeps and destroyed the sandbox 180 s later,
 * inside the 300 s quiet window that count was meant to open.
 *
 * Runs at the shipped defaults (3 agreeing sweeps, 300 s quiet window).
 */

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { StringCodec, type KV } from "nats";

import { bindHandsKv } from "../src/sandbox/registry.js";
import * as replicaA from "../src/sandbox/keepalive.js";
import { bindSandboxProviders } from "../src/sandbox/factory.js";
import { markRetryPending } from "../src/tasks/retry-pending.js";
import { SANDBOX_RECLAIM_QUIET_MS } from "../src/config.js";
import { filterToRegExp } from "./nats-kv-stub.js";
import type { SandboxProvider } from "../src/sandbox/provider.js";

const sc = StringCodec();
const SESSION = "sess-expired-retry-hold";
const WL = "wl-retry-hold";
const HANDS_KEY = `hands.${SESSION}`;
const SWEEP_MS = 60_000;

const BINDING = {
  status: "ready",
  provider: "safe-workload",
  workloadId: WL,
  platformKey: "pk",
  namespace: "ns",
  handsUrl: "http://sandbox:9100/mcp",
  token: "tok",
  keepalive: true,
};

type Replica = typeof replicaA;

function fakeKv(): { kv: KV; deleted: string[]; current: () => Record<string, any> | null } {
  const deleted: string[] = [];
  let seq = 3;
  const store = new Map<string, { value: Uint8Array; revision: number }>([
    [HANDS_KEY, { value: sc.encode(JSON.stringify(BINDING)), revision: seq }],
  ]);
  const kv = {
    async get(key: string) {
      const found = store.get(key);
      return found ? { key, value: found.value, revision: found.revision, operation: "PUT" } : null;
    },
    async keys(filter = ">") {
      const re = filterToRegExp(filter);
      const matched = [...store.keys()].filter((k) => re.test(k));
      return (async function* () { yield* matched; })();
    },
    async put(key: string, v: Uint8Array) {
      store.set(key, { value: v, revision: ++seq });
      return seq;
    },
    async create(key: string, v: Uint8Array) {
      if (store.has(key)) throw Object.assign(new Error("wrong last sequence"), { code: "10071" });
      store.set(key, { value: v, revision: ++seq });
      return seq;
    },
    async update(key: string, value: Uint8Array, revision: number) {
      const found = store.get(key);
      if (!found || found.revision !== revision) {
        throw Object.assign(new Error("wrong last sequence"), { code: "10071" });
      }
      store.set(key, { value, revision: ++seq });
      return seq;
    },
    async delete(key: string) {
      deleted.push(key);
      store.delete(key);
    },
    async purge(key: string) {
      deleted.push(key);
      store.delete(key);
    },
  } as unknown as KV;
  return {
    kv,
    deleted,
    current: () => {
      const e = store.get(HANDS_KEY);
      return e ? JSON.parse(sc.decode(e.value)) : null;
    },
  };
}

let stopped: string[] = [];
let restoreProviders: (() => void) | null = null;

afterEach(() => {
  replicaA.resetBackgroundWorkStateForTest();
  restoreProviders?.();
  restoreProviders = null;
});

function bindRunningProvider(): void {
  stopped = [];
  const provider = {
    kind: "safe-workload",
    async exec() { return { exitCode: 0, stdout: "", stderr: "" }; },
    async get() { return { running: true, healthy: true, state: "running" }; },
    async stop(inst: { id: string }) { stopped.push(inst.id); },
  } as unknown as SandboxProvider;
  restoreProviders = bindSandboxProviders({ safeWorkload: provider, agentSandbox: provider });
}

test("a busy retry probe whose write lost a race still holds the destroy on another replica", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const replicaB = await import("../src/sandbox/keepalive.js?replica=retry-hold") as Replica;
  assert.notEqual(replicaB.runKeepaliveTickForTest, replicaA.runKeepaliveTickForTest,
    "sanity: the second replica has its own process state");
  const { kv, deleted, current } = fakeKv();
  bindHandsKv(kv);
  bindRunningProvider();
  try {
    await markRetryPending(kv, {
      sessionId: SESSION,
      createdAtMs: 0,
      deadlineMs: 1,
      graceSec: 0,
      workloadId: WL,
    });

    // Replica A's teardown reads live work; while the probe is in the air the
    // record is renewed, so the revision the probe was taken under is gone.
    const busyAt = Date.now();
    let busyProbes = 0;
    await replicaA.runKeepaliveTickForTest({
      kv,
      countActiveShells: async () => {
        busyProbes += 1;
        await kv.put(HANDS_KEY, sc.encode(JSON.stringify(current())));
        return 3;
      },
    });
    assert.ok(busyProbes >= 1, "sanity: the retry teardown probed the roster");
    assert.deepEqual(stopped, [], "a busy roster is never stopped");
    assert.equal(current()?.lastPositiveCountAt, busyAt,
      `the positive count was lost to the renewal; record=${JSON.stringify(current())}`);

    // Replica B sees only empty rosters from here on, one sweep a minute. Until
    // the quiet window the busy reading opened is over, none may destroy.
    let sweeps = 0;
    while (Date.now() + SWEEP_MS - busyAt < SANDBOX_RECLAIM_QUIET_MS) {
      t.mock.timers.tick(SWEEP_MS);
      sweeps += 1;
      await replicaB.runKeepaliveTickForTest({ kv, countActiveShells: async () => 0 });
      const destroyed = stopped.includes(WL) || deleted.includes(HANDS_KEY);
      assert.ok(!destroyed,
        `empty retry sweep ${sweeps}, ${(Date.now() - busyAt) / 1000}s after live work, destroyed it; `
        + `record=${JSON.stringify(current())}`);
    }
    assert.ok(sweeps >= 3, "sanity: enough empty sweeps to have confirmed a destroy");

    // A hold, not a veto: past the window, confirmed empty rosters reclaim it.
    for (let i = 0; i < 6 && !stopped.includes(WL); i++) {
      t.mock.timers.tick(SWEEP_MS);
      await replicaB.runKeepaliveTickForTest({ kv, countActiveShells: async () => 0 });
    }
    assert.deepEqual(stopped, [WL], "sanity: past the quiet window the empty sandbox is stopped");
  } finally {
    replicaB.resetBackgroundWorkStateForTest();
  }
});
