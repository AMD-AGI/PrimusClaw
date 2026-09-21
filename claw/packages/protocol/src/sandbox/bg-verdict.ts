// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The background-work verdict a sandbox's `hands.<session>` entry carries, and
 * the single rule for deciding whether it is still about the idle period the
 * handle is in now.
 *
 * Here rather than inside Brain's keepalive sweep because there are now two
 * readers of the same bytes and one writer, in three different processes:
 *
 *   - Brain's keepalive sweep writes the verdict (`persistVerdict`) and reads
 *     it back on every later sweep, on this replica or any other.
 *   - Brain's `applyRunEndedIdleFields`, in the module beside this one, opens a
 *     new idle period and must clear exactly the fields the rule below reads --
 *     a field it forgets is a previous period's answer republished as if it
 *     were about this one.
 *   - The API's orphan-handle sweep reads it before it stops a workload whose
 *     DAG is over, because the session may still be carrying background shells
 *     that nothing else records.
 *
 * The obvious shortcut for that third reader is `bgRunning > 0`. It is wrong,
 * and wrong in the direction that loses a user's work in the OTHER direction
 * too: `bgRunning` is a measurement taken during some idle period, and a
 * verdict from a PREVIOUS one says nothing about this one. Read on its own it
 * both keeps sandboxes that are long since empty and -- once a stale `0` is
 * believed -- releases one with live shells in it. The freshness rules
 * (`BG_VERDICT_TTL_MS`, `sameIdlePeriod`, `measuredUnderThisIdlePeriod`) are
 * what make the number mean anything, so they travel with it: a second copy of
 * this predicate drifting from the first is the exact shape of defect this
 * repository has already shipped once.
 *
 * Nothing here talks to a store. It is a pure reading of fields a caller has
 * already fetched, so both readers can be tested without NATS.
 */

/**
 * What a probe of Hands' background-shell registry can tell us.
 * Only positive idle or gone evidence may permit reclaim.
 */
export type BackgroundWork = "running" | "idle" | "gone" | "unknown";

/**
 * Shared verdict lifetime. It must outlive the interval between fleet sweeps of
 * the same handle, while local probing still refreshes every BG_PROBE_TTL_MS.
 */
export const BG_VERDICT_TTL_MS = 30 * 60_000;

/**
 * The fields one published verdict is made of, as a set.
 *
 * Every writer that invalidates a verdict has to remove all of them together: a
 * leftover `bgRunning` beside a cleared `bgCheckedAt` reads as no verdict here,
 * but a leftover `bgCheckedAt` beside a cleared `bgIdleSince` reads as a
 * verdict nobody can witness. Both of those were separate literal lists in the
 * two writers before this constant existed, which is one edit away from the two
 * disagreeing about what a verdict is.
 */
export const SHARED_VERDICT_FIELDS = [
  "bgCheckedAt", "bgRunning", "bgEpoch", "bgIdleSince", "bgIdleRev", "bgRev",
] as const;

/**
 * The idle-period stamps a verdict is matched against.
 *
 * Declared here, and inherited by Brain's `HandsKvEntry`, so the writer and
 * both readers cannot disagree about the shape. Every field is optional
 * because entries written by earlier binaries carry only some of them, and
 * each rule below says what it does with an absent one.
 */
export interface IdlePeriodFields {
  /**
   * Epoch ms when the handle became idle. All deployed writers stamp this
   * field, so verdicts use it as the mixed-version idle-period witness. Its
   * absence means no idle period has been opened on this entry at all, and
   * therefore that no verdict can ever be usable about it.
   */
  idleSince?: number;
  /**
   * Epoch ms when a sweep last acted on a `running` verdict. The reuse window
   * starts at the later of this and `idleSince`.
   */
  workSeenAt?: number;
  /**
   * Identifies the idle period opened by `markHandsIdle`; unlike `idleSince`,
   * it does not move while background work remains active.
   */
  idleEpoch?: number;
  /**
   * Revision on which the idle-opening write was conditioned. Together with
   * `idleSince`, it uniquely witnesses an idle period even when timestamps
   * collide. Backfilled by `collectTargets` for older entries.
   */
  idleRev?: number;
}

/** The published verdict itself, beside the period it was measured in. */
export interface SharedVerdictFields extends IdlePeriodFields {
  /**
   * The last measured background-work answer, persisted so another replica --
   * or another service -- can consume it.
   */
  bgCheckedAt?: number;
  /** Shell count from that answer. 0 means the sandbox had nothing running. */
  bgRunning?: number;
  /**
   * The `idleEpoch` under which the verdict was measured. `bgIdleSince` also
   * has to match because an older binary can preserve both epoch fields across
   * reuse.
   */
  bgEpoch?: number;
  /**
   * The value `idleSince` had when this verdict was measured.
   *
   * Kept as a witness rather than compared as a time, because the two numbers
   * are written by different replicas off different clocks and a comparison
   * between them cannot establish which event happened first. A replica whose
   * clock runs a minute fast files a verdict stamped a minute into the future;
   * the old binary that later takes the sandbox for a task and idles it again
   * stamps `idleSince` off its own slower clock, and the verdict from BEFORE
   * the task carries the LARGER number. Every ordering test between them then
   * says the stale answer is the current one, and the handle is reclaimed with
   * a background shell in it -- the same reclaim `bgEpoch` and the stamp were
   * added to prevent, arriving through ordinary NTP-grade skew rather than
   * through anything going wrong.
   *
   * Equality asks a question skew cannot answer wrongly. Absent on verdicts
   * written before this field existed, which are read as not witnessed at all.
   */
  bgIdleSince?: number;
  /**
   * The `idleRev` the entry carried when this verdict was measured.
   *
   * The half of the witness that cannot collide. `bgIdleSince` catches an idle
   * period an OLD binary opened -- it rewrites `idleSince` and can write
   * neither of these -- but two distinct periods can share an `idleSince`
   * value, and when they do they share `idleEpoch` with it, so nothing else on
   * the entry tells them apart. This one does: no two idle-opening writes to a
   * key are conditioned on the same revision.
   */
  bgIdleRev?: number;
  /**
   * The revision the write that published this verdict was conditioned on.
   *
   * Names the verdict itself, the way `idleRev` names an idle period and for
   * the same reason: the bucket accepts one write per revision of a key and
   * hands out a strictly greater one each time, so no two verdict-publishing
   * writes can ever carry the same value.
   */
  bgRev?: number;
}

/**
 * Whether a verdict is still about the idle period the handle is in now.
 * Missing epochs are not a match; they remain `unknown` until backfilled and
 * measured.
 */
export function sameIdlePeriod(
  verdictEpoch: number | undefined, info: IdlePeriodFields,
): boolean {
  return typeof verdictEpoch === "number" && verdictEpoch === info.idleEpoch;
}

/**
 * Whether a verdict measured at `at`, under the stamp `witness`, can be about
 * the idle period the handle is in now.
 *
 * During a rolling deployment, an older binary rewrites `idleSince` but carries
 * the epoch fields unchanged. The timestamp witness therefore detects its idle
 * periods even when the epochs still match.
 *
 * Idle verdicts require equality with both witnesses: timestamp equality avoids
 * ordering clocks from different replicas, and revision equality prevents a
 * same-millisecond ABA. Together they leave exactly one gap: an old binary
 * re-idling onto the identical millisecond, which leaves an entry
 * byte-identical to the one it found, and which therefore no rule reading the
 * entry can detect. It closes when the old binary is gone, and nothing on the
 * entry can close it sooner.
 *
 * `running` also accepts the older rule, `at` at or after the stamp. It is a
 * weaker test and it is allowed to be, because the two ways it can be wrong are
 * both safe: believing a stale `running` costs a ping the sandbox did not need,
 * and disbelieving a current one costs a probe. Keeping it means the sweep that
 * slides the stamp forward under a working sandbox does not have to re-witness
 * the verdict it just acted on -- which would amount to relabelling an answer as
 * being about a period it was not measured in -- and means a verdict written by
 * the build before this field existed still keeps a busy sandbox pinged while it
 * ages out. The `idle` branch, the only one that can delete anything, gets no
 * such latitude.
 *
 * A rejected or incomplete witness reads as `unknown`, so the handle is kept and
 * probed again.
 */
export function measuredUnderThisIdlePeriod(
  at: number | undefined,
  witness: number | undefined,
  witnessRev: number | undefined,
  info: IdlePeriodFields,
  state: BackgroundWork,
): boolean {
  if (typeof info.idleSince !== "number") return false;
  if (
    typeof witness === "number" && witness === info.idleSince
    && typeof witnessRev === "number" && witnessRev === info.idleRev
  ) return true;
  if (state !== "running") return false;
  return typeof at === "number" && at >= info.idleSince;
}

/**
 * The reuse window starts at the later of the idle-period opening and the last
 * sweep that observed work.
 */
export function reuseWindowStart(info: IdlePeriodFields): number {
  return Math.max(
    typeof info.idleSince === "number" ? info.idleSince : 0,
    typeof info.workSeenAt === "number" ? info.workSeenAt : 0,
  );
}

/**
 * The handle's own copy of the verdict, which any replica -- or the API -- can
 * read, under the two rules above and its own longer TTL.
 *
 * `running` is the shell count the measurement found, carried out rather than
 * reduced to a boolean so a caller can report the number it is holding a
 * sandbox for. `null` is "this entry establishes nothing about background work
 * right now", which is NOT the same answer as `idle` and must never be
 * collapsed into one: `idle` was measured, `null` was not.
 */
export function usableSharedVerdict(
  info: SharedVerdictFields, now: number = Date.now(),
): { at: number; state: "running" | "idle"; running: number } | null {
  if (typeof info.bgCheckedAt !== "number" || typeof info.bgRunning !== "number") return null;
  if (now - info.bgCheckedAt >= BG_VERDICT_TTL_MS) return null;
  if (!sameIdlePeriod(info.bgEpoch, info)) return null;
  const state = info.bgRunning > 0 ? "running" : "idle";
  if (!measuredUnderThisIdlePeriod(
    info.bgCheckedAt, info.bgIdleSince, info.bgIdleRev, info, state,
  )) return null;
  return { at: info.bgCheckedAt, state, running: info.bgRunning };
}
