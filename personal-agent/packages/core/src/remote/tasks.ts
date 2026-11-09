// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { errorName } from "../errors.js";
import type { Logger } from "../ports/logger.js";

/**
 * Work that runs on its own (a turn being read, a short watch, a throttled edit of a card) and can be cancelled: its signal
 * aborts, and every await it makes on a cancellable call ends. Cancelling is cooperative: the work checks its signal after what it
 * awaited, the way an asyncio task meets its cancellation at its next await.
 */
export class Task {
  private readonly controller = new AbortController();
  private finished = false;
  readonly done: Promise<void>;

  constructor(work: (signal: AbortSignal) => Promise<void>, logger: Logger, what: string) {
    this.done = work(this.controller.signal)
      .catch((error: unknown) => {
        if (!this.controller.signal.aborted) logger.warn(`${what} failed`, { error: errorName(error) });
      })
      .finally(() => {
        this.finished = true;
      });
  }

  get running(): boolean {
    return !this.finished;
  }

  get cancelled(): boolean {
    return this.controller.signal.aborted;
  }

  cancel(): void {
    this.controller.abort();
  }
}

/** One chat at a time: what runs for a chat waits for the one before it (the Python worker's per-chat `asyncio.Lock`). */
export class ChatLocks {
  private readonly tails = new Map<string, Promise<void>>();

  async with<T>(chatKey: string, work: () => Promise<T>): Promise<T> {
    const before = this.tails.get(chatKey) ?? Promise.resolve();
    let release = (): void => undefined;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = before.then(() => mine);
    this.tails.set(chatKey, tail);
    await before;
    try {
      return await work();
    } finally {
      release();
      if (this.tails.get(chatKey) === tail) this.tails.delete(chatKey);
    }
  }
}
