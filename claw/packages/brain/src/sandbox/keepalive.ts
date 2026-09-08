// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { randomBytes } from "node:crypto";
import { StringCodec, type KV } from "nats";
import { isRevisionConflict } from "@claw/utils";
import { applyRunEndedIdleFields, PROTECTED_CLASSES, type RunEndedParkResult } from "@claw/protocol";
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
import {
  ledgerKeyForRetention, reassertRetentions, releaseRetention,
} from "./retain-container.js";
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
  /** Test seam for the durable DAG handle map, which needs JetStream otherwise. */
  listDagHandles?: () => Promise<Array<[string, Record<string, HandleInfo>]>>;
  /** Test seam for the ping-phase budget. */
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
  seenIdentities: Set<string>,
): Promise<boolean> {
  const held = sandboxEntryFrom(info);
  if (!held) {
    logger.error({ key }, "keepalive.retention_unaddressable");
    return false;
  }
  const sessionId = sessionIdFromHandsKey(key);
  // Under the same physical identity as every other target: a retention names
  // its own key and no session, so keying by it would give a container already
  // reached through a session binding or a DAG handle a second roster slot and
  // a second ping a sweep.
  const identity = sandboxRegistryKey(held);
  seenIdentities.add(identity);
  if (!targets.has(identity)) targets.set(identity, { sessionId, entry: held });

  const inst = instanceFromEntry(sessionId, info as never);
  const live = inst
    ? await countLiveWork(inst, HANDS_STATE_DIR)
    : { verdict: "unknown" as const, classes: {}, reason: "entry_unaddressable" };
  if (live.verdict === "clear") {
    await releaseRetention(retentionStore(deps.kv), key, ledgerKeyForRetention(key));
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

/**
 * The sandbox identity a KV entry names.
 * A session key may point to different pods over time, so probe results are
 * matched against this identity before being persisted.
 */
function entryIdentity(info: HandsKvEntry): string {
  return sandboxRegistryKey({
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
  return readHandsEntry(kv, sessionId)
    .then(async (entry): Promise<RunEndedParkResult> => {
      if (!entry) return { outcome: "gone" };
      const kvKey = entry.key;
      let info: HandsKvEntry;
      try {
        info = JSON.parse(entry.value) as HandsKvEntry;
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
      forgetBackgroundWork(sandboxRegistryKey({
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
 * Only positive idle or gone evidence may permit reclaim.
 */
type BackgroundWork = "running" | "idle" | "gone" | "unknown";

/** Local measured-verdict reuse interval. */
const BG_PROBE_TTL_MS = 5 * 60_000;
const BG_PROBE_REFRESH_MS = 4 * 60_000;

/**
 * Consecutive unanswered probes before reporting an unreconciled handle.
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


const bgProbeCache = new Map<
  string,
  {
    at: number; state: BackgroundWork; epoch?: number; idleSince?: number; idleRev?: number;
    verdictAtStart?: VerdictWitness;
  }
>();

const bgUnknownStreak = new Map<string, { count: number; at: number }>();
const bgProbeInFlight = new Set<string>();
/**
 * Bumped whenever an in-flight answer becomes obsolete. Probes discard results
 * whose captured generation no longer matches.
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
  bgRunning: number; bgUnknown: number; bgIdle: number; bgGone: number;
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
    bgRunning: 0, bgUnknown: 0, bgIdle: 0, bgGone: 0,
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
): { at: number; state: BackgroundWork } | null {
  const cached = bgProbeCache.get(identity);
  if (!cached) return null;
  if (Date.now() - cached.at >= BG_PROBE_TTL_MS) return null;
  if (!sameIdlePeriod(cached.epoch, info)) return null;
  // Another replica can reactivate the handle without bumping this process's generation.
  if (!measuredUnderThisIdlePeriod(
    cached.at, cached.idleSince, cached.idleRev, info, cached.state,
  )) return null;
  if ((cached.state === "gone" || cached.state === "unknown")
    && (!cached.verdictAtStart || !sameVerdict(cached.verdictAtStart, info))) return null;
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
  const cached = usableCachedVerdict(identity, info);
  const shared = usableSharedVerdict(info);
  if (cached?.state === "gone" || cached?.state === "unknown") {
    return { state: cached.state, source: "mem", at: cached.at };
  }
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
  if (cached && cached.state !== "unknown" && Date.now() - cached.at < BG_PROBE_REFRESH_MS) return false;
  return !bgProbeInFlight.has(identity);
}

/**
 * Fleet-unique token for probe reservations and idle-write acknowledgement.
 */
const entryTokenPrefix = randomBytes(16).toString("hex");
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
  deps: KeepaliveDeps, key: string, identity: string, token: string,
): Promise<boolean> {
  for (let attempt = 1; attempt <= BG_PROBE_RESERVE_ATTEMPTS; attempt++) {
    try {
      const e = await deps.kv.get(key);
      if (!e) return false;
      const info = JSON.parse(sc.decode(e.value)) as HandsKvEntry;
      if (entryIdentity(info) !== identity) return false;
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
  deps: KeepaliveDeps, key: string, identity: string, token: string,
): Promise<void> {
  try {
    const e = await deps.kv.get(key);
    if (!e) return;
    const info = JSON.parse(sc.decode(e.value)) as HandsKvEntry;
    if (entryIdentity(info) !== identity) return;
    if (!info.bgProbes || !(token in info.bgProbes)) return;
    const bgProbes = liveProbeReservations(info, Date.now());
    delete bgProbes[token];
    const next: HandsKvEntry = { ...info, bgProbes };
    if (Object.keys(bgProbes).length === 0) delete next.bgProbes;
    await deps.kv.update(key, sc.encode(JSON.stringify(next)), e.revision);
  } catch { /* best effort: the deadline is the backstop */ }
}

interface ProbeCandidate {
  key: string;
  identity: string;
  sessionId: string;
  info: HandsKvEntry;
  generation: number;
}

interface BackgroundProbe extends ProbeCandidate {
  token: string;
  verdictAtStart: VerdictWitness;
}

function probeIsStale(probe: ProbeCandidate): boolean {
  return (bgGeneration.get(probe.identity) ?? 0) !== probe.generation;
}

/** Start bounded asynchronous probes, rotating deferred candidates into later sweeps. */
function dispatchProbes(deps: KeepaliveDeps, candidates: ProbeCandidate[]): number {
  if (candidates.length === 0) return 0;
  const start = bgProbeCursor % candidates.length;
  let started = 0;
  for (let n = 0; n < candidates.length; n++) {
    if (bgProbeInFlight.size >= BG_PROBE_MAX_IN_FLIGHT) break;
    const candidate = candidates[(start + n) % candidates.length];
    if (bgProbeInFlight.has(candidate.identity)) continue;
    const probe: BackgroundProbe = {
      ...candidate, info: { ...candidate.info }, token: nextEntryToken(),
      verdictAtStart: verdictWitness(candidate.info),
    };
    bgProbeInFlight.add(probe.identity);
    started += 1;
    void runBackgroundProbe(deps, probe).finally(() => bgProbeInFlight.delete(probe.identity));
  }
  bgProbeCursor = start + started;
  return started;
}

async function runBackgroundProbe(deps: KeepaliveDeps, probe: BackgroundProbe): Promise<void> {
  const { key, identity, sessionId, info, token } = probe;
  try {
    const reserved = await reserveProbe(deps, key, identity, token);
    if (!reserved || probeIsStale(probe)) return;
    try {
      const running = await (deps.countActiveShells ?? countActiveShells)(
        info.handsUrl!, info.token!, sessionId,
      );
      await recordProbeVerdict(deps, probe, running > 0 ? "running" : "idle", running);
    } catch (err) {
      if (probeIsStale(probe)) return;
      await invalidateProbeVerdict(deps, probe);
      if (probeIsStale(probe)) return;
      const evidence = await readProbeEvidence(probe);
      if (probeIsStale(probe)) return;
      if (evidence.state === "unknown") reportUnknownProbe(probe, err);
      else await recordProbeVerdict(deps, probe, evidence.state, evidence.running);
    }
  } catch (err) {
    if (!probeIsStale(probe)) {
      await invalidateProbeVerdict(deps, probe);
      if (!probeIsStale(probe)) reportUnknownProbe(probe, err);
    }
  } finally {
    await releaseProbe(deps, key, identity, token);
  }
}

async function invalidateProbeVerdict(deps: KeepaliveDeps, probe: BackgroundProbe): Promise<void> {
  const { key, identity, info, verdictAtStart } = probe;
  bgProbeCache.set(identity, {
    at: Date.now(), state: "unknown", epoch: info.idleEpoch,
    idleSince: info.idleSince, idleRev: info.idleRev, verdictAtStart,
  });
  try {
    const e = await deps.kv.get(key);
    if (!e || probeIsStale(probe)) return;
    const current = JSON.parse(sc.decode(e.value)) as HandsKvEntry;
    if (entryIdentity(current) !== identity || !sameIdlePeriod(info.idleEpoch, current)
      || info.idleSince !== current.idleSince || info.idleRev !== current.idleRev
      || !sameVerdict(verdictAtStart, current)) return;
    if (current.bgCheckedAt === undefined && current.bgRunning === undefined) {
      bgProbeCache.delete(identity);
      return;
    }
    for (const field of ["bgCheckedAt", "bgRunning", "bgEpoch", "bgIdleSince", "bgIdleRev", "bgRev"] as const) {
      delete current[field];
    }
    await deps.kv.update(key, sc.encode(JSON.stringify(current)), e.revision);
    if (!probeIsStale(probe)) bgProbeCache.delete(identity);
    probe.verdictAtStart = verdictWitness(current);
  } catch (err) {
    logger.warn({ err, sessionId: probe.sessionId }, "keepalive.verdict_invalidation_failed");
  }
}

async function readProbeEvidence(
  probe: BackgroundProbe,
): Promise<{ state: BackgroundWork; running?: number }> {
  const inst = instanceFromEntry(probe.sessionId, probe.info);
  if (!inst) return { state: "unknown" };
  const provider = inst.provider === "agent-sandbox"
    ? getAgentSandboxProvider() : getSafeWorkloadProvider();
  try {
    const status = await provider.get(inst);
    if (probeIsStale(probe)) return { state: "unknown" };
    if (status.state === "absent" || status.state === "terminal") return { state: "gone" };
  } catch (err) {
    logger.warn({ err, sessionId: probe.sessionId }, "keepalive.provider_evidence_failed");
  }
  if (probeIsStale(probe)) return { state: "unknown" };
  const live = await countLiveWork(inst, HANDS_STATE_DIR);
  if (probeIsStale(probe)) return { state: "unknown" };
  if (live.verdict === "clear") return { state: "idle", running: 0 };
  if (live.verdict === "protected") {
    const running = PROTECTED_CLASSES.reduce((sum, cls) => sum + (live.classes[cls] ?? 0), 0);
    return { state: "running", running };
  }
  logger.warn({ sessionId: probe.sessionId, reason: live.reason }, "keepalive.work_evidence_unknown");
  return { state: "unknown" };
}

async function recordProbeVerdict(
  deps: KeepaliveDeps,
  probe: BackgroundProbe,
  state: BackgroundWork,
  running?: number,
): Promise<void> {
  if (probeIsStale(probe)) return;
  const { key, identity, sessionId, info, verdictAtStart } = probe;
  const held = localRegistry.has(identity)
    || await sessionHasActiveRunLease(deps.kv, sessionId, info.runScope);
  if (probeIsStale(probe)) return;
  if (held && state !== "running") return;
  const measuredAt = Date.now();
  bgProbeCache.set(identity, {
    at: measuredAt, state, epoch: info.idleEpoch,
    idleSince: info.idleSince, idleRev: info.idleRev, verdictAtStart,
  });
  bgUnknownStreak.delete(identity);
  if (running !== undefined) {
    await persistVerdict(
      deps, key, sessionId, identity, running, measuredAt,
      info.idleEpoch, info.idleSince, info.idleRev, verdictAtStart, () => probeIsStale(probe),
    );
  }
  if (state === "running") {
    logger.info(
      { sessionId, sandboxName: info.sandboxName, workloadId: info.workloadId, running },
      "keepalive.idle_handle_kept_background_work",
    );
  }
}

function reportUnknownProbe(probe: BackgroundProbe, err: unknown): void {
  const { identity, sessionId, info } = probe;
  if (err instanceof HandsLivenessIndeterminate) {
    logger.error({ sessionId, workloadId: info.workloadId }, "keepalive.background_work_indeterminate");
    return;
  }
  const streak = (bgUnknownStreak.get(identity)?.count ?? 0) + 1;
  bgUnknownStreak.set(identity, { count: streak, at: Date.now() });
  logger.warn(
    { err: (err as Error)?.message ?? err, sessionId, streak },
    "keepalive.background_work_check_failed",
  );
  if (streak > BG_UNKNOWN_TOLERANCE) {
    logger.error(
      { sessionId, workloadId: info.workloadId, streak },
      "keepalive.background_work_unreconciled",
    );
  }
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
  key: string,
  sessionId: string,
  identity: string,
  running: number,
  measuredAt: number,
  epoch: number | undefined,
  idleSinceAtStart: number | undefined,
  idleRevAtStart: number | undefined,
  verdictAtStart: VerdictWitness,
  stale: () => boolean,
): Promise<void> {
  try {
    // Re-read all guards after contention; `idle` yields after one attempt.
    let workloadId: string | undefined;
    const attempts = running > 0 ? BG_VERDICT_WRITE_ATTEMPTS : 1;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const e = await deps.kv.get(key);
      if (!e || stale()) return;
      const info = JSON.parse(sc.decode(e.value)) as HandsKvEntry;
      workloadId = info.workloadId;
      if (entryIdentity(info) !== identity) {
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
        bgCheckedAt: measuredAt,
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
    const next = sc.encode(JSON.stringify({ ...info, idleSince, workSeenAt: (deps.now ?? Date.now)() }));
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

interface TargetCensus {
  targets: Map<string, RegisteredSandbox>;
  seenIdentities: Set<string>;
  probeCandidates: ProbeCandidate[];
  stats: TickStats;
}

type HandsRecord = { value: Uint8Array; revision: number };

async function collectTargets(
  deps: KeepaliveDeps,
  seenIdentities: Set<string>,
  stats: TickStats,
): Promise<{ targets: Map<string, RegisteredSandbox>; complete: boolean }> {
  const census: TargetCensus = { targets: new Map(), seenIdentities, probeCandidates: [], stats };
  for (const [key, registered] of localRegistry) {
    if (await shouldSkipExpiredRetry(deps, registered.sessionId, "local", registered.entry)) continue;
    census.targets.set(key, registered);
  }
  const kvComplete = await collectKvTargets(deps, census);
  const dagComplete = await collectDagTargets(deps, census);
  stats.probes += dispatchProbes(deps, census.probeCandidates);
  return { targets: census.targets, complete: kvComplete && dagComplete };
}

async function collectKvTargets(deps: KeepaliveDeps, census: TargetCensus): Promise<boolean> {
  let complete = true;
  try {
    const keys = await deps.kv.keys("hands.*");
    for await (const key of keys) {
      let e: Awaited<ReturnType<typeof deps.kv.get>>;
      try {
        e = await deps.kv.get(key);
      } catch (err) {
        complete = false;
        logger.warn({ err: (err as Error)?.message, key }, "keepalive.entry_read_failed");
        continue;
      }
      if (!e) continue;
      try {
        if (!await collectKvTarget(deps, census, key, e)) complete = false;
      } catch (err) {
        complete = false;
        logger.warn({ err: (err as Error)?.message, key }, "keepalive.entry_unreadable");
      }
    }
  } catch (err) {
    complete = false;
    logger.warn({ err }, "keepalive.kv_scan_failed");
  }
  return complete;
}

async function collectKvTarget(
  deps: KeepaliveDeps, census: TargetCensus, key: string, e: HandsRecord,
): Promise<boolean> {
  const sessionId = sessionIdFromHandsKey(key);
  const info = JSON.parse(sc.decode(e.value)) as HandsKvEntry;
  if (info.status && info.status !== "ready") return true;
  if (isRetentionEntry(info)) {
    return sweepRetention(deps, key, e, info, census.targets, census.seenIdentities);
  }
  const identity = entryIdentity(info);
  census.seenIdentities.add(identity);
  if (info.keepalive === false && await collectIdleTarget(deps, census, key, e, info)) return true;
  const entry = sandboxEntryFrom(info);
  if (!entry || await shouldSkipExpiredRetry(deps, sessionId, "kv", entry, key)) return true;
  // Renew before queueing so bounded ping concurrency cannot exhaust the TTL.
  await deps.kv.update(key, e.value, e.revision).catch(() => {});
  if (!census.targets.has(identity)) census.targets.set(identity, { sessionId, entry });
  return true;
}

function stampIdlePeriod(info: HandsKvEntry, e: HandsRecord): Uint8Array {
  if (typeof info.idleEpoch === "number" && typeof info.idleRev === "number") return e.value;
  if (typeof info.idleEpoch !== "number") {
    info.idleEpoch = typeof info.idleSince === "number" ? info.idleSince : Date.now();
  }
  if (typeof info.idleRev !== "number") info.idleRev = e.revision;
  return sc.encode(JSON.stringify(info));
}

async function collectIdleTarget(
  deps: KeepaliveDeps, census: TargetCensus, key: string, e: HandsRecord, info: HandsKvEntry,
): Promise<boolean> {
  const identity = entryIdentity(info);
  const sessionId = sessionIdFromHandsKey(key);
  const value = stampIdlePeriod(info, e);
  const peeked = peekBackgroundWork(identity, info);
  const bgWork = peeked.state;
  const stats = census.stats;
  if (bgWork === "running") stats.bgRunning += 1;
  else if (bgWork === "unknown") stats.bgUnknown += 1;
  else if (bgWork === "gone") stats.bgGone += 1;
  else stats.bgIdle += 1;
  if (peeked.source === "mem") stats.fromMem += 1;
  else if (peeked.source === "handle") stats.fromHandle += 1;
  else if (peeked.source === "none") stats.fromNone += 1;
  else if (peeked.source === "no-hands") stats.fromNoHands += 1;
  const candidate = { key, identity, sessionId, info, generation: bgGeneration.get(identity) ?? 0 };
  if (needsProbe(identity, info)) census.probeCandidates.push(candidate);
  if (bgWork === "running" || bgWork === "unknown") {
    const seenAt = bgWork === "running" ? peeked.at ?? Date.now() : (deps.now ?? Date.now)();
    await refreshIdleSince(deps, key, e.revision, info, seenAt);
    return false;
  }
  const expired = bgWork === "gone"
    || (deps.now ?? Date.now)() - reuseWindowStart(info) > SANDBOX_IDLE_REUSE_MS;
  if (expired) await expireIdleTarget(deps, candidate, { ...e, value }, stats);
  else {
    stats.withinWindow += 1;
    await deps.kv.update(key, value, e.revision).catch(() => {});
  }
  return true;
}

async function expireIdleTarget(
  deps: KeepaliveDeps, candidate: ProbeCandidate, e: HandsRecord, stats: TickStats,
): Promise<void> {
  const { key, identity, sessionId, info } = candidate;
  if (registeredSandboxCount(sessionId) > 0 || localRegistry.has(identity)) {
    stats.keptLocal += 1;
    return;
  }
  if (await sessionHasActiveRunLease(deps.kv, sessionId, info.runScope)) {
    stats.keptRunLease += 1;
    return;
  }
  if (probeIsStale(candidate) || localRegistry.has(identity) || registeredSandboxCount(sessionId) > 0) {
    stats.keptLocal += 1;
    return;
  }
  if (probeOutstanding(info)) {
    stats.keptProbe += 1;
    await deps.kv.update(key, e.value, e.revision).catch(() => {});
    return;
  }
  // Release only after the conditional delete wins against any reactivation.
  const deleted = await deps.kv.delete(key, { previousSeq: e.revision })
    .then(() => true).catch(() => false);
  if (deleted) {
    stats.expired += 1;
    if (!await releaseAdmission(identity)) {
      logger.error({ sessionId, identity }, "keepalive.admission_release_unconfirmed");
    }
  }
  logger.info(
    { sessionId, sandboxName: info.sandboxName, workloadId: info.workloadId, deleted },
    "keepalive.idle_handle_expired",
  );
}

async function collectDagTargets(deps: KeepaliveDeps, census: TargetCensus): Promise<boolean> {
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
          ? !!entry.sessionId : !!(entry.workloadId && entry.platformKey);
        if (!usable) continue;
        const key = sandboxRegistryKey(entry);
        census.seenIdentities.add(key);
        if (!census.targets.has(key)) census.targets.set(key, { sessionId: dagRoot, entry });
      }
    }
    return true;
  } catch (err) {
    logger.warn({ err: (err as Error)?.message }, "keepalive.dag_handle_scan_failed");
    return false;
  }
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
    await renewAndReap(
      deps.roster.store, deps.roster.config, new Set(identities), Date.now(), censusComplete,
    );
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

async function reconcileKeepaliveKeyspaces(kv: KV): Promise<void> {
  // Every sweep, not only at boot: an old replica writes the legacy key
  // throughout a rolling upgrade, after every new one has already scanned.
  await reconcileReservedKeys(kv).catch((err) => logger.error(
    { err: (err as Error)?.message }, "keepalive.reserved_key_reconcile_failed",
  ));
  // After that migration and not before it: a pre-scheme replica's binding
  // sitting on a retention's key is moved to its canonical name there, which is
  // what frees the key this puts the retention back under.
  await reassertRetentions(retentionStore(kv)).catch((err) => logger.error(
    { err: (err as Error)?.message }, "keepalive.retention_reassert_failed",
  ));
}

function pruneSweepState(
  targets: Map<string, RegisteredSandbox>,
  seenIdentities: Set<string>,
): void {
  for (const key of failCounts.keys()) {
    if (!targets.has(key)) failCounts.delete(key);
  }
  // Reap by each verdict's lifetime; absence from one rotating sweep is not stale.
  const now = Date.now();
  for (const [identity, cached] of [...bgProbeCache.entries()]) {
    const floor = now - Math.max(BG_VERDICT_TTL_MS, BG_PROBE_TTL_MS);
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
}

function orderedPingTargets(
  targets: Map<string, RegisteredSandbox>,
): Array<readonly [string, RegisteredSandbox]> {
  // Deferred targets lead the next sweep so repeated budget exhaustion stays fair.
  const waiting = pingDeferred.filter((key) => targets.has(key));
  const waitingSet = new Set(waiting);
  return [
    ...waiting.map((key) => [key, targets.get(key)!] as const),
    ...[...targets.entries()].filter(([key]) => !waitingSet.has(key)),
  ];
}

async function pingSandbox(
  deps: KeepaliveDeps,
  targetKey: string,
  target: RegisteredSandbox,
): Promise<KeepaliveFailure | null> {
  const { sessionId, entry } = target;
  const isAgent = entry.provider === "agent-sandbox";
  if (isAgent ? !entry.sessionId : (!entry.workloadId || !entry.platformKey)) return null;

  try {
    if (isAgent) {
      await getAgentSandboxProvider().get({
        provider: "agent-sandbox",
        id: entry.sessionId!,
        sandboxName: entry.sandboxName ?? "",
        namespace: entry.namespace ?? "",
        handsBaseUrl: "",
        userId: entry.userId,
      });
    } else {
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
    logger.info(
      { sessionId, provider: entry.provider ?? "safe-workload", workloadId: entry.workloadId },
      "keepalive.ping",
    );
    return null;
  } catch (error: any) {
    if (error?.sandboxConfirmedRunning === true) {
      failCounts.delete(targetKey);
      logger.error(
        { err: error?.message || String(error), sessionId, workloadId: entry.workloadId },
        "keepalive.router_failed_for_running_sandbox",
      );
      return null;
    }
    return { targetKey, sessionId, entry, error, gone: error?.sandboxGone === true };
  }
}

interface PingPhaseResult {
  deferred: number;
  deferredNow: string[];
  failures: KeepaliveFailure[];
  orderedCount: number;
  pinged: number;
}

async function runPingPhase(
  deps: KeepaliveDeps,
  targets: Map<string, RegisteredSandbox>,
): Promise<PingPhaseResult> {
  const ordered = orderedPingTargets(targets);
  const clock = deps.now ?? Date.now;
  const pingDeadline = clock() + (deps.pingBudgetMs ?? PING_PHASE_BUDGET_MS);
  let pinged = 0;
  let deferred = 0;
  const failures: KeepaliveFailure[] = [];
  const deferredNow: string[] = [];
  await forEachWithLimit(ordered, PING_MAX_IN_FLIGHT, async ([targetKey, target]) => {
    if (clock() >= pingDeadline) {
      deferred += 1;
      deferredNow.push(targetKey);
      return;
    }
    pinged += 1;
    const failure = await pingSandbox(deps, targetKey, target);
    if (failure) failures.push(failure);
  });

  return { deferred, deferredNow, failures, orderedCount: ordered.length, pinged };
}

async function tick(deps: KeepaliveDeps): Promise<void> {
  const seenIdentities = new Set<string>();
  await reconcileKeepaliveKeyspaces(deps.kv);
  const stats = newTickStats();
  const census = await collectTargets(deps, seenIdentities, stats);
  const targets = census.targets;
  const servable = await admitTargets(deps, targets, census.complete);
  if (servable) dropUnadmitted(targets, servable);
  pruneSweepState(targets, seenIdentities);

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

  const clock = deps.now ?? Date.now;
  const phase = await runPingPhase(deps, targets);

  await handleKeepaliveFailures(phase.failures, targets.size, clock);

  pingDeferred = phase.deferredNow;
  if (phase.deferred > 0) {
    logger.warn(
      { pinged: phase.pinged, deferred: phase.deferred, total: phase.orderedCount,
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
  // A sweep may outlast the interval, so interval invocations share the guard.
  timer = setInterval(() => void runGuardedSweep(deps), SANDBOX_KEEPALIVE_INTERVAL_SEC * 1000);
  timer.unref?.();
  return census;
}

/**
 * One sweep, never two at once.
 * Overlap would duplicate writes and race conditional updates.
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
