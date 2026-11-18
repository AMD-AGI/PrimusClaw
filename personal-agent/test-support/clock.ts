// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { Clock } from "@primusclaw/personal-agent";

interface Sleeper {
  readonly due: number;
  readonly seq: number;
  readonly resolve: () => void;
}

/**
 * A clock that moves only when the test moves it. `sleep` resolves when `advance` (or `runAll`) carries the clock to
 * its due time, sleepers in due order (ties in the order they slept). The wall clock and the monotonic clock move
 * together; `setEpochMs` jumps the wall clock alone (a clock change on the host).
 */
export class FakeClock implements Clock {
  private wall: number;
  private mono = 0;
  private seq = 0;
  private sleepers: Sleeper[] = [];

  constructor(startEpochMs = Date.UTC(2026, 0, 1)) {
    this.wall = startEpochMs;
  }

  epochMs(): number {
    return this.wall;
  }

  monotonicMs(): number {
    return this.mono;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason as Error);
    return new Promise((resolve, reject) => {
      const sleeper: Sleeper = { due: this.mono + Math.max(0, ms), seq: this.seq++, resolve };
      this.sleepers.push(sleeper);
      signal?.addEventListener(
        "abort",
        () => {
          this.sleepers = this.sleepers.filter((s) => s !== sleeper);
          reject(signal.reason as Error);
        },
        { once: true },
      );
    });
  }

  /** How many sleeps are waiting. */
  get pending(): number {
    return this.sleepers.length;
  }

  /** Move both clocks forward by `ms`, waking every sleeper that falls due, and let their continuations run. */
  async advance(ms: number): Promise<void> {
    const target = this.mono + ms;
    for (;;) {
      const next = this.nextDue();
      if (next === undefined || next.due > target) break;
      this.moveTo(next.due);
      this.sleepers = this.sleepers.filter((s) => s !== next);
      next.resolve();
      await flushMicrotasks();
    }
    this.moveTo(target);
    await flushMicrotasks();
  }

  /** Advance to each pending sleeper in turn until none is left (at most `limit` wake-ups, to stop a sleep loop). */
  async runAll(limit = 1000): Promise<void> {
    for (let i = 0; i < limit; i++) {
      const next = this.nextDue();
      if (next === undefined) return;
      await this.advance(next.due - this.mono);
    }
    throw new Error(`FakeClock.runAll: still sleeping after ${String(limit)} wake-ups`);
  }

  setEpochMs(epochMs: number): void {
    this.wall = epochMs;
  }

  private nextDue(): Sleeper | undefined {
    return this.sleepers.reduce<Sleeper | undefined>(
      (best, s) => (best === undefined || s.due < best.due || (s.due === best.due && s.seq < best.seq) ? s : best),
      undefined,
    );
  }

  private moveTo(mono: number): void {
    this.wall += mono - this.mono;
    this.mono = mono;
  }
}

/** Let every queued promise continuation run (a few turns of the microtask queue and one macrotask). */
export async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
}
