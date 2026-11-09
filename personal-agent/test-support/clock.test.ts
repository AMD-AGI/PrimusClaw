// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import { FakeClock } from "./index.js";

test("the fake clock stands still until it is advanced, and both clocks move together", async () => {
  const clock = new FakeClock(1_000);
  assert.equal(clock.epochMs(), 1_000);
  assert.equal(clock.monotonicMs(), 0);
  await clock.advance(250);
  assert.equal(clock.epochMs(), 1_250);
  assert.equal(clock.monotonicMs(), 250);
  clock.setEpochMs(5);
  assert.equal(clock.epochMs(), 5);
  assert.equal(clock.monotonicMs(), 250);
});

test("sleepers wake in due order when the clock reaches them, at their due time", async () => {
  const clock = new FakeClock(0);
  const woke: string[] = [];
  void clock.sleep(30).then(() => woke.push(`b@${String(clock.monotonicMs())}`));
  void clock.sleep(10).then(() => woke.push(`a@${String(clock.monotonicMs())}`));
  void clock.sleep(30).then(() => woke.push(`c@${String(clock.monotonicMs())}`));
  assert.equal(clock.pending, 3);
  await clock.advance(9);
  assert.deepEqual(woke, []);
  await clock.advance(25);
  assert.deepEqual(woke, ["a@10", "b@30", "c@30"]);
  assert.equal(clock.monotonicMs(), 34);
  assert.equal(clock.pending, 0);
});

test("a sleep that sleeps again is woken by runAll, and an endless loop is stopped", async () => {
  const clock = new FakeClock(0);
  let ticks = 0;
  const loop = async (): Promise<void> => {
    while (ticks < 3) {
      await clock.sleep(100);
      ticks++;
    }
  };
  const done = loop();
  await clock.runAll();
  await done;
  assert.equal(ticks, 3);
  assert.equal(clock.monotonicMs(), 300);
  const forever = async (): Promise<void> => {
    for (;;) await clock.sleep(1);
  };
  void forever();
  await assert.rejects(clock.runAll(5), /still sleeping after 5/);
});

test("an aborted sleep rejects and is no longer pending", async () => {
  const clock = new FakeClock(0);
  await assert.rejects(clock.sleep(5, AbortSignal.abort(new Error("before"))), /before/);
  const controller = new AbortController();
  const sleeping = clock.sleep(50, controller.signal);
  assert.equal(clock.pending, 1);
  controller.abort(new Error("during"));
  await assert.rejects(sleeping, /during/);
  assert.equal(clock.pending, 0);
});
