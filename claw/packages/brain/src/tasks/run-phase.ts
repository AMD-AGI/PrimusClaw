// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * How much of a run is spent executing, and how much doing something else.
 *
 * A run holds an execution slot whether it is calling the model or sitting on a
 * background command with two hours left, so a pod can be idle and full at
 * once. Knowing which buys two things: the slot goes back to the pod for the
 * duration, and the time is reported with each lease renewal as a running total
 * per state -- see @claw/protocol's run-time module for what it means there.
 *
 * A run is in exactly one state at a time and entering a new one closes the
 * previous, so the totals sum to the run's own wall clock rather than past it.
 * What is not handed back is the sandbox, so parking is bounded by a resident
 * ceiling in the gate. See tasks/execution-gate.ts.
 */
import {
  REASON_STATE,
  RUN_TIME_KNOWN_STATES,
  type RunTimeKnownState,
  type RunWaitReason,
} from "@claw/protocol";
import pino from "pino";

import type { RunIdentityKey } from "./run-identity.js";

const logger = pino({ name: "run-phase" });

/**
 * Whether a wait may hand the pod's execution slot back for its duration.
 *
 * Required and undefaulted at every call site: a slot belongs to whoever
 * acquired it, and a sub-agent waiting inside its parent's slot would be
 * handing back one it does not own, admitting work the pod never intended.
 */
export type WaitMode = "timed" | "timed+park";

interface RunPhaseState {
  /** The one state accumulating right now. */
  activeState: RunTimeKnownState;
  /** Why, when the active state is a wait; null otherwise. */
  activeReason: RunWaitReason | null;
  /** When the active state was entered. */
  activeSince: number;
  stateMs: Record<RunTimeKnownState, number>;
  reasonMs: Partial<Record<RunWaitReason, number>>;
  /** Waits entered, so an average wait length can be derived. */
  waits: number;
}

const runs = new Map<RunIdentityKey, RunPhaseState>();

/** States that mean the run is not executing, for the two-value wire phase. */
const WAITING_STATES: readonly RunTimeKnownState[] = [
  "waiting_human", "waiting_background", "waiting_resource", "waiting_external",
];

/**
 * What to do with the pod's execution slot around a wait. Injected rather than
 * imported so this module stays a plain ledger and a timing-only call site
 * never reads it at all.
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

function zeroStates(): Record<RunTimeKnownState, number> {
  return Object.fromEntries(
    RUN_TIME_KNOWN_STATES.map((state) => [state, 0]),
  ) as Record<RunTimeKnownState, number>;
}

/** Start tracking a run. Idempotent: a redelivery re-enters the same key. */
export function beginRun(key: RunIdentityKey): void {
  runs.set(key, {
    activeState: "executing",
    activeReason: null,
    activeSince: Date.now(),
    stateMs: zeroStates(),
    reasonMs: {},
    waits: 0,
  });
}

/** Whether the ledger holds this key. Read by a park site checking its own. */
export function isTrackedRun(key: RunIdentityKey): boolean {
  return runs.has(key);
}

/** Stop tracking a run. Every beginRun needs exactly one endRun. */
export function endRun(key: RunIdentityKey): void {
  runs.delete(key);
}

/** Close the interval the run is in and open one in `next`. */
function switchTo(
  state: RunPhaseState,
  next: RunTimeKnownState,
  reason: RunWaitReason | null,
): void {
  const now = Date.now();
  const elapsed = now - state.activeSince;
  state.stateMs[state.activeState] += elapsed;
  if (state.activeReason) {
    state.reasonMs[state.activeReason] = (state.reasonMs[state.activeReason] ?? 0) + elapsed;
  }
  state.activeState = next;
  state.activeReason = reason;
  state.activeSince = now;
}

async function whileInState<T>(
  key: RunIdentityKey | undefined,
  next: RunTimeKnownState,
  reason: RunWaitReason | null,
  mode: WaitMode,
  fn: () => Promise<T>,
): Promise<T> {
  const state = key ? runs.get(key) : undefined;
  if (!state) {
    logger.warn({ state: next, reason, mode, keyed: key !== undefined }, "run_phase.ledger_miss");
    return fn();
  }
  // Exclusivity: a run already out of `executing` is in one stretch of not
  // executing, and opening a second would count the same interval twice.
  if (state.activeState !== "executing") return fn();
  switchTo(state, next, reason);
  if (reason) state.waits++;
  const parked = mode === "timed+park" ? hooks : null;
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
      switchTo(state, "executing", null);
    }
  }
}

/**
 * Run `fn` with the run marked as waiting on `reason`.
 *
 * The slot is reacquired before the caller continues, and that can block: the
 * queue for it is counted as waiting, because from the run's point of view that
 * is what it is.
 */
export function whileWaiting<T>(
  key: RunIdentityKey | undefined,
  reason: RunWaitReason,
  mode: WaitMode,
  fn: () => Promise<T>,
): Promise<T> {
  return whileInState(key, REASON_STATE[reason], reason, mode, fn);
}

/**
 * Run `fn` with the run marked as recovering its sandbox.
 *
 * Timing only: the run is repairing what it needs to keep executing, and it
 * has no idle slot to lend out while it does.
 */
export function whileRecovering<T>(
  key: RunIdentityKey | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  return whileInState(key, "recovering", null, "timed", fn);
}

export interface RunPhaseReport {
  phase: "executing" | "waiting";
  waitReason?: RunWaitReason;
  /** Includes the wait in progress, so a long one is visible while it lasts. */
  waitedMs: number;
  waits: number;
}

/** The running per-state totals a lease renewal reports as its coverage. */
export interface RunTimeSnapshot {
  stateMs: Partial<Record<RunTimeKnownState, number>>;
  reasonMs: Partial<Record<RunWaitReason, number>>;
}

/** The entry's totals with the interval in progress folded in. */
function totalsOf(state: RunPhaseState): RunTimeSnapshot {
  const inFlight = Date.now() - state.activeSince;
  const stateMs = { ...state.stateMs };
  stateMs[state.activeState] += inFlight;
  const reasonMs = { ...state.reasonMs };
  if (state.activeReason) {
    reasonMs[state.activeReason] = (reasonMs[state.activeReason] ?? 0) + inFlight;
  }
  return { stateMs, reasonMs };
}

/** What to report with the next lease renewal. */
export function phaseOf(key: RunIdentityKey): RunPhaseReport {
  const state = runs.get(key);
  if (!state) return { phase: "executing", waitedMs: 0, waits: 0 };
  const { stateMs } = totalsOf(state);
  const waitedMs = WAITING_STATES.reduce((sum, s) => sum + stateMs[s]!, 0);
  return {
    phase: state.activeReason ? "waiting" : "executing",
    ...(state.activeReason ? { waitReason: state.activeReason } : {}),
    waitedMs,
    waits: state.waits,
  };
}

/** Running totals, not deltas: the merge on the row banks the difference, so a
 *  lost or duplicated report costs nothing. */
export function runTimeOf(key: RunIdentityKey): RunTimeSnapshot | null {
  const state = runs.get(key);
  return state ? totalsOf(state) : null;
}
