// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { StringCodec, type KV } from "nats";
import { isRevisionConflict } from "@claw/utils";
import { applyRunEndedIdleFields, type RunEndedParkResult } from "@claw/protocol";
import {
  SANDBOX_KEEPALIVE_INTERVAL_SEC,
  SANDBOX_KEEPALIVE_FAIL_LIMIT,
  SANDBOX_IDLE_REUSE_MS,
  BRAIN_REGISTRY_TTL_MS,
} from "../config.js";
import { clearRetryPending, getRetryPending, isRetryPendingExpired } from "../tasks/retry-pending.js";
import { destroyHands } from "./reaper.js";
import { sessionHasActiveRunLease } from "./registry.js";
import { getAgentSandboxProvider, getSafeWorkloadProvider } from "./factory.js";
import { countActiveShells } from "../clients/hands.js";
import pino from "pino";

const logger = pino({ name: "sandbox-keepalive" });
const sc = StringCodec();

/** Minimal info needed by keepalive to ping a sandbox. */
export interface SandboxEntry {
  /** undefined / "safe-workload": SaFE path; "agent-sandbox": kubernetes path. */
  provider?: "safe-workload" | "agent-sandbox";
  workloadId?: string;   // safe-workload
  platformKey?: string;  // safe-workload
  sessionId?: string;    // agent-sandbox
  sandboxName?: string;  // agent-sandbox
  namespace?: string;
  userId?: string;       // agent-sandbox: BYOK identity forwarded to the Router
}

interface HandsKvEntry {
  status?: "pending" | "ready";
  provider?: "safe-workload" | "agent-sandbox";
  workloadId?: string;
  sessionId?: string;
  sandboxName?: string;
  handsUrl: string;
  sandboxImage?: string | null;
  platformKey?: string;
  token?: string;
  namespace?: string;
  userId?: string;
  createdAt?: string;
  /**
   * The key the run lease is under: the DAG root when the run has one, the
   * session otherwise. Absent on entries written before it was recorded, and
   * the readers fall back to the session for those.
   */
  runScope?: string;
  /** False on a post-task idle reuse handle: kept for reuse but NOT pinged so
   *  the pod idles out via the control-plane GC. Set by stopKeepaliveAfterTask. */
  keepalive?: boolean;
  /**
   * Epoch ms when the handle became idle. All deployed writers stamp this field,
   * so verdicts use it as the mixed-version idle-period witness.
   */
  idleSince?: number;
  /**
   * Epoch ms when a sweep last acted on a `running` verdict. The reuse window
   * starts at the later of this and `idleSince`.
   */
  workSeenAt?: number;
  /**
   * Identifies the idle period opened by `markHandsIdle`; unlike `idleSince`, it
   * does not move while background work remains active.
   */
  idleEpoch?: number;
  /**
   * Revision on which the idle-opening write was conditioned. Together with
   * `idleSince`, it uniquely witnesses an idle period even when timestamps
   * collide. Backfilled by `collectTargets` for older entries.
   */
  idleRev?: number;
  /**
   * Per-call token used to confirm an idle write whose acknowledgement was lost.
   * The sweep does not use it.
   */
  idleWriter?: string;
  /**
   * The last measured background-work answer, persisted so another replica can
   * consume it.
   */
  bgCheckedAt?: number;
  /** Shell count from that answer. 0 means the sandbox had nothing running. */
  bgRunning?: number;
  /**
   * The `idleEpoch` under which the verdict was measured. `bgIdleSince` also has
   * to match because an older binary can preserve both epoch fields across reuse.
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
   * stamps `idleSince` off its own slower clock, and the verdict from BEFORE the
   * task carries the LARGER number. Every ordering test between them then says
   * the stale answer is the current one, and the handle is reclaimed with a
   * background shell in it -- the same reclaim `bgEpoch` and the stamp were
   * added to prevent, arriving through ordinary NTP-grade skew rather than
   * through anything going wrong.
   *
   * Equality asks a question skew cannot answer wrongly. `idleSince` is opaque
   * here: whether the value a re-idle wrote is larger or smaller than the one
   * the verdict was measured under does not matter, only that it is a different
   * value -- and it is, because every writer that opens an idle period stamps
   * its own clock's reading of the moment it did so. Absent on verdicts written
   * before this field existed, which are read as not witnessed at all.
   */
  bgIdleSince?: number;
  /**
   * The `idleRev` the entry carried when this verdict was measured.
   *
   * The half of the witness that cannot collide. `bgIdleSince` catches an idle
   * period an OLD binary opened -- it rewrites `idleSince` and can write neither
   * of these -- but two distinct periods can share an `idleSince` value, and
   * when they do they share `idleEpoch` with it, so nothing else on the entry
   * tells them apart. This one does: no two idle-opening writes to a key are
   * conditioned on the same revision.
   *
   * Both must match for an `idle` verdict to be believed, because neither
   * subsumes the other: an old binary carries this field across a task
   * untouched, and a millisecond collision carries the other one across.
   * Absent on verdicts written before this field existed, which are read as not
   * witnessed at all.
   */
  bgIdleRev?: number;
  /**
   * The revision the write that published this verdict was conditioned on.
   *
   * Names the verdict itself, the way `idleRev` names an idle period and for the
   * same reason: the bucket accepts one write per revision of a key and hands
   * out a strictly greater one each time, so no two verdict-publishing writes
   * can ever carry the same value. `bgCheckedAt` cannot do this on its own --
   * it is a clock reading taken on whichever replica probed, and two replicas
   * can read the same millisecond.
   *
   * Read by persistVerdict, to tell the verdict a probe went out under from one
   * a different replica published while that probe was still in the air. Absent
   * on verdicts written before this field existed, where the stamp beside it is
   * the only half of the comparison available.
   */
  bgRev?: number;
  /**
   * Fleet-visible probe reservations, keyed by per-probe token. Reclaim waits
   * while any unexpired reservation remains; each probe releases only its token.
   */
  bgProbes?: Record<string, number>;
  /** True on a handle parked by a session delete rather than by a finished task.
   *  The multi-node sweep reclaims these without waiting out the idle window,
   *  there being no next message to hold a cluster for. Set by parkHandsHandle. */
  sessionDeleted?: boolean;
}

interface KeepaliveDeps {
  kv: KV;
  /** Test seam for the background-work probe. */
  countActiveShells?: (url: string, token: string, owner: string) => Promise<number>;
  /** Test seam for the ping-phase budget. */
  pingBudgetMs?: number;
}

let timer: ReturnType<typeof setInterval> | null = null;
/** Guards both the startup sweep and interval sweeps from overlap. */
let sweeping = false;
const failCounts = new Map<string, number>();

// ── In-memory registry: the primary source of truth for active sandboxes ──
// Brain itself creates these sandboxes — it knows about them without
// needing to discover them through NATS KV. NATS KV is only used as a
// secondary source to recover sessions that survived a Brain restart.
interface RegisteredSandbox {
  sessionId: string;
  entry: SandboxEntry;
}

const localRegistry = new Map<string, RegisteredSandbox>();

function sandboxRegistryKey(sessionId: string, entry: SandboxEntry): string {
  return entry.provider === "agent-sandbox"
    ? `${sessionId}:agent:${entry.sessionId || ""}:${entry.namespace || ""}:${entry.sandboxName || ""}`
    : `${sessionId}:safe:${entry.workloadId || ""}`;
}

/**
 * The sandbox identity a KV entry names.
 * A session key may point to different pods over time, so probe results are
 * matched against this identity before being persisted.
 */
function entryIdentity(sessionId: string, info: HandsKvEntry): string {
  return sandboxRegistryKey(sessionId, {
    provider: info.provider === "agent-sandbox" ? "agent-sandbox" : "safe-workload",
    workloadId: info.workloadId,
    sessionId: info.sessionId,
    sandboxName: info.sandboxName,
    namespace: info.namespace,
  });
}

/** Drop orphaned READY sandboxes when a retryable attempt was never redelivered. */
async function shouldSkipExpiredRetry(
  deps: KeepaliveDeps,
  sessionId: string,
  source: "local" | "kv",
  entry?: SandboxEntry,
): Promise<boolean> {
  const pending = await getRetryPending(deps.kv, sessionId);
  const nowMs = Date.now();
  if (!pending || !isRetryPendingExpired(pending, nowMs)) return false;
  const lockKey = pending.lockKey || sessionId;
  const activeLock = await deps.kv.get(`lock.${lockKey}`).catch(() => null);
  if (activeLock) {
    logger.warn(
      {
        sessionId,
        source,
        lockKey,
        attempt: pending.attempt,
        messageId: pending.messageId,
        reasonClass: pending.reasonClass,
        workloadId: entry?.workloadId || pending.workloadId,
        deadlineMs: pending.deadlineMs,
        deadlineIso: new Date(pending.deadlineMs).toISOString(),
      },
      "keepalive.retry_pending_expired_but_lock_active",
    );
    return false;
  }

  unregisterSandbox(sessionId, entry);
  await deps.kv.delete(`hands.${sessionId}`).catch(() => {});
  await clearRetryPending(deps.kv, sessionId, pending.lockKey);
  logger.warn(
    {
      sessionId,
      source,
      attempt: pending.attempt,
      messageId: pending.messageId,
      lockKey,
      reasonClass: pending.reasonClass,
      reason: pending.reason,
      workloadId: entry?.workloadId || pending.workloadId,
      graceSec: pending.graceSec,
      ageMs: nowMs - pending.createdAtMs,
      createdAtMs: pending.createdAtMs,
      createdAtIso: new Date(pending.createdAtMs).toISOString(),
      deadlineMs: pending.deadlineMs,
      deadlineIso: new Date(pending.deadlineMs).toISOString(),
      expiredByMs: nowMs - pending.deadlineMs,
    },
    "keepalive.retry_pending_expired",
  );
  return true;
}

/** Register a sandbox for keepalive pinging. Called by ensureHands. */
export function registerSandbox(sessionId: string, entry: SandboxEntry): void {
  const key = sandboxRegistryKey(sessionId, entry);
  // A new task invalidates verdicts measured before it took the sandbox.
  forgetBackgroundWork(key);
  localRegistry.set(key, { sessionId, entry });
  logger.info({ sessionId, workloadId: entry.workloadId }, "keepalive.registered");
}

function sameRegisteredSandbox(a: SandboxEntry, b: SandboxEntry): boolean {
  const aAgent = a.provider === "agent-sandbox";
  const bAgent = b.provider === "agent-sandbox";
  if (aAgent !== bAgent) return false;
  return aAgent
    ? !!(
      a.sessionId
      && a.sessionId === b.sessionId
      && a.sandboxName
      && a.sandboxName === b.sandboxName
      && (a.namespace || "") === (b.namespace || "")
    )
    : !!(a.workloadId && a.workloadId === b.workloadId);
}

/**
 * Unregister a sandbox. With `known`, only remove that exact registration;
 * a DAG sibling may have replaced the session-keyed local entry meanwhile.
 */
export function unregisterSandbox(sessionId: string, known?: SandboxEntry): void {
  const keys = known
    ? [sandboxRegistryKey(sessionId, known)]
    : [...localRegistry.entries()]
      .filter(([, value]) => value.sessionId === sessionId)
      .map(([key]) => key);
  let had = false;
  for (const key of keys) {
    had = localRegistry.delete(key) || had;
    failCounts.delete(key);
  }
  if (had) {
    logger.info({ sessionId }, "keepalive.unregistered");
  }
}

/** Number of locally active sandbox identities for a session. */
export function registeredSandboxCount(sessionId: string): number {
  let count = 0;
  for (const registered of localRegistry.values()) {
    if (registered.sessionId === sessionId) count++;
  }
  return count;
}

/**
 * Resolve an unacknowledged idle update by matching its per-call writer token.
 * A matching revision with another token means a concurrent park superseded it.
 */
async function idleWriteOutcome(
  kv: KV,
  kvKey: string,
  witness: string,
  revision: number,
): Promise<"parked" | "superseded" | "unverified"> {
  try {
    const latest = await kv.get(kvKey);
    if (!latest) return "unverified";
    const info = JSON.parse(sc.decode(latest.value)) as HandsKvEntry;
    if (info.idleWriter === witness) return "parked";
    return info.idleRev === revision ? "superseded" : "unverified";
  } catch {
    return "unverified";
  }
}

/**
 * Mark a READY `hands.<sid>` entry idle (keepalive:false) so it is kept as a
 * reuse handle but no longer pinged. The promise reports failures rather than
 * rejecting, and unreadable ownership entries are preserved.
 */
export function markHandsIdle(
  kv: KV,
  sessionId: string,
  known: SandboxEntry | string,
): Promise<RunEndedParkResult> {
  const kvKey = `hands.${sessionId}`;
  return kv.get(kvKey)
    .then(async (entry): Promise<RunEndedParkResult> => {
      if (!entry) return { outcome: "gone" };
      let info: HandsKvEntry;
      try {
        info = JSON.parse(sc.decode(entry.value)) as HandsKvEntry;
      } catch (err) {
        // Preserve unreadable ownership data for repair or natural TTL expiry.
        logger.warn(
          { err: (err as Error)?.message || String(err), sessionId },
          "hands.mark_idle_unreadable",
        );
        return { outcome: "skipped", reason: "unreadable" };
      }
      // Only keep a READY handle that still points at the workload we ran on.
      if (info.status !== "ready") return { outcome: "skipped", reason: "not_ready" };
      const sameTarget = typeof known === "string"
        ? !(known && info.workloadId && info.workloadId !== known)
        : sameRegisteredSandbox(known, info);
      if (!sameTarget) return { outcome: "skipped", reason: "other_sandbox" };

      // Verdicts measured while the task held the sandbox cannot cross re-idling.
      forgetBackgroundWork(sandboxRegistryKey(sessionId, {
        provider: info.provider === "agent-sandbox" ? "agent-sandbox" : "safe-workload",
        workloadId: info.workloadId,
        sessionId: info.sessionId,
        sandboxName: info.sandboxName,
        namespace: info.namespace,
      }));

      // All run-ended parkers must open idle periods with the same field set.
      applyRunEndedIdleFields(
        info as unknown as Record<string, unknown>,
        Date.now(),
        entry.revision,
      );
      // Conditional update prevents resurrecting a concurrently deleted handle.
      const witness = nextEntryToken();
      info.idleWriter = witness;
      try {
        await kv.update(kvKey, sc.encode(JSON.stringify(info)), entry.revision);
      } catch (err) {
        if (isRevisionConflict(err)) throw err;
        const landed = await idleWriteOutcome(kv, kvKey, witness, entry.revision);
        if (landed === "unverified") throw err;
        logger.info({ sessionId, landed }, "hands.mark_idle_ack_lost");
        return { outcome: landed };
      }
      return { outcome: "parked" };
    })
    .catch((err): RunEndedParkResult => {
      if (isRevisionConflict(err)) {
        // Deleted or rewritten while we were deciding; whoever did it wins.
        logger.info({ sessionId }, "hands.mark_idle_superseded");
        return { outcome: "superseded" };
      }
      logger.warn({ err: err?.message || String(err), sessionId }, "hands.mark_idle_failed");
      return { outcome: "failed", error: err };
    });
}

/**
 * What a probe of Hands' background-shell registry can tell us.
 * `unknown` must keep the sandbox; only a measured `idle` may permit reclaim.
 */
type BackgroundWork = "running" | "idle" | "unknown";

/** Local measured-verdict reuse interval. */
const BG_PROBE_TTL_MS = 5 * 60_000;

/**
 * Consecutive failures tolerated before inferring idle. A transient failure
 * keeps the sandbox, while a permanently unreachable one is eventually released.
 */
const BG_UNKNOWN_TOLERANCE = 5;
/**
 * Shared verdict lifetime. It must outlive the interval between fleet sweeps of
 * the same handle, while local probing still refreshes every BG_PROBE_TTL_MS.
 */
const BG_VERDICT_TTL_MS = 30 * 60_000;

/**
 * Failed-probe streak lifetime. It must cover the interval until the same replica
 * revisits an identity, which can span several fleet rotations.
 */
const BG_UNKNOWN_STREAK_TTL_MS = 4 * 60 * 60_000;

/**
 * Local inferred-idle lifetime. It shares the streak horizon so the same replica
 * can act on it, but `needsProbe` still retries at BG_PROBE_TTL_MS.
 */
const BG_GIVEUP_TTL_MS = BG_UNKNOWN_STREAK_TTL_MS;

/**
 * Fleet probe concurrency cap per replica. Deferred candidates remain `unknown`
 * and are rotated into later sweeps.
 */
const BG_PROBE_MAX_IN_FLIGHT = 8;

/**
 * Reservation deadline for a probe and its verdict write. It is shorter than
 * the probe cadence so abandoned reservations cannot defer reclaim indefinitely.
 */
const BG_PROBE_RESERVE_MS = 60_000;

/**
 * Conditional-write retries for publishing a probe reservation. Exhaustion
 * leaves the handle `unknown` and defers the probe to a later sweep.
 */
const BG_PROBE_RESERVE_ATTEMPTS = 8;

/**
 * Retry ceiling for a `running` verdict that loses conditional updates. Running
 * must outlast concurrent idle writes, but a persistent store fault stays bounded.
 */
const BG_VERDICT_WRITE_ATTEMPTS = 64;

/**
 * Ping concurrency cap. Unlike probes, pings are queued rather than skipped.
 */
const PING_MAX_IN_FLIGHT = 16;
/**
 * Cutoff for starting pings in one sweep. Deferred targets retain their renewed
 * record and lead the next rotated sweep.
 */
const PING_PHASE_BUDGET_MS = Math.max(1_000, Math.floor(BRAIN_REGISTRY_TTL_MS / 2));
/** Where the last sweep stopped handing out pings. */
let pingCursor = 0;


/** Keyed by sandbox identity, not by session: see refreshBackgroundWork. */
const bgProbeCache = new Map<
  string,
  {
    at: number; state: BackgroundWork; epoch?: number; idleSince?: number; idleRev?: number;
    /** The give-up path inferred this verdict rather than measuring it. */
    inferred?: boolean;
    /**
     * A later probe also failed, so reclaim may act on an aged inference instead
     * of indefinitely deferring for another retry.
     */
    retested?: boolean;
  }
>();

/** How long this particular cached answer may be reused. */
function cachedVerdictTtlMs(cached: { inferred?: boolean }): number {
  return cached.inferred ? BG_GIVEUP_TTL_MS : BG_PROBE_TTL_MS;
}
const bgUnknownStreak = new Map<string, { count: number; at: number }>();
const bgProbeInFlight = new Set<string>();
/**
 * Bumped whenever an in-flight answer becomes obsolete. Probes discard results
 * whose captured generation no longer matches.
 */
const bgGeneration = new Map<string, number>();
/** Where the last sweep stopped handing out probe slots. */
let bgProbeCursor = 0;

/**
 * Drop the cached verdict for one sandbox identity, and invalidate any answer
 * still in the air about it.
 * Unknown streaks have their own lifetime and are cleared by success or age.
 */
function forgetBackgroundWork(identity: string): void {
  bgProbeCache.delete(identity);
  bgGeneration.set(identity, (bgGeneration.get(identity) ?? 0) + 1);
}

/** Sizes of the background-work bookkeeping, so a leak in it can be asserted. */
export function backgroundWorkStateSizesForTest(): {
  cache: number; streaks: number; generations: number; inFlight: number;
} {
  return {
    cache: bgProbeCache.size,
    streaks: bgUnknownStreak.size,
    generations: bgGeneration.size,
    inFlight: bgProbeInFlight.size,
  };
}

/** Clear module-level probe bookkeeping for isolated tests. */
export function resetBackgroundWorkStateForTest(): void {
  bgProbeCache.clear();
  bgUnknownStreak.clear();
  bgProbeInFlight.clear();
  bgGeneration.clear();
  bgProbeCursor = 0;
}

/** Age cached verdicts and unknown streaks by `ms` for reap tests. */
export function ageBackgroundWorkCacheForTest(ms: number): void {
  for (const [identity, cached] of bgProbeCache) {
    bgProbeCache.set(identity, { ...cached, at: cached.at - ms });
  }
  for (const [identity, streak] of bgUnknownStreak) {
    bgUnknownStreak.set(identity, { ...streak, at: streak.at - ms });
  }
}

/**
 * Per-tick aggregate counters. They expose whether idle handles are progressing
 * toward measured verdicts and reclaim without per-handle log volume.
 */
interface TickStats {
  /** Idle handles by background-work answer. */
  bgRunning: number; bgUnknown: number; bgIdle: number;
  /** Where those answers came from; see VerdictSource. */
  fromMem: number; fromHandle: number; fromNone: number; fromNoHands: number;
  /** What happened to the handles answered `idle`. */
  expired: number; withinWindow: number; keptLocal: number; keptRunLease: number;
  /** Reclaims deferred because a probe about the handle was still outstanding. */
  keptProbe: number;
  /** Probes this tick actually started; candidates over the cap are not counted. */
  probes: number;
}

function newTickStats(): TickStats {
  return {
    bgRunning: 0, bgUnknown: 0, bgIdle: 0,
    fromMem: 0, fromHandle: 0, fromNone: 0, fromNoHands: 0,
    expired: 0, withinWindow: 0, keptLocal: 0, keptRunLease: 0, keptProbe: 0,
    probes: 0,
  };
}

/** Where a verdict came from, for the tick counters. */
type VerdictSource = "mem" | "handle" | "none" | "no-hands";

/**
 * Whether a verdict is still about the idle period the handle is in now.
 * Missing epochs are not a match; they remain `unknown` until backfilled and
 * measured.
 */
function sameIdlePeriod(verdictEpoch: number | undefined, info: HandsKvEntry): boolean {
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
 * same-millisecond ABA. Together they leave exactly one gap: an old binary re-idling
 * onto the identical millisecond, which leaves an entry byte-identical to the
 * one it found, and which therefore no rule reading the entry can detect. It
 * closes when the old binary is gone, and nothing on the entry can close it
 * sooner.
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
function measuredUnderThisIdlePeriod(
  at: number | undefined,
  witness: number | undefined,
  witnessRev: number | undefined,
  info: HandsKvEntry,
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
function reuseWindowStart(info: HandsKvEntry): number {
  return Math.max(
    typeof info.idleSince === "number" ? info.idleSince : 0,
    typeof info.workSeenAt === "number" ? info.workSeenAt : 0,
  );
}

/** This replica's own last answer, if it is fresh enough to reuse and still
 *  about the idle period the handle is in. */
function usableCachedVerdict(
  identity: string,
  info: HandsKvEntry,
): { at: number; state: BackgroundWork; inferred?: boolean; retested?: boolean } | null {
  const cached = bgProbeCache.get(identity);
  if (!cached) return null;
  if (Date.now() - cached.at >= cachedVerdictTtlMs(cached)) return null;
  if (!sameIdlePeriod(cached.epoch, info)) return null;
  // Another replica can reactivate the handle without bumping this process's generation.
  if (!measuredUnderThisIdlePeriod(
    cached.at, cached.idleSince, cached.idleRev, info, cached.state,
  )) return null;
  return cached;
}

/** The handle's own copy, which any replica can read, under the same two rules
 *  and its own longer TTL. */
function usableSharedVerdict(info: HandsKvEntry): { at: number; state: BackgroundWork } | null {
  if (typeof info.bgCheckedAt !== "number" || typeof info.bgRunning !== "number") return null;
  if (Date.now() - info.bgCheckedAt >= BG_VERDICT_TTL_MS) return null;
  if (!sameIdlePeriod(info.bgEpoch, info)) return null;
  const state: BackgroundWork = info.bgRunning > 0 ? "running" : "idle";
  if (!measuredUnderThisIdlePeriod(
    info.bgCheckedAt, info.bgIdleSince, info.bgIdleRev, info, state,
  )) return null;
  return { at: info.bgCheckedAt, state };
}

/**
 * Whether an idle handle's sandbox still has background work running in it.
 *
 * Background shells are owned by the session, not `runScope`. Handles without
 * probe credentials retain the legacy idle behavior.
 */
function peekBackgroundWork(
  identity: string,
  info: HandsKvEntry,
): { state: BackgroundWork; source: VerdictSource; at?: number } {
  if (!info.handsUrl || !info.token) return { state: "idle", source: "no-hands" };
  // An aged inference must survive one failed re-test before it can permit reclaim.
  const local = usableCachedVerdict(identity, info);
  const beingReasked = !!local?.inferred && !local.retested
    && Date.now() - local.at >= BG_PROBE_TTL_MS;
  const cached = beingReasked ? null : local;
  const shared = usableSharedVerdict(info);
  // Cross-replica timestamps are not ordered. `running` therefore wins any
  // disagreement; when both say `running`, the later stamp only advances an anchor.
  if (cached?.state === "running" && shared?.state === "running") {
    return cached.at >= shared.at
      ? { state: "running", source: "mem", at: cached.at }
      : { state: "running", source: "handle", at: shared.at };
  }
  if (cached?.state === "running") return { state: "running", source: "mem", at: cached.at };
  if (shared?.state === "running") return { state: "running", source: "handle", at: shared.at };
  // Any remaining verdict is `idle`; the source matters only for stats.
  if (cached) return { state: cached.state, source: "mem", at: cached.at };
  if (shared) return { state: shared.state, source: "handle", at: shared.at };
  return { state: "unknown", source: "none" };
}

/** Whether this sandbox identity needs a new background-work probe. */
function needsProbe(identity: string, info: HandsKvEntry): boolean {
  if (!info.handsUrl || !info.token) return false;
  // A verdict from another idle period cannot suppress a fresh probe.
  const cached = usableCachedVerdict(identity, info);
  // Inferred verdicts remain readable longer than they suppress probing.
  if (cached && Date.now() - cached.at < BG_PROBE_TTL_MS) return false;
  return !bgProbeInFlight.has(identity);
}

/**
 * Fleet-unique token for probe reservations and idle-write acknowledgement.
 */
const entryTokenPrefix = Math.random().toString(36).slice(2, 10);
let entryTokenSeq = 0;
function nextEntryToken(): string {
  entryTokenSeq += 1;
  return `${entryTokenPrefix}${entryTokenSeq.toString(36)}`;
}

/**
 * The reservations on an entry that have not timed out, pruned on the way past.
 * Writers prune expired tokens whenever they touch the map.
 */
function liveProbeReservations(info: HandsKvEntry, now: number): Record<string, number> {
  const live: Record<string, number> = {};
  for (const [token, until] of Object.entries(info.bgProbes ?? {})) {
    if (typeof until === "number" && until > now) live[token] = until;
  }
  return live;
}

/** Whether any replica is still waiting on an answer about this handle. */
function probeOutstanding(info: HandsKvEntry): boolean {
  return Object.keys(liveProbeReservations(info, Date.now())).length > 0;
}

/**
 * Publish a probe reservation before dispatch. Conditional-write conflicts are
 * retried, and the probe proceeds only after its token is visible on the same
 * sandbox identity.
 */
async function reserveProbe(
  deps: KeepaliveDeps, sessionId: string, identity: string, token: string,
): Promise<boolean> {
  const key = `hands.${sessionId}`;
  for (let attempt = 1; attempt <= BG_PROBE_RESERVE_ATTEMPTS; attempt++) {
    try {
      const e = await deps.kv.get(key);
      if (!e) return false;
      const info = JSON.parse(sc.decode(e.value)) as HandsKvEntry;
      if (entryIdentity(sessionId, info) !== identity) return false;
      const now = Date.now();
      const bgProbes = { ...liveProbeReservations(info, now), [token]: now + BG_PROBE_RESERVE_MS };
      await deps.kv.update(key, sc.encode(JSON.stringify({ ...info, bgProbes })), e.revision);
      return true;
    } catch {
      // Re-read before retrying because the entry revision may have moved.
    }
  }
  return false;
}

/**
 * Release this probe's reservation when it settles without disturbing other
 * replicas' reservations. The deadline remains the failure backstop.
 */
async function releaseProbe(
  deps: KeepaliveDeps, sessionId: string, identity: string, token: string,
): Promise<void> {
  try {
    const key = `hands.${sessionId}`;
    const e = await deps.kv.get(key);
    if (!e) return;
    const info = JSON.parse(sc.decode(e.value)) as HandsKvEntry;
    if (entryIdentity(sessionId, info) !== identity) return;
    if (!info.bgProbes || !(token in info.bgProbes)) return;
    const bgProbes = liveProbeReservations(info, Date.now());
    delete bgProbes[token];
    const next: HandsKvEntry = { ...info, bgProbes };
    if (Object.keys(bgProbes).length === 0) delete next.bgProbes;
    await deps.kv.update(key, sc.encode(JSON.stringify(next)), e.revision);
  } catch { /* best effort: the deadline is the backstop */ }
}

/**
 * Start up to BG_PROBE_MAX_IN_FLIGHT probes, resuming where the last sweep left
 * off.
 *
 * The rotating cursor prevents timeouts early in the list from monopolizing the
 * cap. Probes run behind the sweep; pending answers leave handles `unknown`.
 */
function dispatchProbes(
  deps: KeepaliveDeps,
  candidates: Array<{
    identity: string; sessionId: string; info: HandsKvEntry; generation: number;
  }>,
): number {
  if (candidates.length === 0) return 0;
  const probe = deps.countActiveShells ?? countActiveShells;
  const start = bgProbeCursor % candidates.length;

  let started = 0;
  for (let n = 0; n < candidates.length; n++) {
    if (bgProbeInFlight.size >= BG_PROBE_MAX_IN_FLIGHT) break;
    const { identity, sessionId, info, generation } =
      candidates[(start + n) % candidates.length];
    // Capture the complete idle-period witness used to validate the answer.
    const epoch = info.idleEpoch;
    const idleSinceAtStart = info.idleSince;
    const idleRevAtStart = info.idleRev;
    // Detect a competing verdict published while this probe is in flight.
    const verdictAtStart = verdictWitness(info);
    if (bgProbeInFlight.has(identity)) continue;

    // The scan-time generation invalidates results after any intervening reuse.
    bgProbeInFlight.add(identity);
    started += 1;
    // The fleet-visible reservation must land before the probe is dispatched.
    const token = nextEntryToken();

    // Re-check after suspension points where another task can reuse the sandbox.
    const stale = () => (bgGeneration.get(identity) ?? 0) !== generation;

    void reserveProbe(deps, sessionId, identity, token)
      // Do not send an unreserved probe that another replica cannot see.
      .then((reserved) => (
        reserved ? probe(info.handsUrl!, info.token!, sessionId) : undefined
      ))
      .then(async (running) => {
        if (running === undefined) {
          logger.info(
            { sessionId, workloadId: info.workloadId },
            "keepalive.background_work_probe_unreserved",
          );
          return;
        }
        if (stale()) {
          logger.info(
            { sessionId, workloadId: info.workloadId },
            "keepalive.background_work_answer_stale",
          );
          return;
        }
        // A live registration or run lease prevents publishing an idle verdict.
        const held = localRegistry.has(identity)
          || await sessionHasActiveRunLease(deps.kv, sessionId, info.runScope).catch(() => false);

        // The lease lookup can race with reuse, so validate again before writing.
        if (stale()) {
          logger.info(
            { sessionId, workloadId: info.workloadId },
            "keepalive.background_work_answer_stale",
          );
          return;
        }
        if (held && running === 0) {
          logger.info(
            { sessionId, workloadId: info.workloadId },
            "keepalive.background_work_answer_held",
          );
          return;
        }
        const state: BackgroundWork = running > 0 ? "running" : "idle";
        bgProbeCache.set(identity, {
          at: Date.now(), state, epoch,
          idleSince: idleSinceAtStart, idleRev: idleRevAtStart,
        });
        bgUnknownStreak.delete(identity);
        // Share measured answers; inferred idle remains local to this replica.
        await persistVerdict(
          deps, sessionId, identity, running, epoch, idleSinceAtStart, idleRevAtStart,
          verdictAtStart,
        );
        if (state === "running") {
          logger.info(
            { sessionId, workloadId: info.workloadId, running },
            "keepalive.idle_handle_kept_background_work",
          );
        }
      })
      .catch((err) => {
        if (stale()) return;
        const streak = (bgUnknownStreak.get(identity)?.count ?? 0) + 1;
        bgUnknownStreak.set(identity, { count: streak, at: Date.now() });
        logger.warn(
          { err: (err as Error)?.message ?? err, sessionId, streak },
          "keepalive.background_work_check_failed",
        );
        if (streak > BG_UNKNOWN_TOLERANCE) {
          bgProbeCache.set(identity, {
            at: Date.now(),
            state: "idle",
            epoch,
            idleSince: idleSinceAtStart,
            idleRev: idleRevAtStart,
            // Local inference uses the longer give-up lifetime.
            inferred: true,
            // Reclaim requires a failed probe after the first inference.
            retested: bgProbeCache.get(identity)?.inferred === true,
          });
          logger.warn(
            { sessionId, workloadId: info.workloadId, streak },
            "keepalive.background_work_unknown_giving_up",
          );
        }
      })
      .finally(async () => {
        bgProbeInFlight.delete(identity);
        await releaseProbe(deps, sessionId, identity, token);
      });
  }
  bgProbeCursor = start + started;
  return started;
}

/**
 * Identifies the verdict an entry carried. `rev` is unique per key; `at` keeps
 * compatibility with verdicts written before `bgRev` existed.
 */
interface VerdictWitness {
  rev?: number;
  at?: number;
}

function verdictWitness(info: HandsKvEntry): VerdictWitness {
  return { rev: info.bgRev, at: info.bgCheckedAt };
}

/** Whether the entry still carries the witnessed verdict, including no verdict. */
function sameVerdict(witness: VerdictWitness, info: HandsKvEntry): boolean {
  return witness.rev === info.bgRev && witness.at === info.bgCheckedAt;
}

/**
 * Record a measured background-work answer onto the handle itself.
 *
 * Re-read the entry and require the same sandbox identity and idle-period
 * witnesses. Concurrent `running` verdicts dominate `idle`; only `running`
 * retries a lost conditional update so write arrival order cannot reverse that
 * safety rule.
 */
async function persistVerdict(
  deps: KeepaliveDeps,
  sessionId: string,
  identity: string,
  running: number,
  epoch: number | undefined,
  idleSinceAtStart: number | undefined,
  idleRevAtStart: number | undefined,
  verdictAtStart: VerdictWitness,
): Promise<void> {
  try {
    const key = `hands.${sessionId}`;
    // Re-read all guards after contention; `idle` yields after one attempt.
    let workloadId: string | undefined;
    const attempts = running > 0 ? BG_VERDICT_WRITE_ATTEMPTS : 1;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const e = await deps.kv.get(key);
      if (!e) return;
      const info = JSON.parse(sc.decode(e.value)) as HandsKvEntry;
      workloadId = info.workloadId;
      if (entryIdentity(sessionId, info) !== identity) {
        // Never apply a verdict to a replacement sandbox under the same key.
        logger.info(
          { sessionId, workloadId: info.workloadId },
          "keepalive.background_work_answer_substituted",
        );
        return;
      }
      // Epoch catches current writers, idleSince catches old writers, and idleRev
      // prevents same-millisecond ABA. Values are matched, never clock-ordered.
      if (
        !sameIdlePeriod(epoch, info)
        || info.idleSince !== idleSinceAtStart
        || info.idleRev !== idleRevAtStart
      ) {
        logger.info(
          { sessionId, workloadId: info.workloadId },
          "keepalive.background_work_answer_reactivated",
        );
        return;
      }
      // Do not let an in-flight idle result replace a running verdict published
      // after this probe started. The witness supports binaries without `bgRev`.
      if (
        running === 0
        && usableSharedVerdict(info)?.state === "running"
        && !sameVerdict(verdictAtStart, info)
      ) {
        logger.info(
          { sessionId, workloadId: info.workloadId },
          "keepalive.background_work_answer_superseded",
        );
        return;
      }
      const next = sc.encode(JSON.stringify({
        ...info,
        bgCheckedAt: Date.now(),
        bgRunning: running,
        bgEpoch: epoch,
        bgIdleSince: idleSinceAtStart,
        bgIdleRev: idleRevAtStart,
        // The conditioned-on revision uniquely names this verdict write.
        bgRev: e.revision,
      }));
      try {
        await deps.kv.update(key, next, e.revision);
        return;
      } catch {
        // A running retry re-reads the entry and all guards on the next attempt.
        logger.info(
          { sessionId, workloadId, attempt },
          "keepalive.background_work_answer_write_contended",
        );
      }
    }
    // Exhausted running retries are reported; an unconditional write could
    // overwrite a newer reactivation or replacement.
    if (running > 0) {
      logger.warn(
        { sessionId, workloadId, attempts },
        "keepalive.background_work_answer_write_abandoned",
      );
    }
  } catch {
    // Missing verdicts read back as `unknown`, which keeps the sandbox.
  }
}

/**
 * Move the idle clock forward on a handle whose sandbox is still working.
 * `idleSince` follows the measurement anchor; `workSeenAt` gives the reuse window
 * a current local clock. The update is conditional and best-effort.
 */
async function refreshIdleSince(
  deps: KeepaliveDeps,
  key: string,
  revision: number,
  info: HandsKvEntry,
  seenAt: number,
): Promise<void> {
  try {
    // Keep the verdict anchor monotonic and no later than its measurement.
    const idleSince = Math.max(
      typeof info.idleSince === "number" ? info.idleSince : 0,
      seenAt,
    );
    // The reuse clock reflects when this sweep acted on the running verdict.
    const next = sc.encode(JSON.stringify({ ...info, idleSince, workSeenAt: Date.now() }));
    await deps.kv.update(key, next, revision);
    // Keep the scan copy aligned for probes dispatched later in this tick.
    info.idleSince = idleSince;
  } catch { /* lost the race, or KV is unhappy; the next sweep tries again */ }
}

/** Run `fn` over every item, at most `limit` at a time. */
async function forEachWithLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i]);
    }
  });
  await Promise.all(workers);
}

/**
 * Build the merged ping target list: in-memory registry (primary) + NATS KV
 * (secondary, for crash-recovery of sessions created by a previous Brain pod).
 */
async function collectTargets(
  deps: KeepaliveDeps,
  seenIdentities: Set<string>,
  stats: TickStats,
): Promise<Map<string, RegisteredSandbox>> {
  const targets = new Map<string, RegisteredSandbox>();
  const probeCandidates: Array<{
    identity: string; sessionId: string; info: HandsKvEntry; generation: number;
  }> = [];

  // 1. In-memory registry — always authoritative for this process.
  for (const [key, registered] of localRegistry) {
    if (await shouldSkipExpiredRetry(
      deps,
      registered.sessionId,
      "local",
      registered.entry,
    )) continue;
    targets.set(key, registered);
  }

  // 2. NATS KV — pick up sessions from previous Brain runs that are still alive.
  try {
    // Filtered server-side: this bucket also holds `lock.*`, `deleted.*` and
    // `brain.min_version`, and this runs every SANDBOX_KEEPALIVE_INTERVAL_SEC --
    // the most frequent of the three walks over these keys.
    const keys = await deps.kv.keys("hands.*");
    for await (const key of keys) {
      const sessionId = key.slice("hands.".length);
      const e = await deps.kv.get(key).catch(() => null);
      if (!e) continue;
      try {
        const info = JSON.parse(sc.decode(e.value)) as HandsKvEntry;
        if (info.status && info.status !== "ready") continue;
        // Idle handles with running or unknown work are pinged; only confirmed
        // idle handles may expire. Probes run behind the sweep by sandbox identity.
        const identity = entryIdentity(sessionId, info);
        seenIdentities.add(identity);
        // Give an unstamped idle handle its epoch here, not only in
        // markHandsIdle. Handles that idled before this shipped never pass
        // through that function again until their session gets another message,
        // and until they are stamped no verdict about them can be trusted (see
        // sameIdlePeriod) -- so without this they would be re-probed on every
        // sweep for as long as they exist, which is the cost of the strictness
        // above paid forever rather than once.
        //
        // `idleSince` is the value, because that is when the period being
        // stamped actually began; a fresh timestamp would name a period that
        // starts in the middle of one. It rides along on whichever write this
        // tick was already going to make, so it costs no extra round trip.
        //
        // `idleRev` is backfilled on the same terms and for the same reason --
        // a handle with no revision half to its name can hold no witnessed
        // `idle` verdict, so an unstamped one is re-probed every sweep until it
        // is stamped. The value is the revision this tick's write is
        // conditioned on, which is exactly what markHandsIdle records and is
        // unique for the same reason: one write per revision.
        let value = e.value;
        if (info.keepalive === false
          && (typeof info.idleEpoch !== "number" || typeof info.idleRev !== "number")) {
          if (typeof info.idleEpoch !== "number") {
            info.idleEpoch = typeof info.idleSince === "number" ? info.idleSince : Date.now();
          }
          if (typeof info.idleRev !== "number") info.idleRev = e.revision;
          value = sc.encode(JSON.stringify(info));
        }
        const peeked = info.keepalive === false
          ? peekBackgroundWork(identity, info)
          : { state: "idle" as BackgroundWork, source: null, at: undefined };
        const bgWork = peeked.state;
        if (info.keepalive === false) {
          if (bgWork === "running") stats.bgRunning += 1;
          else if (bgWork === "unknown") stats.bgUnknown += 1;
          else stats.bgIdle += 1;
          if (peeked.source === "mem") stats.fromMem += 1;
          else if (peeked.source === "handle") stats.fromHandle += 1;
          else if (peeked.source === "none") stats.fromNone += 1;
          else if (peeked.source === "no-hands") stats.fromNoHands += 1;
        }
        if (info.keepalive === false && needsProbe(identity, info)) {
          // Capture generation during the scan so reuse before dispatch is visible.
          probeCandidates.push({
            identity, sessionId, info, generation: bgGeneration.get(identity) ?? 0,
          });
        }
        if (info.keepalive === false && bgWork === "running") {
          await refreshIdleSince(deps, key, e.revision, info, peeked.at ?? Date.now());
        } else if (info.keepalive === false && bgWork === "unknown") {
          await deps.kv.update(key, value, e.revision).catch(() => {});
        }
        if (info.keepalive === false && bgWork === "idle") {
          const expired = Date.now() - reuseWindowStart(info) > SANDBOX_IDLE_REUSE_MS;
          // Local registrations and fleet run leases both block reclaim.
          if (expired && registeredSandboxCount(sessionId) > 0) {
            // The local ping path refreshes this entry's TTL.
            logger.info(
              { sessionId, workloadId: info.workloadId },
              "keepalive.idle_handle_kept_locally_active",
            );
            stats.keptLocal += 1;
            continue;
          }
          if (expired && await sessionHasActiveRunLease(deps.kv, sessionId, info.runScope)) {
            // The run lease protects work owned by another replica.
            logger.info(
              { sessionId, workloadId: info.workloadId },
              "keepalive.idle_handle_kept_run_in_flight",
            );
            stats.keptRunLease += 1;
            continue;
          }
          if (expired && probeOutstanding(info)) {
            // Do not reclaim while a fleet-visible answer is still in flight.
            // The reservation is released on completion or expires by deadline.
            logger.info(
              { sessionId, workloadId: info.workloadId },
              "keepalive.idle_handle_kept_probe_outstanding",
            );
            stats.keptProbe += 1;
            await deps.kv.update(key, value, e.revision).catch(() => {});
            continue;
          }
          if (expired) {
            // Report a reclaim only after the conditional delete succeeds.
            await deps.kv.delete(key, { previousSeq: e.revision })
              .then(() => {
                stats.expired += 1;
                logger.info(
                  { sessionId, workloadId: info.workloadId },
                  "keepalive.idle_handle_expired",
                );
              })
              .catch(() => {});
          } else {
            stats.withinWindow += 1;
            // Conditional TTL refresh must yield to concurrent reactivation.
            await deps.kv.update(key, value, e.revision).catch(() => {});
          }
          continue;
        }
        const provider = info.provider === "agent-sandbox" ? "agent-sandbox" : "safe-workload";
        // safe-workload needs workloadId+platformKey; agent-sandbox needs sessionId.
        const usable = provider === "agent-sandbox"
          ? !!info.sessionId
          : !!(info.workloadId && info.platformKey);
        if (!usable) continue;
        const entry: SandboxEntry = {
          provider,
          workloadId: info.workloadId,
          platformKey: info.platformKey,
          sessionId: info.sessionId,
          sandboxName: info.sandboxName,
          namespace: info.namespace,
          userId: info.userId,
        };
        if (await shouldSkipExpiredRetry(deps, sessionId, "kv", entry)) continue;

        // Renew before queueing so bounded ping concurrency cannot exhaust the TTL.
        await deps.kv.update(key, e.value, e.revision).catch(() => {});

        const targetKey = sandboxRegistryKey(sessionId, entry);
        if (!targets.has(targetKey)) targets.set(targetKey, { sessionId, entry });
      } catch { /* malformed — skip */ }
    }
  } catch (err) {
    logger.warn({ err }, "keepalive.kv_scan_failed");
  }

  // Dispatch after the full walk so the global cap and rotation are applied fairly.
  stats.probes += dispatchProbes(deps, probeCandidates);

  return targets;
}

/**
 * Periodically exec a no-op inside every active sandbox to refresh the
 * SaFE Workload Manager's lastActivity timestamp, preventing idle GC.
 */
/** One sweep, exported so its decisions can be tested without an interval. */
export async function runKeepaliveTickForTest(deps: KeepaliveDeps): Promise<void> {
  return tick(deps);
}

interface KeepaliveFailure {
  targetKey: string;
  sessionId: string;
  entry: SandboxEntry;
  error: unknown;
  gone: boolean;
}

async function handleKeepaliveFailures(
  failures: KeepaliveFailure[],
  targetCount: number,
): Promise<void> {
  // More than one independently "gone" result in one tick is more likely to be
  // a shared routing/control-plane fault than simultaneous sandbox loss. Delay
  // immediate eviction and let the ordinary opt-in failure threshold decide.
  const goneCount = failures.filter((failure) => failure.gone).length;
  const suppressImmediateGone = goneCount > 1;
  if (suppressImmediateGone) {
    logger.error(
      { gone: goneCount, total: targetCount },
      "keepalive.multiple_sandboxes_reported_gone",
    );
  }

  for (const failure of failures) {
    const { targetKey, sessionId, entry, error } = failure;
    const goneCircuitOpen = suppressImmediateGone && failure.gone;
    const gone = failure.gone && !goneCircuitOpen;
    const fails = gone
      ? Math.max(SANDBOX_KEEPALIVE_FAIL_LIMIT, (failCounts.get(targetKey) || 0) + 1)
      : (failCounts.get(targetKey) || 0) + 1;
    failCounts.set(targetKey, fails);
    lastVerdict.set(targetKey, { fails, gone });
    logger.warn(
      {
        err: (error as { message?: string })?.message || String(error),
        sessionId,
        workloadId: entry.workloadId,
        fails,
        gone,
        goneCircuitOpen,
      },
      "keepalive.ping_failed",
    );
    // Automatic eviction is opt-in; the default leaves recovery to platform
    // idle/TTL GC rather than acting on an unavailable control plane.
    if (
      SANDBOX_KEEPALIVE_FAIL_LIMIT > 0
      && fails >= SANDBOX_KEEPALIVE_FAIL_LIMIT
      // A multi-target spike gets one additional full-threshold confirmation;
      // otherwise a genuine node-wide loss would be suppressed forever.
      && (!goneCircuitOpen || fails > SANDBOX_KEEPALIVE_FAIL_LIMIT)
    ) {
      await destroyHands(sessionId, entry).catch((err2) =>
        logger.warn({ err: err2, sessionId }, "keepalive.destroy_failed"),
      );
      failCounts.delete(targetKey);
      localRegistry.delete(targetKey);
      logger.error(
        { sessionId, workloadId: entry.workloadId, fails },
        "keepalive.sandbox_evicted",
      );
    }
  }
}

/** The verdict the last sweep reached for a target, for tests. */
const lastVerdict = new Map<string, { fails: number; gone: boolean }>();
export function lastVerdictForTest(sessionId: string): { fails: number; gone: boolean } | null {
  for (const [key, v] of lastVerdict) if (key.includes(sessionId)) return v;
  return null;
}

async function tick(deps: KeepaliveDeps): Promise<void> {
  const seenIdentities = new Set<string>();
  const stats = newTickStats();
  const targets = await collectTargets(deps, seenIdentities, stats);

  // Reap stale failCounts for sessions no longer tracked.
  for (const key of failCounts.keys()) {
    if (!targets.has(key)) failCounts.delete(key);
  }
  // Reap by each verdict's lifetime; absence from one rotating sweep is not stale.
  const now = Date.now();
  for (const [identity, cached] of [...bgProbeCache.entries()]) {
    const floor = now - Math.max(BG_VERDICT_TTL_MS, cachedVerdictTtlMs(cached));
    if (cached.at < floor) forgetBackgroundWork(identity);
  }
  // Failure streaks must also survive rotating sweeps and expire by age.
  const streakFloor = Date.now() - BG_UNKNOWN_STREAK_TTL_MS;
  for (const [identity, streak] of [...bgUnknownStreak.entries()]) {
    if (streak.at < streakFloor) bgUnknownStreak.delete(identity);
  }
  // Keep generations through in-flight answers, then discard unseen identities.
  for (const identity of [...bgGeneration.keys()]) {
    if (!seenIdentities.has(identity) && !bgProbeInFlight.has(identity)) {
      bgGeneration.delete(identity);
    }
  }

  // Emit scan stats even when every target was reclaimed before the ping phase.
  const localCount = localRegistry.size;
  const kvOnlyCount = targets.size - localCount;
  if (targets.size || seenIdentities.size) {
    logger.info(
      { total: targets.size, local: localCount, kvOnly: kvOnlyCount,
        seen: seenIdentities.size, ...stats,
        sessions: [...new Set([...targets.values()].map((target) => target.sessionId))] },
      "keepalive.tick_scan",
    );
  }

  if (!targets.size) return;

  // Rotate deferred targets to the front of the next sweep.
  const ordered = [...targets.entries()];
  const pingStart = pingCursor % ordered.length;
  const rotated = ordered.slice(pingStart).concat(ordered.slice(0, pingStart));
  const pingDeadline = Date.now() + (deps.pingBudgetMs ?? PING_PHASE_BUDGET_MS);
  let pinged = 0;
  let deferred = 0;
  const failures: KeepaliveFailure[] = [];

  await forEachWithLimit(rotated, PING_MAX_IN_FLIGHT, async ([targetKey, target]) => {
    // The deadline bounds ping starts; already-running pings may finish after it.
    if (Date.now() >= pingDeadline) {
      deferred += 1;
      return;
    }
    pinged += 1;
    const { sessionId, entry } = target;
    const isAgent = entry.provider === "agent-sandbox";
    if (isAgent ? !entry.sessionId : (!entry.workloadId || !entry.platformKey)) return;

    try {
      if (isAgent) {
        // agent-sandbox: GET /sessions/{id} refreshes lastActivity (design §16.6),
        // preventing the sandbox's idle GC from reaping an active session.
        await getAgentSandboxProvider().get({
          provider: "agent-sandbox",
          id: entry.sessionId!,
          sandboxName: entry.sandboxName ?? "",
          namespace: entry.namespace ?? "",
          handsBaseUrl: "",
          userId: entry.userId,
        });
      } else {
        // safe-workload: exec a no-op to refresh SaFE Workload Manager lastActivity.
        await getSafeWorkloadProvider().exec({
          provider: "safe-workload",
          id: entry.workloadId!,
          sandboxName: entry.workloadId!,
          namespace: entry.namespace ?? "",
          handsBaseUrl: "",
          platformKey: entry.platformKey!,
        }, "date -Iseconds > /tmp/keepalive_ts", "15s");
      }
      failCounts.delete(targetKey);
      // Refresh KV TTL so the entry survives across Brain restarts.
      const kvKey = `hands.${sessionId}`;
      const existing = await deps.kv.get(kvKey).catch(() => null);
      if (existing) {
        try {
          const recorded = JSON.parse(sc.decode(existing.value)) as HandsKvEntry;
          if (sameRegisteredSandbox(entry, recorded)) {
            await deps.kv.update(kvKey, existing.value, existing.revision);
          }
        } catch (err) {
          logger.warn({ err, sessionId }, "keepalive.kv_refresh_failed");
        }
      }
      logger.info({ sessionId, provider: entry.provider ?? "safe-workload", workloadId: entry.workloadId }, "keepalive.ping");
    } catch (err: any) {
      if (err?.sandboxConfirmedRunning === true) {
        failCounts.delete(targetKey);
        logger.error(
          { err: err?.message || String(err), sessionId, workloadId: entry.workloadId },
          "keepalive.router_failed_for_running_sandbox",
        );
        return;
      }
      // Decide `gone` eviction after the sweep reveals any correlated failures.
      failures.push({
        targetKey, sessionId, entry, error: err,
        gone: err?.sandboxGone === true,
      } satisfies KeepaliveFailure);
    }
  });

  // Advance by completed work so the deferred tail leads the next sweep.
  await handleKeepaliveFailures(failures, targets.size);

  pingCursor = (pingStart + pinged) % ordered.length;
  if (deferred > 0) {
    logger.warn(
      { pinged, deferred, total: ordered.length,
        budgetMs: deps.pingBudgetMs ?? PING_PHASE_BUDGET_MS },
      "keepalive.ping_budget_exhausted",
    );
  }
}

/** Start the periodic keepalive. Idempotent. */
export function startSandboxKeepalive(deps: KeepaliveDeps): void {
  if (SANDBOX_KEEPALIVE_INTERVAL_SEC <= 0) {
    logger.info("keepalive.disabled (SANDBOX_KEEPALIVE_INTERVAL_SEC <= 0)");
    return;
  }
  if (timer) return;
  logger.info(
    {
      intervalSec: SANDBOX_KEEPALIVE_INTERVAL_SEC,
      failLimit: SANDBOX_KEEPALIVE_FAIL_LIMIT,
    },
    "keepalive.start",
  );
  runGuardedSweep(deps);
  // A sweep may outlast the interval, so interval invocations share the guard.
  timer = setInterval(() => runGuardedSweep(deps), SANDBOX_KEEPALIVE_INTERVAL_SEC * 1000);
  timer.unref?.();
}

/**
 * One sweep, never two at once.
 * Overlap would duplicate writes and race conditional updates.
 */
function runGuardedSweep(deps: KeepaliveDeps): void {
  if (sweeping) {
    logger.warn({}, "keepalive.tick_still_running");
    return;
  }
  sweeping = true;
  tick(deps)
    .catch((err) => logger.warn({ err }, "keepalive.tick_unhandled"))
    .finally(() => { sweeping = false; });
}

/** Stop the periodic keepalive. */
export function stopSandboxKeepalive(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  failCounts.clear();
  localRegistry.clear();
  logger.info("keepalive.stop");
}
