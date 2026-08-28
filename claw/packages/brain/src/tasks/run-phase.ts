// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * How much of a run is spent executing, and how much waiting.
 *
 * A run holds an execution slot from the moment it starts until the moment it
 * ends, whether it is calling the model or sitting on a background command
 * that has two hours left to run. A pod can be idle and full at the same time.
 *
 * Two things come out of knowing when a run is waiting. The slot goes back to
 * the pod for the duration, which is what stops a queue from standing still
 * behind runs that are not running. And the fraction of a run spent waiting
 * gets reported with each lease renewal, which is the number that decides
 * whether the deeper version of this -- suspending a run mid-turn and letting
 * the sandbox go too -- is worth building at all. If runs turn out to spend
 * nearly all their time executing, that work buys nothing and the answer is
 * more capacity rather than a new execution model.
 *
 * What is not handed back is the sandbox, so parking is bounded by a resident
 * ceiling in the gate rather than being free. See tasks/execution-gate.ts.
 *
 * Waits are recorded here and keyed by the run's key rather than held on the
 * runner, because the two places that know a wait is happening -- the approval
 * gate and the tool router -- are several layers below it, and passing a
 * handle down to each would put this concern into signatures that have nothing
 * else to do with it.
 */
import type { RunWaitReason } from "@claw/protocol";

interface RunPhaseState {
  /** Why the run is currently waiting, or null while it is executing. */
  waitingOn: RunWaitReason | null;
  /** When the current wait started; meaningless while executing. */
  waitStartedAt: number;
  /** Wall-clock milliseconds spent in finished waits. */
  waitedMs: number;
  /** Waits entered, so an average wait length can be derived. */
  waits: number;
}

const runs = new Map<string, RunPhaseState>();

/**
 * What to do with the pod's execution slot when a run starts and stops
 * waiting.
 *
 * Injected rather than imported so this module stays a plain ledger: tests
 * drive an isolated gate, and the sub-agent path -- which runs inside a slot
 * its parent already holds -- can leave the hooks unset and only be measured.
 */
export interface ParkHooks {
  /** @returns whether a slot was actually given back. */
  park(): boolean;
  /** @param hadSlot what the matching `park` returned. */
  unpark(hadSlot: boolean): Promise<void>;
}

let hooks: ParkHooks | null = null;

export function setParkHooks(next: ParkHooks | null): void {
  hooks = next;
}

/** Start tracking a run. Idempotent: a redelivery re-enters the same key. */
export function beginRun(key: string): void {
  runs.set(key, { waitingOn: null, waitStartedAt: 0, waitedMs: 0, waits: 0 });
}

/** Stop tracking a run. Every beginRun needs exactly one endRun. */
export function endRun(key: string): void {
  runs.delete(key);
}

/**
 * Run `fn` with the run marked as waiting.
 *
 * Nested waits keep the outermost reason: an approval that happens to be
 * requested while a background command is outstanding is still one stretch of
 * the run not executing, and counting it twice would put the waiting fraction
 * above one. That also makes the slot change hands once per stretch rather
 * than once per nested wait.
 *
 * The slot is reacquired before the caller continues, and that reacquisition
 * can block: the pod may have given the slot to something else while this run
 * was waiting. Which is the intended behaviour -- a run coming back from an
 * approval takes its turn -- but it means the time between "the user clicked
 * approve" and "the tool ran" now includes a queue, and it is still counted as
 * waiting, because from the run's point of view that is what it is.
 */
export async function whileWaiting<T>(
  key: string | undefined,
  reason: RunWaitReason,
  fn: () => Promise<T>,
): Promise<T> {
  const state = key ? runs.get(key) : undefined;
  if (!state || state.waitingOn) return fn();
  state.waitingOn = reason;
  state.waitStartedAt = Date.now();
  state.waits++;
  const parked = hooks;
  // A run that had no slot to give back must not come back holding one, so the
  // answer travels with the pair rather than being inferred on return.
  const gaveSlotBack = parked?.park() ?? false;
  try {
    return await fn();
  } finally {
    // Before the bookkeeping, so a slow reacquisition shows up as waiting
    // rather than as execution this run never got to do.
    try {
      await parked?.unpark(gaveSlotBack);
    } finally {
      state.waitedMs += Date.now() - state.waitStartedAt;
      state.waitingOn = null;
    }
  }
}

export interface RunPhaseReport {
  phase: "executing" | "waiting";
  waitReason?: RunWaitReason;
  /** Includes the wait in progress, so a long one is visible while it lasts. */
  waitedMs: number;
  waits: number;
}

/** What to report with the next lease renewal. */
export function phaseOf(key: string): RunPhaseReport {
  const state = runs.get(key);
  if (!state) return { phase: "executing", waitedMs: 0, waits: 0 };
  const inFlight = state.waitingOn ? Date.now() - state.waitStartedAt : 0;
  return {
    phase: state.waitingOn ? "waiting" : "executing",
    ...(state.waitingOn ? { waitReason: state.waitingOn } : {}),
    waitedMs: state.waitedMs + inFlight,
    waits: state.waits,
  };
}
