// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Acks of queued messages: a message that went through the outbound queue learns its Teams id later, when the relay
 * sends `primusclaw.delivered` back in. This matches each ack to the post waiting for it, and tells a late ack (the post
 * stopped waiting) from a stray one.
 */
import type { Clock, Logger } from "@primusclaw/personal-agent";
import { silentLogger } from "@primusclaw/personal-agent";

/** How many acks whose post stopped waiting are remembered, to log a late one as late. */
export const LATE_ACKS_REMEMBERED = 64;

/** What a post waits for: the Teams id of its message (`undefined` when the relay gave none). */
export interface AckWaiter {
  readonly promise: Promise<string | undefined>;
}

export class AckRegistry {
  private readonly waiting = new Map<string, (activityId: string | undefined) => void>();
  private readonly gaveUpAt = new Map<string, number>();

  constructor(
    private readonly clock: Clock,
    private readonly logger: Logger = silentLogger,
  ) {}

  expect(ack: string): AckWaiter {
    let settle: (activityId: string | undefined) => void = () => undefined;
    const promise = new Promise<string | undefined>((resolve) => {
      settle = resolve;
    });
    this.waiting.set(ack, settle);
    return { promise };
  }

  forget(ack: string): void {
    this.waiting.delete(ack);
  }

  gaveUp(ack: string): void {
    this.gaveUpAt.set(ack, this.clock.monotonicMs());
    while (this.gaveUpAt.size > LATE_ACKS_REMEMBERED) {
      const oldest = this.gaveUpAt.keys().next();
      if (oldest.done) break;
      this.gaveUpAt.delete(oldest.value);
    }
  }

  resolve(ack: string, activityId: string | undefined): void {
    const settle = this.waiting.get(ack);
    if (settle) {
      this.waiting.delete(ack);
      settle(activityId);
      return;
    }
    const gaveUpAt = this.gaveUpAt.get(ack);
    if (gaveUpAt === undefined) return;
    this.gaveUpAt.delete(ack);
    // (the relay did deliver it, only later than the post was willing to wait)
    this.logger.warn("outbound ack arrived after the post stopped waiting for it", {
      lateMs: this.clock.monotonicMs() - gaveUpAt,
      activityId: activityId ?? "-",
    });
  }
}
