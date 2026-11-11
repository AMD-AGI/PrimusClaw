// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** What the ingress takes from its host: the settings, HTTP and a clock (tests give their own). */

export type Fetch = typeof fetch;

/** The app settings (process.env on a Function app). */
export type Env = Readonly<Record<string, string | undefined>>;

export interface Clock {
  /** Seconds on a monotonic clock (Python's time.monotonic). */
  monotonic(): number;
  /** Seconds since the epoch (Python's time.time). */
  time(): number;
}

export const SYSTEM_CLOCK: Clock = {
  monotonic: () => performance.now() / 1000,
  time: () => Date.now() / 1000,
};
