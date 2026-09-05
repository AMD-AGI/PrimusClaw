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
  /**
   * Epoch ms when the handle became idle; used to expire it after the window.
   *
   * Also the anchor every background-work verdict is checked against, because it
   * is the one field on this entry that EVERY version of this code stamps when a
   * handle enters the idle pool -- markHandsIdle and parkHandsHandle both write
   * it unconditionally, and they have since long before the epochs below
   * existed. That is what makes it usable across a rolling deployment, where the
   * epochs are not: see `measuredUnderThisIdlePeriod`.
   *
   * Where the reuse window starts counting is `reuseWindowStart`, not this on
   * its own -- see `workSeenAt` for why the two are no longer the same number.
   */
  idleSince?: number;
  /**
   * Epoch ms when a sweep last SAW background work running in this sandbox.
   *
   * `idleSince` cannot be the verdict anchor and the reuse clock at the same
   * time. As the anchor it must never move ahead of the verdict that justified
   * moving it, or the verdict invalidates itself on the next sweep, so
   * refreshIdleSince may only carry it up to the measurement -- which is as much
   * as BG_VERDICT_TTL_MS old. As the reuse clock it has to say "now", or a
   * sandbox whose long job has just finished starts its window already most of
   * the way through it, and one whose last measurement is older than the window
   * is deleted by the very next sweep with no reuse time at all.
   *
   * So the two readings get two fields. This one is stamped `Date.now()` by the
   * sweep that acts on a `running` verdict, and the window runs from whichever
   * of the two is later. Absent on entries written before it existed, and on
   * handles no sweep has ever found working.
   */
  workSeenAt?: number;
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
   * The KV revision the write that opened this idle period was conditioned on.
   *
   * `idleEpoch` cannot identify a period on its own, because it is a copy of
   * `idleSince` -- markHandsIdle stamps one from the other -- so any two idle
   * periods whose `idleSince` readings land on the same millisecond carry the
   * same epoch too. Both halves of the witness below then collapse together, and
   * a verdict from the earlier period reads as current for the later one: the
   * ABA the wall clock cannot rule out, because a clock reading is not a
   * unique name for the moment it was read at.
   *
   * A revision is. Every write to a key is conditioned on the revision it read,
   * the bucket accepts exactly one write per revision, and the revision it
   * produces is strictly greater -- so the revision an idle-opening write was
   * conditioned on is a name no later idle-opening write on this key can be
   * given. Not compared as an ordering, only as a value: see
   * `measuredUnderThisIdlePeriod`.
   *
   * Absent on entries written before it existed, and backfilled in
   * collectTargets for the same reason `idleEpoch` is -- an unstamped handle can
   * never hold a witnessed verdict, so leaving it unstamped costs a probe per
   * sweep forever rather than once.
   */
  idleRev?: number;
  /**
   * The last background-work answer, and when it was taken.
   *
   * On the handle rather than only in memory because the sweep that asks and the
   * sweep that reads are not the same process. A Brain replica walks a rotating
   * slice of the handles -- as few as one per tick -- so a given handle comes
   * back to a given replica on the order of tens of minutes, and any
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
   *
   * Necessary and not sufficient, though: a replica running the previous build
   * opens a new idle period without touching either number, so a match it
   * carried forward proves nothing. `bgIdleSince` is the half of the question
   * that survives a rolling deployment.
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
   * Probes outstanding somewhere in the fleet, as token -> deadline in epoch ms.
   *
   * The in-process set that stops one replica asking the same question twice is
   * invisible to every other replica, and the reclaim is decided by whichever
   * replica sweeps next. So a handle could be deleted while a probe about it was
   * still in the air: the answer then lands on a key that no longer exists and
   * is dropped rather than read, and when that answer is `running` the pod is
   * reclaimed with a background shell in it. Publishing the question, and not
   * only the answer, is what closes that -- for the same reason the verdict
   * itself is published, that the sweep which asks and the sweep which acts are
   * not the same process.
   *
   * A map rather than one deadline because two replicas probing the same handle
   * in the same idle period is the ordinary case here -- it is the race every
   * rule around the verdict exists for -- and a single field cannot be released
   * by one of them without silently dropping the other's protection. Each probe
   * holds its own token and removes that one only.
   *
   * The deadline is the backstop for a replica that stops existing mid-probe,
   * read against the reader's clock the way `bgCheckedAt` already is: skew moves
   * the grace by its own size in either direction, which buys a handle kept
   * slightly longer or a grace slightly shorter, and neither of those is the
   * failure this exists to prevent. Expired tokens are dropped by every writer
   * that touches the map, so a replica that never comes back leaves nothing
   * behind on the entry.
   */
  bgProbes?: Record<string, number>;
  /**
   * The idle stamp's own reading, set aside while a reservation is carrying that
   * stamp forward, and the reading it is being carried to.
   *
   * `bgProbes` above is the reservation every CURRENT replica reads. A replica
   * running the previous build reads none of it: before reclaiming a spare
   * handle its sweep asks one question -- has this been idle longer than the
   * reuse window -- and answers it from `idleSince`, the only field of this
   * mechanism that predates the mechanism. So a probe reserved here and still
   * outstanding is invisible to that sweep, and a handle it finds a millisecond
   * past the window is deleted with the question still open. The answer lands on
   * a key that is gone, and when the answer was `running` the pod is reclaimed
   * with a background shell in it -- the exact failure `bgProbes` exists to
   * prevent, reached by a replica that cannot see `bgProbes`.
   *
   * What every replica does read is the stamp. So the reservation is stated
   * there too: `idleSince` is carried forward just far enough that the handle
   * does not read as expired to the old arithmetic before this reservation
   * lapses, and `base` is what it read before that.
   *
   * Deliberately not a blanket refresh. Sliding the stamp on every reservation
   * would restart the whole reuse window on every probe, and the window is what
   * decides when a spare pod goes back -- a handle re-probed every few minutes
   * would never reach the end of one. The carry is applied only when the handle
   * would otherwise read as expired DURING the reservation, and only as far as
   * that reservation's own deadline: see probeIdleHoldTarget.
   *
   * Two fields rather than one because the carry has to be undone exactly, and
   * "how far it was carried" is not recoverable from the entry afterwards. `to`
   * is also what tells a carry still in force from one another writer has
   * already superseded -- a re-idle, or the running refresh, moves `idleSince`
   * off this value, and a record whose `to` no longer matches the stamp is a
   * record about a reading that is gone. Nothing is restored from one of those,
   * and nothing reads through one: see idlePeriodStamp.
   */
  probeIdleHold?: { base: number; to: number };
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
      // And the half of the period's name that two periods cannot share. The
      // revision this write is conditioned on: the bucket takes one write per
      // revision, so no other idle-opening write on this key can ever be given
      // the same one -- unlike the stamp above, which is a clock reading and can
      // repeat. Read here rather than after the write because the write's own
      // revision is not knowable until it lands, and the value only has to be
      // unique, not to be the write's own number.
      info.idleRev = entry.revision;
      delete info.bgCheckedAt;
      delete info.bgRunning;
      delete info.bgEpoch;
      delete info.bgIdleSince;
      delete info.bgIdleRev;
      delete info.bgRev;
      // And any carry a reservation from the last period left on the stamp. The
      // stamp above is this period's own, so there is nothing left to put back
      // and a record saying otherwise names a reading that is gone.
      delete info.probeIdleHold;
      // Same reason, for the clock those verdicts moved: work seen during the
      // last idle period says nothing about this one. `reuseWindowStart` would
      // ignore it anyway -- the stamp above is later than anything from before
      // it -- but leaving it published invites the next reader to disagree.
      delete info.workSeenAt;
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
 * whichever replica sweeps next, so it has to survive one rotation of the
 * handles. A streak is in-process, owned by the replica that failed, so it has
 * to survive until THAT replica returns, which is that same rotation multiplied
 * by the replica count -- tens of minutes even on a small fleet, and longer on a
 * bigger one or a larger bucket of handles. A lifetime shorter than that is what
 * made the give-up path unreachable: every failure aged out before the same
 * replica could fail again, so the streak never left one.
 *
 * Four hours is that interval with room for a fleet several times the size,
 * because the two directions are not symmetrical. Too short and the give-up path
 * exists but can never fire, which is the bug above. Too long and a run of
 * failures separated by hours is treated as consecutive -- a Hands that failed
 * five times over an afternoon is not one anybody wants pinned either, and the
 * only thing it costs is one integer per identity until the reap below.
 */
const BG_UNKNOWN_STREAK_TTL_MS = 4 * 60 * 60_000;

/**
 * How long the give-up answer is believed.
 *
 * The give-up path infers `idle` after BG_UNKNOWN_TOLERANCE consecutive failed
 * probes, and deliberately keeps that inference in this process only -- it is a
 * statement about one replica's reach, not a measurement to publish to the
 * others. Which leaves it with only the in-process TTL to live under, and
 * BG_PROBE_TTL_MS is five minutes: shorter than the gap until the same replica
 * walks this handle again.
 *
 * That gap is the one BG_UNKNOWN_STREAK_TTL_MS is sized for and not the one
 * BG_PROBE_TTL_MS is. A measured answer only has to survive until *some*
 * replica returns, because it is written to the handle where any of them can
 * read it. An inferred one is readable by the replica that inferred it and by
 * no other, so it has to survive until THAT replica comes back to the handle --
 * the probe rotation multiplied by the replica count, which runs to tens of
 * minutes even on a small fleet and longer on a bigger one or a larger bucket.
 * At five minutes it did not: the inference expired before the visit that would have acted on it, the
 * handle was probed again, the probes failed again, and the streak gave up
 * again -- six, seven, eight failures deep, on a Hands that has stopped
 * answering, which is precisely the sandbox the give-up path exists to release.
 *
 * So it is sized against the same interval the streak is, and shares the
 * constant so the two cannot drift apart: they are two halves of one mechanism,
 * and a give-up that outlives its own streak or dies before it is a mechanism
 * with a hole in it.
 *
 * The length is how long the answer is BELIEVED, and deliberately not how long
 * this replica stops asking -- see needsProbe, which keeps probing on the
 * ordinary BG_PROBE_TTL_MS. That is what keeps the cost bounded: a Hands that
 * comes back is measured within one probe and the inference is replaced, while
 * one that stays away is asked once more and, when that fails too, read as
 * `idle` and its handle reclaimed on the next sweep past the reuse window --
 * see `retested` on the cache entry for why the reclaim waits for that second
 * refusal. An inference is also discarded, exactly as a measured answer is, by
 * anything that opens a new idle period on the handle.
 */
const BG_GIVEUP_TTL_MS = BG_UNKNOWN_STREAK_TTL_MS;

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
 * How long a published probe reservation holds a reclaim off, at most.
 *
 * It has to outlive the whole question rather than just the request. The probe
 * is bounded by its own transport timeout, but the answer is filed through a
 * read-modify-write that re-reads and re-tries while other replicas write to the
 * same key, and it is that tail -- not the call -- the reclaim was racing.
 *
 * And it has to be well short of BG_PROBE_TTL_MS, which is the cadence a handle
 * is re-asked about. A grace as long as the gap between two probes is a grace
 * that never lapses, and a handle whose reclaim is deferred forever is exactly
 * what the reuse window exists to rule out. A minute sits comfortably above the
 * first quantity and comfortably below the second.
 *
 * It is a ceiling and not a wait: the reservation is released as soon as the
 * answer is filed, so the ordinary reclaim is delayed by one probe's round trip
 * and this number is only reached when a replica stops answering for its own.
 */
export const BG_PROBE_RESERVE_MS = 60_000;

/**
 * How many times a probe reservation re-reads and re-writes before the probe is
 * given up on for this sweep.
 *
 * The reservation is a read-modify-write on the same key every other replica is
 * writing to, so losing the conditional update is ordinary rather than
 * exceptional -- a second replica reserving the same handle, a verdict being
 * published, a reservation being released all move the revision underneath it.
 * One attempt therefore does not mean "reserved"; it means "reserved unless
 * anything else touched the entry", which is not a protection anything can be
 * dispatched behind.
 *
 * A smaller budget than a `running` verdict's, because running out here is the
 * neutral outcome that one does not have. What a probe that cannot reserve
 * leaves behind is no answer at all, which reads back as `unknown` -- the branch
 * that keeps the sandbox and pings it -- and the next sweep asks again a tick
 * later. So this only has to outlast the contention of a moment, not outlast a
 * competing answer.
 */
const BG_PROBE_RESERVE_ATTEMPTS = 8;

/**
 * How many times a `running` verdict re-reads and re-writes after losing the
 * conditional update.
 *
 * The write is a read-modify-write with no lock around it, so two replicas
 * probing the same handle in the same idle period can both read the entry
 * before either of them writes to it. Neither sees the other's verdict at the
 * guard, both condition their update on the revision they read, and exactly one
 * of them lands -- chosen by which write reached the store first, which is the
 * one thing about these two answers that carries no information. The guard
 * below settles a race between an answer already on the entry and one arriving
 * after it; this settles the race the guard cannot see, where the two answers
 * are decided against the same revision.
 *
 * Retrying is only for `running`, and the count is a liveness backstop rather
 * than the thing that makes the write safe. It used to be a handful, sized to
 * the number of replicas that can be probing one handle at one moment. That is
 * a fair estimate of the contention and the wrong thing to bound by, because
 * running out is not a neutral outcome here. What a `running` answer leaves
 * behind when it stops is not "no answer" but the `idle` that just beat it, and
 * the next replica to read that reclaims a sandbox with a shell in it -- so an
 * `idle` that keeps arriving for as long as the `running` keeps trying wins by
 * outlasting it. Level with the contention is exactly the budget that loses
 * that way.
 *
 * So it is set far above what it has to survive instead: a fleet's worth of
 * replicas all publishing about one handle inside one idle period, several
 * times over. The attempts are only spent while writes are actually being lost,
 * and each one costs a round trip on a path that is already off the sweep's
 * critical path, so the ceiling is paid for only in the case it exists for.
 *
 * It stays a ceiling rather than becoming an unbounded loop because a store
 * that refuses every conditional update is a different fault from a contended
 * key, and spinning on it forever would hide that one instead of reporting it.
 * Reaching it is logged as the unsafe outcome it is.
 */
const BG_VERDICT_WRITE_ATTEMPTS = 64;

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
  {
    at: number; state: BackgroundWork; epoch?: number; idleSince?: number; idleRev?: number;
    /** Not measured: the give-up path inferred it. See BG_GIVEUP_TTL_MS. */
    inferred?: boolean;
    /**
     * A probe attempted after this inference was first formed has also failed.
     *
     * Which is what lets an aged inference delete a handle. Without it the
     * sweep decides the one irreversible thing in this file from a guess it
     * has, in the same tick, just judged stale enough to re-ask: the delete
     * happens during the walk and the probe goes out after it, so a Hands that
     * came back is measured seconds too late and the answer lands on a key that
     * is gone. Waiting for the re-ask costs one visit, during which the handle
     * is kept and pinged, which is the direction a wrong guess is free in.
     *
     * And it is what stops that wait from becoming permanent: the failed
     * re-ask rewrites the inference, so without a mark saying the question has
     * already been put again, every visit would find a stale answer, re-ask,
     * and defer -- the give-up path suspending a handle forever instead of
     * releasing it.
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
 * was silent -- the branch a stalled fleet sits in emitted nothing, so a stalled
 * reclaim loop and a healthy quiet one produced identical logs. `bgUnknown` high
 * with `expired` at zero across consecutive ticks is that stall, and it is now
 * on the line every sweep already emits.
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
 * An unstamped verdict is not one, and treating two absent fields as a match is
 * the same mistake in a quieter form: `undefined === undefined` reads as "the
 * same period" when what it means is "no period was ever recorded". An entry the
 * new markHandsIdle has not run on yet is exactly that -- and it does not become
 * stamped by being probed, so the window is not the rollout, it is forever for
 * every handle that idles without passing through this build. The verdict on one
 * is then believed across any number of task-and-idle cycles, which is the bug
 * the epoch exists to close.
 *
 * So the epoch has to be a number, and it has to match. An unstamped verdict is
 * ignored the way a wrong-epoch one is: the handle reads `unknown`, which keeps
 * and probes it, and the answer that comes back is stamped. The population it
 * applies to also shrinks on its own -- see the backfill in collectTargets.
 */
function sameIdlePeriod(verdictEpoch: number | undefined, info: HandsKvEntry): boolean {
  return typeof verdictEpoch === "number" && verdictEpoch === info.idleEpoch;
}

/**
 * The stamp that names this handle's idle period, with any probe carry read
 * back out of it.
 *
 * `idleSince` is doing two jobs, and a reservation moves it for exactly one of
 * them. As the reuse clock it is arithmetic -- how long has this been spare --
 * and that is the reading a reservation has to reach, because it is the only one
 * a replica running the previous build consults. As the verdict anchor it is a
 * name -- which idle period is this -- compared by equality and never by
 * ordering, and a name that moves because a probe was reserved is a name that
 * makes every answer about the period look like an answer about a different one.
 *
 * So the carry is applied to the field and read back out of it here, and every
 * reader that wants the name goes through this while the expiry arithmetic reads
 * the field directly. A verdict is then measured, filed and believed under one
 * unchanging value for the whole period, whether or not a probe was outstanding
 * when it was taken -- and the restore in releaseProbe has nothing to put back
 * but the number itself.
 *
 * A record whose `to` does not match the stamp is not describing the stamp that
 * is there, so it is not read through: some other writer set that value, and it
 * is the value itself that names the period now.
 */
function idlePeriodStamp(info: HandsKvEntry): number | undefined {
  const hold = info.probeIdleHold;
  if (hold && hold.to === info.idleSince) return hold.base;
  return info.idleSince;
}

/**
 * Whether a verdict measured at `at`, under the stamp `witness`, can be about
 * the idle period the handle is in now.
 *
 * The epoch check above is necessary and not sufficient, because it asks a
 * question only this build knows how to answer. During a rolling deployment the
 * other replicas are still running the binary these fields were added in, and
 * that binary carries them without understanding them: its activation path
 * deletes `keepalive` and `idleSince` and re-serializes everything else, and its
 * markHandsIdle sets `keepalive:false` and a fresh `idleSince` and
 * re-serializes everything else. So a handle stamped by a new replica, taken by
 * a task on an old one and idled again by it, comes back with `idleEpoch`,
 * `bgEpoch` and the verdict all preserved and all still agreeing -- an answer
 * measured before that task, reading as current for the idle period after it.
 * That is the reclaim this whole file exists to prevent, arriving through the
 * very mechanism added to prevent it: an old binary cannot open a new epoch, so
 * an epoch match it carried forward is not evidence that it did.
 *
 * `idleSince` is evidence, and it is the only field here that is. Every writer
 * that puts a handle into the idle pool stamps it fresh -- this build's
 * markHandsIdle, the previous build's, and parkHandsHandle -- so a new idle
 * period always moves it forward, whichever binary opened the period, and none
 * of them can leave the stamp of the period before untouched.
 *
 * What that evidence will not support is a comparison. The stamp and the
 * verdict's timestamp are two replicas' readings of two different clocks, and
 * "later number" is not "later event" between machines: ordinary skew of a
 * second is enough for the verdict a replica filed BEFORE an old binary took the
 * sandbox for a task to carry a larger number than the `idleSince` that old
 * binary wrote when it idled the sandbox again. Every ordering test then reads
 * the stale answer as the current one, and if it says `idle` the handle is
 * reclaimed with a background shell still in it. No tightening of the
 * inequality helps; the inequality is the mistake.
 *
 * So the `idle` branch does not compare the two numbers at all. It asks whether
 * the verdict was measured under THIS stamp -- `witness`, the value `idleSince`
 * had when the probe went out, recorded next to the answer it came back with.
 * Equality of a value cannot be skewed into the wrong answer: whatever a
 * re-idling replica's clock says, the number it stamps is its own reading of its
 * own now, not the number the previous period was identified by, so a verdict
 * carried across it fails to match no matter which of the two clocks is ahead.
 * An old binary cannot write a witness either, and does not have to: it
 * unavoidably replaces the value the witness names, which is what makes the
 * entry it touched read as suspect.
 *
 * Equality of THAT value is still not enough, because the value is a clock
 * reading and a clock reading is not unique. Two idle periods a quarter of an
 * hour apart can stamp the same millisecond -- and when they do they also share
 * `idleEpoch`, which markHandsIdle copies from the same stamp -- so a verdict
 * from the first reads as current for the second and the handle is deleted with
 * a background shell in it. That is an ABA, and no rule reading only timestamps
 * can close it: the two periods are described by identical numbers.
 *
 * `witnessRev` is the half that can be unique. The bucket accepts exactly one
 * write per revision of a key and hands out a strictly greater one each time, so
 * the revision an idle-opening write was conditioned on names that write and no
 * other, for the life of the key. Compared as a value, like the stamp -- the
 * ordering it happens to have is not what is being relied on, and an ordering
 * test here would be the same mistake in a currency that merely cannot be
 * skewed.
 *
 * Both must match, because neither closes what the other does. An old binary
 * carries `idleRev` across a task untouched, so the revision alone would read
 * its new idle period as the measured one -- the very case the stamp was added
 * for. A millisecond collision carries the stamp across, so the stamp alone is
 * the ABA above. Together they leave exactly one gap: an old binary re-idling
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
 * Both readings of a rejection are the same and are safe: the handle reads
 * `unknown`, which keeps and pings it, and one probe replaces the unwitnessed
 * verdict with a witnessed one. That is also what a handle or a verdict written
 * before `idleRev` existed reads as -- unwitnessed, one extra probe, witnessed
 * from then on -- rather than as a match between two absent fields. A handle
 * with no `idleSince` at all is not one any writer produces, and it is already
 * treated as instantly expired by the window below; no verdict about it is
 * believed.
 */
function measuredUnderThisIdlePeriod(
  at: number | undefined,
  witness: number | undefined,
  witnessRev: number | undefined,
  info: HandsKvEntry,
  state: BackgroundWork,
): boolean {
  // The stamp with any probe carry read out of it: a reservation moves the field
  // to keep an old sweep from reclaiming the handle, and that is arithmetic
  // rather than a rename. See idlePeriodStamp.
  const stamp = idlePeriodStamp(info);
  if (typeof stamp !== "number") return false;
  if (
    typeof witness === "number" && witness === stamp
    && typeof witnessRev === "number" && witnessRev === info.idleRev
  ) return true;
  if (state !== "running") return false;
  return typeof at === "number" && at >= stamp;
}

/**
 * When this handle's reuse window starts counting.
 *
 * The later of the two stamps, because they answer different halves of the
 * question and either one can be the current answer. `idleSince` is when the
 * idle period began and is the only one a replica running the previous build
 * writes, so after a task that ran on an old replica it is the fresh value and
 * `workSeenAt` is a leftover from before. `workSeenAt` is when work was last
 * seen running, and while a long background job is going it is the fresh one --
 * `idleSince` sits back at the measurement that justified it, by as much as the
 * verdict TTL.
 *
 * A leftover can never win. Every writer that opens an idle period stamps
 * `idleSince` with the moment it did so, and that is later than any `workSeenAt`
 * the period before it can have left behind.
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
  // The same rule as the shared copy, and for the same reason: nothing bumps
  // this process's generation when the reactivation happens on another replica,
  // so an in-process answer survives an old binary's task-and-idle cycle exactly
  // as an entry-borne one does.
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
): { state: BackgroundWork; source: VerdictSource; at?: number } {
  if (!info.handsUrl || !info.token) return { state: "idle", source: "no-hands" };
  // An inference this tick has judged stale enough to re-ask is not an answer
  // to act on until the re-ask reports: the delete happens here, during the
  // walk, and the probe goes out after it. While that is outstanding the handle
  // reads `unknown`, which keeps and pings it. A fresh inference re-arms
  // nothing and stands on its own, and one a later probe has already refused
  // (`retested`) stands however old it is -- otherwise the re-ask would renew
  // its own doubt every visit and the give-up could never reclaim anything.
  const local = usableCachedVerdict(identity, info);
  const beingReasked = !!local?.inferred && !local.retested
    && Date.now() - local.at >= BG_PROBE_TTL_MS;
  const cached = beingReasked ? null : local;
  const shared = usableSharedVerdict(info);
  // Which of the two answers to act on, when both are about this idle period
  // and they disagree.
  //
  // The obvious rule is the newer one, and it cannot be asked here. The two
  // stamps are two replicas' readings of two different clocks -- the same
  // reason `measuredUnderThisIdlePeriod` refuses to compare `bgCheckedAt`
  // against `idleSince` -- so "larger number" is not "later measurement", and
  // ordinary skew of a second is enough to invert it. A pure ordering test
  // here is that mistake in a third currency: another replica measures
  // `running` after this one measured `idle`, its clock reads slightly behind,
  // and the local `idle` wins the comparison and deletes the handle with a
  // background shell in it.
  //
  // So the choice is made by what the two answers are, not by when they say
  // they were taken, because the two ways of being wrong are not the same
  // size. Acting on a stale `running` costs one ping of a sandbox that did not
  // need it. Acting on a stale `idle` reclaims a pod that is still working --
  // the failure this whole branch exists to prevent. `running` therefore wins
  // outright, from whichever copy holds it, and an `idle` decides nothing while
  // any live measurement disagrees with it.
  //
  // That is also the rule that makes the sharing do its job, and it subsumes
  // the ordering the sharing was added for: a `running` recorded on the entry
  // by another replica is read here even though this replica has its own older
  // `idle`, with no clock comparison to get wrong.
  //
  // The stamps are still read when both answers agree on `running`, but only to
  // pick the later one, and only because `at` is the anchor refreshIdleSince
  // moves. Skew cannot do harm there: that write takes the max of the anchor it
  // finds and the one it is given, so a reading off a slow clock leaves the
  // stamp where it was, and the reuse clock beside it is stamped locally.
  if (cached?.state === "running" && shared?.state === "running") {
    return cached.at >= shared.at
      ? { state: "running", source: "mem", at: cached.at }
      : { state: "running", source: "handle", at: shared.at };
  }
  if (cached?.state === "running") return { state: "running", source: "mem", at: cached.at };
  if (shared?.state === "running") return { state: "running", source: "handle", at: shared.at };
  // Neither says `running`, so any answer left is `idle` and they agree. Which
  // one is reported is a stats question only.
  if (cached) return { state: cached.state, source: "mem", at: cached.at };
  if (shared) return { state: shared.state, source: "handle", at: shared.at };
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
  const cached = usableCachedVerdict(identity, info);
  // But only for as long as a probe would be redundant, which is not the same
  // as for as long as the answer is worth reading. They were one number while
  // every cached answer was a measurement; the give-up inference is not one,
  // and it lives eight times longer -- so reusing that lifetime here would make
  // it the one answer this replica can never revise. Nothing else revises it
  // either: a handle sitting inside its reuse window is not deleted and opens no
  // new idle period, so no probe means no correction, and a Hands that blipped
  // for six probes and came straight back would have its pod reclaimed at the
  // end of the window with a background shell still in it.
  //
  // So belief and silence are decoupled: the inference is read for
  // BG_GIVEUP_TTL_MS and stops suppressing probes after the ordinary
  // BG_PROBE_TTL_MS, which is what makes it a floor for the sweeps that have to
  // act before an answer arrives rather than a decision not to ask again. A
  // measured answer is unaffected -- for it the two lifetimes are the same
  // number, as they were.
  if (cached && Date.now() - cached.at < BG_PROBE_TTL_MS) return false;
  return !bgProbeInFlight.has(identity);
}

/**
 * A name for one probe, unique across the fleet for as long as it is held.
 *
 * Only has to distinguish the probes whose reservations sit on one entry at one
 * moment, which is a handful; the prefix is what keeps two replicas from
 * choosing the same name for two different questions.
 */
const bgProbeTokenPrefix = Math.random().toString(36).slice(2, 10);
let bgProbeTokenSeq = 0;
function nextProbeToken(): string {
  bgProbeTokenSeq += 1;
  return `${bgProbeTokenPrefix}${bgProbeTokenSeq.toString(36)}`;
}

/**
 * The reservations on an entry that have not timed out, pruned on the way past.
 *
 * Every writer that touches the map prunes it, so a token whose replica stopped
 * answering is removed by the next probe of the same handle rather than needing
 * a sweep of its own.
 */
function liveProbeReservations(info: HandsKvEntry, now: number): Record<string, number> {
  const live: Record<string, number> = {};
  for (const [token, until] of Object.entries(info.bgProbes ?? {})) {
    if (typeof until === "number" && until > now) live[token] = until;
  }
  return live;
}

/**
 * How far the idle stamp has to be carried for a reservation lasting until
 * `until` to be visible to a sweep that reads nothing but that stamp -- or null
 * when it already is.
 *
 * The old arithmetic is `now - idleSince > SANDBOX_IDLE_REUSE_MS`, so the handle
 * stops reading as expired at `idleSince + SANDBOX_IDLE_REUSE_MS`, and the
 * reservation needs it to still read that way at `until`. Nothing to do while
 * the first is at or beyond the second: the boundary is inclusive because the
 * comparison it has to survive is strict, and a handle whose window ends exactly
 * as the reservation does is not expired at that instant.
 *
 * Otherwise the carry is the smallest one that reaches -- the reading whose
 * window ends exactly at the reservation's deadline. Not `now`, which would hand
 * the handle a whole fresh window for the sake of one probe, and not the
 * reservation's length added to whatever is there, which would compound across
 * successive probes into the unbounded deferral the reuse window exists to rule
 * out.
 *
 * `idleSince` and not `reuseWindowStart`, because the sweep this is addressed to
 * predates `workSeenAt` and cannot read it. A handle whose `workSeenAt` is fresh
 * is unexpired to a current replica and expired to that one, and it is that one
 * the carry is for.
 */
function probeIdleHoldTarget(idleSince: number | undefined, until: number): number | null {
  if (typeof idleSince !== "number") return null;
  if (idleSince + SANDBOX_IDLE_REUSE_MS >= until) return null;
  return until - SANDBOX_IDLE_REUSE_MS;
}

/** Whether any replica is still waiting on an answer about this handle. */
function probeOutstanding(info: HandsKvEntry): boolean {
  return Object.keys(liveProbeReservations(info, Date.now())).length > 0;
}

/**
 * Publish "a probe about this handle is outstanding" before asking, and report
 * whether the publication actually landed.
 *
 * Before, because the reservation is only worth writing while it can still
 * change a decision, and the decision it has to reach is a reclaim taken by
 * another replica at any point between here and the answer being filed.
 *
 * Conditional like every other write in this sweep, but not best-effort like
 * them, and the difference is what the caller does with the answer. A verdict
 * that loses its update leaves the entry carrying somebody else's, which is
 * still an answer; a reservation that loses its update leaves the entry carrying
 * nothing, and a probe dispatched behind it is unprotected -- no token on the
 * entry, so the next replica to read it sees no question outstanding and
 * reclaims the handle while this answer is in the air. That is the failure the
 * reservation exists to rule out, reached by the reservation itself being lost.
 *
 * So it re-reads and re-writes rather than swallowing the loss: losing the
 * revision means somebody wrote the entry, and the next attempt writes this
 * token onto whatever they left. It returns true only when the token is
 * genuinely on the entry -- the caller does not ask Hands otherwise -- and false
 * for a handle that has gone or been replaced, where the reservation has nothing
 * to protect and the answer would be dropped on arrival anyway.
 *
 * Under the identity that was probed, so a reservation is never written onto a
 * sandbox the question was not about.
 *
 * And in the same write, the half of the statement a replica running the
 * previous build can read: the token says "a question is open" to anything that
 * knows the field exists, and the stamp carried forward by
 * `probeIdleHoldTarget` says "not expired yet" to everything else. One write,
 * because the two are one statement and a handle protected against half the
 * fleet is not protected.
 *
 * The carry is arithmetic only. What the period is CALLED does not move with it
 * -- `idlePeriodStamp` reads it back out -- so the probe still goes out under,
 * and files its answer against, the one value the period has had all along.
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
      const until = now + BG_PROBE_RESERVE_MS;
      const bgProbes = { ...liveProbeReservations(info, now), [token]: until };
      const next: HandsKvEntry = { ...info, bgProbes };
      const target = probeIdleHoldTarget(info.idleSince, until);
      if (target !== null) {
        // The reading to go back to is the period's own stamp, which is what a
        // carry already in force is holding aside and what the field itself says
        // when none is. Reusing a superseded record's `base` instead is how a
        // restore would walk the window backwards past somebody's legitimate
        // advance; `idlePeriodStamp` is what refuses to read one.
        const base = idlePeriodStamp(info) as number;
        next.probeIdleHold = { base, to: target };
        next.idleSince = target;
      }
      await deps.kv.update(key, sc.encode(JSON.stringify(next)), e.revision);
      return true;
    } catch {
      // Either the update lost its revision or the round trip failed; neither is
      // distinguishable from here and neither has to be. What both mean is that
      // the token is not on the entry, so the next attempt reads what is there
      // now and writes the token onto that instead of resending this value
      // against a revision that has moved.
    }
  }
  return false;
}

/**
 * Take the reservation back once the question has closed.
 *
 * Not left to the deadline, because the deadline is sized for a replica that
 * stopped answering and a handle that answered promptly should not be held for
 * it -- the reclaim would then be deferred by a fixed minute per probe rather
 * than by the probe. Only this probe's own token, so a second replica still
 * waiting on its own answer keeps its protection.
 *
 * And the same for the stamp the reservation carried forward, on the same terms
 * and for the same reason. The carry states that a question is open, so it lasts
 * exactly as long as one is: once the last token is off the entry the stamp goes
 * back to the reading it was taken from and the handle expires on the schedule it
 * was already on. Anything else and a handle probed often enough is a handle
 * never reclaimed -- the reuse window defeated by the mechanism protecting it.
 *
 * Undone exactly, not approximately. `base` is the period's own stamp, so
 * restoring it can neither add life the handle did not have nor take away life it
 * did, and nothing else on the entry has to move with it -- every verdict was
 * measured and filed under that same value while the carry was in force. And only
 * while `to` still matches, which is what keeps this from clobbering a writer who
 * moved the stamp for a reason of their own: a task that re-idled the handle, or
 * the running refresh, both of which supersede the carry rather than race it.
 *
 * The last token, not this one's: a carry left behind by a replica that stopped
 * answering is released here rather than waiting for some later probe to touch
 * the entry, which is the rule the reservation map itself is pruned by.
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
    const mine = !!info.bgProbes && token in info.bgProbes;
    const bgProbes = liveProbeReservations(info, Date.now());
    delete bgProbes[token];
    const outstanding = Object.keys(bgProbes).length > 0;
    const hold = info.probeIdleHold;
    const restorable = !outstanding && !!hold && hold.to === info.idleSince;
    if (!mine && !restorable) return;
    const next: HandsKvEntry = { ...info, bgProbes };
    if (!outstanding) delete next.bgProbes;
    if (restorable && hold) {
      next.idleSince = hold.base;
      delete next.probeIdleHold;
    }
    await deps.kv.update(key, sc.encode(JSON.stringify(next)), e.revision);
  } catch { /* best effort: the deadline is the backstop */ }
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
    // And the stamp that identifies it. The answer describes the sandbox as it
    // was from the moment the probe went out, so the period it belongs to is the
    // one this value names -- which is what persistVerdict checks the entry
    // against when the answer lands, minutes later and possibly on the far side
    // of a task that another replica ran. A value rather than a time: see
    // measuredUnderThisIdlePeriod for why the comparison cannot be an ordering.
    // Read through `idlePeriodStamp`, so a reservation that carried the field
    // forward to keep an old sweep off the handle does not also rename the
    // period underneath its own answer.
    const idleSinceAtStart = idlePeriodStamp(info);
    // And the half of that name a second idle period cannot land on by accident.
    // The stamp alone is a clock reading, so two periods can be described by the
    // same one; this is the revision an idle-opening write was conditioned on,
    // which is unique per key by construction.
    const idleRevAtStart = info.idleRev;
    // And the verdict the handle was carrying when the question was asked, so an
    // answer of `idle` can tell a `running` published while it was in the air
    // from the one it read on the way out. See persistVerdict.
    const verdictAtStart = verdictWitness(info);
    if (bgProbeInFlight.has(identity)) continue;

    // `generation` came from the scan that formed this candidate, not from
    // here. Anything that invalidates the identity between the scan and the
    // promise landing moves it, and the result is dropped on arrival rather
    // than written over whatever replaced it. Checking again here would only
    // save a probe, and no test can tell the two apart -- the guard that
    // matters is the one at the landing.
    bgProbeInFlight.add(identity);
    started += 1;
    // And the fleet-wide half of the same statement, which is what a replica
    // deciding a reclaim can actually read. The probe below is dispatched only
    // if this one is published; see reserveProbe.
    const token = nextProbeToken();

    // True once anything has invalidated this identity since the candidate was
    // formed. Called again after every suspension point below, not once at the
    // top: each await is a window the generation can move in.
    const stale = () => (bgGeneration.get(identity) ?? 0) !== generation;

    void reserveProbe(deps, sessionId, identity, token)
      // Gated, not chained. The point of the reservation is that no answer is
      // ever in the air without one on the entry, and a probe sent regardless of
      // whether the write landed is exactly that -- so a reservation that could
      // not be published means the question is not asked this sweep. Deferring
      // it is cheap: the handle stays `unknown`, which is kept and pinged, and
      // the next tick asks again.
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
        bgProbeCache.set(identity, {
          at: Date.now(), state, epoch,
          idleSince: idleSinceAtStart, idleRev: idleRevAtStart,
        });
        bgUnknownStreak.delete(identity);
        // And onto the handle, so the next sweep to reach it reads the answer
        // whichever replica that turns out to be. Only the measured answer is
        // shared this way -- the give-up below infers `idle` from this replica's
        // own probes failing, which is a statement about one replica's network
        // and not something to publish to the others.
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
            // Inferred, not measured, which is what buys it the longer life
            // above: nothing shares it, so nothing else can carry it to the
            // sweep that needs to read it.
            inferred: true,
            // And whether this failure is the one that re-tested an inference
            // already on the books. The first give-up is a guess about a Hands
            // that has gone quiet; this is that guess asked again, after the
            // handle was kept and pinged for a visit, and refused again. Only
            // then is it allowed to reclaim anything.
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
 * Which verdict an entry is carrying, named by values rather than by a time.
 *
 * `rev` is the revision the publishing write was conditioned on and is unique
 * per key by construction; `at` is the stamp, which is not unique but is all a
 * verdict written before `rev` existed has. Both are read, because either one
 * changing means the verdict changed, and the pair is only equal when the entry
 * is still carrying the same verdict it was.
 */
interface VerdictWitness {
  rev?: number;
  at?: number;
}

function verdictWitness(info: HandsKvEntry): VerdictWitness {
  return { rev: info.bgRev, at: info.bgCheckedAt };
}

/** Whether the entry still carries the verdict this witness was taken from --
 *  including "still carries no verdict", which is two absent values. */
function sameVerdict(witness: VerdictWitness, info: HandsKvEntry): boolean {
  return witness.rev === info.bgRev && witness.at === info.bgCheckedAt;
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
 *
 * And, for an `idle` answer only, only if no `running` answer about that same
 * period was published while this one was in the air -- the write-side half of
 * the rule peekBackgroundWork reads by, where `running` wins on what it says
 * rather than on whose clock said it. See the guard itself for why the two
 * directions are not symmetrical.
 *
 * That guard can only compare against an answer already on the entry, which
 * leaves the case where neither answer is: both replicas read the same revision,
 * both clear every guard, and the conditional update picks one of them by
 * arrival order. So the same asymmetry is applied a second time, to the failed
 * update rather than to the entry -- a `running` answer re-reads and tries
 * again, an `idle` answer stops. See the loop for why that settles it in the
 * same direction from either arrival order.
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
    // `running` re-reads and tries again after losing the conditional update;
    // `idle` gets one attempt and no more. Losing the update means the entry
    // changed between this function's read and its write, so what the guards
    // below cleared is no longer what is there -- every attempt therefore
    // re-reads and re-asks all of them rather than resending the same value
    // against a newer revision.
    //
    // The asymmetry is the same one the `running`-wins guard is built on, and
    // it is why retrying is safe to do here at all. An `idle` write that gives
    // up costs a ping on a sandbox that no longer needs one, until the probe
    // the next sweep starts anyway files the answer again; a `running` write
    // that gives up costs the pod, because the entry is then left carrying an
    // `idle` verdict about a sandbox with a shell in it and the next replica to
    // read it reclaims the handle. So the answer that is expensive to lose is
    // the one allowed to insist, and the answer that is cheap to lose yields --
    // which also means the two can never retry against each other.
    //
    // `verdictAtStart` is not refreshed between attempts, and does not need to
    // be: it is read only by the `running`-wins guard, and that guard is only
    // reachable by an `idle` write, which never takes a second attempt.
    let workloadId: string | undefined;
    const attempts = running > 0 ? BG_VERDICT_WRITE_ATTEMPTS : 1;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const e = await deps.kv.get(key);
      if (!e) return;
      const info = JSON.parse(sc.decode(e.value)) as HandsKvEntry;
      workloadId = info.workloadId;
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
      // Three questions, because no one of them answers the others.
      // `sameIdlePeriod` catches a period this build opened while the probe was
      // out; the stamp catches one an OLD build opened, which leaves the epochs
      // exactly as it found them and moves only `idleSince`; the revision catches
      // one that opened on the same millisecond as the last, which both of the
      // others read as no new period at all. Asked as "does the entry still hold
      // the values the probe went out under", not "was it stamped before the probe
      // started": the two clocks involved belong to different machines and their
      // order proves nothing, while the values are either the ones this answer is
      // about or they are not.
      //
      // The pair the probe went out under is also the pair filed with the answer,
      // so a verdict is only ever published as being about the period it was
      // actually measured in.
      if (
        !sameIdlePeriod(epoch, info)
        || idlePeriodStamp(info) !== idleSinceAtStart
        || info.idleRev !== idleRevAtStart
      ) {
        logger.info(
          { sessionId, workloadId: info.workloadId },
          "keepalive.background_work_answer_reactivated",
        );
        return;
      }
      // And only if no `running` answer about this same period was published while
      // this one was in the air.
      //
      // The checks above establish that the period is still the one this answer
      // was measured in. They do not establish that it is the most authoritative
      // answer taken in it, and one verdict is kept per handle, so whichever write
      // lands last is what every later sweep reads. Two replicas probing the same
      // idle handle is the ordinary case -- the sweep is fleet-wide and the slices
      // overlap -- and this promise has its own suspension points before it gets
      // here, the run-lease read among them. A `running` that completes first and
      // an `idle` that completes second leaves `idle` on the entry, and the next
      // replica to sweep deletes a handle with a background shell in it.
      //
      // Which of the two was taken later cannot be asked here, for the reason
      // peekBackgroundWork will not ask it either: the two stamps are two
      // machines' clocks and their order proves nothing. So the write is decided
      // the same way the read is, by what the answers say rather than by when they
      // say they were taken. `running` wins. The two ways of being wrong are not
      // the same size: dropping a live `idle` costs pings on a sandbox that no
      // longer needs them, until the `running` verdict ages out and the probe this
      // sweep starts anyway files the same answer again; letting a stale `idle`
      // land costs the pod. The opposite direction is unguarded on purpose -- a
      // `running` overwriting an earlier `idle` in the same period is how a
      // sandbox that started work after being measured empty gets protected.
      //
      // "Published while this one was in the air" is asked as a value comparison,
      // not as an ordering: the verdict the entry carries now against the one it
      // carried when the probe went out. `bgRev` is the half that cannot collide
      // -- one write per revision, so no two published verdicts share it -- and
      // the stamp beside it is the half that a verdict from a build without
      // `bgRev` still answers with. Equal on both means nothing has been published
      // since, so this answer is the newer one and may overwrite. That is what
      // keeps the ordinary case working: a job that ends is measured `idle`
      // against the unchanged `running` verdict its own sweep read, and replaces
      // it on the spot.
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
        // The revision this write is conditioned on, which names this verdict and
        // no other -- read before the write for the same reason `idleRev` is: the
        // write's own revision is not knowable until it lands, and the value only
        // has to be unique.
        bgRev: e.revision,
      }));
      try {
        await deps.kv.update(key, next, e.revision);
        return;
      } catch {
        // Somebody else wrote the entry between the read at the top of this
        // attempt and here. Whether that was the other half of a same-revision
        // race or an unrelated writer is not knowable from the failure, and
        // does not have to be: the next attempt reads what is actually there
        // and re-asks every guard against it, so a `running` answer that lost
        // to a concurrent `idle` now sees that `idle` and overwrites it, while
        // one that lost to a reactivation or a substitution sees that instead
        // and stops.
        logger.info(
          { sessionId, workloadId, attempt },
          "keepalive.background_work_answer_write_contended",
        );
      }
    }
    // Falling out of the loop rather than returning from inside it means every
    // attempt was lost to a concurrent write and no guard ever found a reason to
    // stop. For an `idle` answer that is the ordinary yield -- one attempt, and
    // the sweep that comes anyway files it again -- and not worth a word.
    //
    // For a `running` answer it is the outcome the budget above is sized to make
    // unreachable, so reaching it is worth saying out loud: the entry is left
    // carrying whatever beat the last attempt, which may be an `idle` about a
    // sandbox this replica has just measured a shell in.
    //
    // Nothing else can be done about it from here that is not worse than the
    // problem. The only write that cannot be beaten is one with no revision
    // precondition, and that overwrites the whole entry from a snapshot read
    // before the last attempt -- reverting a reactivation or a substitution that
    // landed in between, which loses the pod in the same direction this path
    // exists to protect it from. So it is reported rather than forced.
    if (running > 0) {
      logger.warn(
        { sessionId, workloadId, attempts },
        "keepalive.background_work_answer_write_abandoned",
      );
    }
  } catch {
    // Every failure that reaches here leaves the handle with no verdict from
    // this probe -- which reads back as `unknown`, the branch that keeps the
    // sandbox rather than reclaiming one that may still be working.
  }
}

/**
 * Move the idle clock forward on a handle whose sandbox is still working.
 *
 * `idleSince` is stamped once, when the task ended, and the reuse window is
 * measured from it. Left alone, a background job that outlasts the window means
 * the handle is already expired the moment the job finishes: the next sweep
 * deletes it, the next message in the session cannot reuse the pod, and whatever
 * the job wrote that has not been synced goes with it. Moving the clock while
 * the work is visible gives the session the full window it would have had if the
 * job had never run.
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
  seenAt: number,
): Promise<void> {
  try {
    // `seenAt`, not `Date.now()`: the last moment work was actually *seen*, which
    // is when the verdict driving this branch was measured. Two reasons, and the
    // first is only the honest reading of the sentence above -- a sweep that
    // reuses a four-minute-old `running` has not seen work now, it has read that
    // work was there four minutes ago.
    //
    // The second is that `idleSince` is what every verdict is anchored against
    // (see measuredUnderThisIdlePeriod), so a stamp of `Date.now()` here would land
    // ahead of the very answer that produced it and invalidate it on the next
    // sweep -- a working sandbox would fall back to `unknown` every other tick
    // and be re-probed for as long as its job ran. Anchored to the measurement
    // instead, re-reading the same verdict re-writes the same stamp, and the
    // clock advances exactly when a newer measurement says work is still there.
    //
    // `Math.max` so the stamp is monotonic by construction rather than by the
    // caller's promise: a verdict older than the stamp is already refused before
    // this is reached, and nothing here should be the thing that moves an idle
    // window backwards if that ever stops being true.
    //
    // Through `idlePeriodStamp`, for the same reason every other reader of this
    // value does: a probe reservation may have carried the field forward, and
    // carrying it further from there would compound a temporary hold into a
    // permanent one. The stamp is the period's own reading, which is what this
    // is entitled to move.
    const idleSince = Math.max(idlePeriodStamp(info) ?? 0, seenAt);
    // And the reuse clock, which is the other half of what this write used to
    // do with one number. `Date.now()` is right for it and wrong for the anchor:
    // this sweep is seeing the sandbox at work now, whatever the age of the
    // measurement telling it so, and the window it gets when the work stops has
    // to start from now rather than from a reading that may be half an hour old.
    const entry: HandsKvEntry = { ...info, idleSince, workSeenAt: Date.now() };
    // And any probe carry is spent. This write is the running answer being acted
    // on -- the ordinary, non-temporary reason to hold the stamp up -- and it
    // sets the stamp itself, so a record saying where to put the stamp back is
    // now about a decision that has been superseded. Left behind, releaseProbe
    // would read it as a carry still in force and undo it, taking this refresh
    // with it: the two paths cancelling each other out and a working sandbox
    // reading as expired to exactly the sweep the carry was addressed to.
    delete entry.probeIdleHold;
    const next = sc.encode(JSON.stringify(entry));
    await deps.kv.update(key, next, revision);
    // The scan's copy of the entry outlives this write -- a probe dispatched at
    // the end of the same tick reads its `idleSince` to say which period it is
    // asking about. Left at the pre-write value it would name a stamp the entry
    // no longer carries, and the answer would be dropped on arrival as if the
    // handle had been reactivated.
    info.idleSince = idleSince;
    delete info.probeIdleHold;
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
            // The period's own stamp, not the field: an outstanding reservation
            // may have carried the field forward, and naming the period after a
            // reading that is about to be put back names a period that will not
            // exist a moment later.
            info.idleEpoch = idlePeriodStamp(info) ?? Date.now();
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
          await refreshIdleSince(deps, key, e.revision, info, peeked.at ?? Date.now());
        } else if (info.keepalive === false && bgWork === "unknown") {
          await deps.kv.update(key, value, e.revision).catch(() => {});
        }
        if (info.keepalive === false && bgWork === "idle") {
          const expired = Date.now() - reuseWindowStart(info) > SANDBOX_IDLE_REUSE_MS;
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
          if (expired && probeOutstanding(info)) {
            // A handle with a question still outstanding about it is not a
            // handle whose answer is known, whatever the entry currently says.
            //
            // The verdict this reclaim would act on can be one half of a race
            // that has not finished being decided. Two replicas probing the same
            // idle period both publish; `running` wins over `idle` by re-reading
            // and insisting, and the write that insists is a read-modify-write
            // with suspension points in it. Deleting between the `idle` landing
            // and the `running` overtaking it does not merely pick the loser --
            // it removes the key both answers are about, so the `running` has
            // nowhere to land and is dropped rather than reconsidered, however
            // much budget it had left. The pod is then reclaimed on the one
            // verdict that was still being contested, which is the failure the
            // contest exists to prevent.
            //
            // In-process the same question is already answered, by the set that
            // stops a replica probing what it is already probing. This is that
            // statement made where the other replicas can read it -- the sweep
            // that asks and the sweep that reclaims are not the same process,
            // which is the premise the shared verdict is built on too.
            //
            // Deferred rather than refused: the reservation is released when the
            // answer is filed and times out if it never is, so the handle is
            // reclaimed by the next sweep past either. The TTL is refreshed on
            // the way past, because a handle kept without one is a handle the
            // bucket drops instead -- the same loss by a slower route.
            logger.info(
              { sessionId, workloadId: info.workloadId },
              "keepalive.idle_handle_kept_probe_outstanding",
            );
            stats.keptProbe += 1;
            await deps.kv.update(key, value, e.revision).catch(() => {});
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
  // its sandbox is perfectly alive. Reaping on absence therefore discarded a
  // verdict within a tick or two of it being written, long before the sweep that
  // would have read it: `unknown` became the permanent answer, `unknown` is the
  // branch that keeps the handle, and idle sandboxes were pinged until the CR's
  // absolute deadline instead of being reclaimed.
  //
  // Age is the property that actually says an answer is no longer worth
  // believing, and it bounds the maps on its own: an identity nothing probes
  // again stops being refreshed and falls out one TTL later.
  //
  // The floor is per entry, because the entries do not all have the same
  // lifetime. Reaping a give-up inference at BG_VERDICT_TTL_MS would expire it
  // before the replica that made it returns to the handle, which is the whole
  // failure BG_GIVEUP_TTL_MS exists to fix -- the reap would simply reintroduce
  // it behind the TTL check.
  const now = Date.now();
  for (const [identity, cached] of [...bgProbeCache.entries()]) {
    const floor = now - Math.max(BG_VERDICT_TTL_MS, cachedVerdictTtlMs(cached));
    if (cached.at < floor) forgetBackgroundWork(identity);
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
