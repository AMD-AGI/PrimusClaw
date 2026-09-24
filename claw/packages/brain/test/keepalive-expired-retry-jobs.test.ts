// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Expired-retry teardown must not stop a sandbox that still has user jobs.
 *
 * handleRetryableError leaves the handle READY / keepalive:true so a redelivery
 * can reuse it. Walk-time peekBackgroundWork never sees a usable verdict on
 * that shape, so the destructive boundary has to read the jobs roster itself.
 */

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { StringCodec, type KV } from "nats";

import { bindHandsKv } from "../src/sandbox/registry.js";
import {
  runKeepaliveTickForTest,
  resetBackgroundWorkStateForTest,
} from "../src/sandbox/keepalive.js";
import { bindSandboxProviders } from "../src/sandbox/factory.js";
import { markRetryPending } from "../src/tasks/retry-pending.js";
import { filterToRegExp } from "./nats-kv-stub.js";
import type { SandboxProvider } from "../src/sandbox/provider.js";

const sc = StringCodec();
const SESSION = "sess-expired-retry-jobs";
const WL = "wl-bg";
const HANDS_KEY = `hands.${SESSION}`;

const BINDING = {
  status: "ready",
  provider: "safe-workload",
  workloadId: WL,
  platformKey: "pk",
  namespace: "ns",
  handsUrl: "http://sandbox:9100/mcp",
  token: "tok",
  // Intentionally keepalive:true -- the retry path leaves the handle ready for
  // redelivery reuse, which is exactly the shape peek cannot guard.
  keepalive: true,
};

interface Writes {
  deleted: string[];
  stopped: string[];
}

function fakeKv(): { kv: KV; writes: Writes } {
  const writes: Writes = { deleted: [], stopped: [] };
  const store = new Map<string, { value: Uint8Array; revision: number }>([
    [HANDS_KEY, { value: sc.encode(JSON.stringify(BINDING)), revision: 3 }],
  ]);
  const kv = {
    async get(key: string) {
      const found = store.get(key);
      return found ? { key, value: found.value, revision: found.revision } : null;
    },
    async keys(filter = ">") {
      const re = filterToRegExp(filter);
      const matched = [...store.keys()].filter((k) => re.test(k));
      return (async function* () { yield* matched; })();
    },
    async put(key: string, v: Uint8Array) {
      store.set(key, { value: v, revision: (store.get(key)?.revision ?? 0) + 1 });
      return store.get(key)!.revision;
    },
    async update(key: string, value: Uint8Array, revision: number) {
      const found = store.get(key);
      if (!found || found.revision !== revision) {
        throw Object.assign(new Error("wrong last sequence"), { code: "10071" });
      }
      store.set(key, { value, revision: revision + 1 });
      return revision + 1;
    },
    async delete(key: string) {
      writes.deleted.push(key);
      store.delete(key);
    },
  } as unknown as KV;
  return { kv, writes };
}

let restoreProviders: (() => void) | null = null;

afterEach(() => {
  resetBackgroundWorkStateForTest();
  restoreProviders?.();
  restoreProviders = null;
});

function bindRunningProvider(writes: Writes): void {
  const provider = {
    kind: "safe-workload",
    async exec() { return { exitCode: 0, stdout: "", stderr: "" }; },
    async get() { return { running: true, healthy: true, state: "running" }; },
    async stop(inst: { id: string }) { writes.stopped.push(inst.id); },
  } as unknown as SandboxProvider;
  restoreProviders = bindSandboxProviders({ safeWorkload: provider, agentSandbox: provider });
}

test("an expired retry does not stop a sandbox whose jobs roster is still busy", async () => {
  const { kv, writes } = fakeKv();
  bindHandsKv(kv);
  bindRunningProvider(writes);
  await markRetryPending(kv, {
    sessionId: SESSION,
    createdAtMs: 0,
    deadlineMs: 1,
    graceSec: 0,
    workloadId: WL,
  });

  let probes = 0;
  await runKeepaliveTickForTest({
    kv,
    countActiveShells: async () => {
      probes += 1;
      return 3;
    },
  });

  assert.ok(probes >= 1, "the destructive boundary must probe jobs");
  assert.deepEqual(writes.stopped, [], "a busy roster must not be stopped");
  assert.ok(!writes.deleted.includes(HANDS_KEY), "the hands pointer must stay");
});

test("an expired retry stops only after an explicit empty jobs roster", async () => {
  const { kv, writes } = fakeKv();
  bindHandsKv(kv);
  bindRunningProvider(writes);
  await markRetryPending(kv, {
    sessionId: SESSION,
    createdAtMs: 0,
    deadlineMs: 1,
    graceSec: 0,
    workloadId: WL,
  });

  let probes = 0;
  await runKeepaliveTickForTest({
    kv,
    countActiveShells: async () => {
      probes += 1;
      return 0;
    },
  });

  assert.ok(probes >= 1, "the destructive boundary must probe jobs");
  assert.deepEqual(writes.stopped, [WL], "an empty roster authorises the stop");
});

test("an expired retry yields when a concurrent write wins the closing CAS", async () => {
  // Probe can take seconds. A redelivery that writes the handle in that window
  // must win: destroyHands must not run on a superseded enrollment revision.
  const { kv, writes } = fakeKv();
  bindHandsKv(kv);
  bindRunningProvider(writes);
  await markRetryPending(kv, {
    sessionId: SESSION,
    createdAtMs: 0,
    deadlineMs: 1,
    graceSec: 0,
    workloadId: WL,
  });

  await runKeepaliveTickForTest({
    kv,
    countActiveShells: async () => {
      // Bump the enrollment revision while the probe is in flight.
      const cur = await kv.get(HANDS_KEY);
      assert.ok(cur);
      await kv.update(
        HANDS_KEY,
        sc.encode(JSON.stringify({ ...BINDING, keepalive: true, bumped: true })),
        cur.revision,
      );
      return 0;
    },
  });

  assert.deepEqual(writes.stopped, [], "a superseded closing CAS must not stop");
  assert.ok(!writes.deleted.includes(HANDS_KEY), "the hands pointer must stay");
});

test("an expired retry yields when the enrollment identity changes during the probe", async () => {
  // Queue window can span tens of seconds. A redelivery that wrote a new
  // generation onto the same key must not be marked closing.
  const { kv, writes } = fakeKv();
  bindHandsKv(kv);
  bindRunningProvider(writes);
  await markRetryPending(kv, {
    sessionId: SESSION,
    createdAtMs: 0,
    deadlineMs: 1,
    graceSec: 0,
    workloadId: WL,
  });

  await runKeepaliveTickForTest({
    kv,
    countActiveShells: async () => {
      const cur = await kv.get(HANDS_KEY);
      assert.ok(cur);
      await kv.update(
        HANDS_KEY,
        sc.encode(JSON.stringify({
          ...BINDING,
          workloadId: "wl-successor",
          keepalive: true,
        })),
        cur.revision,
      );
      return 0;
    },
  });

  assert.deepEqual(writes.stopped, [], "a successor generation must not be stopped");
  assert.ok(!writes.deleted.includes(HANDS_KEY), "the hands pointer must stay");
  const left = await kv.get(HANDS_KEY);
  assert.ok(left);
  const info = JSON.parse(sc.decode(left.value)) as { status?: string; workloadId?: string };
  assert.equal(info.status, "ready");
  assert.equal(info.workloadId, "wl-successor");
});
