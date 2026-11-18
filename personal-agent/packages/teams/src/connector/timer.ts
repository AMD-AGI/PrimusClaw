// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Time limits as AbortSignals on the injected Clock: a timer that aborts its signal after a while (a request's timeout,
 * an operation's overall deadline), and a race that ends a wait the moment a signal aborts, whether or not the thing
 * waited for listens to the signal.
 */
import type { Clock } from "@primusclaw/personal-agent";
import { DeadlineError } from "./errors.js";

export interface Timer {
  /** Aborts with a DeadlineError when the time is up, or with the parent's reason when the parent aborts first. */
  readonly signal: AbortSignal;
  /** Stop the timer (the time it waits for is no longer needed). */
  dispose(): void;
}

/** A signal that aborts after `ms` of `clock`, or when `parent` does. Dispose it once the work it limits is over. */
export function startTimer(clock: Clock, ms: number, reason: string, parent?: AbortSignal): Timer {
  const own = new AbortController();
  const stop = new AbortController();
  clock.sleep(ms, stop.signal).then(
    () => {
      own.abort(new DeadlineError(reason));
    },
    () => undefined, // the timer was disposed: its sleep is cancelled, nothing is due
  );
  const signal = parent === undefined ? own.signal : AbortSignal.any([parent, own.signal]);
  return {
    signal,
    dispose: () => {
      stop.abort();
    },
  };
}

/** `work`, ended with the signal's reason as soon as `signal` aborts (the work may keep running; its result is dropped). */
export async function raceAbort<T>(signal: AbortSignal, work: Promise<T>): Promise<T> {
  if (signal.aborted) {
    work.catch(() => undefined); // abandoned before it was awaited: its outcome no longer has a reader
    throw reasonOf(signal);
  }
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      reject(reasonOf(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
    work.catch(() => undefined); // when the abort won, the work's late failure has no reader left
  }
}

/** The error a signal aborted with. */
export function reasonOf(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new DeadlineError("aborted");
}
