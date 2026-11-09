// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { Clock } from "../ports/clock.js";

/** Checks between two passes that forget idle people. */
export const PRUNE_EVERY = 1000;

/** The answer for one message. */
export interface Verdict {
  readonly allowed: boolean;
  /** Refused, and this is the first refusal of the burst: tell the person (once). */
  readonly notify: boolean;
  /** Refused: seconds until one message more fits in the window. */
  readonly retryAfterSeconds: number;
}

const ALLOWED: Verdict = { allowed: true, notify: false, retryAfterSeconds: 0 };

/**
 * A sliding window per person: at most `limit` accepted messages in any `windowSeconds`. Refused messages are not
 * counted, so a person who keeps sending while refused is let through again as soon as the oldest accepted message
 * leaves the window. A person is told once per burst, not once per dropped message.
 */
export class MessageRateLimiter {
  private readonly hits = new Map<string, number[]>();
  /** person -> the end of the burst they were told about */
  private readonly toldUntil = new Map<string, number>();
  private checks = 0;

  constructor(
    readonly limit: number,
    readonly windowSeconds: number,
    private readonly clock: Clock,
  ) {}

  private now(): number {
    return this.clock.monotonicMs() / 1000;
  }

  check(user: string): Verdict {
    this.checks += 1;
    if (this.checks % PRUNE_EVERY === 0) this.prune();
    const now = this.now();
    const hits = this.hits.get(user) ?? [];
    this.hits.set(user, hits);
    while (hits.length > 0 && (hits[0] ?? 0) <= now - this.windowSeconds) hits.shift();
    const oldest = hits[0];
    if (oldest === undefined || hits.length < this.limit) {
      hits.push(now);
      this.toldUntil.delete(user);
      return ALLOWED;
    }
    const retryAfterSeconds = Math.max(oldest + this.windowSeconds - now, 0);
    const notify = now >= (this.toldUntil.get(user) ?? Number.NEGATIVE_INFINITY);
    if (notify) this.toldUntil.set(user, oldest + this.windowSeconds);
    return { allowed: false, notify, retryAfterSeconds };
  }

  /** Forget people with nothing in the window (memory stays bounded by the people active in the last window). */
  prune(): void {
    const now = this.now();
    for (const [user, hits] of [...this.hits]) {
      const newest = hits.at(-1);
      if (newest === undefined || newest <= now - this.windowSeconds) {
        this.hits.delete(user);
        this.toldUntil.delete(user);
      }
    }
  }

  /** How many people the limiter remembers. */
  get remembered(): number {
    return this.hits.size;
  }
}
