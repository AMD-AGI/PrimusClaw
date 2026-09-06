// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The keepalive settings that have to hold together before any sandbox is
 * provisioned, checked once at startup rather than degraded at run time.
 *
 * Two of them are a pair with no safe middle. `SANDBOX_KEEPALIVE_INTERVAL_SEC`
 * at or below zero disables the probe-and-ping sweep outright, and
 * `BG_SHELL_ENABLED` is what makes background dispatch available at all -- so in
 * combination nothing refreshes a sandbox hosting live background work and the
 * guarantee that an active shell holds off idle reclaim is unenforceable. There
 * is no partial mode in which it holds, so the configuration is refused.
 *
 * The rest are capacity data. A ceiling nobody declared cannot be the value a
 * deferral count was proven at, and reading an undeclared one as absent would
 * license any fleet size at all against a reclaim that still happens.
 */

export interface CapacitySettings {
  ceiling: number;
  reconciliationReserve: number;
  /** Sweeps a target may wait, worst case, before it is served again. */
  deferralCount: number;
  /** Longest gap between two refreshes of one handle, in seconds. */
  activityGapSec: number;
  /**
   * How long an unrenewed roster entry is held before any replica may release
   * it. Derived rather than configured: the design pins the relation, not the
   * number.
   */
  reclaimHorizonMs: number;
}

/**
 * How many pings one sweep is guaranteed to start.
 *
 * The phase budget bars the *starting* of a ping and nothing else, so even a
 * phase whose every ping runs to its ceiling hands out this many.
 */
export function pingsPerSweep(
  concurrency: number, phaseBudgetMs: number, pingCeilingMs: number,
): number {
  return Math.max(1, concurrency * Math.ceil(phaseBudgetMs / pingCeilingMs));
}

/**
 * The worst-case gap between two refreshes of one sandbox handle.
 *
 * `(1 + D)` intervals for the ordinary cadence and each deferral, plus
 * `(2 + D)` sweep spans: one for the dropped tick, one for where inside its
 * sweep a ping falls, and one more per deferral.
 */
export function activityGapSec(
  intervalSec: number, sweepSpanSec: number, deferrals: number,
): number {
  return (1 + deferrals) * intervalSec + (2 + deferrals) * sweepSpanSec;
}

export interface CapacityInput {
  /**
   * Longest a provisioning may legitimately take -- create, bootstrap and
   * health together -- in seconds.
   *
   * The reclaim horizon has to exceed it: a slot released while its sandbox is
   * still being provisioned is a live sandbox holding none, which is the
   * un-slotted target the ceiling exists to prevent. Zero means unbounded, and
   * no horizon can exceed that.
   */
  provisioningCeilingSec: number;
  bgShellEnabled: boolean;
  keepaliveIntervalSec: number;
  /** Raw, because "declared" is the question and an empty string is not one. */
  targetCeiling: string;
  reconcileReserve: string;
  /** The shortest idle reclaim in force, which the activity gap must clear. */
  idleDeadlineSec: string;
  /** How many pings one sweep is guaranteed to start. */
  pingsPerSweep: number;
  /** A whole guarded tick's declared ceiling, in seconds. */
  sweepSpanSec: number;
  /**
   * The longest a whole guarded tick can run: the ping phase's budget plus the
   * one ping it lets start, and the failure phase's budget plus the one
   * eviction it lets start. Fleet-size independent by construction -- the
   * declared span has to cover it, or the span is a number the sweep routinely
   * exceeds and every gap derived from it is short.
   */
  pingPhaseCeilingSec: number;
}

/** Refused at startup, naming the settings and their values. */
export class KeepaliveConfigRefused extends Error {}

function requirePositiveInteger(name: string, raw: string): number {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new KeepaliveConfigRefused(
      `${name} is undeclared. It has no default: the keepalive relation is `
      + "proven against it before the sweep starts, so a number nobody declared "
      + "cannot stand in for one.",
    );
  }
  if (!/^[1-9][0-9]*$/.test(trimmed)) {
    throw new KeepaliveConfigRefused(
      `${name}=${trimmed} is not a positive integer, and is never coerced to one.`,
    );
  }
  return Number(trimmed);
}

export function validateKeepaliveCapacity(input: CapacityInput): CapacitySettings {
  if (input.bgShellEnabled && input.keepaliveIntervalSec <= 0) {
    throw new KeepaliveConfigRefused(
      `BG_SHELL_ENABLED=true with SANDBOX_KEEPALIVE_INTERVAL_SEC=${input.keepaliveIntervalSec}: `
      + "nothing would refresh a sandbox hosting live background work, so an "
      + "active shell could not hold off idle reclaim. No default interval is "
      + "substituted for the rejected one.",
    );
  }
  if (!input.bgShellEnabled) {
    return {
      ceiling: 0, reconciliationReserve: 0, deferralCount: 0,
      activityGapSec: 0, reclaimHorizonMs: 0,
    };
  }

  const ceiling = requirePositiveInteger("SANDBOX_KEEPALIVE_TARGET_CEILING", input.targetCeiling);
  const reserve = requirePositiveInteger(
    "SANDBOX_KEEPALIVE_RECONCILE_RESERVE", input.reconcileReserve,
  );
  if (reserve >= ceiling) {
    throw new KeepaliveConfigRefused(
      `SANDBOX_KEEPALIVE_RECONCILE_RESERVE=${reserve} leaves no ordinary admission `
      + `below SANDBOX_KEEPALIVE_TARGET_CEILING=${ceiling}.`,
    );
  }

  // The relation the whole ceiling exists to make provable, checked here rather
  // than assumed: at N_max targets a rotation reaches every one within
  // ceil(N_max / C) sweeps, and the gap that implies has to clear the shortest
  // reclaim in force with room to spare. Equality is a breach, not a fit.
  if (input.sweepSpanSec <= input.pingPhaseCeilingSec) {
    throw new KeepaliveConfigRefused(
      `SANDBOX_KEEPALIVE_SWEEP_SPAN_SEC=${input.sweepSpanSec} does not cover a sweep's `
      + `own worst case of ${input.pingPhaseCeilingSec}s -- the ping phase and the `
      + "failure handling that follows it, each bounded by its own budget -- so the "
      + "span every refresh gap is derived from is one the sweep routinely exceeds.",
    );
  }
  const deadline = requirePositiveInteger(
    "SANDBOX_KEEPALIVE_IDLE_DEADLINE_SEC", input.idleDeadlineSec,
  );
  const deferrals = Math.max(0, Math.ceil(ceiling / Math.max(1, input.pingsPerSweep)) - 1);
  const gap = activityGapSec(input.keepaliveIntervalSec, input.sweepSpanSec, deferrals);
  if (gap >= deadline) {
    throw new KeepaliveConfigRefused(
      `these settings cannot keep a sandbox alive: at SANDBOX_KEEPALIVE_TARGET_CEILING`
      + `=${ceiling} a handle waits up to ${deferrals} deferral(s), so two refreshes of `
      + `one handle can be ${gap}s apart, which is not under the ${deadline}s reclaim in `
      + `force (SANDBOX_KEEPALIVE_IDLE_DEADLINE_SEC). Lower the ceiling or the interval, `
      + `or declare a longer deadline.`,
    );
  }
  // The design pins the relation rather than the value: the horizon must exceed
  // both one sweep span and the declared provisioning ceiling, so that neither
  // a slow sweeper nor a slow but live provisioning loses its reservation.
  // Derived from them so it cannot drift out of that relation by being tuned.
  if (input.provisioningCeilingSec <= 0) {
    throw new KeepaliveConfigRefused(
      "the provisioning ceiling is unbounded (SANDBOX_POLL_TIMEOUT_MS=0), so no "
      + "reclaim horizon can exceed it and a slot could be released while its "
      + "sandbox is still being provisioned. Set a finite ceiling.",
    );
  }
  const reclaimHorizonMs = (Math.max(input.provisioningCeilingSec, input.sweepSpanSec) + gap) * 1000;
  return {
    ceiling, reconciliationReserve: reserve, deferralCount: deferrals, activityGapSec: gap,
    reclaimHorizonMs,
  };
}
