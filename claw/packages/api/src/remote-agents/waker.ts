// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * An in-process doorbell for the streams of this replica.
 *
 * The database is the truth; this only shortens the wait. A stream that is
 * asleep until its next poll wakes at once when something is written through
 * the same process. A write made through another replica is found by the poll
 * instead, so a missed or lost wake-up costs latency and never data.
 */
export class Waker {
  private readonly waiting = new Map<string, Set<() => void>>();

  /** Wake every stream waiting on `key`. */
  wake(key: string): void {
    const set = this.waiting.get(key);
    if (!set) return;
    for (const fn of [...set]) fn();
  }

  /**
   * Resolve after `ms`, or sooner when `key` is woken or `signal` aborts.
   * Resolves either way; the caller re-reads the database to find out why.
   */
  wait(key: string, ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      let set = this.waiting.get(key);
      if (!set) this.waiting.set(key, (set = new Set()));
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        set!.delete(done);
        if (set!.size === 0 && this.waiting.get(key) === set) this.waiting.delete(key);
        resolve();
      };
      const timer = setTimeout(done, Math.max(0, ms));
      set.add(done);
      if (signal?.aborted) done();
      else signal?.addEventListener("abort", done, { once: true });
    });
  }

  /** Streams currently waiting, for tests that check nothing is leaked. */
  get size(): number {
    let n = 0;
    for (const s of this.waiting.values()) n += s.size;
    return n;
  }
}
