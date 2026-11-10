// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { Clock } from "../../ports/clock.js";

/** What `Inbox.next` gives when its wait ran out with nothing in it. */
export const TIMED_OUT: unique symbol = Symbol("timed out");

/**
 * A queue one reader waits on, for an item or the end of a pause (`next` with a timeout), whichever comes first. A wait that runs
 * out never takes an item away: the next `next` gets it.
 */
export class Inbox<T> {
  private readonly items: T[] = [];
  private wake: (() => void) | null = null;

  constructor(private readonly clock: Clock) {}

  push(item: T): void {
    this.items.push(item);
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  /** The next item, or `TIMED_OUT` after `timeoutMs` (null: wait for an item however long). */
  async next(timeoutMs: number | null): Promise<T | typeof TIMED_OUT> {
    for (;;) {
      if (this.items.length > 0) return this.items.shift() as T;
      if (timeoutMs !== null && timeoutMs <= 0) return TIMED_OUT;
      const pause = new AbortController();
      const arrived = new Promise<boolean>((resolve) => {
        this.wake = () => {
          resolve(true);
        };
      });
      const waits: Promise<boolean>[] = [arrived];
      if (timeoutMs !== null)
        waits.push(
          this.clock.sleep(timeoutMs, pause.signal).then(
            () => false,
            () => false,
          ),
        );
      const came = await Promise.race(waits);
      pause.abort();
      this.wake = null;
      if (!came && this.items.length === 0) return TIMED_OUT;
    }
  }
}
