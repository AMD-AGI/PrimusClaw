// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * One lock per key (a conversation; or one key for a token cache), held from the start of a piece of work to its end and
 * handed over in arrival order: the sends of a conversation leave in the order they were made. A lane is forgotten as
 * soon as nobody holds or waits for it.
 */
import { raceAbort } from "./timer.js";

interface Lane {
  /** Resolves when the last holder that queued so far is done. */
  tail: Promise<void>;
  /** Holders and waiters. */
  users: number;
}

export class Lanes {
  private readonly lanes = new Map<string, Lane>();

  /** How many keys are held or waited for just now. */
  get size(): number {
    return this.lanes.size;
  }

  /**
   * Run `work` once every earlier holder of `key` is done. With `signal`, waiting for the lane ends when it aborts (the
   * work is then not run, and the holders behind still wait for the ones in front).
   */
  async hold<T>(key: string, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    let lane = this.lanes.get(key);
    if (lane === undefined) {
      lane = { tail: Promise.resolve(), users: 0 };
      this.lanes.set(key, lane);
    }
    lane.users += 1;
    const previous = lane.tail;
    let release = (): void => undefined;
    lane.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await (signal === undefined ? previous : raceAbort(signal, previous));
      return await work();
    } finally {
      void previous.then(release);
      lane.users -= 1;
      if (lane.users === 0) this.lanes.delete(key);
    }
  }
}
