// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import { systemClock } from "../src/index.js";

test("the wall clock is Date.now and the monotonic clock never goes back", () => {
  const before = Date.now();
  const wall = systemClock.epochMs();
  assert.ok(wall >= before && wall <= Date.now());
  const a = systemClock.monotonicMs();
  const b = systemClock.monotonicMs();
  assert.ok(b >= a);
});

test("sleep waits at least the time asked, and a negative time not at all", async () => {
  const start = systemClock.monotonicMs();
  await systemClock.sleep(20);
  assert.ok(systemClock.monotonicMs() - start >= 15);
  await systemClock.sleep(-5);
});

test("sleep rejects when its signal is aborted, before or during the sleep", async () => {
  await assert.rejects(systemClock.sleep(10, AbortSignal.abort(new Error("gone"))), /gone/);
  const controller = new AbortController();
  const sleeping = systemClock.sleep(60_000, controller.signal);
  controller.abort(new Error("stop"));
  await assert.rejects(sleeping, /stop/);
});
