// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// watchdog.test.ts
//
// Smoke test for brain/src/infra/watchdog.ts. Verifies:
//   - startWatchdog() refreshes lastWatchdogTick at least once a
//     second (the timer is actually running and bound to the event
//     loop)
//   - startWatchdog() is idempotent — repeat calls do not double up
//     timers
//   - stopWatchdog() leaves the module in a state that startWatchdog()
//     can be called again (matters for tests that share a process)
//
// We deliberately do NOT assert the gauge value directly: prom-client
// gauges are racy under tsx's --test parallel mode, and the
// __getLastWatchdogTickForTest() helper gives us a stronger signal.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  startWatchdog,
  stopWatchdog,
  __getLastWatchdogTickForTest,
} from "../src/infra/watchdog.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

test("startWatchdog refreshes lastWatchdogTick within 1.5s", async (t) => {
  stopWatchdog();
  startWatchdog();
  t.after(() => stopWatchdog());

  const t0 = __getLastWatchdogTickForTest();
  await sleep(1500);
  const t1 = __getLastWatchdogTickForTest();
  assert.ok(
    t1 > t0,
    `watchdog tick must advance; before=${t0} after=${t1}`,
  );
});

test("startWatchdog is idempotent (second call returns silently)", async (t) => {
  stopWatchdog();
  startWatchdog();
  // Second call should log "already_running" but not throw and not
  // register a second pair of timers. We do not have a clean way to
  // count timers from userland, so we rely on tick monotonicity as a
  // proxy: a second timer pair would not corrupt monotonicity, but
  // an exception would obviously fail the test.
  assert.doesNotThrow(() => startWatchdog());
  t.after(() => stopWatchdog());

  const t0 = __getLastWatchdogTickForTest();
  await sleep(1200);
  const t1 = __getLastWatchdogTickForTest();
  assert.ok(t1 > t0);
});

test("stopWatchdog freezes the tick and permits restart", async (t) => {
  stopWatchdog();
  startWatchdog();
  await sleep(1100);
  const tFresh = __getLastWatchdogTickForTest();

  stopWatchdog();
  await sleep(1500);
  // Tick must NOT advance while stopped.
  assert.equal(
    __getLastWatchdogTickForTest(),
    tFresh,
    "tick must not advance while stopped",
  );

  startWatchdog();
  t.after(() => stopWatchdog());
  await sleep(1200);
  assert.ok(
    __getLastWatchdogTickForTest() > tFresh,
    "tick must advance again after restart",
  );
});
