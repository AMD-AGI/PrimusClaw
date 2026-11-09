// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { Clock } from "../../src/ports/clock.js";

interface Sleeper {
  readonly when: number;
  readonly seq: number;
  readonly resolve: () => void;
  done: boolean;
}

/** Let every runnable continuation react before time moves (the Python tests' 25 x `asyncio.sleep(0)`). */
export async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * Virtual time in seconds (the Python tests' `Timeline`). Everything that waits registers a wake-up time; `pump` lets the
 * other work run, then moves the clock to the earliest wake-up. Nothing really sleeps.
 */
export class Timeline implements Clock {
  now = 1000;
  readonly start = 1000;
  private sleepers: Sleeper[] = [];
  private seq = 0;

  epochMs(): number {
    return this.now * 1000;
  }

  monotonicMs(): number {
    return this.now * 1000;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return this.sleepUntil(this.now + ms / 1000, signal);
  }

  sleepUntil(when: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason as Error);
    return new Promise<void>((resolve, reject) => {
      const sleeper: Sleeper = { when, seq: this.seq++, resolve, done: false };
      this.sleepers.push(sleeper);
      signal?.addEventListener(
        "abort",
        () => {
          sleeper.done = true;
          reject(signal.reason as Error);
        },
        { once: true },
      );
    });
  }

  /** Seconds since the start. */
  get elapsed(): number {
    return this.now - this.start;
  }

  private async step(): Promise<boolean> {
    await settle();
    this.sleepers = this.sleepers.filter((s) => !s.done);
    if (this.sleepers.length === 0) return false;
    const next = this.sleepers.reduce((a, b) => (b.when < a.when || (b.when === a.when && b.seq < a.seq) ? b : a));
    this.sleepers = this.sleepers.filter((s) => s !== next);
    next.done = true;
    this.now = Math.max(this.now, next.when);
    next.resolve();
    return true;
  }

  /** Run until `work` settles, moving time as it waits. */
  async pump<T>(work: Promise<T>): Promise<T> {
    const state = { over: false };
    const isOver = (): boolean => state.over;
    const watched = work.finally(() => {
      state.over = true;
    });
    watched.catch(() => undefined);
    for (let i = 0; i < 4000; i += 1) {
      await settle();
      if (isOver()) return work;
      if (!(await this.step())) {
        await settle();
        if (isOver()) return work;
        throw new Error("nothing is waiting and the work is not over");
      }
    }
    throw new Error("virtual time ran away: something keeps scheduling work");
  }

  async advanceTo(when: number): Promise<void> {
    for (let i = 0; i < 4000; i += 1) {
      if (this.now >= when) return;
      if (!(await this.step())) {
        this.now = when;
        return;
      }
    }
    throw new Error("virtual time never reached the expected moment");
  }

  /** Whatever is still waiting after the turn ended (it must be nothing that sends). */
  async drain(): Promise<void> {
    while (await this.step()) {
      // wake each sleeper in turn
    }
  }

  get waiting(): number {
    return this.sleepers.filter((s) => !s.done).length;
  }
}
