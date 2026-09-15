// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The instant every time-dependent answer in this service reads.
 *
 * One surface rather than a `Date.now()` at each site, so a retention window
 * measured in hours or a deadline that has to be in the future can be exercised
 * without waiting either of them out. No production path sets it, and no
 * production behaviour is conditional on whether a test has.
 */

let clock: (() => number) | null = null;

/** Test-only. */
export function bindClock(next: (() => number) | null): void {
  clock = next;
}

export function nowMs(): number {
  return clock ? clock() : Date.now();
}
