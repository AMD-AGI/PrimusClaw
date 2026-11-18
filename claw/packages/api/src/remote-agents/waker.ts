// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * An in-process doorbell for the streams of this replica.
 *
 * The database is the truth; this only shortens the wait. A stream that is
 * asleep until its next poll wakes at once when something is written through
 * the same process, and, with a relay (`remote-agents/wake-relay.ts`), when it
 * is written through another replica. Without one, or while it is down, such a
 * write is found by the poll instead, so a missed or lost wake-up costs latency
 * and never data.
 */
export class Waker {
  private readonly waiting = new Map<string, Set<() => void>>();
  private relay?: (key: string) => void;

  /** Also ring every wake on the other replicas; `undefined` stops it. */
  setRelay(relay: ((key: string) => void) | undefined): void {
    this.relay = relay;
  }

  /** Wake every stream waiting on `key`, here and, through the relay, on every other replica. */
  wake(key: string): void {
    this.wakeHere(key);
    this.relay?.(key);
  }

  /** Wake every stream of this process waiting on `key`: what a wake relayed from another replica does. */
  wakeHere(key: string): void {
    const set = this.waiting.get(key);
    if (!set) return;
    for (const fn of [...set]) fn();
  }

  /** Wake every stream of this process, to re-read whatever a relay that was down may have missed. */
  wakeAll(): void {
    for (const key of [...this.waiting.keys()]) this.wakeHere(key);
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
