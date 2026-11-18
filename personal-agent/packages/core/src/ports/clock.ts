// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Time, injected. Nothing in core reads `Date.now()`, `performance.now()` or calls `setTimeout` itself: tests drive a
 * fake clock (`test-support/clock.ts`), the runtime gives the system's (`@primusclaw/personal-agent-runtime`).
 */
export interface Clock {
  /** Wall-clock time, milliseconds since the Unix epoch (what is stored and shown; it can jump). */
  epochMs(): number;
  /** A monotonic reading in milliseconds, for durations and deadlines only (never stored; its origin is arbitrary). */
  monotonicMs(): number;
  /**
   * Resolves after `ms` milliseconds of this clock. With `signal`, rejects with the signal's reason as soon as it is
   * aborted (an abort that happened before the call rejects at once).
   */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

/** Wall-clock seconds since the epoch, as a float: the unit the stored timestamps use (`created_at REAL`). */
export function epochSeconds(clock: Clock): number {
  return clock.epochMs() / 1000;
}
