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
import { test } from "node:test";
import assert from "node:assert/strict";
import type { KV } from "nats";

import {
  acquireTaskLock, bindTaskLockKv, lockExpiresBetweenRenewals, lockProofDeadlineMs,
  refreshTaskLock,
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
