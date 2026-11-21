// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `setLongTimeout` waits the delay it is given, however long.
 *
 * Node's `setTimeout` takes at most 2^31 - 1 ms (about 24.8 days); a longer delay
 * fires after 1 ms. The fake timers here do the same, which the first test shows,
 * so the others prove the wait on the clamp a real process has.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_TIMER_DELAY_MS, setLongTimeout } from "../src/async.js";

const DAY = 86_400_000;

/**
 * Move the fake clock `ms` on, in steps no longer than one timer. The fake clock
 * runs every timer a tick passes at the tick's end, and a timer armed there counts
 * from that end, as a real one counts from when its callback ran; steps that land
 * on each chunk's end keep the chain on the clock a process that is never late has.
 */
function advance(timers: { tick(ms: number): void }, ms: number): void {
  while (ms > 0) {
    const step = Math.min(ms, MAX_TIMER_DELAY_MS);
    timers.tick(step);
    ms -= step;
  }
}

test("the fake clock clamps as Node does: a bare setTimeout of 30 days fires at once", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let fired = false;
  setTimeout(() => { fired = true; }, 30 * DAY);
  t.mock.timers.tick(1);
  assert.equal(fired, true, "this is the clamp the long timer is for");
});

test("30 days: not a moment early, and on time", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let fired = 0;
  setLongTimeout(() => { fired++; }, 30 * DAY);
  advance(t.mock.timers, 1);
  assert.equal(fired, 0, "not after 1 ms");
  advance(t.mock.timers, MAX_TIMER_DELAY_MS - 1);
  assert.equal(fired, 0, "not after the first chunk");
  advance(t.mock.timers, 30 * DAY - MAX_TIMER_DELAY_MS - 1);
  assert.equal(fired, 0, "not 1 ms before");
  advance(t.mock.timers, 1);
  assert.equal(fired, 1, "at 30 days");
  advance(t.mock.timers, 60 * DAY);
  assert.equal(fired, 1, "once");
});

test("at and around the limit, and short delays, as setTimeout", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const delay of [0, 1, 1_000, MAX_TIMER_DELAY_MS - 1, MAX_TIMER_DELAY_MS, MAX_TIMER_DELAY_MS + 1, 2 * MAX_TIMER_DELAY_MS + 5]) {
    let fired = 0;
    setLongTimeout(() => { fired++; }, delay);
    if (delay > 0) {
      advance(t.mock.timers, delay - 1);
      assert.equal(fired, 0, `${delay}: not early`);
    }
    advance(t.mock.timers, 1);
    assert.equal(fired, 1, `${delay}: on time`);
  }
  // Not a positive number: at once, as setTimeout(fn, 0).
  for (const delay of [-5, Number.NaN]) {
    let fired = 0;
    setLongTimeout(() => { fired++; }, delay);
    t.mock.timers.tick(0);
    assert.equal(fired, 1, String(delay));
  }
});

test("clear stops it in any chunk, and twice is harmless", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let fired = 0;
  const a = setLongTimeout(() => { fired++; }, 30 * DAY);
  advance(t.mock.timers, MAX_TIMER_DELAY_MS + 10);
  a.clear();
  a.clear();
  advance(t.mock.timers, 60 * DAY);
  assert.equal(fired, 0, "cleared in its second chunk");
  const b = setLongTimeout(() => { fired++; }, 10);
  b.clear();
  t.mock.timers.tick(20);
  assert.equal(fired, 0, "cleared in its first");
});

test("unref: no chunk keeps the process alive", async (t) => {
  const made: NodeJS.Timeout[] = [];
  const real = globalThis.setTimeout;
  // Every chunk made, each shortened to 1 ms so the chain runs now.
  t.mock.method(globalThis, "setTimeout", ((fn: () => void, ms: number) => {
    const h = real(fn, Math.min(ms, 1));
    made.push(h);
    return h;
  }) as never);
  const keep = setInterval(() => {}, 1_000);
  try {
    await new Promise<void>((resolve) => setLongTimeout(resolve, 3 * MAX_TIMER_DELAY_MS, { unref: true }));
  } finally {
    clearInterval(keep);
  }
  assert.equal(made.length, 3, "three chunks");
  assert.deepEqual(made.map((h) => h.hasRef()), [false, false, false], "every one unref'd");
  made.length = 0;
  await new Promise<void>((resolve) => setLongTimeout(resolve, 2 * MAX_TIMER_DELAY_MS));
  assert.deepEqual(made.map((h) => h.hasRef()), [true, true], "and without it, as setTimeout");
});
