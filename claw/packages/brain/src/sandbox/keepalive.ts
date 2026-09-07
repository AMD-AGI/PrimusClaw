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
import {
  handsEntryKeys, readHandsEntry, reconcileReservedKeys, retentionStore,
  sessionHasActiveRunLease,
} from "./registry.js";
import { getAgentSandboxProvider, getSafeWorkloadProvider } from "./factory.js";
import { listAllDagHandles } from "./handles.js";
import type { HandleInfo } from "@claw/protocol";
import { HandsLivenessIndeterminate, countActiveShells } from "../clients/hands.js";
import { reconcileTargets, renewAndReap, type RosterConfig, type RosterStore } from "./admission-roster.js";
import {
  latchRosterStale, markCensusReconciled, markRosterStale, releaseAdmission,
} from "./admission.js";
import { pingsPerSweep } from "./keepalive-capacity.js";
import pino from "pino";
import { isRetentionEntry, sessionIdFromHandsKey } from "./hands-key.js";
import { instanceFromEntry } from "./container-probe.js";
import { countLiveWork } from "./live-work-gate.js";
import { releaseRetention } from "./retain-container.js";
import { HANDS_STATE_DIR } from "./bootstrap.js";

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
  /** Test seam for the durable DAG handle map, which needs JetStream otherwise. */
  listDagHandles?: () => Promise<Array<[string, Record<string, HandleInfo>]>>;
  /**
   * Test seam for the ping-phase budget. The real one is derived from the
   * record TTL and is minutes long, which no test can exhaust without sleeping
   * for minutes -- so a test that wants to see the deferral path has to shorten
   * it. Never set in production.
   */
  pingBudgetMs?: number;
  /**
   * Test seam for the clock the ping deadline is measured against.
   *
   * The budget is what makes a sweep defer, and deferral is what the refresh
   * bound is stated over -- so a test that cannot move this clock cannot
   * exercise the bound at all, whatever it does to the pings themselves.
   * Never set in production.
   */
  now?: () => number;
  /**
   * The fleet-wide admission roster, where one is bound.
   *
   * Every distinct target a sweep may face holds a slot, including one reached
   * only through a handle record another replica wrote or one recovered after a
   * restart. An un-admitted target is reconciled in before this sweep serves
   * it, because the alternative is serving it from whatever capacity the
   * admitted ones leave -- which starves exactly the target holding live work.
   */
  roster?: { store: RosterStore; config: RosterConfig };
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


/**
 * One retained container's turn in the sweep.
 *
 * It is a target like any other -- pinged, its lifetime refreshed -- and it is
 * never probed for a shell count: its key names no session, so the owner a
 * probe would ask about owns nothing, and the zero that came back would file
 * the container idle and reclaim the very work the retention protects.
 *
 * What ends a retention is the evidence that caused it reaching zero, read the
 * same way it was taken. Without this the entry is permanent and the container
 * never returns to the ordinary lifetime machinery.
 *
 * @returns false where the sweep could not complete this entry, which is not
 * the same as an entry it completed and found nothing in.
 */
async function sweepRetention(
  deps: KeepaliveDeps,
  key: string,
  entry: { value: Uint8Array; revision: number },
  info: HandsKvEntry,
  targets: Map<string, RegisteredSandbox>,
): Promise<boolean> {
  const held = sandboxEntryFrom(info);
  if (!held) {
    logger.error({ key }, "keepalive.retention_unaddressable");
    return false;
  }
  const sessionId = sessionIdFromHandsKey(key);
  targets.set(key, { sessionId, entry: held });

  const inst = instanceFromEntry(sessionId, info as never);
  const live = inst
    ? await countLiveWork(inst, HANDS_STATE_DIR)
    : { verdict: "unknown" as const, classes: {}, reason: "entry_unaddressable" };
  if (live.verdict === "clear") {
    await releaseRetention(retentionStore(deps.kv), key);
    return true;
  }

  try {
    await deps.kv.update(key, entry.value, entry.revision);
  } catch (err) {
    // This bucket expires entries on its own, so a refresh that failed and was
    // swallowed is a retained container that silently falls out of the sweep.
    logger.error({ err: (err as Error)?.message, key }, "keepalive.retention_refresh_failed");
    return false;
  }
  return true;
}

/**
 * The sandbox an entry names, or null where it names none this can address.
 *
 * safe-workload needs a workload id and platform key; agent-sandbox needs a
 * session id. An entry short of either is not a sandbox with no work in it --
 * it is one nothing can be sent to, which is a different answer.
 */
function sandboxEntryFrom(info: HandsKvEntry): SandboxEntry | null {
  const provider = info.provider === "agent-sandbox" ? "agent-sandbox" : "safe-workload";
  const usable = provider === "agent-sandbox"
    ? !!info.sessionId
    : !!(info.workloadId && info.platformKey);
  if (!usable) return null;
  return {
    provider,
    workloadId: info.workloadId,
    platformKey: info.platformKey,
    sessionId: info.sessionId,
    sandboxName: info.sandboxName,
    namespace: info.namespace,
    userId: info.userId,
  };
}

/**
 * The identity of one ping target.
 *
 * Exported because admission reserves a slot per target and has to name the
 * same thing the sweep pings: a slot bound to anything else would leave the
 * target un-admitted and reconciled in later, which is the ceiling being
 * enforced after the fact rather than before provisioning.
 */
export function pingTargetIdentity(entry: SandboxEntry): string {
  return sandboxRegistryKey(entry);
}

/**
 * What the provider assigned, and nothing logical.
 *
 * One physical sandbox is reachable under more than one logical name -- a
 * session binding and a DAG handle map naming the same container under
 * different roots -- and keying by the name it was reached through counts it
 * twice: two admission slots against one ceiling and two pings a sweep, which
 * understates the deferral count the idle-GC deadline is proven against by
 * exactly the number of doubly-named sandboxes.
 */
function sandboxRegistryKey(entry: SandboxEntry): string {
  return entry.provider === "agent-sandbox"
    ? `agent:${entry.sessionId || ""}:${entry.namespace || ""}:${entry.sandboxName || ""}`
    : `safe:${entry.workloadId || ""}`;
}

/**
 * The key holding the generation `entry` names.
 *
 * A canonical-first read returns whichever key exists, which is the wrong
 * record when both do: the local registry names one particular generation, and
 * its sibling under the other key belongs to a different, live one. Matching on
 * identity is the only way to tell them apart, so an unreadable or
 * non-matching record is passed over rather than guessed at.
 */
async function recordKeyNamingSandbox(
  kv: KV, sessionId: string, entry: SandboxEntry,
): Promise<string | null> {
  for (const key of handsEntryKeys(sessionId)) {
    const found = await kv.get(key).catch(() => null);
    if (!found) continue;
    try {
      if (sameRegisteredSandbox(entry, JSON.parse(sc.decode(found.value)) as HandsKvEntry)) {
        return key;
      }
    } catch { /* unreadable is not evidence that this is the record we want */ }
  }
  return null;
}

/**
 * Delete the binding this decision was taken on.
 *
 * Not a key re-derived from the session id: during a rolling upgrade the
 * binding can sit under the legacy name, and the canonical key can hold a
 * different generation of the same session -- so re-deriving either leaves the
 * orphan behind or deletes a live sibling.
 *
 * Deleting nothing is the safe end of that: an orphan costs a sandbox until the
 * bucket TTL takes it, while deleting a sibling strands a running workload.
 */
async function deleteExpiredRetryRecord(
  kv: KV, sessionId: string, recordKey?: string, entry?: SandboxEntry,
): Promise<void> {
  const key = recordKey
    ?? (entry ? await recordKeyNamingSandbox(kv, sessionId, entry) : null);
  if (!key) {
    logger.warn({ sessionId, workloadId: entry?.workloadId },
      "keepalive.retry_pending_record_unresolved");
    return;
  }
  await kv.delete(key).catch((err) => logger.warn(
    { err: String(err), sessionId, key }, "keepalive.retry_pending_record_not_deleted",
  ));
}

/** Drop orphaned READY sandboxes when a retryable attempt was never redelivered. */
async function shouldSkipExpiredRetry(
  deps: KeepaliveDeps,
  sessionId: string,
  source: "local" | "kv",
  entry?: SandboxEntry,
  recordKey?: string,
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
  await deleteExpiredRetryRecord(deps.kv, sessionId, recordKey, entry);
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
  const key = sandboxRegistryKey(entry);
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
export function unregisterSandbox(
  sessionId: string,
  known?: SandboxEntry,
  /**
   * Whether this sandbox is finished with.
   *
   * A turn that ends stops pinging its sandbox but keeps the handle for the
   * next message, and a background shell started in that turn is expected to
   * still be there. Releasing the slot then hands the ceiling to somebody else
   * while the sandbox is still a target the sweep will reconcile back in --
   * which is the over-cap state admission exists to prevent, reached through
   * ordinary use.
   */
  opts: { releaseSlot?: boolean } = { releaseSlot: true },
): void {
  const keys = known
    ? [sandboxRegistryKey(known)]
    : [...localRegistry.entries()]
      .filter(([, value]) => value.sessionId === sessionId)
      .map(([key]) => key);
  let had = false;
  for (const key of keys) {
    had = localRegistry.delete(key) || had;
    failCounts.delete(key);
    // The slot goes with the target where the target is gone. Held past that,
    // it counts against the ceiling for a sandbox that no longer exists and an
    // ordinary teardown becomes a capacity refusal for the next request.
    if (opts.releaseSlot !== false) {
      void releaseAdmission(key).then((ok) => {
        if (!ok) logger.error({ sessionId, key }, "keepalive.admission_release_unconfirmed");
      });
    }
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
  readHandsEntry(kv, sessionId)
    .then(async (entry) => {
      if (!entry) return; // no handle to keep; a fresh task will recreate one.
      const kvKey = entry.key;
      let info: HandsKvEntry;
      try {
        info = JSON.parse(entry.value) as HandsKvEntry;
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
      forgetBackgroundWork(sandboxRegistryKey({
        provider: info.provider === "agent-sandbox" ? "agent-sandbox" : "safe-workload",
        workloadId: info.workloadId,
        sessionId: info.sessionId,
        sandboxName: info.sandboxName,
        namespace: info.namespace,
      }));

      info.keepalive = false;
      info.idleSince = Date.now();
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
 * `unknown` holds the handle at every streak length: a sandbox nobody can read
 * is not a sandbox with nothing in it, and only the second may release a
 * container. Past this many ticks the handle is reported unreconciled, so an
 * operator sees a sandbox pinned to its absolute deadline rather than a silence.
 */
const BG_UNKNOWN_TOLERANCE = 5;

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
/**
 * Every target the last sweep left unserved, in the order it deferred them.
 *
 * The whole list rather than a resume point: the target set is rebuilt each
 * sweep, so a position moves under arrivals and departures and a single
 * identity vanishes when its sandbox does -- and either way an already-served
 * target can be carried back ahead of one still waiting, repeatedly, which is
 * what makes the deferral count unbounded and the refresh gap with it.
 */
let pingDeferred: string[] = [];


/** Keyed by sandbox identity, not by session: see refreshBackgroundWork. */
const bgProbeCache = new Map<string, { at: number; state: BackgroundWork }>();
const bgUnknownStreak = new Map<string, number>();
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
/**
 * How many pings one sweep is guaranteed to start, from this build's own
 * concurrency and budgets. Read at startup to prove the refresh-gap relation.
 */
export function keepalivePingsPerSweep(): number {
  return pingsPerSweep(PING_MAX_IN_FLIGHT, PING_PHASE_BUDGET_MS, HANDS_PING_CEILING_MS);
}

/**
 * The longest the ping phase can run: its budget bars the *starting* of a ping,
 * so the pings already in flight when it expires run on for their own ceiling.
 */
export function keepalivePingPhaseCeilingSec(): number {
  return Math.ceil((PING_PHASE_BUDGET_MS + HANDS_PING_CEILING_MS) / 1000);
}

/**
 * The whole guarded tick's worst case: the ping phase, plus the failure phase
 * and the one eviction its budget lets start. Fleet-size independent, which is
 * the property the declared span has to have.
 */
export function keepaliveSweepCeilingSec(): number {
  return keepalivePingPhaseCeilingSec()
    + Math.ceil((FAILURE_PHASE_BUDGET_MS + HANDS_STOP_CEILING_MS) / 1000);
}

/** Longest one started eviction may take, stop and retries together. */
const HANDS_STOP_CEILING_MS = 30_000;

/** Longest one ping may take before its own timeout ends it. */
const HANDS_PING_CEILING_MS = 15_000;

/** Where the last sweep stopped handing out probe slots. */
let bgProbeCursor = 0;

/** Drop the cached verdict for one sandbox identity, and invalidate any
 *  answer still in the air about it. */
function forgetBackgroundWork(identity: string): void {
  bgProbeCache.delete(identity);
  bgUnknownStreak.delete(identity);
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
function peekBackgroundWork(identity: string, info: HandsKvEntry): BackgroundWork {
  if (!info.handsUrl || !info.token) return "idle";
  const cached = bgProbeCache.get(identity);
  if (cached && Date.now() - cached.at < BG_PROBE_TTL_MS) return cached.state;
  return "unknown";
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
  const cached = bgProbeCache.get(identity);
  if (cached && Date.now() - cached.at < BG_PROBE_TTL_MS) return false;
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
): void {
  if (candidates.length === 0) return;
  const probe = deps.countActiveShells ?? countActiveShells;
  const start = bgProbeCursor % candidates.length;

  let started = 0;
  for (let n = 0; n < candidates.length; n++) {
    if (bgProbeInFlight.size >= BG_PROBE_MAX_IN_FLIGHT) break;
    const { identity, sessionId, info, generation } =
      candidates[(start + n) % candidates.length];
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
        bgProbeCache.set(identity, { at: Date.now(), state });
        bgUnknownStreak.delete(identity);
        if (state === "running") {
          logger.info(
            // The sandbox name, beside the session id: a session id outlives
            // every sandbox successively written under it, so one generation's
            // reclamation would otherwise cancel the next generation's held
            // count and neither event could be correlated per sandbox.
            { sessionId, sandboxName: info.sandboxName, workloadId: info.workloadId, running },
            "keepalive.idle_handle_kept_background_work",
          );
        }
      })
      .catch((err) => {
        if (stale()) return;
        // A sandbox that says it cannot tell is not a sandbox that did not
        // answer. Giving up on the second eventually is right -- one that has
        // stopped answering entirely would otherwise be pinned to its absolute
        // deadline. Giving up on the first reclaims the sandbox whose records
        // were lost, which is the work this whole path protects.
        if (err instanceof HandsLivenessIndeterminate) {
          logger.error(
            { sessionId, workloadId: info.workloadId },
            "keepalive.background_work_indeterminate",
          );
          return;
        }
        const streak = (bgUnknownStreak.get(identity) ?? 0) + 1;
        bgUnknownStreak.set(identity, streak);
        logger.warn(
          { err: (err as Error)?.message ?? err, sessionId, streak },
          "keepalive.background_work_check_failed",
        );
        if (streak > BG_UNKNOWN_TOLERANCE) {
          // Reported, never converted. A run of unanswered probes is a sandbox
          // nobody can read, which is not the same fact as a sandbox with
          // nothing in it -- and only the second may release a container. The
          // handle stays unreconciled until something answers or its absolute
          // deadline ends it.
          logger.error(
            { sessionId, workloadId: info.workloadId, streak },
            "keepalive.background_work_unreconciled",
          );
        }
      })
      .finally(() => { bgProbeInFlight.delete(identity); });
  }
  bgProbeCursor = start + started;
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
    const next = sc.encode(JSON.stringify({ ...info, idleSince: (deps.now ?? Date.now)() }));
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
): Promise<{ targets: Map<string, RegisteredSandbox>; complete: boolean }> {
  const targets = new Map<string, RegisteredSandbox>();
  // A walk that could not read everything yields a smaller census, and a
  // smaller census reconciled as if whole announces a fleet nobody counted.
  let complete = true;
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
      const sessionId = sessionIdFromHandsKey(key);
      // A read that failed is not a key that is absent: folding the two
      // together drops the target from the census, and the reconcile that
      // follows then clears a staleness the fleet still has.
      let e: Awaited<ReturnType<typeof deps.kv.get>> = null;
      try {
        e = await deps.kv.get(key);
      } catch (err) {
        complete = false;
        logger.warn({ err: (err as Error)?.message, key }, "keepalive.entry_read_failed");
        continue;
      }
      if (!e) continue;
      try {
        const info = JSON.parse(sc.decode(e.value)) as HandsKvEntry;
        if (info.status && info.status !== "ready") continue;
        // A retention names no session, so the owner scope a probe would ask
        // about owns nothing: the probe would read zero, file the container
        // idle, and reclaim the very work the retention exists to protect. It
        // is pinged like any other target and is a case of its own beside the
        // running, idle and unobtainable answers -- never probed for a count,
        // never marked idle, never destroyed or evicted on a failed ping.
        if (isRetentionEntry(info)) {
          if (!await sweepRetention(deps, key, e, info, targets)) complete = false;
          continue;
        }
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
        const identity = sandboxRegistryKey({
          provider: info.provider === "agent-sandbox" ? "agent-sandbox" : "safe-workload",
          workloadId: info.workloadId,
          sessionId: info.sessionId,
          sandboxName: info.sandboxName,
          namespace: info.namespace,
        });
        seenIdentities.add(identity);
        const bgWork = info.keepalive === false
          ? peekBackgroundWork(identity, info)
          : "idle";
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
        if (info.keepalive === false && (bgWork === "running" || bgWork === "unknown")) {
          // An unknown resets the clock exactly as a running answer does. A TTL
          // refresh alone leaves the clock running through the whole unanswered
          // stretch, so one confirmed zero afterwards expires a handle whose
          // idleness was never observed across the window it is expired on.
          await refreshIdleSince(deps, key, e.revision, info);
        }
        if (info.keepalive === false && bgWork === "idle") {
          const idleSince = typeof info.idleSince === "number" ? info.idleSince : 0;
          const expired = (deps.now ?? Date.now)() - idleSince > SANDBOX_IDLE_REUSE_MS;
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
            continue;
          }
          if (expired) {
            // The release is conditional on the delete: `previousSeq` loses to a
            // sibling reactivating this very handle, and releasing then would
            // strip the slot from a target that is live again. Idle expiry is
            // the one exit that reaches no unregisterSandbox, so without this
            // the ceiling leaks a slot per parked handle, monotonically, until
            // ordinary provisioning is refused for capacity.
            const deleted = await deps.kv.delete(key, { previousSeq: e.revision })
              .then(() => true).catch(() => false);
            if (deleted) {
              const identity = pingTargetIdentity({
                provider: info.provider === "agent-sandbox" ? "agent-sandbox" : "safe-workload",
                workloadId: info.workloadId,
                platformKey: info.platformKey,
                sessionId: info.sessionId,
                sandboxName: info.sandboxName,
                namespace: info.namespace,
              });
              if (!await releaseAdmission(identity)) {
                logger.error({ sessionId, identity }, "keepalive.admission_release_unconfirmed");
              }
            }
            logger.info(
              { sessionId, sandboxName: info.sandboxName, workloadId: info.workloadId, deleted },
              "keepalive.idle_handle_expired",
            );
          } else {
            // Refresh the TTL only, no ping -- and conditionally, because an
            // unconditional put bumps the revision that ensureHands is holding
            // while it reactivates this very handle. Losing the race is the
            // correct outcome: whoever won either refreshed the same TTL or
            // took the handle out of idle, and neither wants this write.
            await deps.kv.update(key, e.value, e.revision).catch(() => {});
          }
          continue;
        }
        const entry = sandboxEntryFrom(info);
        if (!entry) continue;
        if (await shouldSkipExpiredRetry(deps, sessionId, "kv", entry, key)) continue;

        // Renew the record here rather than after the ping it is waiting for.
        // Pings run bounded and in turn, and one can take its whole command
        // timeout plus transport slack, so a large enough fleet leaves the tail
        // of the queue waiting longer than the bucket's own TTL: the handle would
        // expire before its ping ever arrived, and the sweep guard means no other
        // sweep is coming to renew it. The revision is already in hand, so this
        // costs a write and no read.
        await deps.kv.update(key, e.value, e.revision).catch(() => {});

        const targetKey = sandboxRegistryKey(entry);
        if (!targets.has(targetKey)) targets.set(targetKey, { sessionId, entry });
      } catch (err) {
        // A record that cannot be used is a sandbox missing from the census,
        // not a sandbox that does not exist.
        complete = false;
        logger.warn({ err: (err as Error)?.message, key }, "keepalive.entry_unreadable");
      }
    }
  } catch (err) {
    complete = false;
    logger.warn({ err }, "keepalive.kv_scan_failed");
  }

  // The other half of the fleet. A DAG node resolves its sandbox through the
  // handle map, and every node of a DAG shares one session id -- so a live DAG
  // sandbox may be named by no session entry at all, or only by a stale
  // sibling's. Missed here it holds no slot and is pinged by nobody, which
  // after a restart is every DAG sandbox this replica did not create.
  try {
    for (const [dagRoot, handles] of await (deps.listDagHandles ?? listAllDagHandles)()) {
      for (const info of Object.values(handles)) {
        const entry: SandboxEntry = {
          provider: info.provider === "agent-sandbox" ? "agent-sandbox" : "safe-workload",
          workloadId: info.workload_id,
          platformKey: info.platform_key,
          sessionId: info.session_id,
          sandboxName: info.sandbox_name,
          namespace: info.namespace,
          userId: info.user_id,
        };
        const usable = entry.provider === "agent-sandbox"
          ? !!entry.sessionId
          : !!(entry.workloadId && entry.platformKey);
        if (!usable) continue;
        const key = sandboxRegistryKey(entry);
        seenIdentities.add(key);
        if (!targets.has(key)) targets.set(key, { sessionId: dagRoot, entry });
      }
    }
  } catch (err) {
    // Unreadable, not empty: a census missing this half is one the roster is
    // reconciled against as if those sandboxes did not exist.
    complete = false;
    logger.warn({ err: (err as Error)?.message }, "keepalive.dag_handle_scan_failed");
  }

  // After the walk, not during it: the cap is global and the cursor rotates, so
  // who gets a slot has to be decided once the candidates are all known.
  dispatchProbes(deps, probeCandidates);

  return { targets, complete };
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

/**
 * How long the failure-handling phase may spend starting evictions.
 *
 * A budget rather than a count, and independent of how many targets failed:
 * evictions run serially and each awaits a stop, so a fleet-sized failure
 * makes this phase fleet-sized and the declared sweep span -- which every
 * refresh gap is derived from -- becomes a number the sweep routinely exceeds.
 * An eviction not started inside it is deferred, which costs nothing: a handle
 * that stays unreachable keeps failing and is evicted on a later sweep, and no
 * deferral expires a handle or reclaims anything.
 */
const FAILURE_PHASE_BUDGET_MS = 30_000;

async function handleKeepaliveFailures(
  failures: KeepaliveFailure[],
  targetCount: number,
  now: () => number = Date.now,
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

  const phaseDeadline = now() + FAILURE_PHASE_BUDGET_MS;
  let deferredEvictions = 0;
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
    if (now() >= phaseDeadline) {
      // Counted and left for the next sweep. The fail count is already
      // recorded, so nothing is forgotten -- only postponed.
      deferredEvictions += 1;
      continue;
    }
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
      await releaseAdmission(targetKey);
      logger.error(
        { sessionId, workloadId: entry.workloadId, fails },
        "keepalive.sandbox_evicted",
      );
    }
  }
  if (deferredEvictions > 0) {
    logger.warn(
      { deferred: deferredEvictions, budgetMs: FAILURE_PHASE_BUDGET_MS },
      "keepalive.failure_budget_exhausted",
    );
  }
}

/**
 * Take every target of this sweep onto the roster, and renew what this replica
 * already holds, before any of them is pinged.
 *
 * The ceiling is held against ordinary admission, never against work already
 * running: a target the sweep faces is never a confirmed-idle handle, so it is
 * either working or unaccounted for, and refusing it here would leave it
 * unpinged rather than keeping the fleet small.
 */
async function admitTargets(
  deps: KeepaliveDeps,
  targets: Map<string, RegisteredSandbox>,
  censusComplete: boolean,
): Promise<Set<string> | null> {
  if (!deps.roster) return null;
  const identities = [...targets.keys()];
  try {
    const result = await reconcileTargets(
      deps.roster.store, deps.roster.config, identities, censusComplete,
    );
    if (result.admitted.length) {
      logger.info({ admitted: result.admitted.length }, "keepalive.roster_reconciled");
    }
    if (result.breach) {
      logger.error(
        { rosterSize: result.rosterSize, ceiling: deps.roster.config.ceiling,
          beyondCeiling: result.beyondCeiling },
        "keepalive.roster_capacity_breach",
      );
    }
    await renewAndReap(deps.roster.store, deps.roster.config, new Set(identities));
    if (censusComplete) {
      // Only a sweep that reconciled a complete census may lift the local
      // latch, or report the fleet counted: anything less returns the replica
      // to apparent health on the strength of a reading it could not take.
      latchRosterStale(false);
      markCensusReconciled();
    } else {
      latchRosterStale(true);
      logger.error({ targets: identities.length }, "keepalive.census_incomplete");
    }
    return null;
  } catch (err) {
    // If the marker itself cannot be written, the shared roster still looks
    // healthy -- so this replica latches locally as well and every claim it
    // sees is refused until a sweep completes clean. A neighbour that can write
    // is unaffected; one that cannot is at least not the one admitting.
    await markRosterStale((err as Error)?.message ?? "reconcile failed")
      .catch((markErr) => {
        latchRosterStale(true);
        logger.error(
          { err: (markErr as Error)?.message },
          "keepalive.roster_stale_marker_unwritten",
        );
      });
    logger.error(
      { err: (err as Error)?.message, targets: identities.length },
      "keepalive.roster_reconcile_failed",
    );
    // Targets the roster already holds keep being pinged -- refusing those is
    // how a sandbox with live work in it is reclaimed. The rest are not served:
    // reconcile-before-serving is what makes the deferral count every handle's
    // refresh gap rests on a number the fleet agrees on, and pinging a target
    // no roster holds spends this sweep's budget against that number.
    return await heldIdentities(deps.roster.store);
  }
}

/**
 * The identities the roster is known to hold, or none where it cannot be read.
 *
 * An unreadable roster is not an empty one, but it is equally not evidence that
 * any particular target was admitted -- and this set is only ever used to decide
 * what may be served without reconciliation having succeeded.
 */
async function heldIdentities(store: RosterStore): Promise<Set<string>> {
  const current = await store.read().catch(() => null);
  return new Set(
    (current?.roster.entries ?? [])
      .map((e) => e.identity)
      .filter((i): i is string => !!i),
  );
}

/**
 * Take the targets reconciliation could not admit out of this sweep.
 *
 * Reported at error level rather than dropped quietly: an un-admitted target
 * that is also unserved is a sandbox whose refresh is not happening, and the
 * failure it precedes -- a handle expiring un-pinged -- looks like nothing at
 * all from the outside.
 */
function dropUnadmitted(
  targets: Map<string, RegisteredSandbox>, servable: Set<string>,
): void {
  const refused: string[] = [];
  for (const key of [...targets.keys()]) {
    if (servable.has(key)) continue;
    targets.delete(key);
    refused.push(key);
  }
  if (refused.length) {
    logger.error({ refused }, "keepalive.unadmitted_targets_unserved");
  }
}

/** The verdict the last sweep reached for a target, for tests. */
const lastVerdict = new Map<string, { fails: number; gone: boolean }>();
export function lastVerdictForTest(identityPart: string): { fails: number; gone: boolean } | null {
  for (const [key, v] of lastVerdict) if (key.includes(identityPart)) return v;
  return null;
}

async function tick(deps: KeepaliveDeps): Promise<void> {
  const seenIdentities = new Set<string>();
  // Every sweep, not only at boot: an old replica writes the legacy key
  // throughout a rolling upgrade, after every new one has already scanned.
  await reconcileReservedKeys(deps.kv).catch((err) => logger.error(
    { err: (err as Error)?.message }, "keepalive.reserved_key_reconcile_failed",
  ));
  const census = await collectTargets(deps, seenIdentities);
  const targets = census.targets;
  const servable = await admitTargets(deps, targets, census.complete);
  if (servable) dropUnadmitted(targets, servable);

  // Reap stale failCounts for sessions no longer tracked.
  for (const key of failCounts.keys()) {
    if (!targets.has(key)) failCounts.delete(key);
  }
  // Same for the background-work bookkeeping, which is keyed by sandbox identity
  // rather than by target: an identity the sweep no longer sees is one nothing
  // will ask about again, and its cached answer would otherwise outlive the pod
  // it was about.
  // Keyed on what the sweep saw, not on what it decided to ping: an `idle`
  // answer is exactly the case where the handle does not become a target, so
  // reaping on targets threw away the answer at the end of every tick and asked
  // again on the next one -- which is the load the cache exists to remove.
  for (const identity of [...bgProbeCache.keys(), ...bgUnknownStreak.keys()]) {
    if (!seenIdentities.has(identity)) forgetBackgroundWork(identity);
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

  if (!targets.size) return;

  const localCount = localRegistry.size;
  const kvOnlyCount = targets.size - localCount;
  logger.info(
    { total: targets.size, local: localCount, kvOnly: kvOnlyCount,
      sessions: [...new Set([...targets.values()].map((target) => target.sessionId))] },
    "keepalive.tick_scan",
  );

  // Rotated, so a sweep that cannot finish does not always give up on the same
  // tail. Ordering is otherwise insertion order, which is stable across sweeps.
  // Whatever the last sweep left unserved goes first, in the order it was
  // deferred, and the rest follow. Resuming at a position -- or at one identity
  // and falling back to the front when it has gone -- lets an arrival or a
  // departure put an already-served target ahead of a waiting one, repeatedly,
  // which is what makes the deferral count unbounded.
  const ordered = [...targets.entries()];
  const waiting = pingDeferred.filter((key) => targets.has(key));
  const waitingSet = new Set(waiting);
  const rotated = [
    ...waiting.map((key) => [key, targets.get(key)!] as const),
    ...ordered.filter(([key]) => !waitingSet.has(key)),
  ];
  const clock = deps.now ?? Date.now;
  const pingDeadline = clock() + (deps.pingBudgetMs ?? PING_PHASE_BUDGET_MS);
  let pinged = 0;
  let deferred = 0;
  const failures: KeepaliveFailure[] = [];

  const deferredNow: string[] = [];
  await forEachWithLimit(rotated, PING_MAX_IN_FLIGHT, async ([targetKey, target]) => {
    // Checked as each target is picked up, so this bounds when a ping may
    // start, not when the phase ends: the pings already running continue past
    // the deadline. See PING_PHASE_BUDGET_MS.
    if (clock() >= pingDeadline) {
      deferred += 1;
      deferredNow.push(targetKey);
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
      // Refresh KV TTL so the entry survives across Brain restarts. Read-through
      // and write back to the key it was found under: a binding an old replica
      // still holds under the legacy name would otherwise never be refreshed,
      // and the live sandbox's record would expire underneath it.
      const existing = await readHandsEntry(deps.kv, sessionId).catch(() => null);
      if (existing) {
        try {
          const recorded = JSON.parse(existing.value) as HandsKvEntry;
          if (sameRegisteredSandbox(entry, recorded)) {
            await deps.kv.update(existing.key, existing.entry.value, existing.revision);
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
  await handleKeepaliveFailures(failures, targets.size, clock);

  pingDeferred = deferredNow;
  if (deferred > 0) {
    logger.warn(
      { pinged, deferred, total: ordered.length,
        budgetMs: deps.pingBudgetMs ?? PING_PHASE_BUDGET_MS },
      "keepalive.ping_budget_exhausted",
    );
  }
}

/**
 * Start the periodic keepalive. Idempotent.
 *
 * @returns the first sweep, which admission waits on: the roster is stamped
 * empty at boot, so a claim committed before the running fleet has been
 * reconciled onto it is checked against a count that omits every sandbox this
 * replica did not create.
 */
export function startSandboxKeepalive(deps: KeepaliveDeps): Promise<void> {
  if (SANDBOX_KEEPALIVE_INTERVAL_SEC <= 0) {
    logger.info("keepalive.disabled (SANDBOX_KEEPALIVE_INTERVAL_SEC <= 0)");
    return Promise.resolve();
  }
  if (timer) return Promise.resolve();
  logger.info(
    {
      intervalSec: SANDBOX_KEEPALIVE_INTERVAL_SEC,
      failLimit: SANDBOX_KEEPALIVE_FAIL_LIMIT,
    },
    "keepalive.start",
  );
  const census = runGuardedSweep(deps);
  // Guarded, because a sweep is not guaranteed to finish inside its interval:
  // it walks every KV handle serially and can make a network call per idle one.
  // Overlapping sweeps would double every write in here and race each other's
  // conditional updates, and the symptom -- handles refreshed twice, others not
  // at all -- would read as KV flakiness rather than as this.
  timer = setInterval(() => void runGuardedSweep(deps), SANDBOX_KEEPALIVE_INTERVAL_SEC * 1000);
  timer.unref?.();
  return census;
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
function runGuardedSweep(deps: KeepaliveDeps): Promise<void> {
  if (sweeping) {
    logger.warn({}, "keepalive.tick_still_running");
    return Promise.resolve();
  }
  sweeping = true;
  return tick(deps)
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
