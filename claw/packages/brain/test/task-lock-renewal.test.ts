// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// What a failed lock renewal means, and what it must not cost.
//
// The lock is how one run at a time is guaranteed a session's sandbox and
// workspace, and it survives on renewals: the entry lives on the registry
// bucket's TTL, and a run that stops renewing loses it five minutes later
// whether or not it is still running.
//
// Renewals fail in two ways that look alike and mean opposite things. A
// revision conflict is another replica holding the lock, and the only correct
// response is to stand down. A transport error -- a NATS reconnect, a server
// restart, a timeout -- says nothing about ownership, and standing down for one
// would end healthy runs during a blip. Both used to drop the remembered
// revision, which turned the second into something worse than the first: every
// later tick found no revision, returned "not_held" without attempting
// anything, and logged nothing, so the lock quietly expired under a running
// worker and the redelivery that took it over drove the same sandbox.
//
// Coverage:
//   R1 a transport error keeps the claim, and the next tick renews it
//   R2 a revision conflict is still a loss, and is final
//   R3 renewals failing for long enough become a stand-down, not silence
//   R4 the stand-down deadline is derived from the TTL it has to beat
//   R5 a lock this pod never took is reported, not silently skipped
//   R6 a refresh interval too close to the TTL is a lock that lapses mid-run
//   R7 a renewal that timed out but was stored is ours, not a takeover
//   R8 after a conflict, a lock read back under another holder is still lost
//   R9 a read-back that does not answer is an error, not a verdict
//   R10 a renewal that outlives its run cannot take over the next run of the key
//   R11 ...nor make this process forget the next run's lock while it reads back
import { test } from "node:test";
import assert from "node:assert/strict";
import type { KV } from "nats";

import {
  acquireTaskLock, bindTaskLockKv, lockExpiresBetweenRenewals, lockProofDeadlineMs,
  refreshTaskLock, releaseTaskLock,
} from "../src/tasks/lock.js";
import { BRAIN_REGISTRY_TTL_MS, LOCK_REFRESH_INTERVAL_MS } from "../src/config.js";

/** A KV whose `update` behaves as the test says, recording what it was told. */
function fakeKv(update: (rev: number) => number): { kv: KV; revisions: number[] } {
  const revisions: number[] = [];
  const kv = {
    create: async () => 11,
    update: async (_key: string, _value: Uint8Array, rev: number) => {
      revisions.push(rev);
      return update(rev);
    },
  } as unknown as KV;
  return { kv, revisions };
}

const transportError = (): never => { throw new Error("connection reset by peer"); };
const conflict = (): never => { throw new Error("wrong last sequence: 11"); };

/** Run a body against a clock the test moves by hand. */
async function withClock(body: (advance: (ms: number) => void) => Promise<void>): Promise<void> {
  const real = Date.now;
  let now = real();
  Date.now = () => now;
  try {
    await body((ms) => { now += ms; });
  } finally {
    Date.now = real;
  }
}

test("R1 a transport error keeps the claim, and the next tick renews it", async () => {
  let failNext = true;
  const { kv, revisions } = fakeKv((rev) => {
    if (failNext) { failNext = false; transportError(); }
    return rev + 1;
  });
  bindTaskLockKv(kv);
  assert.equal(await acquireTaskLock("sess-blip"), true);

  assert.equal(await refreshTaskLock("sess-blip"), "error");
  assert.equal(await refreshTaskLock("sess-blip"), "renewed");
  assert.deepEqual(revisions, [11, 11], "the second attempt still knows what it holds");
});

test("R2 a revision conflict is still a loss, and is final", async () => {
  const { kv, revisions } = fakeKv(() => conflict());
  // Read back after the conflict, as a renewal now does: somebody else holds it.
  (kv as unknown as { get: () => Promise<unknown> }).get = async () => ({
    key: "lock.sess-taken", revision: 40, operation: "PUT",
    value: new TextEncoder().encode(JSON.stringify({ holderId: "another-pod", acquiredAt: 1, lastRenewedAt: 1 })),
  });
  bindTaskLockKv(kv);
  await acquireTaskLock("sess-taken");

  assert.equal(await refreshTaskLock("sess-taken"), "lost");
  // Nothing to renew afterwards: the revision belongs to whoever took the lock,
  // and attempting a CAS against it would be asking to overwrite their claim.
  assert.equal(await refreshTaskLock("sess-taken"), "not_held");
  assert.deepEqual(revisions, [11]);
});

test("R3 renewals failing for long enough become a stand-down, not silence", async () => {
  await withClock(async (advance) => {
    const { kv } = fakeKv(() => transportError());
    bindTaskLockKv(kv);
    await acquireTaskLock("sess-stale");

    advance(LOCK_REFRESH_INTERVAL_MS * 3);
    assert.equal(await refreshTaskLock("sess-stale"), "error",
      "half a minute of failures is a blip, and a blip must not end a run");

    advance(lockProofDeadlineMs());
    assert.equal(await refreshTaskLock("sess-stale"), "expired",
      "past the point where the claim can still be ours, the run has to yield");
  });
});

test("R4 the stand-down deadline is derived from the TTL it has to beat", async () => {
  // One refresh short of the TTL: the decision is taken while the lock is still
  // ours rather than after it has gone, and it moves with the bucket's TTL
  // instead of being a second number to remember.
  assert.equal(lockProofDeadlineMs(300_000, 10_000), 290_000);
  assert.ok(lockProofDeadlineMs() < BRAIN_REGISTRY_TTL_MS);

  // A TTL configured at or below one refresh interval cannot leave room for
  // both, and the floor keeps that from becoming a deadline of zero -- which
  // would stand every run down on its first failed renewal.
  assert.equal(lockProofDeadlineMs(10_000, 10_000), 10_000);
  assert.equal(lockProofDeadlineMs(5_000, 10_000), 10_000);
});

test("R5 a lock this pod never took is reported, not silently skipped", async () => {
  bindTaskLockKv(fakeKv((rev) => rev + 1).kv);
  assert.equal(await refreshTaskLock("sess-never-acquired"), "not_held");
});

test("R6 a refresh interval too close to the TTL is a lock that lapses mid-run", () => {
  // The part of the relation the deadline above cannot express. At a refresh
  // interval at or above the TTL the deadline collapses to its floor, so every
  // renewal succeeds while the entry being renewed expires in the gaps -- and
  // the redelivered copy that finds the lock free executes the same turn beside
  // the run that never noticed. Nothing at runtime can see that, which is why
  // it is a startup check.
  assert.equal(lockExpiresBetweenRenewals(300_000, 10_000), false);
  assert.equal(lockExpiresBetweenRenewals(20_000, 10_000), false,
    "two renewals per TTL exactly is the floor, not yet a fault");
  assert.equal(lockExpiresBetweenRenewals(19_000, 10_000), true,
    "below two, one slow renewal is all it takes");
  assert.equal(lockExpiresBetweenRenewals(300_000, 300_000), true,
    "and at the TTL the deadline is no longer shorter than the claim it judges");
  assert.equal(lockExpiresBetweenRenewals(), false,
    "the shipped pair has to satisfy its own check");
});

/**
 * A lock bucket with one entry, stored the way JetStream stores it: a revision
 * that moves on every write, CAS on that revision, and -- the case that matters
 * -- a write that is stored while its acknowledgement is lost.
 */
function storedKv() {
  const enc = new TextEncoder();
  let entry: { revision: number; value: Uint8Array } | null = null;
  let seq = 100;
  let loseNextAck = false;
  let readFails = false;
  const kv = {
    async create(_key: string, value: Uint8Array) {
      if (entry) throw new Error("wrong last sequence: key exists");
      entry = { revision: ++seq, value };
      return entry.revision;
    },
    async update(_key: string, value: Uint8Array, rev: number) {
      if (!entry || entry.revision !== rev) throw new Error(`wrong last sequence: ${entry?.revision ?? 0}`);
      entry = { revision: ++seq, value };
      if (loseNextAck) {
        loseNextAck = false;
        throw Object.assign(new Error("TIMEOUT"), { name: "NatsError", code: "TIMEOUT" });
      }
      return entry.revision;
    },
    async get(key: string) {
      if (readFails) throw Object.assign(new Error("TIMEOUT"), { name: "NatsError", code: "TIMEOUT" });
      return entry ? { key, revision: entry.revision, value: entry.value, operation: "PUT" } : null;
    },
  } as unknown as KV;
  return {
    kv,
    loseNextAck: () => { loseNextAck = true; },
    readFails: (on: boolean) => { readFails = on; },
    takeOver: () => {
      entry = { revision: ++seq, value: enc.encode(JSON.stringify({ holderId: "successor", seq: 7, acquiredAt: 1, lastRenewedAt: 1 })) };
    },
  };
}

test("R7 a renewal that timed out but was stored is ours, not a takeover", async () => {
  const store = storedKv();
  bindTaskLockKv(store.kv);
  assert.equal(await acquireTaskLock("sess-stall", 7), true);

  // The JetStream stall: the write lands, its PubAck does not.
  store.loseNextAck();
  assert.equal(await refreshTaskLock("sess-stall"), "error");
  // The next renewal's CAS quotes the revision before the stored write, so it
  // conflicts. Nobody else is holding the lock; the entry is our own.
  assert.equal(await refreshTaskLock("sess-stall"), "renewed",
    "the 2026-11-06 stand-down: a healthy run read its own write as a takeover");
  assert.equal(await refreshTaskLock("sess-stall"), "renewed", "and renewals carry on from the adopted revision");
});

test("R8 after a conflict, a lock read back under another holder is still lost", async () => {
  const store = storedKv();
  bindTaskLockKv(store.kv);
  await acquireTaskLock("sess-taken-over", 7);
  store.takeOver();
  assert.equal(await refreshTaskLock("sess-taken-over"), "lost");
  assert.equal(await refreshTaskLock("sess-taken-over"), "not_held");
});

test("R9 a read-back that does not answer is an error, not a verdict", async () => {
  const store = storedKv();
  bindTaskLockKv(store.kv);
  await acquireTaskLock("sess-blind", 7);
  store.loseNextAck();
  assert.equal(await refreshTaskLock("sess-blind"), "error");
  store.readFails(true);
  assert.equal(await refreshTaskLock("sess-blind"), "error",
    "ownership is unknown, which is the transport case, not the takeover case");
  store.readFails(false);
  assert.equal(await refreshTaskLock("sess-blind"), "renewed");
});

test("R10 a renewal that outlives its run cannot take over the next run of the key", async () => {
  // Run A's renewal is slow; A finishes, releases, and run B of the same key
  // acquires it in the same process (same holder id) before A's CAS answers.
  const dec = new TextDecoder();
  let entry: { revision: number; value: Uint8Array } | null = null;
  let seq = 0;
  const parked: Array<() => void> = [];
  let parkNextUpdate = false;
  const kv = {
    async create(_k: string, value: Uint8Array) {
      if (entry) throw new Error("wrong last sequence: key exists");
      entry = { revision: ++seq, value };
      return entry.revision;
    },
    async update(_k: string, value: Uint8Array, rev: number) {
      if (parkNextUpdate) {
        parkNextUpdate = false;
        await new Promise<void>((r) => parked.push(r));
      }
      if (!entry || entry.revision !== rev) throw new Error(`wrong last sequence: ${entry?.revision ?? 0}`);
      entry = { revision: ++seq, value };
      return entry.revision;
    },
    async get(key: string) {
      return entry ? { key, revision: entry.revision, value: entry.value, operation: "PUT" } : null;
    },
    async delete() { entry = null; },
  } as unknown as KV;
  bindTaskLockKv(kv);

  assert.equal(await acquireTaskLock("sess-reused", 101), true);
  parkNextUpdate = true;
  const staleA = refreshTaskLock("sess-reused");
  // A ends: its lock is released and B takes the key.
  entry = null;
  await releaseTaskLock("sess-reused");
  assert.equal(await acquireTaskLock("sess-reused", 202), true);
  const bAcq = JSON.parse(dec.decode(entry!.value)).acq;

  parked.shift()!();
  assert.equal(await staleA, "lost", "A's renewal is A's business only");
  const stored = JSON.parse(dec.decode(entry!.value));
  assert.equal(stored.seq, 202, "B's entry was not overwritten");
  assert.equal(stored.acq, bAcq);
  assert.equal(await refreshTaskLock("sess-reused"), "renewed", "and B renews as if nothing happened");
});

test("R11 a renewal whose read-back outlives its run does not forget the next run's lock", async () => {
  const dec = new TextDecoder();
  let entry: { revision: number; value: Uint8Array } | null = null;
  let seq = 0;
  let conflictNextUpdate = false;
  let parkNextGet = false;
  const parked: Array<() => void> = [];
  const kv = {
    async create(_k: string, value: Uint8Array) {
      if (entry) throw new Error("wrong last sequence: key exists");
      entry = { revision: ++seq, value };
      return entry.revision;
    },
    async update(_k: string, value: Uint8Array, rev: number) {
      if (conflictNextUpdate) { conflictNextUpdate = false; throw new Error("wrong last sequence: 999"); }
      if (!entry || entry.revision !== rev) throw new Error(`wrong last sequence: ${entry?.revision ?? 0}`);
      entry = { revision: ++seq, value };
      return entry.revision;
    },
    async get(key: string) {
      if (parkNextGet) {
        parkNextGet = false;
        await new Promise<void>((r) => parked.push(r));
      }
      return entry ? { key, revision: entry.revision, value: entry.value, operation: "PUT" } : null;
    },
    async delete() { entry = null; },
  } as unknown as KV;
  bindTaskLockKv(kv);

  assert.equal(await acquireTaskLock("sess-readback", 101), true);
  // A's renewal conflicts and its read-back is slow.
  conflictNextUpdate = true;
  parkNextGet = true;
  const staleA = refreshTaskLock("sess-readback");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(parked.length, 1, "A is inside its read-back");
  // Meanwhile A ends and B takes the key.
  entry = null;
  await releaseTaskLock("sess-readback");
  assert.equal(await acquireTaskLock("sess-readback", 202), true);

  parked.shift()!();
  assert.equal(await staleA, "lost");
  assert.equal(JSON.parse(dec.decode(entry!.value)).seq, 202);
  assert.equal(await refreshTaskLock("sess-readback"), "renewed",
    "B still renews: a late answer to A did not erase B's local record");
});
