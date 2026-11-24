// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The longest delay a Node timer waits: `setTimeout` with a longer one (about
 * 24.8 days and up) does not wait it, it fires after 1 ms.
 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** A timer from {@link setLongTimeout}. */
export interface LongTimeout {
  /** Cancel it; calling it after the timer fired, or twice, does nothing. */
  clear(): void;
}

/**
 * `setTimeout(fn, delayMs)` for any delay, including one past
 * {@link MAX_TIMER_DELAY_MS}: the wait is a chain of timers no longer than that,
 * each one arming the next with what is left, so `fn` runs once the whole delay
 * has passed, never before. The delay is counted on the timers' own clock, as
 * `setTimeout`'s is, not re-read from `Date.now()`. A delay that is not a
 * positive number is 0.
 *
 * `unref` unrefs every timer it makes, so the wait never keeps the process alive.
 */
export function setLongTimeout(fn: () => void, delayMs: number, opts: { unref?: boolean } = {}): LongTimeout {
  let left = delayMs > 0 ? delayMs : 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let done = false;
  const arm = (): void => {
    const step = Math.min(left, MAX_TIMER_DELAY_MS);
    left -= step;
    timer = setTimeout(onTimer, step);
    if (opts.unref) timer.unref?.();
  };
  function onTimer(): void {
    if (done) return;
    if (left > 0) { arm(); return; }
    done = true;
    fn();
  }
  arm();
  return {
    clear(): void {
      done = true;
      clearTimeout(timer);
    },
  };
}
