// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { test } from "node:test";
import assert from "node:assert/strict";
import { GRACEFUL_STOP_MAX_MS, gracefulStopRemainingMs, markGracefulStop } from "../src/tasks/abort-registry.js";

test("a run that is not winding down gracefully is force-released at the first timeout", () => {
  assert.equal(gracefulStopRemainingMs(new AbortController(), 1_000), 0);
});

test("a graceful stop is given the time it asked for, and no more", () => {
  const ctrl = new AbortController();
  markGracefulStop(ctrl, 10_000, 5_000);
  assert.equal(gracefulStopRemainingMs(ctrl, 10_000), 5_000);
  assert.equal(gracefulStopRemainingMs(ctrl, 12_000), 3_000);
  assert.equal(gracefulStopRemainingMs(ctrl, 15_000), 0, "up: released like any other");
  assert.equal(gracefulStopRemainingMs(ctrl, 99_999), 0);
});

test("the bound is the maximum app grace plus room to finish, so a stuck finish cannot hold the lock for ever", () => {
  assert.equal(GRACEFUL_STOP_MAX_MS, (3600 + 600) * 1000);
  const ctrl = new AbortController();
  markGracefulStop(ctrl, 0);
  assert.equal(gracefulStopRemainingMs(ctrl, 0), GRACEFUL_STOP_MAX_MS);
});
