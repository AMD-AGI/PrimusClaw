// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Teams allows one open stream per conversation. This remembers, per conversation, until when this process does not open
 * another one there: one is open, or one whose final was refused may still be open on Teams' side until it times out.
 */
import type { Clock } from "@primusclaw/personal-agent";

/** Teams closes a stream 10 minutes after its first request. */
export const STREAM_LIMIT_MS = 10 * 60 * 1000;

export class BusyConversations {
  private readonly until = new Map<string, number>();

  constructor(private readonly clock: Clock) {}

  isBusy(conversation: string): boolean {
    return (this.until.get(conversation) ?? 0) > this.clock.monotonicMs();
  }

  /** A stream opened at `openedAt` in `conversation`: busy until Teams' limit. Expired entries are dropped. */
  opened(conversation: string, openedAt: number): void {
    this.until.set(conversation, openedAt + STREAM_LIMIT_MS);
    for (const [other, until] of this.until) if (until <= openedAt) this.until.delete(other);
  }

  /** The stream opened at `openedAt` closed: the conversation is free, unless a newer stream holds it. */
  closed(conversation: string, openedAt: number): void {
    if (this.until.get(conversation) === openedAt + STREAM_LIMIT_MS) this.until.delete(conversation);
  }
}
