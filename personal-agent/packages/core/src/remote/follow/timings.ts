// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** When a burst of what an agent says on its own is over (milliseconds). Tests use short ones. */
export interface FollowTimings {
  /** No event for this long, and no step or permission request open: the burst is over. */
  readonly quietMs: number;
  /** ... when one is open: the agent may be waiting for a long step. */
  readonly toolQuietMs: number;
  /** At most one message per this long (what comes in between is said with the next one). */
  readonly gapMs: number;
  /** The longest text waits for a pause, however busy the agent is. */
  readonly maxAgeMs: number;
  /** First wait before reading again after a stream ended (it doubles, up to `RECONNECT_MAX_MS`). */
  readonly reconnectMs: number;
  /** After a message failed to go out, the wait before it is tried again (`RETRY_MS` when not given). */
  readonly retryMs?: number;
  /** How long a stop waits for the reader to deliver what it read (`STOP_WAIT_MS` when not given). */
  readonly stopWaitMs?: number;
}

export const DEFAULT_TIMINGS: FollowTimings = {
  quietMs: 30_000,
  toolQuietMs: 300_000,
  gapMs: 60_000,
  maxAgeMs: 600_000,
  reconnectMs: 1_000,
};

/** How a watched conversation (open in a terminal, read-only) is followed: told after a few quiet seconds, not half a minute. */
export const WATCH_TIMINGS: FollowTimings = {
  quietMs: 5_000,
  toolQuietMs: 20_000,
  gapMs: 10_000,
  maxAgeMs: 60_000,
  reconnectMs: 1_000,
};

export const RECONNECT_MAX_MS = 60_000;
/** A message that could not be sent is tried again after this long. */
export const RETRY_MS = 15_000;
/** `stop` waits this long for the reader to finish what it was doing. */
export const STOP_WAIT_MS = 15_000;
/** Events between two writes of the read position (a write also follows every delivery). */
export const CURSOR_EVERY = 25;

/** The wait before reading again after `failures` failed reads in a row. */
export function reconnectDelayMs(timings: FollowTimings, failures: number): number {
  return Math.min(RECONNECT_MAX_MS, timings.reconnectMs * 2 ** Math.min(failures, 8));
}
