// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// A brain lost with its node leaves its runs' `lock.<key>` behind, and nothing
// ever restarts under its name to give them back. The API hands such a run to
// another brain once its lease has gone unrenewed; that brain may then take the
// lock over -- but only the lock of that very run, only one nobody has rewritten
// for TASK_LOCK_DEAD_HOLDER_MS, and only with a CAS that a live holder's
// renewal defeats.
//
// Coverage:
//   D1 each condition of the takeover, one at a time
//   D2 a stale lock of the run this pod was handed is taken over, by CAS on the
//      revision read, and renewals carry the run on
//   D3 a fresh lock, a lock of another run, and an unfenced caller all wait
//   D4 a holder that renews between the read and the takeover keeps its lock
//   D5 a lock written by a pod from before the run id was recorded is never taken
//   D6 a holder that is alive but cut off from NATS (renewals fail as transport
//      errors, not conflicts) gives its lock up one refresh interval before
//      another brain may take it over -- never after
import { test } from "node:test";
import assert from "node:assert/strict";
import type { KV } from "nats";

import {
  acquireTaskLock, bindTaskLockKv, deadHolderTakeover, lockPastSelfFence, lockSelfFenceMs,
  lockSelfFenceTooTight, refreshTaskLock, releaseTaskLock,
} from "../src/tasks/lock.js";
import { LOCK_REFRESH_INTERVAL_MS, TASK_LOCK_DEAD_HOLDER_MS } from "../src/config.js";

const enc = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const dec = (b: Uint8Array) => JSON.parse(new TextDecoder().decode(b));

interface Stored { value: Uint8Array; revision: number; created: Date }

/** How much later than the request the store stamps a write (a slow PubAck). */
let stampDelayMs = 0;

/** A one-key KV with real create/update CAS semantics and a settable write time. */
function storeKv(initial: Stored | null) {
  let cur = initial;
  const writes: Array<{ op: string; rev?: number; value: Record<string, unknown> }> = [];
  const kv = {
    create: async (_k: string, value: Uint8Array) => {
      if (cur) throw new Error("wrong last sequence: key exists");
      cur = { value, revision: 1, created: new Date(Date.now() + stampDelayMs) };
      writes.push({ op: "create", value: dec(value) });
      return 1;
    },
    update: async (_k: string, value: Uint8Array, rev: number) => {
      if (!cur || cur.revision !== rev) throw new Error(`wrong last sequence: ${cur?.revision ?? 0}`);
      cur = { value, revision: rev + 1, created: new Date(Date.now() + stampDelayMs) };
      writes.push({ op: "update", rev, value: dec(value) });
      return rev + 1;
    },
    get: async () => (cur ? { ...cur, operation: "PUT" } : null),
    delete: async () => { cur = null; },
  } as unknown as KV;
  return {
    kv, writes,
    get current() { return cur; },
    set(next: Stored | null) { cur = next; },
  };
}

const deadHolder = (task: string | undefined, agoMs: number, revision = 7): Stored => ({
  value: enc({ holderId: "dead-holder", pod: "brain-lost", acq: "a1", ...(task ? { task } : {}), acquiredAt: 0, lastRenewedAt: 0 }),
  revision,
  created: new Date(Date.now() - agoMs),
});

test("D1 each condition of the takeover, one at a time", () => {
  const now = 1_000_000;
  const held = { holderId: "dead-holder", task: "t1" };
  const old = new Date(now - 61_000);
  const fenced = { taskId: "t1", takeOverDeadHolder: true };
  assert.deepEqual(deadHolderTakeover(held, old, fenced, now, 60_000), { ok: true, staleMs: 61_000 });
  assert.equal(deadHolderTakeover(held, new Date(now - 59_000), fenced, now, 60_000).ok, false, "fresh");
  assert.equal(deadHolderTakeover(held, old, { taskId: "t1" }, now, 60_000).ok, false, "unfenced caller");
  assert.equal(deadHolderTakeover(held, old, { takeOverDeadHolder: true }, now, 60_000).ok, false, "no run named");
  assert.equal(deadHolderTakeover({ ...held, task: "t2" }, old, fenced, now, 60_000).ok, false, "another run's lock");
  assert.equal(deadHolderTakeover({ holderId: "dead-holder" }, old, fenced, now, 60_000).ok, false, "pre-field lock");
  assert.equal(deadHolderTakeover(null, old, fenced, now, 60_000).ok, false, "unparseable lock");
  assert.equal(deadHolderTakeover(held, undefined, fenced, now, 60_000).ok, false, "no write time");
  assert.equal(deadHolderTakeover(held, old, fenced, now, 0).ok, false, "switched off");
  assert.equal(TASK_LOCK_DEAD_HOLDER_MS, 60_000, "the default the API's grace is derived against");
});

test("D2 a stale lock of the run this pod was handed is taken over, by CAS on the revision read", async () => {
  const s = storeKv(deadHolder("t-run", TASK_LOCK_DEAD_HOLDER_MS + 5_000, 7));
  bindTaskLockKv(s.kv);
  assert.equal(await acquireTaskLock("sess-lost", 42, { taskId: "t-run", takeOverDeadHolder: true }), true);
  assert.equal(s.writes.length, 1);
  assert.equal(s.writes[0].op, "update");
  assert.equal(s.writes[0].rev, 7, "a CAS on the revision that was read");
  assert.equal(s.writes[0].value.task, "t-run");
  assert.notEqual(s.writes[0].value.holderId, "dead-holder");
  // Renewals carry on from the taken-over revision and keep the run id.
  assert.equal(await refreshTaskLock("sess-lost"), "renewed");
  assert.equal(s.writes[1].rev, 8);
  assert.equal(s.writes[1].value.task, "t-run");
  await releaseTaskLock("sess-lost");
});

test("D3 a fresh lock, a lock of another run, and an unfenced caller all wait", async () => {
  for (const [label, stored, opts] of [
    ["fresh", deadHolder("t-run", TASK_LOCK_DEAD_HOLDER_MS - 10_000), { taskId: "t-run", takeOverDeadHolder: true }],
    ["another run", deadHolder("t-other", TASK_LOCK_DEAD_HOLDER_MS + 60_000), { taskId: "t-run", takeOverDeadHolder: true }],
    ["unfenced", deadHolder("t-run", TASK_LOCK_DEAD_HOLDER_MS + 60_000), { taskId: "t-run" }],
  ] as const) {
    const s = storeKv(stored);
    bindTaskLockKv(s.kv);
    assert.equal(await acquireTaskLock("sess-wait", 1, opts), false, label);
    assert.equal(s.writes.length, 0, `${label}: nothing written`);
    assert.equal(dec(s.current!.value).holderId, "dead-holder", label);
  }
});

test("D4 a holder that renews between the read and the takeover keeps its lock", async () => {
  const s = storeKv(deadHolder("t-run", TASK_LOCK_DEAD_HOLDER_MS + 5_000, 7));
  const realGet = (s.kv as unknown as { get: () => Promise<unknown> }).get;
  (s.kv as unknown as { get: () => Promise<unknown> }).get = async () => {
    const seen = await realGet();
    // The holder was only slow: its renewal lands after our read.
    s.set({ ...deadHolder("t-run", 0, 8) });
    return seen;
  };
  bindTaskLockKv(s.kv);
  assert.equal(await acquireTaskLock("sess-alive", 1, { taskId: "t-run", takeOverDeadHolder: true }), false);
  assert.equal(s.current!.revision, 8, "the live holder's write stands");
  assert.equal(dec(s.current!.value).holderId, "dead-holder");
});

test("D5 a lock written by a pod from before the run id was recorded is never taken", async () => {
  const s = storeKv(deadHolder(undefined, 10 * 60_000));
  bindTaskLockKv(s.kv);
  assert.equal(await acquireTaskLock("sess-legacy", 1, { taskId: "t-run", takeOverDeadHolder: true }), false);
  assert.equal(s.writes.length, 0);
});

test("D6 a holder cut off from NATS stops before anybody may take its lock", async (t) => {
  // The defaults the fleet runs with: the fence is one refresh interval inside
  // the takeover window, and leaves room for two renewals.
  assert.equal(lockSelfFenceMs(), TASK_LOCK_DEAD_HOLDER_MS - LOCK_REFRESH_INTERVAL_MS);
  assert.equal(lockSelfFenceTooTight(), false);
  assert.equal(lockSelfFenceTooTight(25_000, 300_000, 10_000), true, "a fence under two renewals is reported");
  assert.equal(lockSelfFenceMs(0), null, "no takeover, nothing to stay ahead of");

  const realNow = Date.now;
  let now = 5_000_000;
  Date.now = () => now;
  t.after(() => { Date.now = realNow; stampDelayMs = 0; });

  const s = storeKv(null);
  bindTaskLockKv(s.kv);
  // Every write lands two seconds after it was sent, so the store's stamp --
  // which the takeover counts from -- is later than anything the holder saw.
  stampDelayMs = 2_000;
  assert.equal(await acquireTaskLock("sess-cut", 9, { taskId: "t-cut" }), true);
  now += LOCK_REFRESH_INTERVAL_MS;
  assert.equal(await refreshTaskLock("sess-cut"), "renewed");
  const lastSent = now;

  // Partitioned: every NATS call now fails at the transport, which says
  // nothing about ownership. The process itself is fine.
  const cut = async () => { throw Object.assign(new Error("TIMEOUT"), { code: "TIMEOUT" }); };
  const kvAny = s.kv as unknown as Record<string, unknown>;
  kvAny.update = cut;
  kvAny.get = cut;

  // What another brain, handed this run by the API, would conclude at `at`.
  const held = { ...dec(s.current!.value), holderId: "the-holder-as-seen-by-someone-else" };
  const takeoverPossible = (at: number) =>
    deadHolderTakeover(held, s.current!.created, { taskId: "t-cut", takeOverDeadHolder: true }, at).ok;

  let fencedAt: number | null = null;
  let takeoverAt: number | null = null;
  for (let at = lastSent; at <= lastSent + 3 * TASK_LOCK_DEAD_HOLDER_MS; at += 250) {
    if (fencedAt === null && lockPastSelfFence("sess-cut", at)) fencedAt = at;
    if (takeoverAt === null && takeoverPossible(at)) takeoverAt = at;
  }
  assert.ok(fencedAt !== null && takeoverAt !== null);
  assert.ok(
    fencedAt + LOCK_REFRESH_INTERVAL_MS <= takeoverAt,
    `the holder stops at +${fencedAt - lastSent} ms, a takeover is possible at +${takeoverAt - lastSent} ms`,
  );

  // The renewal's own verdict agrees: a failure before the fence is "error"
  // (keep going, the lock is still ours), at the fence it is "expired" -- long
  // before the proof deadline that applied before the takeover existed.
  now = fencedAt - 1_000;
  assert.equal(await refreshTaskLock("sess-cut"), "error");
  now = fencedAt;
  assert.equal(await refreshTaskLock("sess-cut"), "expired");

  // A lock that names no run cannot be taken over, so it keeps the old,
  // longer deadline.
  const plain = storeKv(null);
  bindTaskLockKv(plain.kv);
  now = 9_000_000;
  assert.equal(await acquireTaskLock("sess-plain", 1), true);
  (plain.kv as unknown as Record<string, unknown>).update = cut;
  now += TASK_LOCK_DEAD_HOLDER_MS;
  assert.equal(lockPastSelfFence("sess-plain", now), false);
  assert.equal(await refreshTaskLock("sess-plain"), "error");
});
