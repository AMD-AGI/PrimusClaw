// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import type { Clock } from "@primusclaw/personal-agent";

/** The process's clocks: `Date.now()` for the wall clock, `performance.now()` for durations. */
export const systemClock: Clock = {
  epochMs: () => Date.now(),
  monotonicMs: () => performance.now(),
  sleep: async (ms, signal) => {
    try {
      await delay(Math.max(0, ms), undefined, signal ? { signal } : {});
    } catch (error) {
      // Node rejects with its own AbortError; the port promises the signal's reason, as the fake clock gives.
      if (signal?.aborted === true) throw signal.reason as Error;
      throw error;
    }
  },
};
