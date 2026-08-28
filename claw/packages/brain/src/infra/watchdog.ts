// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// infra/watchdog.ts
//
// Pod-level event-loop watchdog (checkpoint-architecture-redesign §12.1,
// NP0-3). Two cooperating setInterval(1s) timers:
//
//   tickTimer   — every 1s, refreshes lastWatchdogTick = Date.now() and
//                 zeros the exported watchdogLastTickAgeSeconds gauge.
//   ageTimer    — every 1s, writes (now - lastWatchdogTick) to the
//                 gauge. When the Node event loop stalls (long GC pause,
//                 wedged session callback, blocking native call) BOTH
//                 timers slip; the gauge then climbs visibly even
//                 though the tick timer never ran. Prometheus scraping
//                 picks up the climb on the next interval (10s default)
//                 → alert BrainKeepAliveStalled fires at age > 60s.
//
// Why two timers instead of one: a single timer that both refreshes
// the anchor AND publishes the age would zero itself out as soon as
// the loop recovers, masking the worst spike between two scrapes. The
// independent age publisher keeps the high-water mark visible across
// scrape windows.
//
// Both timers .unref() so the watchdog never holds the process open;
// the brain main() process exit path is unaffected.
//
// IMPORTANT: this watchdog is INDEPENDENT of the session-level
// keepAlive (NATS KV lock renewal). They are deliberately decoupled —
// a healthy session must not be able to mask a stuck pod (the v2.8
// design flaw that motivated NP0-3). startWatchdog() MUST be called
// at most once per process; multiple invocations are no-ops.

import { watchdogLastTickAgeSeconds } from "./metrics.js";
import pino from "pino";

const logger = pino({ name: "watchdog" });

const WATCHDOG_TICK_MS = 1000;

let lastWatchdogTick = Date.now();
let started = false;
let tickTimer: NodeJS.Timeout | undefined;
let ageTimer: NodeJS.Timeout | undefined;

/**
 * Start the pod-level event-loop watchdog. Idempotent — repeat calls
 * after the first one log and return without registering a second
 * setInterval. Returns the underlying tick timer so tests can stop it
 * deterministically via stopWatchdog().
 */
export function startWatchdog(): void {
  if (started) {
    logger.warn("watchdog.start_ignored_already_running");
    return;
  }
  started = true;
  lastWatchdogTick = Date.now();
  watchdogLastTickAgeSeconds.set(0);

  tickTimer = setInterval(() => {
    lastWatchdogTick = Date.now();
    watchdogLastTickAgeSeconds.set(0);
  }, WATCHDOG_TICK_MS);
  tickTimer.unref();

  ageTimer = setInterval(() => {
    const ageSec = (Date.now() - lastWatchdogTick) / 1000;
    watchdogLastTickAgeSeconds.set(ageSec);
  }, WATCHDOG_TICK_MS);
  ageTimer.unref();

  logger.info({ tickMs: WATCHDOG_TICK_MS }, "watchdog.started");
}

/**
 * Stop the watchdog. Intended for unit / integration tests; production
 * code never calls this — the .unref()'d timers exit naturally with
 * the process.
 */
export function stopWatchdog(): void {
  if (!started) return;
  if (tickTimer) clearInterval(tickTimer);
  if (ageTimer) clearInterval(ageTimer);
  tickTimer = undefined;
  ageTimer = undefined;
  started = false;
}

/**
 * Test-only accessor for the most recent tick timestamp. Exported so
 * the C9 watchdog test can assert that the timer is actually moving
 * without reaching into module-private state via any-cast.
 */
export function __getLastWatchdogTickForTest(): number {
  return lastWatchdogTick;
}
