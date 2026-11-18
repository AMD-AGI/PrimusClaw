// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// A release that loses its CAS to a renewal of its own lock.
//
// releaseTaskLock reads the entry and deletes it with a CAS on the revision it
// read. The run's renewal timer is stopped before the release, but a renewal it
// had already sent is not: when the store answers that renewal between the read
// and the delete, the revision moves, the delete is refused, and the lock used
// to stay where it was -- renewed by nobody, held by nobody, and refused to every
// later run of the key until the bucket TTL reaped it (2026-11-09, brain pod
// n5ntq: `lock.release.cas_lost_INV13_protected`, then ten
// `task.lock_not_acquired.nak` across three brains and a six-minute wait for
// the session's next message).
//
// Every interleaving here is placed by the fake store itself -- a hook that
// runs between the release's read and its delete -- so no test depends on a
// timer or a sleep.
//
// Coverage:
//   X1 a renewal of this acquisition landing between read and delete: released
//   X2 a renewal tick that fires once the release has begun writes nothing
//   X3 another holder writing between read and delete: never deleted (INV-13)
//   X4 a later acquisition in this process: never deleted (INV-13)
//   X5 another holder's lock from the start: never deleted (INV-13)
//   X6 an entry that keeps moving: the release gives up after a bounded number of tries
//   X7 a late release by a run whose lock was force-released leaves the next run's lock alone
//   X8 ...the same through the real Stop path (interruptRunsAt's force release)
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExecuteRequest } from "@claw/protocol";
import type { KV } from "nats";

import { activeAbort, forgetRunAddresses, registerRunAddressesFor } from "../src/tasks/abort-registry.js";
import { interruptRunsAt } from "../src/tasks/interrupt.js";

import { acquireTaskLock, bindLockRun, bindTaskLockKv, refreshTaskLock, releaseTaskLock } from "../src/tasks/lock.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

interface Entry { revision: number; value: Uint8Array; operation: "PUT" | "DEL" }

/**
 * One lock bucket, stored the way JetStream stores it: a revision that moves on
 * every write, including a delete, and CAS on that revision for update and
 * delete alike.
 */
function bucket() {
  let entry: Entry | null = null;
  let seq = 500;
  let afterNextGet: (() => Promise<void>) | null = null;
  let afterEveryGet: (() => void) | null = null;
  let parkNextUpdate = false;
  const parked: Array<() => void> = [];
  const updates: number[] = [];
  const deletes: Array<{ previousSeq: number; ok: boolean }> = [];
  const conflict = (): Error => new Error(`wrong last sequence: ${entry?.revision ?? 0}`);

  const kv = {
    async create(_key: string, value: Uint8Array) {
      if (entry && entry.operation === "PUT") throw conflict();
      entry = { revision: ++seq, value, operation: "PUT" };
      return entry.revision;
    },
    async update(_key: string, value: Uint8Array, rev: number) {
      updates.push(rev);
      if (parkNextUpdate) {
        parkNextUpdate = false;
        await new Promise<void>((r) => parked.push(r));
      }
      if (!entry || entry.revision !== rev) throw conflict();
      entry = { revision: ++seq, value, operation: "PUT" };
      return entry.revision;
    },
    async get(key: string) {
      // The snapshot is taken first; the hook then runs "between this read and
      // whatever the caller does next with it".
      const snap = entry ? { key, revision: entry.revision, value: entry.value, operation: entry.operation } : null;
      const hook = afterNextGet;
      afterNextGet = null;
      if (hook) await hook();
      afterEveryGet?.();
      return snap;
    },
    async delete(_key: string, opts?: { previousSeq?: number }) {
      const previousSeq = opts?.previousSeq ?? -1;
      if (!entry || entry.revision !== previousSeq) {
        deletes.push({ previousSeq, ok: false });
        throw conflict();
      }
      deletes.push({ previousSeq, ok: true });
      entry = { revision: ++seq, value: new Uint8Array(), operation: "DEL" };
    },
  } as unknown as KV;

  return {
    kv,
    updates,
    deletes,
    parked,
    current: () => entry,
    held: () => (entry && entry.operation === "PUT" ? JSON.parse(dec.decode(entry.value)) : null),
    /** Overwrite the entry as a different writer would, moving the revision. */
    put: (value: object) => { entry = { revision: ++seq, value: enc.encode(JSON.stringify(value)), operation: "PUT" }; },
    afterNextGet: (hook: () => Promise<void>) => { afterNextGet = hook; },
    afterEveryGet: (hook: (() => void) | null) => { afterEveryGet = hook; },
    parkNextUpdate: () => { parkNextUpdate = true; },
  };
}

test("X1 a renewal of this acquisition landing between read and delete: the lock is still released", async () => {
  const b = bucket();
  bindTaskLockKv(b.kv);
  assert.equal(await acquireTaskLock("ws.race", 41), true);
  const acquiredRev = b.current()!.revision;

  // The renewal timer's last tick, sent just before the run finished: the store
  // has not answered it yet when the release starts.
  b.parkNextUpdate();
  const renewal = refreshTaskLock("ws.race");
  assert.equal(b.parked.length, 1, "the renewal is in flight");

  // The store answers that renewal after the release has read the entry and
  // before its delete -- the incident's interleaving.
  b.afterNextGet(async () => {
    b.parked.shift()!();
    await renewal;
  });
  await releaseTaskLock("ws.race");

  assert.equal(await renewal, "renewed", "the renewal's write was stored");
  assert.deepEqual(b.updates, [acquiredRev], "exactly one renewal write, quoting the acquired revision");
  assert.equal(b.current()!.operation, "DEL",
    "a renewal of our own lock must not leave it held by nobody until the TTL");
  assert.deepEqual(b.deletes.map((d) => d.ok), [false, true], "refused at the old revision, then deleted at the new one");

  // And the key is free at once for the session's next message.
  assert.equal(await acquireTaskLock("ws.race", 42), true);
  await releaseTaskLock("ws.race");
});

test("X2 a renewal tick that fires once the release has begun writes nothing", async () => {
  const b = bucket();
  bindTaskLockKv(b.kv);
  assert.equal(await acquireTaskLock("ws.tick", 51), true);

  let tick: string | null = null;
  b.afterNextGet(async () => { tick = await refreshTaskLock("ws.tick"); });
  await releaseTaskLock("ws.tick");

  assert.equal(tick, "not_held", "the acquisition is being given back; nothing is left to renew");
  assert.deepEqual(b.updates, [], "no renewal write after the release began");
  assert.equal(b.current()!.operation, "DEL");
  assert.deepEqual(b.deletes.map((d) => d.ok), [true]);
});

test("X3 another holder taking the lock between read and delete: never deleted (INV-13)", async () => {
  const b = bucket();
  bindTaskLockKv(b.kv);
  assert.equal(await acquireTaskLock("ws.stolen", 61), true);

  const successor = { holderId: "another-pod", seq: 62, acq: "their-acq", acquiredAt: 1, lastRenewedAt: 1 };
  b.afterNextGet(async () => { b.put(successor); });
  await releaseTaskLock("ws.stolen");

  assert.deepEqual(b.held(), successor, "the successor's lock is untouched");
  assert.ok(b.deletes.every((d) => !d.ok), "no delete was accepted");
  assert.equal(b.deletes.length, 1, "and none was attempted at the successor's revision");
});

test("X4 a later acquisition of the key in this process: never deleted (INV-13)", async () => {
  const b = bucket();
  bindTaskLockKv(b.kv);
  assert.equal(await acquireTaskLock("ws.reused", 71), true);
  const ours = b.held();

  // Same process (same holder id), different acquisition: a later run of the
  // key. The release of the earlier run must not take it away.
  const later = { ...ours, acq: "later-acquisition", seq: 72 };
  b.afterNextGet(async () => { b.put(later); });
  await releaseTaskLock("ws.reused");

  assert.deepEqual(b.held(), later);
  assert.ok(b.deletes.every((d) => !d.ok));
});

test("X5 another holder's lock from the start: never deleted (INV-13)", async () => {
  const b = bucket();
  bindTaskLockKv(b.kv);
  assert.equal(await acquireTaskLock("ws.foreign", 81), true);
  const foreign = { holderId: "another-pod", seq: 82, acquiredAt: 1, lastRenewedAt: 1 };
  b.put(foreign);

  await releaseTaskLock("ws.foreign");

  assert.deepEqual(b.held(), foreign);
  assert.equal(b.deletes.length, 0);
});

test("X6 an entry that keeps moving: the release gives up after a bounded number of tries", async () => {
  const b = bucket();
  bindTaskLockKv(b.kv);
  assert.equal(await acquireTaskLock("ws.churn", 91), true);
  const ours = b.held();

  // Every read is followed by another write of the same value, so every delete
  // quotes a stale revision. The release must end rather than spin.
  b.afterEveryGet(() => b.put(ours));
  await releaseTaskLock("ws.churn");
  b.afterEveryGet(null);

  assert.ok(b.deletes.length >= 2 && b.deletes.length <= 8, `bounded: ${b.deletes.length} tries`);
  assert.ok(b.deletes.every((d) => !d.ok));
  assert.deepEqual(b.held(), ours);
});

test("X7 a late release by a run whose lock was force-released leaves the next run's lock alone", async () => {
  const b = bucket();
  bindTaskLockKv(b.kv);

  // Run A takes the key; a Stop it ignores force-releases its lock
  // (interrupt.ts), and run B of the same key -- same process, same holder id
  // -- takes it next.
  const runA = new AbortController();
  assert.equal(await acquireTaskLock("ws.late", 101), true);
  bindLockRun("ws.late", runA);
  await releaseTaskLock("ws.late", runA);
  assert.equal(b.current()!.operation, "DEL");

  const runB = new AbortController();
  assert.equal(await acquireTaskLock("ws.late", 102), true);
  bindLockRun("ws.late", runB);
  const bLock = b.held();

  // A's pending work finally returns and its finishRun releases again.
  await releaseTaskLock("ws.late", runA);

  assert.deepEqual(b.held(), bLock, "B's lock is not A's to give back");
  assert.equal(await refreshTaskLock("ws.late"), "renewed", "and B's local record survived A's release");

  await releaseTaskLock("ws.late", runB);
  assert.equal(b.current()!.operation, "DEL", "B's own release still frees it");
});

test("X8 the same through the real Stop path: interruptRunsAt's force release, then the run's own late release", async (t) => {
  const b = bucket();
  bindTaskLockKv(b.kv);
  const key = "ws.kws_stop";
  const request = { task_id: "chat-a", session_id: "sess-stop", files_workspace_id: "kws_stop" } as unknown as ExecuteRequest;

  // What dispatch does for run A.
  assert.equal(await acquireTaskLock(key, 201), true);
  const runA = new AbortController();
  bindLockRun(key, runA);
  activeAbort.set(key, runA);
  registerRunAddressesFor(key, request);
  try {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    assert.deepEqual(interruptRunsAt("sess-stop", 30_000), [key]);
    // A ignores the abort; the force release fires.
    t.mock.timers.tick(30_000);
    t.mock.timers.reset();
    for (let i = 0; i < 20 && b.current()!.operation !== "DEL"; i++) await new Promise((r) => setImmediate(r));
    assert.equal(b.current()!.operation, "DEL", "the Stop freed the key");

    // Run B of the key starts.
    assert.equal(await acquireTaskLock(key, 202), true);
    const runB = new AbortController();
    bindLockRun(key, runB);
    activeAbort.set(key, runB);
    const bLock = b.held();

    // A finally returns and finishRun releases with A's controller.
    await releaseTaskLock(key, runA);
    assert.deepEqual(b.held(), bLock, "B's lock survives A's late release");
    assert.equal(await refreshTaskLock(key), "renewed");

    await releaseTaskLock(key, runB);
    assert.equal(b.current()!.operation, "DEL");
  } finally {
    activeAbort.delete(key);
    forgetRunAddresses(key);
  }
});
