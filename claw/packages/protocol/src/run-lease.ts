// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// When a run may be declared dead, as one arithmetic rather than three
// constants in three packages.
//
// A run's liveness is decided by four numbers that live in different processes:
// the lease TTL a worker renews (brain), the grace the reaper waits past expiry
// (api), the ack_wait after which the queue redelivers the message (this file),
// and the TTL of the `lock.<key>` entry a dead worker leaves behind (the
// BRAIN_REGISTRY bucket). Only their *ordering* is correct or incorrect, and
// the ordering used to be recorded in a comment while each factor could be
// overridden on its own. This module owns the relation instead, the same way
// task-consumer.ts owns the one between the redelivery budget and retention.

import {
  resolveTaskDeliveryBudget,
  TASK_CONSUMER_ACK_WAIT_NS,
  TASK_LOCK_NAK_CEILING_NS,
} from "./task-consumer.js";

/**
 * How long a renewal is good for, and how often a worker sends one.
 *
 * The ratio matters more than either number: at three heartbeats per lease, two
 * can be lost to a slow API or a GC pause without the run being declared dead.
 * Defaults live here rather than in brain's config because the reaper on the
 * API side has to derive its grace from the lease it is judging, and a value
 * only one of the two can see is a value they can disagree about.
 */
export const DEFAULT_RUN_LEASE_TTL_MS = 45_000;
export const DEFAULT_RUN_LEASE_HEARTBEAT_MS = 15_000;

/**
 * Widest lease the API will write onto a row, in milliseconds.
 *
 * Enforced at the renewal endpoint, and here because the reaper derives its
 * grace from the lease it is judging: a configured TTL wider than this is not
 * the TTL any row ends up carrying, so deriving from the configured value
 * describes a verdict that arrives later than the real one -- which is the
 * direction that closes runs while they are still resumable.
 */
export const MAX_RUN_LEASE_TTL_MS = 300_000;

/** The lease a row will actually carry, which is not always the one configured. */
export function effectiveRunLeaseTtlMs(configuredMs: number): number {
  return Math.min(configuredMs, MAX_RUN_LEASE_TTL_MS);
}

/** Renewals per lease the ratio above promises. */
export const RUN_LEASE_HEARTBEATS_PER_TTL = 3;

/**
 * The shortest gap between two renewals that is still maintenance.
 *
 * Derived from what a renewal costs rather than chosen for looking reasonable.
 * Each one is a round trip to another process -- a KV update plus a get for a
 * lock, an HTTP POST for a lease -- which in-cluster answers in single-digit
 * milliseconds when the store is healthy and takes the whole of its own timeout
 * when it is not. Anything in that range issues the next renewal before the
 * previous one has answered, which is a busy loop rather than a schedule.
 *
 * Here with the rest of the lease arithmetic because both processes bound the
 * same environment variables with it, and a floor only one of them applies is
 * how one variable comes to mean two things: a value refused in brain and taken
 * literally by the API flows into `resolveLeaseReapGraceSec`, which decides how
 * long after a lease lapses a run may be declared dead.
 *
 * A floor of one, which those settings carried first, excludes only the literal
 * zero: `RUN_LEASE_HEARTBEAT_MS=1` is a lease POST every millisecond per run --
 * the failure the bound is for -- and it satisfies every relation
 * `runLeaseTimingProblems` checks, since anything times three still fits inside
 * anything.
 */
export const MIN_RENEWAL_INTERVAL_MS = 1_000;

/**
 * First delay before a redelivery blocked by lock contention is retried.
 *
 * Next to the ceiling it doubles towards, because the takeover bound below is
 * computed from the whole curve. Brain applies it; nobody else needs to know
 * the curve exists, only how long it can take to climb.
 */
export const TASK_LOCK_NAK_BASE_MS = 5_000;

/**
 * Default TTL of the BRAIN_REGISTRY KV bucket, in milliseconds.
 *
 * Load-bearing here because `lock.<key>` lives in that bucket: it is how long a
 * dead worker's claim on a session survives the worker, and therefore how long
 * a redelivery of its message is refused the lock it needs to take the run
 * over. The bucket holds entries wanting very different lifetimes -- this one
 * wants to be short -- so this is the number to shorten once locks have a
 * bucket of their own, and everything below re-derives from it.
 */
export const DEFAULT_BRAIN_REGISTRY_TTL_MS = 5 * 60 * 1000;

/** Milliseconds, from the same source the durable is configured from. */
export const TASK_CONSUMER_ACK_WAIT_MS = TASK_CONSUMER_ACK_WAIT_NS / 1_000_000;
const TASK_LOCK_NAK_CEILING_MS = TASK_LOCK_NAK_CEILING_NS / 1_000_000;

/** Everything the reap ordering depends on. Milliseconds unless named otherwise. */
export interface RunLeaseTiming {
  /** Lease TTL a worker asks for on every renewal. */
  leaseTtlMs: number;
  /** Interval between renewals. */
  heartbeatMs: number;
  /** How long past expiry the reaper waits before closing the row. */
  graceSec: number;
  /** How long a dead worker's `lock.<key>` survives it. */
  lockTtlMs: number;
  /** How often the reaper looks. Its verdict lands up to one tick late. */
  sweeperTickMs: number;
  /** Redelivery budget, which bounds how many takeover attempts there can be. */
  maxDeliver: number;
}

/** Where a lock-blocked redelivery lands, and whether it lands at all. */
export interface LockBlockedTakeover {
  /** How long after the worker died the attempt happens. */
  atMs: number;
  /** Which delivery of the message that attempt is. */
  delivery: number;
  /**
   * Whether the attempt exists. A budget that runs out before the lock expires,
   * or that puts the attempt past the poison guard, has no takeover at all --
   * and `atMs` is then just where the budget ran out, which is not a moment
   * anything can be ordered against.
   */
  reachable: boolean;
}

/**
 * The delivery brain's poison guard resolves a still-locked task on.
 *
 * Read from the budget rather than re-derived, so `maxDeliver - 1` has one
 * definition: the guard firing one delivery early is what makes the last
 * attempt usable, and a second copy of that relation here would be a second
 * place to forget it.
 */
function poisonDeliveryOf(maxDeliver: number): number {
  return resolveTaskDeliveryBudget(maxDeliver).poisonDeliveryCount;
}

/** What the takeover curve is computed from. */
export interface TakeoverTiming {
  lockTtlMs: number;
  maxDeliver: number;
  ackWaitMs?: number;
  nakBaseMs?: number;
  nakCeilingMs?: number;
  /**
   * Which delivery of the message the dead worker was executing.
   *
   * Not always the first. A task is nak'd before it executes whenever its lock
   * is held -- and DAG siblings share one lock key by design -- so beginning on
   * a later delivery is the normal case for fan-out, not an edge. It matters
   * because the backoff after the death continues from wherever the count had
   * reached: the later the start, the larger the steps, and the later the
   * takeover.
   */
  diedOnDelivery?: number;
}

/**
 * The earliest a redelivery can actually resume a run whose worker died.
 *
 * Not `ack_wait`, which is only when the *message* comes back. The copy that
 * comes back still has to acquire `lock.<key>`, and the dead worker's lock is
 * held until the bucket TTL expires it -- so every attempt before that is
 * refused and nak'd, and the attempts are spaced by a doubling backoff. The
 * takeover therefore happens on the first attempt that lands after the lock has
 * expired, which the backoff can push well past the expiry itself.
 *
 * This is the number the reaper has to be slower than. Comparing against
 * ack_wait instead is what let a reaper at 165s close a run whose takeover was
 * not due until minutes later: the row went `worker_lost`, and the takeover,
 * when it finally got the lock, found a terminal row and stood down -- so a pod
 * death that used to cost a resume from checkpoint cost the whole turn instead.
 *
 * Answers the question for one death, on the no-jitter curve, which is its
 * upper edge: brain's jitter only ever shortens a backoff. Which death to ask
 * about is `worstLockBlockedTakeover`'s problem.
 */
export function resolveLockBlockedTakeover(timing: TakeoverTiming): LockBlockedTakeover {
  const ackWaitMs = timing.ackWaitMs ?? TASK_CONSUMER_ACK_WAIT_MS;
  const nakBaseMs = timing.nakBaseMs ?? TASK_LOCK_NAK_BASE_MS;
  const nakCeilingMs = timing.nakCeilingMs ?? TASK_LOCK_NAK_CEILING_MS;
  // The message is taken back once, at ack_wait, and that copy is the delivery
  // after the one that died -- which is the exponent brain's backoff uses.
  let at = ackWaitMs;
  let delivery = (timing.diedOnDelivery ?? 1) + 1;
  while (at < timing.lockTtlMs && delivery < timing.maxDeliver) {
    at += Math.min(nakCeilingMs, nakBaseMs * 2 ** (delivery - 1));
    delivery += 1;
  }
  // The loop stops for two reasons and only one of them is a takeover: the wait
  // finally outlasted the lock, or the redelivery budget ran out first. Past
  // the poison guard's threshold there is no attempt either, because the guard
  // resolves a task whose lock is still held rather than waiting again -- so a
  // budget that puts the attempt beyond it discards the run instead.
  return {
    atMs: at,
    delivery,
    reachable: at >= timing.lockTtlMs && delivery <= poisonDeliveryOf(timing.maxDeliver),
  };
}

/**
 * The latest takeover the reaper could preempt, over every death it could be
 * judging.
 *
 * The curve is not monotonic in the delivery the worker died on, so the answer
 * is neither the first death nor the last. A death one delivery later can move
 * the first post-lock attempt across a doubling step and add minutes; a death
 * later still can put that attempt past the poison guard, where there is no
 * takeover to preempt at all and the case drops out of the maximum entirely.
 * With the shipped numbers the death that matters is the fifth delivery, at
 * 580s, while the first -- the only one this used to ask about -- is 430s, and
 * every death from the sixth on is 420s, because its single backoff step is
 * already at the ceiling. Deriving the grace from the first is what let the
 * reaper close, as `worker_lost`, runs whose takeover was still minutes out.
 *
 * A death on the poison delivery or later is not considered: the guard resolves
 * the task rather than executing it, so there is no worker there to die.
 */
export function worstLockBlockedTakeover(timing: TakeoverTiming): LockBlockedTakeover {
  const lastExecutable = Math.max(1, poisonDeliveryOf(timing.maxDeliver) - 1);
  let worst: LockBlockedTakeover | null = null;
  for (let diedOnDelivery = 1; diedOnDelivery <= lastExecutable; diedOnDelivery++) {
    const takeover = resolveLockBlockedTakeover({ ...timing, diedOnDelivery });
    if (!takeover.reachable) continue;
    if (!worst || takeover.atMs > worst.atMs) worst = takeover;
  }
  // Nothing reachable means no death can be taken over, which is a statement
  // about the budget rather than about any one delivery. The first death is
  // what the caller is told about, because it is the one whose numbers make the
  // shortfall legible.
  return worst ?? resolveLockBlockedTakeover({ ...timing, diedOnDelivery: 1 });
}

/**
 * How long past a lease's expiry the reaper should wait, in seconds.
 *
 * Derived rather than chosen, for the reason the tombstone TTL is: the two
 * things it has to outlast are configured elsewhere, and a number that merely
 * happens to be bigger than both today stops being bigger the moment either
 * moves. It has to outlast the takeover bound above -- so a run that can still
 * be resumed is not closed first -- plus one sweeper tick, because a verdict
 * lands anywhere inside the tick that reaches it.
 *
 * Two numbers shorten it, and the nak ceiling is the one that sets the scale: a
 * death late in the budget waits exactly one backoff step, and that step is at
 * the ceiling whatever the lock costs. The lock TTL still moves the bound,
 * because it decides whether the worst death -- the one whose backoff has
 * climbed to just under the lock's expiry -- has to take that ceiling-sized
 * step at all. At the shipped numbers it does, which is the difference between
 * a grace of 610s and the 450s a lock expiring before that step would give.
 * Under ack_wait the bound collapses entirely, because the message comes back
 * to a lock that has already expired and waits out no backoff at all. So giving
 * `lock.<key>` a bucket of its own is the lever, and how short that bucket has
 * to be is a question with two useful answers rather than one.
 */
export function resolveLeaseReapGraceSec(timing: {
  leaseTtlMs: number;
  heartbeatMs: number;
  lockTtlMs: number;
  sweeperTickMs: number;
  maxDeliver: number;
}): number {
  const takeoverMs = worstLockBlockedTakeover(timing).atMs;
  // The verdict is (lease expiry + grace), and the lease expires leaseTtlMs
  // after the worker's last renewal, so the lease already covers part of the
  // wait -- as much of it as a row can actually carry, which is where a
  // configured TTL wider than the endpoint grants stops being the one that
  // counts.
  //
  // The heartbeat is added back because the two ends are measured from
  // different moments: the takeover from the death, the lease from the last
  // renewal, which was up to one heartbeat before it. Without this the margin
  // over the takeover is `sweeperTick - heartbeat` rather than a tick, so the
  // tick becomes the entire margin -- and at a tick shorter than the heartbeat
  // the derivation produces a grace whose real verdict lands before the
  // takeover it was derived to outlast, with startup validation passing.
  const graceMs = takeoverMs + timing.sweeperTickMs + timing.heartbeatMs
    - effectiveRunLeaseTtlMs(timing.leaseTtlMs);
  return Math.max(1, Math.ceil(graceMs / 1000));
}

/**
 * What is wrong with a set of timings, or nothing at all.
 *
 * A list rather than a boolean so a deployment that broke two of these is told
 * about both, and so the message names the numbers -- these are only ever
 * broken by an override, and the operator who set it is the reader.
 *
 * Checked at startup rather than trusted, because every factor can be
 * overridden independently: the reaper's own grace parsed to 0 from an empty
 * string, a lease TTL lowered until a GC pause looks like a death, a lock TTL
 * raised past the reaper. None of those fail visibly. They fail as runs closed
 * while they were still recoverable.
 */
export function runLeaseTimingProblems(timing: RunLeaseTiming): string[] {
  const problems: string[] = [];
  const positive = (name: string, value: number): boolean => {
    if (Number.isFinite(value) && value > 0) return true;
    problems.push(`${name} must be a positive number, got ${value}`);
    return false;
  };
  const ok = [
    positive("leaseTtlMs", timing.leaseTtlMs),
    positive("heartbeatMs", timing.heartbeatMs),
    positive("graceSec", timing.graceSec),
    positive("lockTtlMs", timing.lockTtlMs),
    positive("sweeperTickMs", timing.sweeperTickMs),
    positive("maxDeliver", timing.maxDeliver),
  ].every(Boolean);
  // Every check below compares these values against each other, so one of them
  // being absent makes the comparisons meaningless rather than false.
  if (!ok) return problems;

  // What a row can carry, not what was asked for: every comparison below is
  // about when the reaper acts on a real row.
  const leaseTtlMs = effectiveRunLeaseTtlMs(timing.leaseTtlMs);
  if (timing.heartbeatMs * RUN_LEASE_HEARTBEATS_PER_TTL > leaseTtlMs) {
    problems.push(
      `heartbeatMs=${timing.heartbeatMs} leaves fewer than ${RUN_LEASE_HEARTBEATS_PER_TTL} `
      + `renewals inside leaseTtlMs=${leaseTtlMs}: one slow API call would `
      + "expire the lease of a healthy run",
    );
  }

  // Measured from the death, like everything it is compared against, which is
  // up to one heartbeat after the renewal the lease is actually counted from.
  const verdictMs = leaseTtlMs + timing.graceSec * 1000 - timing.heartbeatMs;
  if (verdictMs <= TASK_CONSUMER_ACK_WAIT_MS) {
    problems.push(
      `the reaper's verdict at ${verdictMs}ms lands inside ack_wait `
      + `(${TASK_CONSUMER_ACK_WAIT_MS}ms), so a run is closed before the queue has `
      + "even offered its message to another worker",
    );
  }

  // The worst over every death the reaper could be judging, not the first one:
  // a run that began executing on a later delivery -- the normal case for DAG
  // siblings sharing a lock key -- is taken over later, and the grace has to
  // outlast the last of them, not the earliest.
  const takeover = worstLockBlockedTakeover(timing);
  if (!takeover.reachable) {
    // Reported instead of the ordering below rather than alongside it: with no
    // takeover to preempt, the reaper cannot be too fast, and saying it is
    // would send the operator after the wrong number.
    problems.push(
      `maxDeliver=${timing.maxDeliver} leaves no delivery that can take a run over: `
      + `a redelivery is refused lock.<key> until ${timing.lockTtlMs}ms after its `
      + `holder dies, and the budget reaches ${takeover.atMs}ms on delivery `
      + `${takeover.delivery} while the poison guard resolves the task on delivery `
      + `${poisonDeliveryOf(timing.maxDeliver)}: a dead pod's run is discarded `
      + "rather than resumed from its checkpoint, whatever the reaper does",
    );
    return problems;
  }
  if (verdictMs < takeover.atMs + timing.sweeperTickMs) {
    problems.push(
      `the reaper's verdict at ${verdictMs}ms preempts the takeover a redelivery `
      + `can first attempt at ${takeover.atMs}ms (lock.<key> lives lockTtlMs=`
      + `${timing.lockTtlMs}ms after its holder dies): the run would be closed as `
      + "worker_lost while it was still resumable",
    );
  }
  return problems;
}
