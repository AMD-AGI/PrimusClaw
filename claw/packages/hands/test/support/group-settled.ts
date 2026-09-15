// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Wait for a process-group fact instead of guessing how long it takes.
 *
 * These tests assert on `/proc`, and the states they are about -- a leader
 * collected, its children still there -- arrive some unbounded moment after the
 * exit event. A fixed sleep is a bet on machine load, and under a full suite run
 * it is a bet that is eventually lost; what failed then is not the code.
 */
export async function until(
  condition: () => boolean,
  what: string,
  timeoutMs = 5_000,
  stepMs = 20,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (condition()) return;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
}
