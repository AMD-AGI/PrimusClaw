// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// A brain container restarted in place takes its runs back at once.
//
// A crash skips the SIGTERM hand-off, so the runs the dead process held kept
// their claims and locks until those timed out: eleven minutes on 2026-11-06,
// for a container that was back in seconds under the same pod name.
//
//   I1 locks naming this pod under another holder are released; nobody else's are
//   I2 a lock written after the restart -- this process's own -- is kept
//   I3 without a pod-scoped BRAIN_ID nothing is touched
//   I4 locks first, then the runs, and a failing API call does not fail the start
import { test } from "node:test";
import assert from "node:assert/strict";
import type { KV } from "nats";

import {
  acquireTaskLock, bindTaskLockKv, incarnationPod, releaseLocksOfPreviousIncarnation,
} from "../src/tasks/lock.js";
import { reclaimPreviousIncarnation } from "../src/tasks/previous-incarnation.js";

const enc = new TextEncoder();

function bucket(entries: Record<string, Record<string, unknown>>) {
  const store = new Map<string, { revision: number; value: Uint8Array }>();
  let seq = 0;
  for (const [k, v] of Object.entries(entries)) store.set(k, { revision: ++seq, value: enc.encode(JSON.stringify(v)) });
  const deleted: string[] = [];
  const kv = {
    async keys(filter: string) {
      const prefix = filter.replace(/>$/, "");
      const ks = [...store.keys()].filter((k) => k.startsWith(prefix));
      return (async function* () { yield* ks; })();
    },
    async get(key: string) {
      const e = store.get(key);
      return e ? { key, revision: e.revision, value: e.value, operation: "PUT" } : null;
    },
    async create(key: string, value: Uint8Array) {
      if (store.has(key)) throw new Error("wrong last sequence: key exists");
      store.set(key, { revision: ++seq, value });
      return seq;
    },
    async delete(key: string, opts?: { previousSeq?: number }) {
      const e = store.get(key);
      if (opts?.previousSeq !== undefined && e?.revision !== opts.previousSeq) throw new Error("wrong last sequence");
      store.delete(key);
      deleted.push(key);
    },
  } as unknown as KV;
  return { kv, store, deleted };
}

test("I1 locks naming this pod under another holder are released; nobody else's are", async () => {
  const b = bucket({
    "lock.sess-mine-1": { holderId: "dead-process", pod: "brain-abc", seq: 1 },
    "lock.sess-mine-2": { holderId: "dead-process", pod: "brain-abc", seq: 2 },
    "lock.sess-other-pod": { holderId: "live-elsewhere", pod: "brain-xyz", seq: 3 },
    "lock.sess-legacy": { holderId: "old-binary", seq: 4 },
  });
  bindTaskLockKv(b.kv);
  assert.equal(await releaseLocksOfPreviousIncarnation("brain-abc"), 2);
  assert.deepEqual(b.deleted.sort(), ["lock.sess-mine-1", "lock.sess-mine-2"]);
  assert.ok(b.store.has("lock.sess-other-pod"), "another pod's lock is its own business");
  assert.ok(b.store.has("lock.sess-legacy"), "a lock with no pod cannot be attributed, so it is left to its TTL");
});

test("I2 a lock written after the restart -- this process's own -- is kept", async () => {
  const env = { ...process.env };
  process.env.POD_NAME = "brain-abc";
  process.env.BRAIN_ID = "brain-abc";
  try {
    const b = bucket({});
    bindTaskLockKv(b.kv);
    assert.equal(await acquireTaskLock("sess-new", 9), true);
    const written = JSON.parse(new TextDecoder().decode(b.store.get("lock.sess-new")!.value));
    assert.equal(written.pod, "brain-abc", "a lock records the pod it was taken in");
    assert.equal(await releaseLocksOfPreviousIncarnation("brain-abc"), 0);
    assert.ok(b.store.has("lock.sess-new"));
  } finally {
    process.env = env;
  }
});

test("I3 without a pod-scoped BRAIN_ID nothing is touched", async () => {
  assert.equal(incarnationPod({ BRAIN_ID: "brain-yihan" }), undefined, "a local id several processes may share");
  assert.equal(incarnationPod({ POD_NAME: "brain-abc", BRAIN_ID: "brain-default" }), undefined);
  assert.equal(incarnationPod({ POD_NAME: "brain-abc", BRAIN_ID: "brain-abc" }), "brain-abc");

  const calls: string[] = [];
  const out = await reclaimPreviousIncarnation({
    pod: undefined,
    releaseLocks: async () => { calls.push("locks"); return 1; },
    releaseRuns: async () => { calls.push("runs"); return 1; },
  });
  assert.deepEqual(out, { locks: 0, runs: 0 });
  assert.deepEqual(calls, []);
});

test("I4 locks first, then the runs, and a failing API call does not fail the start", async () => {
  const calls: string[] = [];
  const ok = await reclaimPreviousIncarnation({
    pod: "brain-abc",
    releaseLocks: async (pod) => { calls.push(`locks:${pod}`); return 2; },
    releaseRuns: async (pod) => { calls.push(`runs:${pod}`); return 3; },
  });
  assert.deepEqual(calls, ["locks:brain-abc", "runs:brain-abc"],
    "a requeued run's next claim has to find its lock already free");
  assert.deepEqual(ok, { locks: 2, runs: 3 });

  const down = await reclaimPreviousIncarnation({
    pod: "brain-abc",
    releaseLocks: async () => 0,
    releaseRuns: async () => { throw new Error("fetch failed"); },
  });
  assert.deepEqual(down, { locks: 0, runs: 0 });
});
