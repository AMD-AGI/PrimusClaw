// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Verifies that a run accumulates in exactly one time state at once. */
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  beginRun, endRun, phaseOf, runTimeOf, setParkHooks, whileRecovering, whileWaiting,
} from "../src/tasks/run-phase.js";
import { testRunKey } from "./support/run-identity.js";

afterEach(() => { setParkHooks(null); });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const totalOf = (states: Partial<Record<string, number>>) =>
  Object.values(states).reduce((sum, ms) => sum + (ms ?? 0), 0);

test("the states a run passes through sum to the run's own clock, and no more", async () => {
  const key = testRunKey("states-sum");
  const startedAt = Date.now();
  beginRun(key);
  try {
    await sleep(20);
    await whileWaiting(key, "background_command", "timed", () => sleep(40));
    await whileRecovering(key, () => sleep(30));
    await sleep(10);

    const snapshot = runTimeOf(key)!;
    const elapsed = Date.now() - startedAt;
    assert.ok(Math.abs(totalOf(snapshot.stateMs) - elapsed) <= 5,
      `states summed to ${totalOf(snapshot.stateMs)}ms against ${elapsed}ms elapsed`);
    assert.ok(snapshot.stateMs.waiting_background! >= 35);
    assert.ok(snapshot.stateMs.recovering! >= 25);
    assert.ok(snapshot.stateMs.executing! >= 25, "the stretches either side are execution");
    assert.equal(snapshot.reasonMs.background_command, snapshot.stateMs.waiting_background,
      "a reason is a breakdown of its state, not a second interval");
  } finally {
    endRun(key);
  }
});

test("a state entered inside another is one stretch, counted once", async () => {
  const key = testRunKey("states-nested");
  beginRun(key);
  try {
    await whileWaiting(key, "background_command", "timed", async () => {
      await whileWaiting(key, "approval", "timed", () => sleep(20));
      await whileRecovering(key, () => sleep(20));
      assert.equal(phaseOf(key).waitReason, "background_command",
        "the outer reason is the one that describes the stretch");
    });
    const snapshot = runTimeOf(key)!;
    assert.equal(snapshot.stateMs.waiting_human, 0, "the inner states opened nothing");
    assert.equal(snapshot.stateMs.recovering, 0);
    assert.ok(snapshot.stateMs.waiting_background! >= 35);
    assert.equal(phaseOf(key).waits, 1);
  } finally {
    endRun(key);
  }
});

test("recovering is not reported as waiting, and lends out no slot", async () => {
  // The run is repairing what it needs to keep executing; it has no idle slot
  // to hand back, and a consumer reading `waited_ms` must not see repair time
  // as time the run spent waiting on something outside itself.
  const key = testRunKey("states-recovering");
  const parkEvents: string[] = [];
  setParkHooks({
    park: () => { parkEvents.push("park"); return true; },
    unpark: async () => { parkEvents.push("unpark"); },
  });
  beginRun(key);
  try {
    let during = "";
    await whileRecovering(key, async () => { during = phaseOf(key).phase; await sleep(20); });
    assert.equal(during, "executing", "there is no wait reason to report for a repair");
    assert.deepEqual(parkEvents, []);
    assert.equal(phaseOf(key).waitedMs, 0, "and it is not folded into the waiting total");
    assert.ok(runTimeOf(key)!.stateMs.recovering! >= 15, "while still being its own state");
  } finally {
    endRun(key);
  }
});

test("an untracked run has no totals to report", async () => {
  assert.equal(runTimeOf(testRunKey("states-never-begun")), null);
  assert.equal(await whileRecovering(undefined, async () => 7), 7);
});
