// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { Clock } from "../ports/clock.js";

/** A step of a report that took longer than it may (Python's `TimeoutError` from `asyncio.timeout`). */
export class DeadlineExceeded extends Error {
  override readonly name = "TimeoutError";
}

/**
 * `work`, given `ms` of `clock`: past that, the returned promise rejects with DeadlineExceeded and `work`'s signal is
 * aborted, so what it waits on (a stream) stops. The clock's timer is cancelled once `work` settles.
 */
export async function withDeadline<T>(clock: Clock, ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const workAbort = new AbortController();
  const timerAbort = new AbortController();
  const expired = clock.sleep(ms, timerAbort.signal).then(
    () => {
      const error = new DeadlineExceeded(`no answer in ${String(ms)} ms`);
      workAbort.abort(error);
      throw error;
    },
    () => new Promise<never>(() => undefined), // the timer was cancelled: this side never settles
  );
  try {
    return await Promise.race([work(workAbort.signal), expired]);
  } finally {
    timerAbort.abort();
  }
}
