// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// Whose workload is `hands.<sessionId>` pointing at?
//
// `reapPendingHands` exists so a task that died inside ensureHands does not
// leave a SaFE workload behind, and it identified that workload by the session
// alone. A session holds ONE such entry -- but under a session-scoped run gate
// two DAG roots get different lock keys and run at the same time, so the entry
// a failing task finds may have been written by a sibling that is still
// creating, or, if the read and the teardown straddle its promotion, still
// USING the workload it names. Reaping on the session alone stopped it.
//
// The workload id cannot be the key. A task whose ensureHands died mid-create
// never learned it -- that is the whole reason this function exists -- so the
// entry itself has to say who wrote it.

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { StringCodec } from "nats";
import type { KV } from "nats";
import { reapPendingHands } from "../src/sandbox/reaper.js";
import { bindHandsKv } from "../src/sandbox/registry.js";
import { bindSandboxProviders } from "../src/sandbox/factory.js";
import type { SandboxProvider } from "../src/sandbox/provider.js";

const sc = StringCodec();
const SESSION = "sess-shared";
let restoreProviders: (() => void) | null = null;

afterEach(() => {
  restoreProviders?.();
  restoreProviders = null;
});

/** Drives the real reaper against one pending entry; reports what it stopped. */
async function reap(entry: Record<string, unknown>, expected?: { taskId?: string }) {
  const stopped: string[] = [];
  const deleted: string[] = [];
  const kv = {
    async get(key: string) {
      if (deleted.includes(key)) return null;
      return { key, value: sc.encode(JSON.stringify(entry)), revision: 3 };
    },
    async delete(key: string) { deleted.push(key); },
    async put() { return 1; },
    async update() { return 4; },
  } as unknown as KV;
  bindHandsKv(kv);
  const provider = {
    kind: "safe-workload",
    async stop(t: { id?: string }) { stopped.push(String(t?.id)); },
  } as unknown as SandboxProvider;
  restoreProviders = bindSandboxProviders({ safeWorkload: provider, agentSandbox: provider });
  await reapPendingHands(SESSION, expected);
  return { stopped, deleted };
}

const pending = (workloadId: string, taskId?: string) => ({
  status: "pending", provider: "safe-workload", workloadId,
  platformKey: "pk", namespace: "ns", token: "tok",
  ...(taskId === undefined ? {} : { taskId }),
});

test("the workload a sibling DAG is creating is not reaped", async () => {
  const r = await reap(pending("W2", "d2-task"), { taskId: "d1-task" });
  assert.deepEqual(r.stopped, [], "D1 failing must not stop what D2 created");
  assert.deepEqual(r.deleted, [], "and must not clear D2's entry either");
});

test("a task's own half-created workload still is", async () => {
  const r = await reap(pending("W1", "d1-task"), { taskId: "d1-task" });
  assert.deepEqual(r.stopped, ["W1"], "the case this function exists for still works");
});

test("an entry with no task on it is reaped as before", async () => {
  // It can only have come from a process running before this field existed.
  // Skipping those would leak every workload in flight across a rollout.
  const r = await reap(pending("W0"), { taskId: "d1-task" });
  assert.deepEqual(r.stopped, ["W0"]);
});

test("a caller that names no task reaps whatever is there", async () => {
  const r = await reap(pending("W9", "d2-task"));
  assert.deepEqual(r.stopped, ["W9"], "the guard must not fire on an absent expectation");
});

test("a READY entry is still left alone", async () => {
  const r = await reap({ ...pending("W3", "d1-task"), status: "ready" }, { taskId: "d1-task" });
  assert.deepEqual(r.stopped, [], "a healthy sandbox is kept for the next message");
});

test("a lease lost during the reaper's own read still stops the teardown", async () => {
  // Round 34. The caller checks it still holds the lock before calling -- but
  // that check and the teardown are a KV round trip apart, and that is exactly
  // long enough for the heartbeat to notice the lease is gone. The snapshot
  // that comes back is then the successor's, carrying the same task id, and it
  // passes the identity comparison. Reproduced as
  // `{"workload":"W2","leaseLost":true,"successorReady":true}`.
  let owned = true;
  const stopped: string[] = [];
  const kv = {
    async get(key: string) {
      owned = false;  // the heartbeat notices while this read is in flight
      return {
        key,
        value: sc.encode(JSON.stringify(pending("W2", "t-same"))),
        revision: 3,
      };
    },
    async delete() {},
    async put() { return 1; },
    async update() { return 4; },
  } as unknown as KV;
  bindHandsKv(kv);
  const provider = {
    kind: "safe-workload",
    async stop(t: { id?: string }) { stopped.push(String(t?.id)); },
  } as unknown as SandboxProvider;
  restoreProviders = bindSandboxProviders({ safeWorkload: provider, agentSandbox: provider });

  await reapPendingHands(SESSION, { taskId: "t-same", stillOwned: () => owned });

  assert.deepEqual(stopped, [], "the successor holds the lock, so its workload is not ours");
});
