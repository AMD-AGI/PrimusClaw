// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// task-lock-tombstone.test.ts
//
// NATS KV reports a deleted key as a DEL entry carrying an empty payload, not
// as a miss. releaseTaskLock used to hand that payload to JSON.parse, throw,
// and take the "legacy pre-INV13 lock" branch — so the broadcast session
// cleanup made every brain replica log hundreds of
// `lock.release.legacy_value_format_skip` warnings and bump the INV-13 health
// counter for locks it had just deleted correctly, burying the real INV-13
// signal the counter exists to raise.

import { test } from "node:test";
import assert from "node:assert/strict";
import { StringCodec, type KV } from "nats";
import { bindTaskLockKv, readTaskLock, releaseTaskLock } from "../src/tasks/lock.js";
import { registry } from "../src/infra/metrics.js";

const sc = StringCodec();

async function skippedAs(reason: string): Promise<number> {
  const metric = registry.getSingleMetric("claw_brain_lock_release_skipped_total");
  assert.ok(metric, "expected the INV-13 skip counter to be registered");
  const { values } = await (metric as { get(): Promise<{ values: Array<{ labels: Record<string, string>; value: number }> }> }).get();
  return values.find((v) => v.labels.reason === reason)?.value ?? 0;
}

/** Minimal KV stub: only what releaseTaskLock touches. */
function fakeKv(entry: unknown): { kv: KV; deletes: string[] } {
  const deletes: string[] = [];
  const kv = {
    get: async () => entry,
    delete: async (key: string) => { deletes.push(key); return true; },
  } as unknown as KV;
  return { kv, deletes };
}

test("a DEL tombstone is treated as already-released, not as a legacy lock", async () => {
  const before = await skippedAs("legacy_format");
  const { kv, deletes } = fakeKv({
    key: "lock.sess-del",
    revision: 7,
    operation: "DEL",
    value: new Uint8Array(0),
  });
  bindTaskLockKv(kv);

  await releaseTaskLock("sess-del");

  assert.deepEqual(deletes, [], "must not re-delete a key that is already gone");
  assert.equal(
    await skippedAs("legacy_format"),
    before,
    "a tombstone is normal and must not register as an INV-13 skip",
  );
});

test("an empty payload is treated as a tombstone even without an operation field", async () => {
  const before = await skippedAs("legacy_format");
  const { kv, deletes } = fakeKv({
    key: "lock.sess-empty",
    revision: 9,
    value: new Uint8Array(0),
  });
  bindTaskLockKv(kv);

  await releaseTaskLock("sess-empty");

  assert.deepEqual(deletes, []);
  assert.equal(await skippedAs("legacy_format"), before);
});

test("a genuine legacy plain-string lock is still detected", async () => {
  // The branch has a real job to do; the tombstone fix must not disarm it.
  const before = await skippedAs("legacy_format");
  const { kv, deletes } = fakeKv({
    key: "lock.sess-legacy",
    revision: 3,
    operation: "PUT",
    value: sc.encode("brain-default"),
  });
  bindTaskLockKv(kv);

  await releaseTaskLock("sess-legacy");

  assert.deepEqual(deletes, [], "a legacy lock must be left for TTL to reap");
  assert.equal(await skippedAs("legacy_format"), before + 1);
});

// The poison guard uses this probe to tell a task that keeps failing from one
// that never ran because a sibling held its lock. Getting it wrong reports a
// healthy queued task to the user as "exceeded maximum retry attempts".
test("the lock probe reports a live lock as held", async () => {
  const { kv, deletes } = fakeKv({
    key: "lock.sess-live",
    revision: 2,
    operation: "PUT",
    value: sc.encode(JSON.stringify({
      holderId: "00000000-0000-4000-8000-000000000001",
      acquiredAt: Date.now(),
      lastRenewedAt: Date.now(),
    })),
  });
  bindTaskLockKv(kv);

  assert.equal((await readTaskLock("sess-live")).held, true);
  assert.deepEqual(deletes, [], "probing must not take or release the lock");
});

test("the lock probe reports a tombstone and a miss as not held", async () => {
  bindTaskLockKv(fakeKv({
    key: "lock.sess-gone", revision: 5, operation: "DEL", value: new Uint8Array(0),
  }).kv);
  assert.equal((await readTaskLock("sess-gone")).held, false);

  bindTaskLockKv(fakeKv(null).kv);
  assert.equal((await readTaskLock("sess-missing")).held, false);
});

// The probe must not take down the poison guard that called it, but "could not
// find out" is not the same answer as "nobody holds it" and cannot be reported
// as one: the guard uses this probe to decide whether a run is alive, and a
// failure rendered as "free" tells it to resolve a task another pod is
// executing. It reports the failure as such and lets the caller wait.
test("a KV failure reports an unknown lock rather than an unheld one", async () => {
  let gets = 0;
  bindTaskLockKv({
    get: async () => { gets += 1; throw new Error("kv unavailable"); },
  } as unknown as KV);

  const state = await readTaskLock("sess-broken");
  assert.equal(state.known, false, "a failed read learned nothing about the lock");
  assert.equal(state.held, false, "and it still must not throw at its caller");
  assert.ok(gets > 1, "a blip is retried before being reported as an unknown");
});

// The retry only exists for the blip; a probe that succeeds must not pay for
// it, and an answer of "free" has to stay distinguishable from "unknown".
test("a probe that recovers on retry reports a known lock", async () => {
  let gets = 0;
  bindTaskLockKv({
    get: async () => {
      gets += 1;
      if (gets === 1) throw new Error("kv unavailable");
      return null;
    },
  } as unknown as KV);

  const state = await readTaskLock("sess-flaky");
  assert.equal(state.known, true);
  assert.equal(state.held, false);
});

test("a lock held by another brain is refused, not deleted", async () => {
  const before = await skippedAs("not_holder");
  const { kv, deletes } = fakeKv({
    key: "lock.sess-other",
    revision: 4,
    operation: "PUT",
    value: sc.encode(JSON.stringify({
      holderId: "00000000-0000-4000-8000-000000000000",
      acquiredAt: Date.now(),
      lastRenewedAt: Date.now(),
    })),
  });
  bindTaskLockKv(kv);

  await releaseTaskLock("sess-other");

  assert.deepEqual(deletes, []);
  assert.equal(await skippedAs("not_holder"), before + 1);
});
