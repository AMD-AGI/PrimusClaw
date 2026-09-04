// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { StringCodec, type KV } from "nats";
import { isRevisionConflict } from "@claw/utils";
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
  /** Epoch ms when the handle became idle; used to expire it after the window. */
  idleSince?: number;
  /**
   * Identifies the idle period `idleSince` opened.
   *
   * Separate from `idleSince` because that one moves: refreshIdleSince slides it
   * forward every tick under a sandbox that is still working, so it says when
   * the handle was last seen busy rather than which idle period this is. This
   * one is stamped once, by markHandsIdle, and a handle taken back by a task and
   * idled again gets a new value -- which is what tells a background-work
   * verdict measured during the previous idle period apart from one measured
   * during this one. Absent on entries written before it existed.
   */
  idleEpoch?: number;
  /**
   * The last background-work answer, and when it was taken.
   *
   * On the handle rather than only in memory because the sweep that asks and the
   * sweep that reads are not the same process. A Brain replica walks a rotating
   * slice of the handles -- one per tick on this cluster -- so a given handle
   * comes back to a given replica on the order of tens of minutes, and any
   * in-process cache has expired by then even when nothing evicts it. Left
   * in-memory the verdict is written by whoever probed and read by nobody: every
   * sweep sees `unknown`, `unknown` is the keep branch, and an idle handle whose
   * work has ended is pinged until the CR's absolute deadline.
   */
  bgCheckedAt?: number;
  /** Shell count from that answer. 0 means the sandbox had nothing running. */
  bgRunning?: number;
  /**
   * The `idleEpoch` the verdict above was measured under, so it is only believed
   * while it is still about the idle period it measured.
   *
   * Sandbox identity does not close this: the same pod is handed back to a task
   * and idled again under the same identity, so an `idle` answer taken before
   * the task ran would otherwise still be answering for the sandbox after it --
   * including for a background shell that task started. Absent, like
   * `idleEpoch`, on entries written before either existed; the two are then
   * equal, which is the behaviour those entries already had.
   */
  bgEpoch?: number;
  /** True on a handle parked by a session delete rather than by a finished task.
   *  The multi-node sweep reclaims these without waiting out the idle window,
   *  there being no next message to hold a cluster for. Set by parkHandsHandle. */
  sessionDeleted?: boolean;
}

interface KeepaliveDeps {
  kv: KV;
  /**
   * Test seam for the background-work probe, which is otherwise a live HTTP call
   * to a Hands that does not exist under test -- so every probe would fail, and
   * a failed probe answers `unknown`. That keeps the handle, which is the safe
   * direction but only one of three branches: neither a confirmed `running` nor
   * a confirmed `idle` could be reached without stubbing the call.
   */
  countActiveShells?: (url: string, token: string, owner: string) => Promise<number>;
  /**
   * Test seam for the ping-phase budget. The real one is derived from the
   * record TTL and is minutes long, which no test can exhaust without sleeping
   * for minutes -- so a test that wants to see the deferral path has to shorten
   * it. Never set in production.
   */
  pingBudgetMs?: number;
}

let timer: ReturnType<typeof setInterval> | null = null;
/** Module-level so the immediate sweep at startup is under the same guard as
 *  the interval's: the first one can outlast a whole period, and it used to be
 *  the one sweep nothing stopped the timer from starting a second copy of. */
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
 *
 * The same string the local registry keys on, derived from the fields the entry
 * carries. One definition, shared by the scan that starts a probe and the write
 * that files the answer, so the two cannot drift: `hands.<session>` is a key a
 * sandbox is put behind, not the sandbox, and two reads of it that disagree here
 * are about two different pods.
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
  // A task has taken this sandbox, so whatever the last sweep concluded about
  // it is about the turn before. Reuse hands the same pod to the next task, so
  // identity alone would carry an `idle` verdict across that boundary -- and a
  // turn that leaves a background shell behind would be read as one that left
  // nothing, up to the length of the cache TTL. The next idle decision is made
  // from a fresh answer.
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
 * Mark a READY `hands.<sid>` entry idle (keepalive:false) so it is kept as a
 * reuse handle but no longer pinged. Called by stopKeepaliveAfterTask instead
 * of deleting the entry outright, so the next message in the same session
 * can still reuse the pod via ensureHands within SANDBOX_IDLE_REUSE_MS
 * (collectTargets above skips pinging it and expires it after the window).
 *
 * Fire-and-forget. An entry that cannot be parsed is dropped; a KV error is
 * not, because the entry may be fine and it is the only record the idle sweeper
 * can find the session's GPU clusters through.
 */
export function markHandsIdle(
  kv: KV,
  sessionId: string,
  known: SandboxEntry | string,
): void {
  const kvKey = `hands.${sessionId}`;
  kv.get(kvKey)
    .then(async (entry) => {
      if (!entry) return; // no handle to keep; a fresh task will recreate one.
      let info: HandsKvEntry;
      try {
        info = JSON.parse(sc.decode(entry.value)) as HandsKvEntry;
      } catch (err) {
        // Unreadable ownership data is not evidence that no live sandbox is
        // referenced. Preserve it for operator repair and natural TTL expiry.
        logger.warn(
          { err: (err as Error)?.message || String(err), sessionId },
          "hands.mark_idle_unreadable",
        );
        return;
      }
      // Only keep a READY handle that still points at the workload we ran on.
      if (info.status !== "ready") return;
      const sameTarget = typeof known === "string"
        ? !(known && info.workloadId && info.workloadId !== known)
        : sameRegisteredSandbox(known, info);
      if (!sameTarget) return;

      // The handle is going back into the idle pool, which is the moment its
      // background-work verdict starts being acted on -- so nothing concluded
      // while a task held it may carry over. A probe that ran mid-task and
      // found no shells is the case that matters: the task may have started one
      // afterwards, and an `idle` answer from before would suppress pinging for
      // the rest of the cache TTL. registerSandbox invalidates on the way in;
      // this is the way out, and without it the boundary is only half closed.
      forgetBackgroundWork(sandboxRegistryKey(sessionId, {
        provider: info.provider === "agent-sandbox" ? "agent-sandbox" : "safe-workload",
        workloadId: info.workloadId,
        sessionId: info.sessionId,
        sandboxName: info.sandboxName,
        namespace: info.namespace,
      }));

      info.keepalive = false;
      info.idleSince = Date.now();
      // A new idle period, so the verdict from the last one is not about it.
      // forgetBackgroundWork above drops this replica's copy; the handle is
      // where every OTHER replica reads it, and it is re-serialized here either
      // way -- so leaving the fields alone republishes a stale answer to the
      // whole fleet at the exact moment the sweep starts acting on it.
      info.idleEpoch = info.idleSince;
      delete info.bgCheckedAt;
      delete info.bgRunning;
      delete info.bgEpoch;
      // Conditioned on the revision just read, because a session teardown can
      // delete this entry between the read and the write. An unconditional put
      // would resurrect the handle of a deleted session, and collectTargets
      // then refreshes its TTL for the whole reuse window rather than letting
      // it expire -- so the deleted session's platformKey and workload id would
      // outlive it by 15 minutes.
      await kv.update(kvKey, sc.encode(JSON.stringify(info)), entry.revision);
    })
    .catch((err) => {
      if (isRevisionConflict(err)) {
        // Deleted or rewritten while we were deciding; whoever did it wins. In
        // particular, do not fall through to the delete below -- that would
        // remove an entry somebody else just wrote.
        logger.info({ sessionId }, "hands.mark_idle_superseded");
        return;
      }
      // A transport failure may arrive after the CAS succeeded, and another
      // writer may already own the key. An unconditional delete here could
      // erase that sibling, so preserve the latest value.
      logger.warn({ err: err?.message || String(err), sessionId }, "hands.mark_idle_failed");
    });
}

/**
 * What a probe of Hands' background-shell registry can tell us.
 *
 * Three states rather than a boolean, because "no work" and "could not ask" lead
 * to opposite decisions and only one of them is safe to guess at. A caller that
 * folds `unknown` into `idle` deletes the handle the moment a probe times out --
 * and over a job long enough to need this, at one probe a minute, a single blip
 * is close to certain.
 */
type BackgroundWork = "running" | "idle" | "unknown";

/**
 * Last probe answer per sandbox identity, so the sweep does not ask once per
 * handle per tick.
 *
 * The sweep has to know on every tick -- the answer decides whether the sandbox
 * is pinged, and an unpinged sandbox is reclaimed -- but the answer does not
 * change on that timescale. Without the cache each idle handle costs an HTTP
 * round trip inside the sweep's serial KV walk, so a handful of unreachable ones
 * push a tick past its own interval and the next one starts on top of it.
 *
 * The TTL is what an ended job costs: up to this long being pinged after the
 * last shell exited. That is the harmless direction, and it is why the entry is
 * not invalidated eagerly.
 */
const BG_PROBE_TTL_MS = 5 * 60_000;

/**
 * Consecutive unanswered probes before a handle is treated as idle after all.
 *
 * `unknown` holds the handle, which is right for a blip and wrong forever: a
 * sandbox that has stopped answering entirely would otherwise be pinned until
 * its absolute deadline. Five ticks is long enough that no single failure
 * decides anything and short enough that a dead sandbox is not held for hours.
 */
const BG_UNKNOWN_TOLERANCE = 5;
/**
 * How long the verdict recorded on the handle is believed.
 *
 * Longer than BG_PROBE_TTL_MS on purpose: that one bounds how stale an answer a
 * single replica will reuse before asking again, while this one has to outlive
 * the gap between two sweeps that see the same handle. That gap is a function of
 * how many handles the fleet is walking, not of anything this module controls,
 * so the number is generous and the freshness that matters is still enforced by
 * the probe the sweep starts anyway.
 */
const BG_VERDICT_TTL_MS = 30 * 60_000;

/**
 * How long a run of failed probes is remembered.
 *
 * The streak has to survive the sweeps that do not see the handle, for the same
 * reason the verdict does: a replica walks a rotating slice, so an identity is
 * absent from most ticks while its sandbox is alive, and a streak dropped on
 * absence is a streak that never reaches the tolerance above -- the give-up path
 * would exist and never fire, and a Hands that has stopped answering would hold
 * its handle until the CR's absolute deadline.
 *
 * Each failure re-stamps the entry, so this only has to outlive the gap between
 * two consecutive probes of the same identity -- not the whole run of five. But
 * that gap is not the one BG_VERDICT_TTL_MS is sized for. A verdict is read by
 * whichever replica sweeps next, so it has to survive until ANY replica returns
 * to the handle -- about six minutes here. A streak is in-process, owned by the
 * replica that failed, so it has to survive until THAT replica returns, which is
 * the same rotation multiplied by the replica count: about thirty-six minutes on
 * this cluster, and more on a bigger one or a larger bucket of handles. Thirty
 * minutes is inside that gap, so every failure aged out before the same replica
 * could fail again and the streak never left one.
 *
 * Four hours is that measured gap with room for a fleet several times the size,
 * because the two directions are not symmetrical. Too short and the give-up path
 * exists but can never fire, which is the bug above. Too long and a run of
 * failures separated by hours is treated as consecutive -- a Hands that failed
 * five times over an afternoon is not one anybody wants pinned either, and the
 * only thing it costs is one integer per identity until the reap below.
 */
const BG_UNKNOWN_STREAK_TTL_MS = 4 * 60 * 60_000;

/**
 * How many probes may be in flight across the whole sweep.
 *
 * Per-session de-duplication is not a bound: on a cold start every idle handle
 * is uncached at once, so a replica with a few hundred of them opened a few
 * hundred sockets in the same tick -- times the number of replicas, against one
 * control plane. Reaching the limit skips the rest of the probes rather than
 * queueing them, because a skipped probe is not a lost one: the handle stays
 * `unknown`, which keeps it, and the next tick picks up where this one stopped.
 * A cold start spreads over a few ticks instead of arriving as a burst.
 */
const BG_PROBE_MAX_IN_FLIGHT = 8;

/**
 * How many sandboxes are pinged at once.
 *
 * The ping fan-out was `Promise.all` over every target, which was survivable
 * while an idle handle was never a target. It is not any more: an uncached
 * handle answers `unknown`, and `unknown` is pinged -- so the same cold start
 * that floods the probes floods this too, and the two are the same connection
 * pool. Bounded rather than skipped, because unlike a probe a missed ping is
 * how a sandbox dies.
 */
const PING_MAX_IN_FLIGHT = 16;
/**
 * How long the ping phase may run before it defers the rest to the next sweep.
 *
 * Renewing a record when it is queued gives it a full TTL from that moment,
 * which is not the same as guaranteeing its ping arrives inside one. Pings run
 * bounded and in turn and one can take its whole command timeout, so a fleet
 * large enough makes the queue itself longer than the TTL: with the default 16
 * at a time and a 15s ceiling per ping, the tail of ~320 targets is renewed and
 * then waits past its own expiry, and the sweep guard means no other sweep is
 * coming to renew it.
 *
 * Half the record's lifetime is the budget. Precisely, it is a cutoff on
 * *starting* a ping, not on the phase finishing: the deadline is tested as each
 * target is picked up, so up to PING_MAX_IN_FLIGHT pings already in progress run
 * past it, each bounded by its own command timeout. The phase can therefore
 * overrun the budget by roughly one ping's timeout, not by the length of the
 * remaining queue -- which is the property that matters, since the queue is what
 * grows with the fleet and the timeout does not.
 *
 * So a ping started this sweep began with the other half of the TTL to spare,
 * and anything not started keeps the renewal it already got and goes first next
 * time -- the cursor below is what makes deferral fair rather than starvation
 * for whoever sorts last.
 */
const PING_PHASE_BUDGET_MS = Math.max(1_000, Math.floor(BRAIN_REGISTRY_TTL_MS / 2));
/** Where the last sweep stopped handing out pings. */
let pingCursor = 0;


/** Keyed by sandbox identity, not by session: see refreshBackgroundWork. */
const bgProbeCache = new Map<
  string,
  { at: number; state: BackgroundWork; epoch?: number }
>();
const bgUnknownStreak = new Map<string, { count: number; at: number }>();
const bgProbeInFlight = new Set<string>();
/**
 * Bumped whenever something makes an in-flight answer obsolete.
 *
 * Dropping the cached answer is not enough on its own: a probe already in the
 * air writes when it lands, and for a reused sandbox it lands on the very key
 * the next sweep reads. So the probe carries the generation it started under
 * and its result is discarded if that has moved -- which is what "a task took
 * this sandbox back" looks like from inside a promise that started before it.
 */
const bgGeneration = new Map<string, number>();
/** Where the last sweep stopped handing out probe slots. */
let bgProbeCursor = 0;

/**
 * Drop the cached verdict for one sandbox identity, and invalidate any answer
 * still in the air about it.
 *
 * Deliberately not the unknown streak. The two are reaped on different clocks
 * -- see BG_UNKNOWN_STREAK_TTL_MS -- and this function is called from the
 * verdict reap, so clearing both here meant one identity's answer crossing its
 * thirty-minute TTL wiped a run of failures recorded minutes ago. Nothing links
 * the two: a failed probe caches no verdict at all, so the streak is about
 * probes that produced nothing to reap.
 *
 * What clears a streak is a probe that succeeds, which is what "consecutive"
 * means, or the streak's own age. Reuse leaves it: the URL and the Hands behind
 * it are the same process across a reuse, so failures to reach it are still the
 * most recent thing known about reaching it.
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

/**
 * Clear the probe bookkeeping. Exported for tests, which drive several sweeps
 * over one sandbox identity in one process and would otherwise read each
 * other's cached answers -- the cache being module state is the point of it.
 */
export function resetBackgroundWorkStateForTest(): void {
  bgProbeCache.clear();
  bgUnknownStreak.clear();
  bgProbeInFlight.clear();
  bgGeneration.clear();
  bgProbeCursor = 0;
}

/**
 * Age every cached verdict and every unknown streak by `ms`, for tests about the
 * reap.
 *
 * The reap is by age now, and the age that matters is tens of minutes -- longer
 * than any test can wait and longer than a fake timer would reach without also
 * moving the clock the sweep itself reads. This moves only the two maps' own
 * stamps, which are the inputs the reap consults.
 */
export function ageBackgroundWorkCacheForTest(ms: number): void {
  for (const [identity, cached] of bgProbeCache) {
    bgProbeCache.set(identity, { ...cached, at: cached.at - ms });
  }
  for (const [identity, streak] of bgUnknownStreak) {
    bgUnknownStreak.set(identity, { ...streak, at: streak.at - ms });
  }
}

/**
 * Per-tick counters for the scan line.
 *
 * Aggregated rather than logged per handle: the interesting quantity is the
 * shape of a whole sweep, and a line per handle per replica per minute is a
 * volume nobody reads. The specific gap these close is that `unknown` -> keep
 * was silent -- the branch the fleet was stuck in for four hours emitted
 * nothing, so a stalled reclaim loop and a healthy quiet one produced identical
 * logs. `bgUnknown` high with `expired` at zero across consecutive ticks is that
 * stall, visible without a debug build.
 */
interface TickStats {
  /** Idle handles by background-work answer. */
  bgRunning: number; bgUnknown: number; bgIdle: number;
  /** Where those answers came from; see VerdictSource. */
  fromMem: number; fromHandle: number; fromNone: number; fromNoHands: number;
  /** What happened to the handles answered `idle`. */
  expired: number; withinWindow: number; keptLocal: number; keptRunLease: number;
  /** Probes this tick actually started; candidates over the cap are not counted. */
  probes: number;
}

function newTickStats(): TickStats {
  return {
    bgRunning: 0, bgUnknown: 0, bgIdle: 0,
    fromMem: 0, fromHandle: 0, fromNone: 0, fromNoHands: 0,
    expired: 0, withinWindow: 0, keptLocal: 0, keptRunLease: 0,
    probes: 0,
  };
}

/**
 * Where a verdict came from, for the tick counters.
 *
 * Worth reporting because the three sources fail differently and the failures
 * look identical from outside: `none` dominating means answers are not reaching
 * the sweeps that read them, which is the shape of the bug this sharing was
 * added to fix, while `handle` dominating is that same sharing working.
 */
type VerdictSource = "mem" | "handle" | "none" | "no-hands";

/**
 * Whether a verdict is still about the idle period the handle is in now.
 *
 * Both fields absent is an entry from before either existed, and those compare
 * equal -- the verdict is believed exactly as it was before this check.
 */
function sameIdlePeriod(verdictEpoch: number | undefined, info: HandsKvEntry): boolean {
  return (verdictEpoch ?? null) === (info.idleEpoch ?? null);
}

/** This replica's own last answer, if it is fresh enough to reuse and still
 *  about the idle period the handle is in. */
function usableCachedVerdict(
  identity: string,
  info: HandsKvEntry,
): { at: number; state: BackgroundWork } | null {
  const cached = bgProbeCache.get(identity);
  if (!cached) return null;
  if (Date.now() - cached.at >= BG_PROBE_TTL_MS) return null;
  if (!sameIdlePeriod(cached.epoch, info)) return null;
  return cached;
}

/** The handle's own copy, which any replica can read, under the same two rules
 *  and its own longer TTL. */
function usableSharedVerdict(info: HandsKvEntry): { at: number; state: BackgroundWork } | null {
  if (typeof info.bgCheckedAt !== "number" || typeof info.bgRunning !== "number") return null;
  if (Date.now() - info.bgCheckedAt >= BG_VERDICT_TTL_MS) return null;
  if (!sameIdlePeriod(info.bgEpoch, info)) return null;
  return { at: info.bgCheckedAt, state: info.bgRunning > 0 ? "running" : "idle" };
}

/**
 * Whether an idle handle's sandbox still has background work running in it.
 *
 * `stopKeepaliveAfterTask` marks the handle idle on every terminal task, and an
 * idle handle is never pinged, so the control-plane GC reclaims the pod about
 * fifteen minutes later. That is right when the sandbox is only a warm cache for
 * the next message. It is wrong when the turn left something running: Claw's own
 * rule is that a `run_in_background` shell outlives the turn that started it --
 * "the user is still there, and a shell started this turn is expected to still
 * be running when they ask about it in the next one, which is the reason
 * background shells exist at all" -- and reclaiming the pod kills it anyway. The
 * two policies contradicted each other; this is the side that reads the fact.
 *
 * Asked with the session as the owner, which is the key Hands files shells under
 * for everything except a DAG node (there it is the DAG root, and a DAG node's
 * shells are reaped when it finishes, so there is nothing left to protect). Not
 * `runScope`: that is the run *lease* key, a workspace id under
 * RUN_GATE_KEY=workspace, and it would match no owner at all.
 *
 * A handle with no URL or token predates this and cannot be asked; it answers
 * idle, which is what the sweep did before the question existed.
 */
function peekBackgroundWork(
  identity: string,
  info: HandsKvEntry,
): { state: BackgroundWork; source: VerdictSource } {
  if (!info.handsUrl || !info.token) return { state: "idle", source: "no-hands" };
  const cached = usableCachedVerdict(identity, info);
  const shared = usableSharedVerdict(info);
  // Whichever measurement is actually the newer one. The in-process copy is the
  // newer one most of the time -- it is written by the probe that also wrote the
  // handle -- but not always: another replica probes the same handle on its own
  // rotation, so a local answer from four minutes ago is still inside its TTL
  // while a `running` recorded elsewhere two minutes ago sits unread on the
  // entry. Preferring the local one there reclaims a handle that a more recent
  // measurement says is busy, which is the failure the sharing exists to stop.
  if (cached && (!shared || cached.at >= shared.at)) {
    return { state: cached.state, source: "mem" };
  }
  if (shared) return { state: shared.state, source: "handle" };
  return { state: "unknown", source: "none" };
}

/**
 * Ask Hands in the background and remember the answer for the next sweep.
 *
 * Not awaited, which is the point. The sweep walks every KV handle in one
 * sequence and then pings from what it collected, so an awaited probe is in
 * front of every ping in the fleet: a handful of handles whose Hands takes its
 * five-second timeout to fail is a sweep that outlasts its own interval, and
 * the sandboxes that were answering fine get pinged late or not at all. Reading
 * the last answer costs nothing and is never more than one tick stale; the
 * refresh catches up behind it.
 *
 * Keyed by sandbox identity rather than by session, and that is not a detail.
 * A session outlives its sandbox: reuse hands the next task the same pod, a
 * failed reuse builds a new one, and a session-keyed answer would carry the old
 * pod's verdict onto the new one. It also settles the late-probe problem for
 * free -- a probe that started against the sandbox that has since been replaced
 * writes under the key it started with, which nothing reads any more, instead of
 * overwriting the new pod's state with an answer about a pod that is gone.
 *
 * Bounded across the whole sweep, not just per session. Skipping rather than
 * queueing when the limit is reached: the handle stays `unknown`, which keeps
 * and pings it, and the next tick continues down the list.
 */
function needsProbe(identity: string, info: HandsKvEntry): boolean {
  if (!info.handsUrl || !info.token) return false;
  // The same rule peekBackgroundWork reads by, so an answer the peek will not
  // use is not an answer that suppresses asking again -- a handle whose idle
  // period has turned over needs a fresh probe, not the previous period's.
  if (usableCachedVerdict(identity, info)) return false;
  return !bgProbeInFlight.has(identity);
}

/**
 * Start up to BG_PROBE_MAX_IN_FLIGHT probes, resuming where the last sweep left
 * off.
 *
 * Rotating matters as much as the cap. Handing the slots to whichever
 * candidates the KV walk happened to yield first means a handful that always
 * time out keep the quota to themselves, and everything behind them waits
 * however many sweeps it takes for those to be given up on. The cursor makes
 * the wait bounded and roughly fair instead.
 *
 * Fire-and-forget on purpose: awaiting a probe puts it in front of every ping
 * in the fleet. The answer is for the next sweep, which is never more than one
 * tick away, and until it arrives the handle reads `unknown` -- kept and pinged,
 * the safe direction for a sweep whose job is to keep things alive.
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
    // The idle period this probe is asking about, read from the entry the scan
    // saw. The answer is only about that period, and both places it is recorded
    // carry it so a later period cannot inherit it.
    const epoch = info.idleEpoch;
    if (bgProbeInFlight.has(identity)) continue;

    // `generation` came from the scan that formed this candidate, not from
    // here. Anything that invalidates the identity between the scan and the
    // promise landing moves it, and the result is dropped on arrival rather
    // than written over whatever replaced it. Checking again here would only
    // save a probe, and no test can tell the two apart -- the guard that
    // matters is the one at the landing.
    bgProbeInFlight.add(identity);
    started += 1;

    // True once anything has invalidated this identity since the candidate was
    // formed. Called again after every suspension point below, not once at the
    // top: each await is a window the generation can move in.
    const stale = () => (bgGeneration.get(identity) ?? 0) !== generation;

    void probe(info.handsUrl!, info.token!, sessionId)
      .then(async (running) => {
        if (stale()) {
          logger.info(
            { sessionId, workloadId: info.workloadId },
            "keepalive.background_work_answer_stale",
          );
          return;
        }
        // A live registration outranks the count. `idle` is the only verdict
        // that suppresses pinging, so it has to mean "nothing is holding this
        // sandbox" -- and a task that took the pod while the probe was in the
        // air is holding it, whatever the shell count said. Recording `idle`
        // here would be believed for the whole TTL, including after the task
        // ends and markHandsIdle puts the handle back in the idle pool with a
        // background shell the probe never saw.
        const held = localRegistry.has(identity)
          || await sessionHasActiveRunLease(deps.kv, sessionId, info.runScope).catch(() => false);

        // Re-read, because the lease query is a suspension point and the check
        // above was made before it. registerSandbox and markHandsIdle both bump
        // the generation from outside this promise, so a task can take the pod
        // while the query is outstanding -- and then the `idle` below would be
        // filed about the previous occupant and believed for the whole cache
        // TTL. That is the exact failure the generation exists to prevent,
        // arriving one await later than the guard that was watching for it.
        //
        // Guarding the write rather than the question is the general rule here:
        // any await added between these two points needs the check to stay
        // immediately before the write, not wherever the await was introduced.
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
        bgProbeCache.set(identity, { at: Date.now(), state, epoch });
        bgUnknownStreak.delete(identity);
        // And onto the handle, so the next sweep to reach it reads the answer
        // whichever replica that turns out to be. Only the measured answer is
        // shared this way -- the give-up below infers `idle` from this replica's
        // own probes failing, which is a statement about one replica's network
        // and not something to publish to the others.
        await persistVerdict(deps, sessionId, identity, running, epoch);
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
          bgProbeCache.set(identity, { at: Date.now(), state: "idle", epoch });
          logger.warn(
            { sessionId, workloadId: info.workloadId, streak },
            "keepalive.background_work_unknown_giving_up",
          );
        }
      })
      .finally(() => { bgProbeInFlight.delete(identity); });
  }
  bgProbeCursor = start + started;
  return started;
}

/**
 * Record a measured background-work answer onto the handle itself.
 *
 * Re-reads instead of reusing the revision the sweep was holding: the answer
 * lands well after the walk that asked for it, and the entry has normally been
 * rewritten since -- by this same sweep's TTL refresh, if by nothing else.
 * Writing against the stale revision would fail every time, and that failure is
 * indistinguishable from success from here, because the write is best-effort.
 *
 * Only the two fields are set; the rest is carried over from the entry as just
 * read, so a concurrent writer's change to any other field survives unless it
 * landed inside this read-modify-write -- which is what the conditional update
 * catches.
 *
 * And only if the entry still names the sandbox that was probed. The revision
 * check cannot see that: it is taken against the read this function just made,
 * so an entry another replica replaced while the probe was in the air matches
 * its own fresh revision and the update succeeds -- stamping one sandbox's shell
 * count onto a different one. Believed for BG_VERDICT_TTL_MS afterwards, that is
 * either a pod kept alive on a verdict about a pod that is gone, or a working
 * one reclaimed early. The key is the session; the identity is the sandbox, and
 * the identity is what the answer was about.
 *
 * And only if the handle is still in the idle period that was probed. Identity
 * does not move when the same pod is handed back to a task and idled again, so
 * without this the answer measured before the task lands on the entry after it
 * -- reporting an empty sandbox for a task that may have left a background shell
 * behind. The epoch comes from the scan that formed the candidate, so a
 * reactivation anywhere in the probe's flight is caught here as well as by the
 * generation the promise carries.
 */
async function persistVerdict(
  deps: KeepaliveDeps,
  sessionId: string,
  identity: string,
  running: number,
  epoch: number | undefined,
): Promise<void> {
  try {
    const key = `hands.${sessionId}`;
    const e = await deps.kv.get(key);
    if (!e) return;
    const info = JSON.parse(sc.decode(e.value)) as HandsKvEntry;
    if (entryIdentity(sessionId, info) !== identity) {
      // Somebody put a different sandbox behind this key. Dropping the write is
      // the same outcome as losing the revision race, and for the same reason:
      // the entry that is there now is newer than anything this answer knows.
      logger.info(
        { sessionId, workloadId: info.workloadId },
        "keepalive.background_work_answer_substituted",
      );
      return;
    }
    if (!sameIdlePeriod(epoch, info)) {
      logger.info(
        { sessionId, workloadId: info.workloadId },
        "keepalive.background_work_answer_reactivated",
      );
      return;
    }
    const next = sc.encode(JSON.stringify({
      ...info,
      bgCheckedAt: Date.now(),
      bgRunning: running,
      bgEpoch: epoch,
    }));
    await deps.kv.update(key, next, e.revision);
  } catch {
    // A revision conflict means another writer got there first, and any other
    // failure leaves the handle with no verdict -- which reads back as
    // `unknown`, the branch that keeps the sandbox rather than reclaiming one
    // that may still be working.
  }
}

/**
 * Move the idle clock forward on a handle whose sandbox is still working.
 *
 * `idleSince` is stamped once, when the task ended, and the reuse window is
 * measured from it. Left alone, a background job that outlasts the window means
 * the handle is already expired the moment the job finishes: the next sweep
 * deletes it, the next message in the session cannot reuse the pod, and whatever
 * the job wrote that has not been synced goes with it. Keeping the stamp at the
 * last moment work was seen gives the session the full window it would have had
 * if the job had never run.
 *
 * Conditional and best-effort, like every other write in this sweep: losing the
 * race means somebody else just wrote the entry, and their value is the newer
 * one.
 */
async function refreshIdleSince(
  deps: KeepaliveDeps,
  key: string,
  revision: number,
  info: HandsKvEntry,
): Promise<void> {
  try {
    const next = sc.encode(JSON.stringify({ ...info, idleSince: Date.now() }));
    await deps.kv.update(key, next, revision);
  } catch { /* lost the race, or KV is unhappy; the next sweep tries again */ }
}

/**
 * Run `fn` over every item, at most `limit` at a time.
 *
 * `Promise.all` over the whole list was fine while an idle handle was never a
 * ping target. It is not any more: an uncached handle answers `unknown`, and
 * `unknown` is pinged, so a cold start turns every handle in the bucket into a
 * simultaneous request -- from each replica, into one connection pool and one
 * control plane. Bounded rather than skipped, because unlike a probe a missed
 * ping is how a sandbox dies.
 */
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
        // Post-task idle reuse handle: keep it for reuse but never ping it, so
        // the pod idles out via the control-plane GC (no extra cost). Refresh
        // its TTL within the reuse window; expire it afterwards.
        // An idle handle whose sandbox is still working is not idle. Three
        // answers, because "no work" and "could not ask" are not the same
        // question and only one of them is safe to act on:
        //
        //   running  ping it, and move the idle clock forward so the reuse
        //            window starts when the work stops rather than when the
        //            turn did
        //   unknown  ping it and refresh the record's TTL, but leave the clock
        //            alone -- a blip must not decide this, and without the TTL
        //            write the bucket drops the entry on its own inside the
        //            tolerance window (both are five minutes)
        //   idle     the handle really is spare; the expiry below is unchanged
        //
        // Read, not asked: the probe runs behind the sweep and leaves its answer
        // for the next one. Under the identity of the sandbox this entry names,
        // so the answer cannot outlive the pod it was about.
        const identity = entryIdentity(sessionId, info);
        seenIdentities.add(identity);
        const peeked = info.keepalive === false
          ? peekBackgroundWork(identity, info)
          : { state: "idle" as BackgroundWork, source: null };
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
          // The generation is read here, not at dispatch. The candidate is a
          // judgement about the handle as this scan found it -- idle, unprobed
          // -- and dispatch happens after the whole walk, so a registerSandbox
          // landing in between would bump the generation and then be read as
          // the generation this candidate was formed under. The answer would
          // survive a reuse it should have been discarded by.
          probeCandidates.push({
            identity, sessionId, info, generation: bgGeneration.get(identity) ?? 0,
          });
        }
        if (info.keepalive === false && bgWork === "running") {
          await refreshIdleSince(deps, key, e.revision, info);
        } else if (info.keepalive === false && bgWork === "unknown") {
          await deps.kv.update(key, e.value, e.revision).catch(() => {});
        }
        if (info.keepalive === false && bgWork === "idle") {
          const idleSince = typeof info.idleSince === "number" ? info.idleSince : 0;
          const expired = Date.now() - idleSince > SANDBOX_IDLE_REUSE_MS;
          // A session this replica is actively running is not idle, whatever
          // the entry says. The `local wins` short-circuit that used to guard
          // the whole KV branch was removed so DAG siblings could each be
          // pinged, and it took this delete's protection with it: a reuse that
          // failed to clear the markers -- or an entry a sibling wrote while
          // this one was mid-turn -- now reads as an expired handle, and the
          // key naming the live workload goes out from under the run.
          if (expired && registeredSandboxCount(sessionId) > 0) {
            // No TTL refresh needed here: a session this replica has registered
            // is also a local ping target, and that path re-puts the entry at
            // the revision it read. Refreshing again would be a second write
            // per tick for the same effect.
            logger.info(
              { sessionId, workloadId: info.workloadId },
              "keepalive.idle_handle_kept_locally_active",
            );
            stats.keptLocal += 1;
            continue;
          }
          if (expired && await sessionHasActiveRunLease(deps.kv, sessionId, info.runScope)) {
            // The check above answers "is THIS replica running it", which the
            // other replicas answer with zero for a session they are not
            // running. The run lease is the fleet-wide form of the same
            // question, and without it whichever replica sweeps first deletes
            // the key naming a workload that is in use.
            logger.info(
              { sessionId, workloadId: info.workloadId },
              "keepalive.idle_handle_kept_run_in_flight",
            );
            stats.keptRunLease += 1;
            continue;
          }
          if (expired) {
            // Counted and logged on the delete landing, not on it being
            // attempted: the conditional delete loses to any writer that touched
            // the entry first, and a swallowed failure reported as a reclaim is
            // the counter saying the loop is moving while it is stuck.
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
            // Refresh the TTL only, no ping -- and conditionally, because an
            // unconditional put bumps the revision that ensureHands is holding
            // while it reactivates this very handle. Losing the race is the
            // correct outcome: whoever won either refreshed the same TTL or
            // took the handle out of idle, and neither wants this write.
            await deps.kv.update(key, e.value, e.revision).catch(() => {});
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

        // Renew the record here rather than after the ping it is waiting for.
        // Pings run bounded and in turn, and one can take its whole command
        // timeout plus transport slack, so a large enough fleet leaves the tail
        // of the queue waiting longer than the bucket's own TTL: the handle would
        // expire before its ping ever arrived, and the sweep guard means no other
        // sweep is coming to renew it. The revision is already in hand, so this
        // costs a write and no read.
        await deps.kv.update(key, e.value, e.revision).catch(() => {});

        const targetKey = sandboxRegistryKey(sessionId, entry);
        if (!targets.has(targetKey)) targets.set(targetKey, { sessionId, entry });
      } catch { /* malformed — skip */ }
    }
  } catch (err) {
    logger.warn({ err }, "keepalive.kv_scan_failed");
  }

  // After the walk, not during it: the cap is global and the cursor rotates, so
  // who gets a slot has to be decided once the candidates are all known. Counted
  // from what it started rather than from the candidate list, which the cap can
  // leave far behind -- `probes: 50` on a tick that opened eight is the reading
  // that would send someone looking for the wrong problem.
  stats.probes += dispatchProbes(deps, probeCandidates);

  return targets;
}

/**
 * Periodically exec a no-op inside every active sandbox to refresh the
 * SaFE Workload Manager's lastActivity timestamp, preventing idle GC.
 */
/**
 * One sweep, exported so its decisions can be tested without an interval.
 *
 * The branch that matters most is the idle-handle expiry: it deletes the only
 * record of a live workload, and the `local wins` short-circuit that used to
 * protect it is gone.
 */
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
  // The background-work bookkeeping is reaped by age, not by whether this sweep
  // happened to see the identity.
  //
  // "Not seen" looks like it means "the pod is gone", and it does not. A sweep
  // walks the handles the KV walk returned this tick, which on a multi-replica
  // Brain is a rotating slice -- so an identity is absent from most sweeps while
  // its sandbox is perfectly alive, and reaping on absence discarded every
  // verdict about a minute after it was written, long before the sweep that
  // would have read it. `unknown` then became the permanent answer, `unknown` is
  // the branch that keeps the handle, and idle sandboxes were pinged until the
  // CR's absolute deadline instead of being reclaimed.
  //
  // Age is the property that actually says an answer is no longer worth
  // believing, and it bounds the maps on its own: an identity nothing probes
  // again stops being refreshed and falls out one TTL later.
  const verdictFloor = Date.now() - BG_VERDICT_TTL_MS;
  for (const [identity, cached] of [...bgProbeCache.entries()]) {
    if (cached.at < verdictFloor) forgetBackgroundWork(identity);
  }
  // Streaks the same way, and for the same reason. A failed probe deliberately
  // caches nothing -- only a measured answer is worth reusing -- so reaping a
  // streak because no cached answer accompanies it discarded it on the first
  // tick that walked elsewhere, and the count restarted at one every time. Five
  // consecutive failures were then unreachable under the rotation this module
  // actually runs under, and the give-up that settles a permanently unreachable
  // Hands to idle never happened.
  //
  // A run of failures that has stopped being added to is what "no longer worth
  // counting" means, and that is an age.
  const streakFloor = Date.now() - BG_UNKNOWN_STREAK_TTL_MS;
  for (const [identity, streak] of [...bgUnknownStreak.entries()]) {
    if (streak.at < streakFloor) bgUnknownStreak.delete(identity);
  }
  // Generations outlive the two maps above on purpose -- a bumped generation is
  // what discards an in-flight answer, so it has to survive the answer -- but
  // only that long. forgetBackgroundWork writes an entry every time, including
  // for identities it is forgetting, so a Brain that has seen a lot of
  // sandboxes would keep one integer per sandbox it has ever seen, forever.
  //
  // With nothing in flight there is no token anyone still holds, so the entry
  // can go entirely; a later probe under the same identity starts from 0 again
  // with no stale answer able to match it. An identity still being probed keeps
  // its entry and is collected on a later sweep.
  for (const identity of [...bgGeneration.keys()]) {
    if (!seenIdentities.has(identity) && !bgProbeInFlight.has(identity)) {
      bgGeneration.delete(identity);
    }
  }

  // Ahead of the early return, because a sweep with no ping targets is not a
  // sweep with nothing to say: a fleet that is entirely idle reclaims its pods
  // through exactly that path, and logging only when something is left to ping
  // makes the successful case the invisible one.
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

  // Rotated, so a sweep that cannot finish does not always give up on the same
  // tail. Ordering is otherwise insertion order, which is stable across sweeps.
  const ordered = [...targets.entries()];
  const pingStart = pingCursor % ordered.length;
  const rotated = ordered.slice(pingStart).concat(ordered.slice(0, pingStart));
  const pingDeadline = Date.now() + (deps.pingBudgetMs ?? PING_PHASE_BUDGET_MS);
  let pinged = 0;
  let deferred = 0;
  const failures: KeepaliveFailure[] = [];

  await forEachWithLimit(rotated, PING_MAX_IN_FLIGHT, async ([targetKey, target]) => {
    // Checked as each target is picked up, so this bounds when a ping may
    // start, not when the phase ends: the pings already running continue past
    // the deadline. See PING_PHASE_BUDGET_MS.
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
      // Collected, not decided here: whether a `gone` may evict depends on how
      // many OTHER targets reported gone in the same sweep -- more than one is
      // more likely a shared control-plane fault than simultaneous loss -- and
      // that is only knowable once the sweep has finished.
      failures.push({
        targetKey, sessionId, entry, error: err,
        gone: err?.sandboxGone === true,
      } satisfies KeepaliveFailure);
    }
  });

  // Advance past what was actually pinged, so the deferred tail leads the next
  // sweep. Reported rather than silent: a sweep that cannot cover the fleet
  // inside half a TTL is a capacity signal, and the failure it precedes -- a
  // handle expiring un-pinged -- looks like nothing at all from the outside.
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
  // Guarded, because a sweep is not guaranteed to finish inside its interval:
  // it walks every KV handle serially and can make a network call per idle one.
  // Overlapping sweeps would double every write in here and race each other's
  // conditional updates, and the symptom -- handles refreshed twice, others not
  // at all -- would read as KV flakiness rather than as this.
  timer = setInterval(() => runGuardedSweep(deps), SANDBOX_KEEPALIVE_INTERVAL_SEC * 1000);
  timer.unref?.();
}

/**
 * One sweep, never two at once.
 *
 * A sweep is not guaranteed to finish inside its interval -- it walks every KV
 * handle in sequence and writes as it goes -- and overlapping sweeps double
 * every write and race each other's conditional updates. The symptom would be
 * handles refreshed twice and others not at all, which reads as KV flakiness
 * rather than as this.
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
