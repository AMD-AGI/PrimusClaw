// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * When the EnvD jobs probe is allowed to destroy a sandbox.
 *
 * One reading of the jobs roster used to be enough: a probe that answered
 * "0 user processes" past the reuse window, or one that answered from a new
 * EnvD/Pod identity, destroyed the sandbox on the spot. A restart of the node
 * agent under the sandbox runtime breaks the data path for a moment and the
 * first answer after it can be exactly that -- an empty roster, or a new
 * instance id -- while the user's processes are still running. Sandboxes with
 * hundreds of live processes were destroyed on the probe right after an EOF.
 *
 * So the probe now has to agree with itself. A destructive reading is recorded
 * on the hands record (sweeps run on whichever Brain replica holds the tick, so
 * process memory cannot carry a count) and acted on only once:
 *
 *   - the same reading was made on `SANDBOX_RECLAIM_CONFIRM_SWEEPS` consecutive
 *     sweeps of the same sandbox and idle period, readings less than half a
 *     sweep apart counting once, and
 *   - no probe failed and no probe saw a positive count within
 *     `SANDBOX_RECLAIM_QUIET_MS`.
 *
 * A contrary reading -- a positive count (from the bound instance or a new
 * one), a failed probe, a different replaced identity -- restarts the count. A workload the control plane itself reports
 * terminal or absent is not this: that answer is authoritative and is acted on
 * at once, and tracking_lost / jobs-unavailable never authorise a destroy.
 *
 * Platform confirmation of a replaced instance: neither provider's status read
 * (`SandboxStatus`) carries a Pod UID or EnvD instance id, so the control plane
 * can only confirm a replacement by reporting the workload terminal or absent,
 * which already takes the immediate path. Absent such a source the replaced
 * reading falls back to the consecutive-sweeps rule.
 */

export type ReclaimReason = "idle_empty" | "instance_replaced";

/** A run of agreeing destructive readings, bound to what they were about. */
export interface ReclaimStreak {
  reason: ReclaimReason;
  /** Sandbox identity (`entryIdentity`) the readings were made on. */
  identity: string;
  /** Idle period the readings were made in; a reactivation starts a new one. */
  idleEpoch?: number;
  /**
   * The period's `idleSince` as well: a replica on an older build reactivates
   * and re-idles a handle without touching `idleEpoch` (or this streak), and
   * `idleSince` is the one field every build's park writes anew.
   */
  idleSince?: number;
  count: number;
  firstAt: number;
  lastAt: number;
  /** Process counts observed along the streak, most recent last (bounded). */
  counts: number[];
  /** For instance_replaced: the identity the probe answered from. */
  podUidAfter?: string;
  instanceIdAfter?: string;
}

/** The fields this module owns on a hands record. */
export interface ReclaimEvidenceFields {
  reclaimStreak?: ReclaimStreak;
  /** Last time a jobs probe failed (EOF, HTTP error, timeout, tracking lost). */
  lastProbeFailureAt?: number;
  /** Last time a jobs probe saw a positive user process count. */
  lastPositiveCountAt?: number;
}

export type JobsObservation =
  | { kind: "count"; count: number }
  | {
    kind: "replaced";
    count?: number;
    podUidAfter?: string;
    instanceIdAfter?: string;
  }
  | { kind: "failure" };

export interface ObservationContext {
  identity: string;
  idleEpoch?: number;
  idleSince?: number;
  now: number;
  /** Readings closer together than this are one sweep's worth of evidence. */
  spacingMs: number;
}

const MAX_KEPT_COUNTS = 8;

/** The later of two instants, either of which may be missing. */
export function later(a: number | undefined, b: number | undefined): number | undefined {
  if (typeof a !== "number") return b;
  if (typeof b !== "number") return a;
  return Math.max(a, b);
}

/** Whether a streak was recorded in the idle period `ctx` names. */
function samePeriod(
  streak: ReclaimStreak, ctx: { idleEpoch?: number; idleSince?: number },
): boolean {
  return streak.idleEpoch === ctx.idleEpoch && streak.idleSince === ctx.idleSince;
}

function continues(
  streak: ReclaimStreak | undefined,
  reason: ReclaimReason,
  obs: JobsObservation,
  ctx: { identity: string; idleEpoch?: number; idleSince?: number },
): streak is ReclaimStreak {
  if (!streak || streak.reason !== reason || streak.identity !== ctx.identity) return false;
  if (!samePeriod(streak, ctx)) return false;
  if (obs.kind === "replaced") {
    return streak.podUidAfter === obs.podUidAfter && streak.instanceIdAfter === obs.instanceIdAfter;
  }
  return true;
}

/**
 * The evidence fields after one jobs-probe reading. Returns only the fields
 * this module owns, to be spread onto the record being written.
 */
export function applyObservation(
  prev: ReclaimEvidenceFields,
  obs: JobsObservation,
  ctx: ObservationContext,
): ReclaimEvidenceFields {
  const base: ReclaimEvidenceFields = {
    lastProbeFailureAt: prev.lastProbeFailureAt,
    lastPositiveCountAt: prev.lastPositiveCountAt,
  };
  // Evidence that only holds a destroy is merged as the later of what the
  // record already holds and this reading: a replica whose clock runs behind
  // must not pull an open quiet window shut by writing an earlier time over it.
  if (obs.kind === "failure") {
    return { ...base, lastProbeFailureAt: later(prev.lastProbeFailureAt, ctx.now), reclaimStreak: undefined };
  }
  // Live user work is contrary evidence whichever instance reports it: a
  // replaced reading with a positive count ends any streak exactly like a
  // positive count from the bound instance, so the replacement branch never
  // reclaims a sandbox whose processes are still running.
  if ((obs.count ?? 0) > 0) {
    return { ...base, lastPositiveCountAt: later(prev.lastPositiveCountAt, ctx.now), reclaimStreak: undefined };
  }
  const reason: ReclaimReason = obs.kind === "replaced" ? "instance_replaced" : "idle_empty";
  const count = obs.count ?? 0;
  const prior = prev.reclaimStreak;
  if (continues(prior, reason, obs, ctx)) {
    if (ctx.now - prior.lastAt < ctx.spacingMs) {
      // Same sweep (or a second replica in it): not new evidence.
      return { ...base, reclaimStreak: prior };
    }
    return {
      ...base,
      reclaimStreak: {
        ...prior,
        count: prior.count + 1,
        lastAt: ctx.now,
        counts: [...prior.counts, count].slice(-MAX_KEPT_COUNTS),
      },
    };
  }
  const streak: ReclaimStreak = {
    reason,
    identity: ctx.identity,
    count: 1,
    firstAt: ctx.now,
    lastAt: ctx.now,
    counts: [count],
  };
  if (ctx.idleEpoch !== undefined) streak.idleEpoch = ctx.idleEpoch;
  if (ctx.idleSince !== undefined) streak.idleSince = ctx.idleSince;
  if (obs.kind === "replaced") {
    if (obs.podUidAfter) streak.podUidAfter = obs.podUidAfter;
    if (obs.instanceIdAfter) streak.instanceIdAfter = obs.instanceIdAfter;
  }
  return { ...base, reclaimStreak: streak };
}

export type ReclaimHold = "awaiting_confirmation" | "recent_probe_failure" | "recent_positive_count";

export interface ReclaimConfirmConfig {
  sweeps: number;
  quietMs: number;
}

/** Whether the recorded evidence authorises a destroy for `reason` now. */
export function reclaimDecision(
  fields: ReclaimEvidenceFields,
  reason: ReclaimReason,
  ctx: { identity: string; idleEpoch?: number; idleSince?: number; now: number },
  cfg: ReclaimConfirmConfig,
): { allowed: true } | { allowed: false; hold: ReclaimHold } {
  const streak = fields.reclaimStreak;
  if (!streak || streak.reason !== reason || streak.identity !== ctx.identity
    || !samePeriod(streak, ctx) || streak.count < cfg.sweeps) {
    return { allowed: false, hold: "awaiting_confirmation" };
  }
  if (typeof fields.lastProbeFailureAt === "number"
    && ctx.now - fields.lastProbeFailureAt < cfg.quietMs) {
    return { allowed: false, hold: "recent_probe_failure" };
  }
  if (typeof fields.lastPositiveCountAt === "number"
    && ctx.now - fields.lastPositiveCountAt < cfg.quietMs) {
    return { allowed: false, hold: "recent_positive_count" };
  }
  return { allowed: true };
}
