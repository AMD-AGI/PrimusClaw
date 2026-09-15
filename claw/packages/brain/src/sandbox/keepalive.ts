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
import { isTombstone } from "../tasks/lock.js";
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
import { LIVE_WORK_READ_CEILING_MS, countLiveWork } from "./live-work-gate.js";
import type { SandboxInstance } from "./provider.js";
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
 * One retained container's turn in the walk.
 *
 * It is a target like any other -- pinged, its lifetime refreshed -- and it is
 * never probed for a shell count: its key names no session, so the owner a
 * probe would ask about owns nothing, and the zero that came back would file
 * the container idle and reclaim the very work the retention protects.
 *
 * What ends a retention is the evidence that caused it reaching zero, read the
 * same way it was taken. Without this the entry is permanent and the container
 * never returns to the ordinary lifetime machinery. That read is the one
 * expensive thing on this path, and it does not happen here: the walk enrols
 * the retention and queues it, and `runRetentionReadPhase` decides whose turn it
 * is once the whole walk is known. See `retentionDeferred` for why the decision
 * cannot be made from inside the walk at all.
 *
 * Everything this does for a retention it does for every retention, with no
 * branch on whether the read will be taken this sweep: target and identity go
 * into the census, the record behind the projection is refreshed, and the
 * projection is renewed. That is what makes a deferred read free -- the
 * container is pinged and named to `renewAndReap` exactly as a read one is --
 * and it is why the refreshes now precede the read rather than following it.
 *
 * @returns false where the sweep could not complete this entry, which is not
 * the same as an entry it completed and found nothing in.
 */
async function sweepRetention(
  deps: KeepaliveDeps,
  census: TargetCensus,
  key: string,
  entry: { value: Uint8Array; revision: number },
  info: HandsKvEntry,
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
  census.seenIdentities.add(identity);
  if (!census.targets.has(identity)) census.targets.set(identity, { sessionId, entry: held });

  const ledgerKey = ledgerKeyForRetention(key);
  const inst = instanceFromEntry(sessionId, info as never);
  // An entry nothing can be addressed through is not queued at all rather than
  // queued and answered `unknown` every sweep: a read that can never be taken
  // would otherwise hold a place in the queue for as long as the entry exists,
  // and the bound the queue states is a number of turns.
  if (inst) census.retentionReads.set(key, { key, ledgerKey, inst });
  else logger.warn({ key }, "keepalive.retention_unreadable");

  // The record behind the projection, which this bucket expires like everything
  // else in it: written once when the retention was taken and never again, it
  // outlives the retention by one TTL window and no longer, after which a
  // projection an old replica writes over is restored from nothing. At the
  // value the projection holds, byte for byte, so what a later reassertion puts
  // back is still what was retained.
  //
  // Refreshed, never created, and before the projection rather than after it --
  // between them is the one order that cannot resurrect a retention another
  // replica has given up. `releaseRetention` removes the record first and the
  // projection second, so a release interleaved anywhere around these two
  // writes settles as removed: ahead of both, the record is gone and this
  // refuses to put it back; between them, the release's own delete of the
  // projection lands after this refresh; after both, it removes what was just
  // written. Creating the record here instead -- an unconditional put -- would
  // write it back in that middle window, and the next `reassertRetentions`
  // would restore a retention whose work had already finished.
  //
  // Both refreshes now run ahead of the read rather than only on the branch
  // where the read said the retention still holds, and that is safe on the same
  // argument: they extend the lifetime of a retention that is still held at the
  // moment they run -- nothing has read anything yet, and `unknown` is what an
  // unread retention is worth -- while the only irreversible act, the release,
  // still happens strictly after a read that answered `clear`. A release that
  // follows them in this sweep deletes what they just refreshed, and one that
  // another replica interleaves with them settles as removed by the ordering
  // above, unchanged. What the old order bought was skipping two writes on the
  // sweep that released; what it cost was that the writes could not be reached
  // at all without first spending the read.
  //
  // Its failure is not the projection's. The projection is the live protection
  // and this is only what repairs it, so a record that could not be refreshed
  // is logged and the sweep goes on to the refresh that matters.
  await refreshRetentionLedger(deps.kv, ledgerKey, entry.value);

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
 * The reads a sweep may take, in the order they are owed.
 *
 * The same shape `orderedPingTargets` uses, for the same reason: everything
 * still waiting leads, in the order it has been waiting, and everything else
 * follows. What it buys here is that the schedule stops being a function of the
 * walk.
 *
 * That matters because the walk is not an order at all. `KV.keys()` enumerates
 * the last value per subject in stream-sequence order, so a key moves to the
 * back of the next walk every time anything writes it -- and this sweep writes
 * them itself: the projection refresh above touches every retention, and
 * `pingSandbox` writes the `hands.` record of every retention it pinged, from a
 * ping phase that rotates its own batch whenever its budget runs out. A scheme
 * that decides whose turn it is from a position in that walk -- a resume point,
 * a cursor, "everything from here on" -- is reading a permutation that its own
 * writes reshuffle between sweeps, and an unread retention carried ahead of the
 * resume point is skipped for being ahead of it, sweep after sweep, while its
 * refreshes keep it alive and its ping keeps its admission slot.
 *
 * A queue cannot be reshuffled by a write. Every retention still owed a read is
 * ahead of every retention that has had one, whatever order the keyspace is
 * handed over in, so each sweep the position of a waiting retention strictly
 * decreases by the number of reads that sweep took -- at least one, because the
 * budget bars *starting* a read and the phase begins with the budget whole. With
 * R retentions present, every one of them is read within R sweeps.
 *
 * Counted over the sweeps the walk could read it, which is the only kind of
 * sweep that could have served it. A key this walk failed to read is not in
 * `reads` and so is not offered here, and `rebuildRetentionQueue` leaves it
 * where it was waiting rather than dropping it; the reads that sweep does take
 * come from the same queue in the same order, so on every sweep a waiting
 * retention IS visible the phase reads either it or something ahead of it, and
 * what it reads leaves the queue -- released, or re-entering behind it. Nothing
 * enters ahead of it: a key deferred keeps the place it had, and a key seen for
 * the first time follows every key already waiting.
 */
function orderedRetentionReads(reads: Map<string, RetentionRead>): RetentionRead[] {
  const waiting = retentionDeferred.filter((key) => reads.has(key));
  const waitingSet = new Set(waiting);
  return [
    ...waiting.map((key) => reads.get(key)!),
    ...[...reads.entries()].filter(([key]) => !waitingSet.has(key)).map(([, read]) => read),
  ];
}

/**
 * Read live-work evidence out of as many retained containers as the budget
 * allows, and release the ones whose work has finished.
 *
 * A phase of its own, after the walk, rather than a decision taken inside it.
 * Three things follow from that and none of them followed from the alternative:
 *
 *   - The order is the queue's, not the keyspace's. Whose turn it is cannot be
 *     decided until the whole set of retentions is known, and inside the walk it
 *     is not known.
 *   - The budget is the phase's own wall clock, armed when the phase starts.
 *     Inside the walk the same budget had to be metered over the reads by hand,
 *     because a deadline armed at the top of the census is spent by the store
 *     round trips the walk makes -- and a store slow enough to retire it before
 *     the first retention is reached leaves nothing to read any of them with, on
 *     this sweep or any sweep after it. Here there is nothing else inside the
 *     phase to spend it.
 *   - The term it contributes to `keepaliveSweepCeilingSec()` is the phase's
 *     whole span, which is what a term in that sum has to be.
 *
 * Serial, like the evictions in the failure phase: these reads are the thing
 * being bounded, and starting several at once would make the bound a function of
 * how many containers are stuck rather than of the budget.
 */
async function runRetentionReadPhase(
  deps: KeepaliveDeps, census: TargetCensus, scanComplete: boolean,
): Promise<boolean> {
  const ordered = orderedRetentionReads(census.retentionReads);
  const clock = deps.now ?? Date.now;
  const deadline = clock() + CENSUS_READ_BUDGET_MS;
  const deferred: string[] = [];
  let complete = true;
  let taken = 0;
  let released = 0;
  for (const target of ordered) {
    // Barring the start of a read is the whole of the budget's authority; it
    // never interrupts one, which is why the ceiling pairs it with the ceiling
    // of a single read. At the head of the phase the budget is whole, so a sweep
    // always takes at least one read however long that read then holds -- which
    // is the forward progress the bound in `orderedRetentionReads` rests on.
    //
    // A read not taken is deferred rather than guessed at, and the deferral
    // costs this entry nothing: its target and its identity went into the census
    // during the walk, so the container is pinged this sweep and named to
    // `renewAndReap` like every other target, and both its records were
    // refreshed there too. `unknown` is the verdict that keeps a retention, so
    // all a deferral delays is the release of one whose work has already
    // finished -- and a retention held one sweep too long protects, where one
    // released on a guess destroys the work it was taken for.
    if (clock() >= deadline) {
      deferred.push(target.key);
      continue;
    }
    taken += 1;
    // Per entry, as the walk this phase was lifted out of already did. One
    // container's read or release is nothing to the rest of the fleet: a store
    // that refuses a delete, or a provider call that throws rather than timing
    // out, used to cost that entry its turn and no more, because every entry in
    // `collectKvTargets` is wrapped. Let it out of this loop instead and the
    // sweep exits before the roster is renewed and before a single ping goes
    // out -- so one unreachable retained container leaves every live sandbox in
    // the fleet without the refresh its idle deadline is proven against, and
    // does so again on every sweep for as long as the store keeps refusing.
    //
    // The entry is counted against the census rather than retried here: an
    // incomplete census is what stops `renewAndReap` from reaping on a fleet it
    // could not read whole, and a release that failed is exactly the case where
    // this sweep's account of the fleet is not to be trusted. The retention
    // stands meanwhile, which is the safe direction -- it protects work that may
    // already be finished rather than reclaiming work that is not.
    try {
      const live = await countLiveWork(target.inst, HANDS_STATE_DIR);
      if (live.verdict !== "clear") continue;
      // The only irreversible act on this path, and it still happens only after
      // a read that answered `clear`, on this sweep, about this container.
      await releaseRetention(retentionStore(deps.kv), target.key, target.ledgerKey);
      released += 1;
    } catch (err) {
      complete = false;
      logger.warn(
        { err: (err as Error)?.message, key: target.key },
        "keepalive.retention_read_failed",
      );
    }
  }
  retentionDeferred = rebuildRetentionQueue(
    retentionDeferred, census.retentionReads, deferred, scanComplete,
  );
  if (deferred.length) {
    logger.warn(
      { taken, released, deferred: deferred.length, total: ordered.length,
        budgetMs: CENSUS_READ_BUDGET_MS },
      "keepalive.census_read_deferred",
    );
  }
  return complete;
}

/**
 * The queue the next sweep inherits: every retention still owed a read, in the
 * order it has been owed.
 *
 * Rebuilt rather than pruned, because the rebuild is what keeps a released or
 * expired key out without a separate pruning step to forget. What the rebuild
 * cannot do on its own is tell the two reasons a key is missing apart. A
 * retention another replica released is gone, and a rebuild that drops it is
 * right. A retention whose `hands.` record this walk could not read is still
 * there -- still refreshed by whoever can read it, still pinged, still holding
 * its admission slot -- and a rebuild that drops it forgets a waiting position
 * that was earned. The key then re-enters at the BACK the next sweep the store
 * answers for it, and with reads that outlast the budget ahead of it that is a
 * livelock and not a delay: the sweeps it is visible for are spent on the
 * containers ahead of it, and the sweeps that would have advanced it are the
 * ones that forget it. Its work has finished and it holds a slot forever.
 *
 * So absence removes a key only from a walk that was COMPLETE, which is the one
 * state in which absence is evidence: `collectKvTargets` reports false the
 * moment any key could not be read, and a walk that read every key and did not
 * name this one is a walk saying it is gone. Anything else keeps it. A key kept
 * this way costs a queue position and nothing else -- it is not in `reads`, so
 * `orderedRetentionReads` never offers it and no sweep spends a read on it --
 * and it leaves on the first complete walk that does not name it, which is the
 * same filter that keeps a released one out.
 *
 * Order is the old queue's: a key kept or deferred holds the place it had, and
 * keys waiting for the first time follow in the order the phase deferred them.
 * That is what makes the position of a waiting retention monotone, which is
 * what the bound in `orderedRetentionReads` rests on.
 */
function rebuildRetentionQueue(
  previous: string[],
  reads: Map<string, RetentionRead>,
  deferred: string[],
  scanComplete: boolean,
): string[] {
  const deferredSet = new Set(deferred);
  const kept = previous.filter(
    (key) => deferredSet.has(key) || (!scanComplete && !reads.has(key)),
  );
  const keptSet = new Set(kept);
  return [...kept, ...deferred.filter((key) => !keptSet.has(key))];
}

/**
 * Put a retention's record back at the age it was written, if it is still there.
 *
 * On the revision it was just read at, so two replicas sweeping the same entry
 * do not both count as a refresh: the loser's conflict says the record was
 * refreshed by someone else in this window, which is the outcome it wanted.
 * A record that is simply gone is left gone -- see the ordering note above.
 */
async function refreshRetentionLedger(
  kv: KV, ledgerKey: string, value: Uint8Array,
): Promise<void> {
  try {
    const held = await kv.get(ledgerKey);
    if (!held || isTombstone(held)) {
      logger.warn({ ledgerKey }, "keepalive.retention_ledger_absent");
      return;
    }
    await kv.update(ledgerKey, value, held.revision);
  } catch (err) {
    if (isRevisionConflict(err)) return;
    logger.error(
      { err: (err as Error)?.message, ledgerKey }, "keepalive.retention_ledger_refresh_failed",
    );
  }
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
  // A read that failed is not a lock that is absent. Collapsing the two with
  // `.catch(() => null)` made a KV hiccup indistinguishable from "nobody holds
  // this", and the unregister below then ran on the strength of an error.
  let activeLock: Awaited<ReturnType<typeof deps.kv.get>> | null = null;
  let lockReadFailed = false;
  try {
    activeLock = await deps.kv.get(`lock.${lockKey}`);
  } catch (err) {
    lockReadFailed = true;
    logger.warn({ err, sessionId, lockKey }, "keepalive.retry_lock_read_failed");
  }
  if (lockReadFailed) {
    // Nothing is known, so nothing is released: the next sweep asks again.
    return false;
  }
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
 * How long the retention read phase may go on starting live-work reads.
 *
 * A budget rather than a count, and for the same reason the failure phase has
 * one: each retention's read awaits a container exec, so a fleet of
 * unresponsive retained containers makes an unbudgeted phase fleet-sized -- and
 * the declared sweep span, which every refresh gap and the reclaim horizon are
 * derived from, becomes a number the sweep routinely exceeds.
 *
 * Sized by subtraction, not by taste. What the declared span has to cover is the
 * phase's whole worst case, which is this budget plus `LIVE_WORK_READ_CEILING_MS`
 * for the one read the budget lets start; `keepaliveCensusPhaseCeilingSec()` is
 * that sum and 50s is what the span was already sized for. The per-read term used
 * to name the container's 20s command timeout, which the provider does not hold
 * the awaited call to -- it adds transport slack on top, and the SaFE path can
 * add a status lookup after that -- so the real term is 35s and the honest budget
 * at an unchanged phase ceiling is 15s. Paying for a true term out of the budget
 * rather than out of the span is deliberate: the span is what the operator's
 * config envelope is checked against, and moving it a second time would narrow
 * that envelope again for a correction that costs the schedule nothing.
 *
 * It costs the schedule nothing because what the budget buys is throughput, not
 * progress. Progress is one read a sweep, which is guaranteed at any budget at
 * all -- the budget bars the *starting* of a read and the phase starts with it
 * whole -- and that guarantee is the whole of the bound in
 * `orderedRetentionReads`. What 15s still buys is hundreds of reads a sweep from
 * containers that answer, which is every sweep in which nothing is wrong, and
 * one read a sweep from a fleet that will not answer, which is the case the
 * bound is stated for.
 *
 * Metered by the phase's own wall clock, which it can be because the phase runs
 * after the walk and contains nothing but these reads. Metering it inside the
 * walk was the only thing that made the number mean what its name says while the
 * walk was also spending it on store round trips.
 */
const CENSUS_READ_BUDGET_MS = 15_000;
/**
 * Every retention the last read phase left unread, in the order it deferred
 * them.
 *
 * The whole queue rather than a resume point, and this is the correction the
 * previous three rounds were each one step short of. A resume point is a
 * position in the walk, and the walk is `KV.keys()` -- last value per subject in
 * stream-sequence order, which is to say ordered by each key's most recent
 * write. This sweep writes those keys: it refreshes every retention's
 * projection, and `pingSandbox` rewrites the `hands.` record of every retention
 * it managed to ping, out of a ping phase that rotates its own batch whenever
 * its budget runs out. So consecutive sweeps are handed different permutations,
 * an unread retention can be carried ahead of the saved resume point, and being
 * ahead of it is exactly what the resume point takes as "has already had its
 * turn". It is skipped, refreshed, pinged, and skipped again -- holding an
 * admission slot after its work has finished, which is the leak this whole
 * mechanism exists to close.
 *
 * A queue is not a position, so nothing a write does to the keyspace can move
 * anything in it. The order is only ever "how long have you waited", the walk
 * decides nothing but where a retention first entered, and the bound in
 * `orderedRetentionReads` follows from the queue alone.
 *
 * It is also not a set, which is where the round before this one stopped: a set
 * records that a read was deferred and not how long it has been waiting, so with
 * four stuck containers and two reads a sweep the membership check alternates
 * between the first two pairs forever and the tail never comes up.
 *
 * Process-local, like every other rotation state here (`pingDeferred`,
 * `bgProbeCursor`). A restart empties it, which starts the cycle over from the
 * walk order: at most one extra cycle of waiting for a retention that was near
 * the front, and never a release, since nothing in the queue decides a verdict
 * -- an unread retention is `unknown`, and `unknown` keeps what it protects.
 */
let retentionDeferred: string[] = [];
/**
 * The point at which a census's own store latency is worth saying out loud.
 *
 * Reported, not enforced. The discovery half of a census is every handle record
 * the sweep has to renew and every target it has to name to `renewAndReap`;
 * cutting it off at a budget would drop the tail of the keyspace out of both,
 * which costs a live sandbox its refresh -- a worse outcome than the slow sweep
 * it would be protecting the span from. So the reads are held apart from it in
 * a phase of their own and the latency itself is surfaced, because a census
 * whose store round trips alone cost as much as the entire bounded read phase
 * is a store problem, and nothing this file can schedule its way out of.
 */
const CENSUS_DISCOVERY_REPORT_MS = CENSUS_READ_BUDGET_MS + LIVE_WORK_READ_CEILING_MS;
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
 * The longest the retention read phase can run: its budget bars the *starting*
 * of a read, so the one read already in flight when it expires runs on for its
 * own ceiling.
 *
 * `LIVE_WORK_READ_CEILING_MS` and not the container's command timeout. The
 * timeout is the deadline of the process inside the container; the call this
 * phase awaits is bounded by the provider's transport deadline on top of it,
 * and on the SaFE path by a status lookup after that. Naming the smaller number
 * would be naming a timeout nothing holds the awaited call to, which is not a
 * bound -- so the read arms that ceiling itself, and this term is a deadline
 * enforced on this side of the call rather than one hoped for.
 */
export function keepaliveCensusPhaseCeilingSec(): number {
  return Math.ceil((CENSUS_READ_BUDGET_MS + LIVE_WORK_READ_CEILING_MS) / 1000);
}

/**
 * The whole guarded tick's worst case: the retention read phase, then the ping
 * phase, then the failure phase. Fleet-size independent, which is the property
 * the declared span has to have -- every phase that awaits per-target work has
 * to appear here, or the span every refresh gap and the reclaim horizon are
 * derived from is a number the sweep routinely exceeds.
 *
 * Each term is a budget paired with the ceiling of the one piece of work that
 * budget lets start, because a budget bars the *starting* of work and never
 * interrupts what is already in flight; each phase runs its work serially, so
 * one is all that can be in flight when the budget expires. The census walk
 * itself carries no term, and deliberately: it starts no container work at all,
 * only store round trips, whose latency is the store's bound and not one this
 * file can state. `CENSUS_DISCOVERY_REPORT_MS` is what happens to it instead.
 * The read phase running after the walk rather than inside it is what makes
 * that split honest -- a term sized for container work cannot be quietly spent
 * on store latency if the phase it bounds contains no store latency.
 *
 * Of the three per-work ceilings this sums, the read's is enforced locally
 * (`LIVE_WORK_READ_CEILING_MS` is armed by the read itself). The ping and stop
 * ceilings are still the deadlines handed to the provider, so a provider that
 * ignores its own timeout under-runs those two the way an omitted phase would.
 */
export function keepaliveSweepCeilingSec(): number {
  return keepaliveCensusPhaseCeilingSec()
    + keepalivePingPhaseCeilingSec()
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
  // Rotation state like the cursor above it: a queue left by one test names keys
  // the next one never walks, and its first read phase would order itself around
  // retentions that do not exist.
  retentionDeferred = [];
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
  const cached = usableCachedVerdict(identity, info);
  const shared = usableSharedVerdict(info);
  // Missing credentials mean this replica cannot ask again -- not that the
  // answer is no. Returning `idle` here, before any verdict was read, threw
  // away a witnessed `running` that another replica (or this one, before the
  // token went) had already established: a sandbox with live background work
  // was released because the address to re-check it had gone missing.
  //
  // So the evidence is read first, and the legacy `idle` is the fallback for
  // the case it was written for: no credentials *and* nothing on record.
  if (!info.handsUrl || !info.token) {
    if (cached?.state === "running") return { state: "running", source: "mem", at: cached.at };
    if (shared?.state === "running") return { state: "running", source: "handle", at: shared.at };
    return { state: "idle", source: "no-hands" };
  }
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

/** One retained container the walk enrolled, and everything its read needs. */
interface RetentionRead {
  /** The projection key, which is the key the walk saw and the queue's identity. */
  key: string;
  ledgerKey: string;
  inst: SandboxInstance;
}

interface TargetCensus {
  targets: Map<string, RegisteredSandbox>;
  seenIdentities: Set<string>;
  probeCandidates: ProbeCandidate[];
  stats: TickStats;
  /**
   * Every retention the walk found, keyed by its projection key.
   *
   * Collected rather than acted on, the way `probeCandidates` is: which of them
   * this sweep can afford to read is a question about the whole set, and the
   * walk does not know the whole set until it ends.
   */
  retentionReads: Map<string, RetentionRead>;
}

type HandsRecord = { value: Uint8Array; revision: number };

async function collectTargets(
  deps: KeepaliveDeps,
  seenIdentities: Set<string>,
  stats: TickStats,
): Promise<{ targets: Map<string, RegisteredSandbox>; complete: boolean }> {
  const clock = deps.now ?? Date.now;
  const censusStartedAt = clock();
  const census: TargetCensus = {
    targets: new Map(), seenIdentities, probeCandidates: [], stats,
    retentionReads: new Map(),
  };
  for (const [key, registered] of localRegistry) {
    if (await shouldSkipExpiredRetry(deps, registered.sessionId, "local", registered.entry)) continue;
    census.targets.set(key, registered);
  }
  const kvComplete = await collectKvTargets(deps, census);
  const dagComplete = await collectDagTargets(deps, census);
  stats.probes += dispatchProbes(deps, census.probeCandidates);
  // Accounted apart from the reads, and only accounted: the reads happen after
  // this line, inside a phase with a budget of its own, so this is the census
  // time that budget deliberately cannot be spent on -- and a walk this
  // expensive is a store to look at rather than a schedule to tighten.
  const discoveryMs = Math.max(0, clock() - censusStartedAt);
  if (discoveryMs >= CENSUS_DISCOVERY_REPORT_MS) {
    logger.warn(
      { discoveryMs, retentions: census.retentionReads.size, budgetMs: CENSUS_READ_BUDGET_MS },
      "keepalive.census_discovery_slow",
    );
  }
  // After the walk, and before anything the tick does with the targets: whose
  // turn it is needs the whole set, and the budget needs a phase that holds
  // nothing but the reads it bounds. Nothing downstream changes either way --
  // a retention released here was already entered into `targets` and
  // `seenIdentities` by the walk, so it is pinged and named to `renewAndReap`
  // this sweep like any other target, and gives its slot back on the next one.
  //
  // A walk that found no retention does not enter the phase at all, and leaves
  // the queue exactly as it was. Not entering is what keeps a sweep over a
  // fleet with no retentions in it the sweep it was before this phase existed;
  // leaving the queue alone is because "no retentions this sweep" is not
  // evidence that the queue is stale -- the scan above may simply have failed,
  // and throwing the waiting order away on a transient store fault would cost a
  // cycle for nothing. A key that really is gone leaves the queue the next time
  // a read phase rebuilds it, which is the same filter that keeps a released
  // one out.
  const readsComplete = census.retentionReads.size
    ? await runRetentionReadPhase(deps, census, kvComplete)
    : true;
  return { targets: census.targets, complete: kvComplete && dagComplete && readsComplete };
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
    return sweepRetention(deps, census, key, e, info);
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
  if (expired) {
    await expireIdleTarget(deps, candidate, { ...e, value }, stats);
  }
  else {
    stats.withinWindow += 1;
    await deps.kv.update(key, value, e.revision).catch(() => {});
  }
  return true;
}

/**
 * How long an expiry may wait for the sandbox's own work evidence.
 *
 * Short on purpose: the answer only ever *holds* a binding, so a slow read
 * costs a binding that would have been released a tick later, while a long one
 * costs the whole sweep its schedule.
 */

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
