// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A fleet count that is briefly unreadable delays a new sandbox; it does not
 * fail the task that asked for it.
 *
 * A sweep that cannot read the fleet whole marks the roster stale, and the next
 * sweep that can clears it -- at most one keepalive interval later. Admission
 * used to refuse at once in that window, and on 2026-11-07 that turned two
 * replicas sweeping in phase into user tasks failing with "the fleet count is
 * incomplete". Staleness is now waited out for a bounded time; only a count
 * that stays unreadable past the wait, or a fleet genuinely at its ceiling, is
 * refused, and both refusals say in plain words what happened.
 */
import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  SandboxCapacityRefused, admitSandbox, bindAdmission, latchRosterStale, markCensusReconciled,
  setAdmissionStaleWaitForTest,
} from "../src/sandbox/admission.js";
import type { Roster } from "../src/sandbox/admission-roster.js";
import type { CapacitySettings } from "../src/sandbox/keepalive-capacity.js";

const CAPACITY: CapacitySettings = { ceiling: 3, reconciliationReserve: 1 };
const ROSTER_KEY = "keepalive.roster";
const WAIT_MS = 1_500;
const POLL_MS = 20;

/** The registry bucket's compare-and-set, with a hand on the stored roster. */
function fakeKv() {
  let value: string | null = null;
  let revision = 0;
  const encoder = new TextEncoder();
  const kv = {
    async get(key: string) {
      if (key !== ROSTER_KEY || value === null) return null;
      return { value: encoder.encode(value), revision };
    },
    async create(key: string, data: Uint8Array) {
      if (value !== null) throw Object.assign(new Error("wrong last sequence"), { code: "10071" });
      value = new TextDecoder().decode(data);
      revision += 1;
    },
    async update(key: string, data: Uint8Array, expected: number) {
      if (expected !== revision) throw Object.assign(new Error("wrong last sequence"), { code: "10071" });
      value = new TextDecoder().decode(data);
      revision += 1;
    },
  };
  return {
    kv,
    roster: (): Roster => JSON.parse(value!) as Roster,
    /** What another replica's sweep writes: the roster marked stale, or cleared. */
    edit(fn: (r: Roster) => Roster) {
      value = JSON.stringify(fn(JSON.parse(value!) as Roster));
      revision += 1;
    },
  };
}

const markStale = (r: Roster): Roster => ({
  ...r, stale: { at: Date.now(), replicaId: "replica-b", reason: "incomplete target scan" },
});
const clearStale = (r: Roster): Roster => {
  const next = { ...r };
  delete next.stale;
  return next;
};

let store: ReturnType<typeof fakeKv>;
let restoreWait: () => void;

beforeEach(async () => {
  store = fakeKv();
  await bindAdmission(store.kv as never, CAPACITY);
  markCensusReconciled();
  restoreWait = setAdmissionStaleWaitForTest(WAIT_MS, POLL_MS);
});

afterEach(() => {
  restoreWait();
  latchRosterStale(false);
});

test("a roster another replica marked stale is waited out, and the claim then lands", async () => {
  store.edit(markStale);
  // The next clean sweep, on whichever replica, clears it.
  setTimeout(() => store.edit(clearStale), 200);

  const hold = await admitSandbox("sess-user-task");
  await hold.bind("sandbox-1");

  const entries = store.roster().entries;
  assert.equal(entries.length, 1, "the claim was counted once the fleet could be counted");
  assert.equal(entries[0].identity, "sandbox-1");
  assert.equal(store.roster().stale, undefined);
});

test("this replica's own latch is waited out too", async () => {
  latchRosterStale(true);
  setTimeout(() => latchRosterStale(false), 200);

  const hold = await admitSandbox("sess-user-task");
  await hold.bind("sandbox-1");
  assert.equal(store.roster().entries.length, 1);
});

test("nothing is claimed while the count is stale", async () => {
  store.edit(markStale);
  let claimedWhileStale = false;
  const watch = setInterval(() => {
    if (store.roster().stale && store.roster().entries.length > 0) claimedWhileStale = true;
  }, 5);
  setTimeout(() => store.edit(clearStale), 200);
  try {
    const hold = await admitSandbox("sess-user-task");
    await hold.release();
  } finally {
    clearInterval(watch);
  }
  assert.equal(claimedWhileStale, false);
});

test("a count that stays unreadable past the wait is refused, in words a user can act on", async () => {
  store.edit(markStale);
  const started = Date.now();

  await assert.rejects(() => admitSandbox("sess-user-task"), (err: Error) => {
    assert.ok(err instanceof SandboxCapacityRefused);
    assert.match(err.message, /temporary/);
    assert.match(err.message, /retry/i);
    return true;
  });
  assert.ok(Date.now() - started >= WAIT_MS - 50, "refused only after the wait ran out");
  assert.equal(store.roster().entries.length, 0, "and nothing was claimed");
});

test("a fleet genuinely at its ceiling is refused at once, saying the slots are in use", async () => {
  for (let i = 0; i < CAPACITY.ceiling - CAPACITY.reconciliationReserve; i++) {
    const hold = await admitSandbox(`seed-${i}`);
    await hold.bind(`sandbox-${i}`);
  }
  const started = Date.now();

  await assert.rejects(() => admitSandbox("sess-over"), (err: Error) => {
    assert.ok(err instanceof SandboxCapacityRefused);
    assert.match(err.message, /all sandbox slots are in use/);
    return true;
  });
  assert.ok(Date.now() - started < WAIT_MS / 2, "capacity is a verdict, not a reading to wait out");
});
