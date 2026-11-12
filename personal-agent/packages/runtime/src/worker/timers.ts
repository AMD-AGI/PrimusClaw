// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The worker's background loops (the Python worker's sweep, release, resend, retry and mend tasks): each runs every
 * `everyMs` (first at start when `runAtStart`) until the worker stops; a run that fails is logged by its kind and the loop
 * goes on.
 */
import type { Clock, Logger } from "@primusclaw/personal-agent";
import { errorName } from "@primusclaw/personal-agent";

export interface Timer {
  readonly name: string;
  readonly everyMs: number;
  readonly runAtStart: boolean;
  run(): Promise<void>;
}

async function loop(timer: Timer, clock: Clock, logger: Logger, signal: AbortSignal): Promise<void> {
  let first = true;
  while (!signal.aborted) {
    if (!(first && timer.runAtStart)) {
      try {
        await clock.sleep(timer.everyMs, signal);
      } catch {
        return; // (stopped while it slept)
      }
    }
    first = false;
    try {
      await timer.run();
    } catch (error) {
      logger.error("a background task failed", { task: timer.name, error: errorName(error) });
    }
  }
}

/** Run every timer until `signal` aborts; resolves when all have stopped. */
export async function startTimers(
  timers: readonly Timer[],
  clock: Clock,
  logger: Logger,
  signal: AbortSignal,
): Promise<void> {
  await Promise.all(timers.map((timer) => loop(timer, clock, logger, signal)));
}
