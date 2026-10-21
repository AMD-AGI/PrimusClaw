// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// The hold key's own rules: merged as the later of each field, applied only to
// its identity and before it expires, an ended streak recognised by the run it
// ended whatever the clocks say, and a put that a concurrent put cannot erase.

import test from "node:test";
import assert from "node:assert/strict";
import { StringCodec, type KV } from "nats";
import {
  applyHold, mergeHolds, putReclaimHold, readReclaimHold, reclaimHoldKey, type ReclaimHold,
} from "../src/sandbox/reclaim-hold.js";
import type { ReclaimStreak } from "../src/sandbox/reclaim-evidence.js";

const sc = StringCodec();
const ID = "safe:wl-1";

function hold(patch: Partial<ReclaimHold> = {}): ReclaimHold {
  return { identity: ID, endedAt: {}, endedStreaks: {}, at: 1_000, expiresAt: 10_000, ...patch };
}

function streak(patch: Partial<ReclaimStreak> = {}): ReclaimStreak {
  return {
    reason: "idle_empty", identity: ID, idleEpoch: 7, idleSince: 7,
    count: 2, firstAt: 500, lastAt: 600, counts: [0, 0], ...patch,
  };
}

test("merge keeps the later of every field", () => {
  const m = mergeHolds(
    hold({ failureAt: 5, endedAt: { idle_empty: 9 }, endedStreaks: { idle_empty: { firstAt: 3 } }, at: 9 }),
    hold({ failureAt: 4, positiveAt: 2, endedAt: { idle_empty: 8, instance_replaced: 1 },
      endedStreaks: { idle_empty: { firstAt: 6 } }, at: 8, expiresAt: 20_000 }),
  );
  assert.deepEqual(m, {
    identity: ID, failureAt: 5, positiveAt: 2,
    endedAt: { idle_empty: 9, instance_replaced: 1 },
    endedStreaks: { idle_empty: { firstAt: 6 } },
    at: 9, expiresAt: 20_000,
  });
});

test("a hold opens the quiet window and ends the streak it names", () => {
  const { info, dropped } = applyHold(
    { reclaimStreak: streak(), lastProbeFailureAt: 100 }, hold({ failureAt: 700, endedAt: { idle_empty: 700 } }), ID, 800,
  );
  assert.equal(dropped, true);
  assert.equal(info.reclaimStreak, undefined);
  assert.equal(info.lastProbeFailureAt, 700);
});

test("an ended streak is recognised by its run, with the ender's clock behind", () => {
  // The replica that ended the run reads its clock 400 ms behind the one that
  // started it: by time alone the run began after it was ended.
  const ended = hold({ endedAt: { idle_empty: 450 }, endedStreaks: { idle_empty: { firstAt: 500, idleEpoch: 7, idleSince: 7 } } });
  assert.equal(applyHold({ reclaimStreak: streak({ count: 3 }) }, ended, ID, 800).dropped, true);
  // A run in a later idle period is a new run, whatever its first reading.
  assert.equal(applyHold({ reclaimStreak: streak({ idleEpoch: 8, idleSince: 8, firstAt: 480 }) }, ended, ID, 800).dropped, false);
  // As is a later run in the same period.
  assert.equal(applyHold({ reclaimStreak: streak({ firstAt: 501 }) }, ended, ID, 800).dropped, false);
});

test("a hold on another identity, or past its expiry, says nothing", () => {
  const h = hold({ failureAt: 700, endedAt: { idle_empty: 700 } });
  assert.deepEqual(applyHold({ reclaimStreak: streak() }, h, "safe:other", 800), { info: { reclaimStreak: streak() }, dropped: false });
  assert.deepEqual(applyHold({ reclaimStreak: streak() }, h, ID, 10_001), { info: { reclaimStreak: streak() }, dropped: false });
});

function memKv(): KV & { store: Map<string, Uint8Array>; beforePut?: () => void; failGet?: boolean } {
  const store = new Map<string, Uint8Array>();
  const kv = {
    store,
    async get(key: string) {
      if (kv.failGet) throw new Error("bucket unavailable");
      const v = store.get(key);
      return v ? { key, value: v, revision: 1, operation: "PUT" } : null;
    },
    async put(key: string, value: Uint8Array) {
      store.set(key, value);
      const hook = kv.beforePut;
      kv.beforePut = undefined;
      hook?.();
      return 1;
    },
    async delete(key: string) { store.delete(key); },
  } as unknown as KV & { store: Map<string, Uint8Array>; beforePut?: () => void; failGet?: boolean };
  return kv;
}

test("a note overwritten by a concurrent put is merged in again", async () => {
  const kv = memKv();
  // Another replica's put lands right after this one, from a read that did not
  // see it.
  kv.beforePut = () => kv.store.set(reclaimHoldKey(ID), sc.encode(JSON.stringify(hold({ positiveAt: 900, at: 900 }))));
  await putReclaimHold(kv, hold({ failureAt: 800, at: 800 }));
  const back = await readReclaimHold(kv, ID);
  assert.equal(back?.failureAt, 800, "this note survived the concurrent put");
  assert.equal(back?.positiveAt, 900, "and so did the other one");
});

test("an unreadable or malformed hold key throws, so a reader holds", async () => {
  const kv = memKv();
  kv.failGet = true;
  await assert.rejects(readReclaimHold(kv, ID));
  kv.failGet = false;
  kv.store.set(reclaimHoldKey(ID), sc.encode("{not json"));
  await assert.rejects(readReclaimHold(kv, ID));
  // A writer replaces a malformed value rather than giving up on it.
  await putReclaimHold(kv, hold({ failureAt: 800 }));
  assert.equal((await readReclaimHold(kv, ID))?.failureAt, 800);
});
