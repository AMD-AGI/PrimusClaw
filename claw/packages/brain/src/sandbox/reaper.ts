// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Hands sandbox teardown + reclamation: destroyHands (explicit stop),
 * reapPendingHands (abort-time cleanup of an in-flight create), and the
 * periodic sweeper that reclaims workloads whose Hands endpoint has gone
 * unhealthy.
 */
import { StringCodec, type KV } from "nats";
import pino from "pino";
import { parkHandsHandle } from "@claw/protocol";
import { sleep } from "@claw/utils";
import {
  BRAIN_REGISTRY_TTL_MS,
  MULTI_NODE_IDLE_RECLAIM_MS,
  MULTI_NODE_SWEEPER_INTERVAL_MS,
  SANDBOX_PENDING_ABANDONED_AFTER_MS,
  SANDBOX_SWEEPER_EVICT_AFTER_FAILURES,
} from "../config.js";
import { reclaimIdleSessionClusters as realReclaimIdleSessionClusters }
  from "./multi-node/safe-provider.js";

/**
 * Indirection so a test can watch what the sweeper decides to reclaim.
 *
 * The decision is the dangerous part -- reclaiming issues a DELETE against a
 * user's cluster and nothing undoes it -- so the guards in front of it have to
 * be observable without a control plane to talk to.
 */
let reclaimClusters = realReclaimIdleSessionClusters;

export function bindClusterReclaimForTest(
  fn: (sessionId: string, apiKey: string) => Promise<number>,
): () => void {
  const prev = reclaimClusters;
  reclaimClusters = fn;
  return () => { reclaimClusters = prev; };
}

import { metrics } from "../infra/metrics.js";
import { checkHandsHealth } from "./hands-health.js";
import { releaseHandlesForWorkload } from "./handles.js";
import {
  getHandsKv,
  revokeHandsToken,
  revokeSessionHandsToken,
  sessionHasActiveRunLease,
} from "./registry.js";
import { isTombstone } from "../tasks/lock.js";
import { SandboxStopUnavailable } from "./errors.js";
import { getAgentSandboxProvider, getSafeWorkloadProvider } from "./factory.js";
import { unregisterSandbox } from "./keepalive.js";
import {
  instanceFromEntry,
  parseHandsProbeValue,
  sameHandsSandbox,
  type HandsProbeEntry,
} from "./container-probe.js";
import { handsSessionKey, isRetentionEntry, sessionIdFromHandsKey } from "./hands-key.js";
import { readHandsEntry as readSessionBinding } from "./registry.js";

const logger = pino({ name: "sandbox-reaper" });
const sc = StringCodec();

/**
 * Read the session's SaFE platform key out of its Hands KV entry.
 *
 * Session cleanup has no request to take the key from, and every SaFE API call
 * needs one. Callers must read it BEFORE destroyHands, which drops the entry.
 *
 * @returns The key, or "" when the session has no usable entry.
 */
export async function readSessionPlatformKey(sessionId: string): Promise<string> {
  try {
    // Read-through, so a teardown finds the binding an old replica wrote.
    const entry = await readSessionBinding(getHandsKv(), sessionId);
    if (!entry) return "";
    return String(JSON.parse(entry.value).platformKey ?? "");
  } catch {
    return "";
  }
}

interface RecordedHandsEntry {
  state: "valid" | "missing" | "unknown";
  identity?: HandsProbeEntry;
  revision?: number;
  /** The key the binding was read from; a delete conditioned on `revision` must target it. */
  key?: string;
}

/**
 * Read the session entry without folding an unavailable/corrupt value into
 * "missing". Teardown is destructive, so only a parsed, addressable identity
 * is valid evidence about what the session key owns.
 */
async function readHandsEntry(sessionId: string): Promise<RecordedHandsEntry> {
  try {
    const found = await readSessionBinding(getHandsKv(), sessionId);
    const entry = found?.entry;
    // A deleted key reads back as an entry with an empty value, and letting it
    // reach the parser turns "gone" into "unreadable". The two are not
    // interchangeable here: `missing` lets teardown finish, while `unknown`
    // falls past both branches at the end of destroyHands and throws "hands KV
    // unavailable after confirmed sandbox stop" -- so a second teardown, or a
    // sweeper, deleting this key first would fail a user request over a
    // workload that is already stopped.
    if (!found || !entry || isTombstone(entry)) return { state: "missing" };
    const identity = parseHandsProbeValue(found.value);
    if (!instanceFromEntry(sessionId, identity)) return { state: "unknown" };
    return { state: "valid", identity, revision: entry.revision, key: found.key };
  } catch (err) {
    logger.warn({ err: String(err), sessionId }, "hands.entry_unreadable");
    return { state: "unknown" };
  }
}

/**
 * Drop this process's own references to a session's sandbox: its accepted bearer
 * token and its keepalive registration.
 *
 * Split out of destroyHands because it has to run whatever the teardown's
 * outcome, while destroyHands runs only once the resources are confirmed gone --
 * it deletes the `hands.<sid>` entry, which an unfinished teardown still needs.
 * Leaving the local state behind is worse than it sounds: a replica that keeps
 * its keepalive registration goes on exec-ing into a stopped workload every 60s,
 * which refreshes SaFE's lastActivity and suppresses the very GC that would have
 * reclaimed the pod.
 *
 * Purely in-memory and keyed only on the session id, so it does not care whether
 * the KV entry still exists.
 */
export function releaseLocalHandsState(sessionId: string): void {
  revokeSessionHandsToken(sessionId);
  unregisterSandbox(sessionId);
}

/**
 * Attempts at a stop before teardown gives up and refuses to replace.
 *
 * Refusing is right -- a workload that may still be running must not be
 * orphaned under its replacement -- but one 503 from the control plane is not
 * evidence that it is still running, and treating it as such fails a user
 * request over a blip. Three tries over about three seconds separates a control
 * plane that is briefly unhappy from one that will not stop this workload.
 */
const STOP_ATTEMPTS = 3;
const STOP_RETRY_DELAY_MS = 1_000;

/**
 * The bounds above, parameterised for the reason bootstrap's commands are: the
 * production numbers are sized for a real control plane, and a test of the
 * never-stops path should not have to wait all of them out.
 */
let stopRetry = { attempts: STOP_ATTEMPTS, delayMs: STOP_RETRY_DELAY_MS };

/** Override the stop retry bounds; returns the call that puts them back. */
export function bindSandboxStopRetry(over: Partial<typeof stopRetry>): () => void {
  const prev = stopRetry;
  stopRetry = { ...stopRetry, ...over };
  return () => { stopRetry = prev; };
}

/**
 * Stop the named sandbox, or say why the caller must not replace it.
 *
 * Returns normally in exactly two cases, and says WHICH: the stop was
 * confirmed, or this deployment cannot issue one at all (see
 * SandboxStopUnavailable). Everything else is retried and then thrown, because
 * the caller's next move is to build a replacement over the top of it.
 *
 * The distinction is not cosmetic. A caller that treats "cannot stop" as
 * "stopped" drops the workload's last reference while it is still running --
 * which is how a deployment with no platform key or no `SAFE_API_URL` turns
 * every teardown into a silent leak the report then calls released.
 */
async function stopNamedSandbox(
  sessionId: string,
  entry: HandsProbeEntry,
  /** Re-asked before every attempt -- see the note in the retry loop. */
  stillOwned?: () => boolean,
): Promise<"stopped" | "unavailable" | "not_owned"> {
  const inst = instanceFromEntry(sessionId, entry);
  // No instance to address: nothing was stopped, and nothing may be released
  // on the strength of it.
  if (!inst) return "unavailable";
  const provider = inst.provider === "agent-sandbox"
    ? getAgentSandboxProvider()
    : getSafeWorkloadProvider();
  for (let attempt = 1; ; attempt++) {
    // Before EVERY attempt, not once before the loop. A stop that comes back
    // 503 is retried after a wait, and that wait is long enough to stop being
    // the owner: the first attempt can be refused while the workload is still
    // this attempt's, and the retry land after a successor has taken the lock
    // and promoted it. Checking on the way in only covers the first try.
    if (stillOwned && !stillOwned()) {
      logger.warn(
        { sessionId, workloadId: inst.id, attempt },
        "hands.stop_abandoned_not_owned",
      );
      return "not_owned";
    }
    try {
      await provider.stop(inst);
      return "stopped";
    } catch (err) {
      if (err instanceof SandboxStopUnavailable) {
        // Nothing to retry and nothing an operator can do mid-request. Leave
        // the workload to the control plane's GC and let teardown finish, or
        // the session can never be rebuilt.
        logger.warn(
          { err: String(err), sessionId, provider: inst.provider },
          "hands.stop_unavailable",
        );
        return "unavailable";
      }
      if (attempt >= stopRetry.attempts) {
        logger.warn(
          { err: String(err), sessionId, provider: inst.provider, attempts: attempt },
          "hands.stop_failed",
        );
        throw err;
      }
      logger.warn(
        { err: String(err), sessionId, provider: inst.provider, attempt },
        "hands.stop_retrying",
      );
      await sleep(stopRetry.delayMs);
    }
  }
}

/** Delete only the KV revision teardown inspected before its remote stop. */
export async function deleteHandsEntryIfRevision(
  kv: Pick<KV, "delete">,
  key: string,
  revision: number,
): Promise<boolean> {
  try {
    await kv.delete(key, { previousSeq: revision });
    return true;
  } catch {
    return false;
  }
}

/**
 * Stop a Hands sandbox. With `known`, that sandbox is the one stopped — not
 * whichever workload last wrote `hands.<sessionId>`.
 *
 * KV cleanup is revision-conditional, while token and keepalive cleanup are
 * scoped to the target identity so a concurrent sibling remains registered.
 *
 * There is deliberately no check that the entry still sits at the revision the
 * caller read. Every destructive step here is already scoped: the stop targets
 * `known`, the token and registry cleanup target it too, and the KV delete is
 * a CAS gated on `sameHandsSandbox`. A revision check on top of that protects
 * nothing and costs a teardown -- `hands.<sessionId>` is re-put on every
 * successful keepalive ping to refresh its TTL, so a benign bump in the window
 * between reading and acting would abort a repair that was correct, and leave
 * the workload it had already confirmed dead still running.
 */
export async function destroyHands(
  sessionId: string,
  known?: HandsProbeEntry,
  knownToken?: string,
  /**
   * Asked immediately before the stop, if given.
   *
   * Every caller that can lose its right to tear down between deciding to and
   * doing it needs this asked LAST, not earliest. Checking in the caller and
   * again after the reaper's own read still left this function's own read in
   * between, and a lease can go during that one too -- so the check follows the
   * reads down to the one irreversible step rather than being sprinkled above
   * them. Callers with nothing to lose pass nothing and behave as before.
   */
  stillOwned?: () => boolean,
): Promise<void> {
  const kv = getHandsKv();
  const recorded = await readHandsEntry(sessionId);
  const key = recorded.key ?? handsSessionKey(sessionId);
  const target = known ?? recorded.identity;
  const ownsRecorded = recorded.state === "valid"
    && !!recorded.identity
    && !!target
    && sameHandsSandbox(target, recorded.identity);

  if (!target) {
    // A genuinely absent session key has no remote sandbox to stop. An
    // unreadable/corrupt key is different: preserve all session state because
    // it may still belong to a live workload.
    if (!known && recorded.state === "missing") releaseLocalHandsState(sessionId);
    return;
  }

  try {
    // Asked inside, before every attempt, rather than once here: the retry
    // after a refused stop is its own window.
    const stopOutcome = await stopNamedSandbox(sessionId, target, stillOwned);
    if (stopOutcome === "not_owned") {
      // Nothing was stopped, so nothing downstream may act as though it was --
      // the handle stays, the KV entry stays, local state stays. They belong to
      // whoever holds the lock now.
      logger.warn(
        { sessionId, workloadId: (target as { workloadId?: string })?.workloadId ?? null },
        "hands.destroy_skipped_not_owned",
      );
      return;
    }
    metrics.onSandboxStop("ok");
    // Whoever stops a workload frees its handle. Registration refuses to point
    // a handle away from a workload still on record -- which is what stops a
    // redelivery overwriting a live one -- so a handle left naming something
    // that has been stopped blocks the replacement instead of leaking it.
    //
    // Contained: this is bookkeeping that makes the next step possible, and it
    // must never be why a teardown reports failure. If it does not land, the
    // next registration refuses and the turn fails visibly, with the handle
    // still naming the stopped workload for a sweep to find.
    // Only when a stop was actually issued and accepted. `unavailable` means
    // this deployment could not ask -- the workload is still running, and its
    // handle is the last thing pointing at it.
    const stoppedWorkload = stopOutcome === "stopped"
      ? (target as { workloadId?: string }).workloadId
      : undefined;
    if (stoppedWorkload) {
      await releaseHandlesForWorkload(stoppedWorkload).catch((e: unknown) => {
        logger.warn(
          { sessionId, workloadId: stoppedWorkload, err: (e as Error)?.message ?? String(e) },
          "dag-handles.release_after_stop_failed",
        );
      });
    }
  } catch (cause) {
    // Counted before the rethrow: the caller turns this into a replacement
    // decision and never reports the teardown itself, so this is the only
    // place a failed stop is visible.
    metrics.onSandboxStop("error");
    // Every caller of this is about to build a replacement, and the raw
    // provider message ("HTTP 500") does not say why that is now refused.
    // Naming the consequence is what makes the failure actionable, and what
    // stops it reading like a bug in the request the user made.
    throw new Error(
      `could not confirm the sandbox was stopped after ${stopRetry.attempts} attempts, so it `
      + `was not replaced -- a workload that is still running must not be orphaned under `
      + `a new one: ${(cause as Error)?.message ?? cause}`,
      { cause },
    );
  }

  // Scoped local cleanup: never revoke a sibling's token or remove a
  // registration that replaced this one while stop was in flight.
  revokeHandsToken(knownToken || (ownsRecorded ? recorded.identity?.token || "" : ""));
  unregisterSandbox(sessionId, target);

  if (!ownsRecorded || recorded.revision === undefined) {
    logger.warn(
      {
        sessionId,
        stoppedWorkload: target.workloadId || target.sandboxName,
        recordedWorkload: recorded.identity?.workloadId || recorded.identity?.sandboxName,
        recordedState: recorded.state,
      },
      "sandbox.destroy.left_session_entry",
    );
    return;
  }

  const deleted = await deleteHandsEntryIfRevision(kv, key, recorded.revision);
  if (deleted) return;

  // A keepalive TTL refresh changes the revision without changing ownership.
  // Retry that benign race, but never delete a replacement sibling.
  const latest = await readHandsEntry(sessionId);
  if (latest.state === "missing") return;
  if (
    latest.state === "valid"
    && latest.identity
    && latest.revision !== undefined
    && sameHandsSandbox(target, latest.identity)
  ) {
    if (await deleteHandsEntryIfRevision(kv, latest.key ?? key, latest.revision)) return;
    // Losing twice means the key is being written faster than we can clear
    // it -- but the workload is already stopped, which is the part callers
    // build a replacement on top of. Throwing here fails a user request over
    // a stale record the bucket TTL removes on its own, so the entry is left
    // behind and said out loud instead.
    logger.warn(
      { sessionId, workloadId: target.workloadId || target.sandboxName },
      "sandbox.destroy.entry_left_after_stop",
    );
    return;
  }
  if (latest.state === "valid") {
    logger.warn({ sessionId, revision: recorded.revision }, "sandbox.destroy.kv_owner_changed");
    return;
  }
  // Unreadable is different from contended: the stop is confirmed, but we
  // cannot see whose entry this is, so clearing it might remove a sibling's.
  // Refusing keeps the caller from building over a record it cannot vouch for.
  throw new Error("hands KV unavailable after confirmed sandbox stop");
}

/**
 * Reap only PENDING Hands KV entries (B). Used by handleTask's failure path
 * so that a task aborted mid-ensureHands does not leave an orphan SaFE
 * workload behind. A READY entry means ensureHands already completed and
 * the failure happened later in the agent loop (LLM error, tool crash,
 * etc.) — in that case the sandbox is healthy and should be kept so the
 * user's next message can reuse it; this function is a no-op for READY.
 *
 * `expected.taskId` is what makes this the CALLER's reap rather than the
 * session's. `hands.<sid>` is keyed per session, so `status === "pending"`
 * alone says only that some run of this session left a workload mid-creation
 * -- not that this run did. The entry names the task that wrote it, and that
 * is the comparison. The two come
 * apart on the ordinary chat turn: under BRAIN_LAZY_SANDBOX a turn answered
 * from context calls `ensureHands` zero times, and when its model provider
 * refuses it, this failure path ran and destroyed the workload a PREVIOUS
 * message of the same session was still provisioning. The predecessor then
 * reported its own sandbox as preempted, on a task that had never asked for
 * one.
 *
 * The test that separates them already exists and is the runner's, not ours:
 * `sandboxAskedAt` is stamped immediately before each `ensureHands` call, and
 * `onProvisioned` writes `createdAt` from inside that same call in the same
 * process, so an entry stamped before the ask belongs to something else. The
 * runner passes that threshold down rather than this function re-deriving it,
 * because it is the only thing that knows it -- see `pendingHandsIdentity`,
 * which makes exactly this comparison for the reporting side.
 *
 * `null` means this run never asked for a sandbox at all. A run that never
 * asked owns no entry and therefore reaps nothing: there is no window in which
 * it could have minted the workload the entry names.
 */
export async function reapPendingHands(
  sessionId: string,
  /**
   * Both gates, because they answer different questions and neither covers the
   * other. `taskId` is the precise one: a session can hold more than one DAG
   * under a session-scoped run gate, and `hands.<sessionId>` is a single slot,
   * so the entry a failing task finds may belong to a sibling DAG that is still
   * creating -- or, if the read and the teardown straddle its promotion, still
   * USING -- the workload it names. It is the whole gate: every entry this
   * build writes carries a task id (ensure-hands.ts), so a predecessor's entry
   * is identified by ITS task id rather than by when it was stamped, and a
   * second age-based test would only disagree with this one.
   *
   * An entry with NO task id is reaped anyway, and that is deliberate in both
   * directions: it can only have come from a process running before the field
   * existed, which also means it carries no `runScope`, and `runScope` is what
   * `collectAbandonedPending` collects by -- so nothing else will ever reach it.
   * Skipping it would not defer the teardown, it would leak the workload for
   * good.
   *
   * `stillOwned` is re-asked after the read, because the lock can go between
   * deciding and acting.
   */
  expected?: {
    taskId?: string | null;
    stillOwned?: () => boolean;
  },
): Promise<void> {
  try {
    const kv = getHandsKv();
    // Read-through: a pending binding an old replica wrote sits under the
    // legacy name, and missing it leaks the workload it names.
    const entry = await readSessionBinding(kv, sessionId);
    if (!entry) return;
    const info = JSON.parse(entry.value);
    // Belt and braces with the key walk above: `readSessionBinding` looks under
    // the session's own names and a retention is keyed by a sandbox generation,
    // so it should not be reachable from here. Should not is not the standard
    // this guard is held to anywhere else it appears -- a retention projection
    // is a byte copy of the binding it was made from, so it would pass the
    // status test below and be stopped with the live work it exists to protect
    // still running inside it.
    if (isRetentionEntry(info)) return;
    if (info.status !== "pending") return;
    // Whose workload this is decides whether it may be stopped. A session can
    // hold more than one DAG at once under a session-scoped run gate, and
    // `hands.<sessionId>` is a single slot, so the entry a failing task finds
    // may have been written by a sibling DAG that is still creating -- or, if
    // the read and the teardown straddle its promotion, still USING -- the
    // workload it names. Reaping on the session alone stopped it.
    //
    // A pending entry with no task on it predates this field and can only have
    // come from a process that was running before this rollout; it is reaped as
    // before, because the alternative is leaking every such workload.
    if (expected?.taskId && info.taskId && info.taskId !== expected.taskId) {
      logger.info(
        { sessionId, workloadId: info.workloadId, entryTaskId: info.taskId,
          taskId: expected.taskId },
        "hands.reap_pending_skipped_other_task",
      );
      return;
    }
    // No task id on the entry, which the gate above cannot judge. What decides
    // is whether anyone still HOLDS it -- the same question, and the same read,
    // the collector uses (`readRunLeaseState` over `lock.<runScope>`).
    //
    // Held: leave it. Reaping on the session alone is the mis-kill this branch
    // exists to stop -- a lazy chat turn that never asked for a sandbox,
    // failing, and tearing down the workload a sibling is still queueing for.
    // Somebody is alive behind that lease and the entry is theirs.
    //
    // Free, or unscoped, or unreadable: reap it. This path is the only teardown
    // such an entry will get, and the reason is a number rather than a
    // principle: the bucket's TTL is DEFAULT_BRAIN_REGISTRY_TTL_MS (5 minutes,
    // protocol/src/run-lease.ts) and `collectAbandonedPending` does not look
    // until SANDBOX_PENDING_ABANDONED_AFTER_MS (2 hours). An entry nobody
    // refreshes evaporates hours before the collector could reach it, so
    // "leave it to the sweeper" is not deferral, it is the workload leaking
    // with nothing left that names it.
    //
    // The merge that brought the two ownership gates together reasoned only
    // about the task id -- that an entry without one could only predate both
    // fields and so had no collector behind it. That was wrong twice over:
    // `94b63ef` on this branch wrote `runScope` and not yet `taskId`, so the
    // scoped-but-unnamed entry it said could not exist is what a rolling
    // upgrade produces; and the first correction, which deferred every scoped
    // entry to the collector, missed that the collector never gets one.
    if (expected?.taskId && !info.taskId
        && typeof info.runScope === "string" && info.runScope
        && await readRunLeaseState(kv, info.runScope) === "held") {
      logger.info(
        { sessionId, workloadId: info.workloadId, runScope: info.runScope,
          taskId: expected.taskId },
        "hands.reap_pending_skipped_unnamed_but_held",
      );
      return;
    }
    // Re-asked after the read, not only before it. The caller checks that it
    // still holds the lock before calling -- but the check and the teardown are
    // separated by a KV round trip, and that is exactly long enough for the
    // heartbeat to notice the lease is gone. The snapshot that comes back then
    // belongs to the successor, carrying the same task id, and passes the
    // comparison above.
    if (expected?.stillOwned && !expected.stillOwned()) {
      logger.warn(
        { sessionId, workloadId: info.workloadId, taskId: expected.taskId ?? null },
        "hands.reap_pending_skipped_lease_lost_mid_read",
      );
      return;
    }
    logger.warn({ sessionId, workloadId: info.workloadId }, "hands.reap_pending");
    await destroyHands(
      sessionId,
      info as HandsProbeEntry,
      typeof info.token === "string" ? info.token : undefined,
      expected?.stillOwned,
    );
  } catch (e) {
    logger.warn({ err: e, sessionId }, "hands.reap_pending_failed");
  }
}

const sweeperFailureCounts = new Map<string, number>();
const SWEEPER_INTERVAL_MS = 5 * 60 * 1000;
const SWEEPER_HEALTH_TIMEOUT_MS = 3_000;
// Evict threshold now comes from config (SANDBOX_SWEEPER_EVICT_AFTER_FAILURES);
// <=0 disables sweeper-driven eviction entirely.

/**
 * Whether anyone still holds the run lease at `scope` -- and, separately,
 * whether we could find out.
 *
 * `sessionHasActiveRunLease` is the same read and the same tombstone rule; what
 * it does not have is the third answer. It returns `false` when the bucket
 * cannot be read, because its callers turn a `false` into a skipped reclaim
 * that the next pass retries. The pending collector turns a `false` into a stop
 * against a user's sandbox, and there is nothing after that to retry, so "the
 * store did not answer" has to stay distinguishable from "nobody is running".
 */
async function readRunLeaseState(kv: KV, scope: string): Promise<"held" | "free" | "unknown"> {
  let lock;
  try {
    lock = await kv.get(`lock.${scope}`);
  } catch (err) {
    logger.warn({ err, scope }, "sweeper.lease_read_failed");
    return "unknown";
  }
  // A released lease is deleted, and a delete leaves a readable entry with an
  // empty value -- so presence alone reads every finished run as a running one.
  return lock && !isTombstone(lock) ? "held" : "free";
}

/**
 * Is the walked entry still, byte for byte, the one the decision was taken on?
 *
 * The revision answers it on its own -- in a NATS KV bucket a revision is the
 * sequence of the write that produced the value, so an unchanged revision means
 * nobody has written this key since the walk read it. The payload is re-checked
 * anyway because it costs nothing and because it names the failure in the log
 * an operator will read: an entry that is READY here is a creator that finished
 * while this pass was reading the lease, which is a different story from an
 * entry that has simply been refreshed.
 *
 * Every unreadable or changed answer is `false`. This gates a stop that nothing
 * undoes, and the cost of a wrong `false` is one skipped pass against an entry
 * that is still sitting there for the next one.
 */
async function pendingEntryUnmoved(
  kv: KV,
  key: string,
  revision: number,
  workloadId: string,
): Promise<boolean> {
  let entry;
  try {
    entry = await kv.get(key);
  } catch (err) {
    logger.warn({ err, key, revision }, "sweeper.pending_recheck_failed");
    return false;
  }
  // A deleted key reads back as an entry with an empty value; something else
  // collected this one first, and it names no workload we may act on.
  if (!entry || isTombstone(entry)) return false;
  if (entry.revision !== revision) return false;
  try {
    const info = JSON.parse(sc.decode(entry.value)) as Record<string, unknown>;
    return info.status === "pending" && String(info.workloadId ?? "") === workloadId;
  } catch {
    return false;
  }
}

/**
 * Stop the workload a long-abandoned PENDING entry names, and delete that
 * entry -- the one that was walked, at the revision it was walked at.
 *
 * Not `destroyHands`. That one is written for a caller holding a session: it
 * re-reads `hands.<sessionId>` and CASes on the key that read returns. A walker
 * has something better and something more dangerous than a session id. Better,
 * because it has the exact key and revision its decision was taken on. More
 * dangerous, because `sessionIdFromHandsKey` does not always yield a session:
 * a retention is keyed by a sandbox generation, so the id it hands back names
 * no session, and re-deriving a key from it addresses whatever that fabricated
 * id happens to hit. The caller's `isRetentionEntry` guard is what keeps a
 * retention out of here in the first place; deleting only the walked key is
 * what keeps a mistake from spreading to a key nobody looked at.
 *
 * The revision is checked BEFORE the stop, not only after it. The decision this
 * call carries was taken on two separate reads -- the entry, then the lease --
 * and the creator that entry belongs to finishes inside exactly that gap: it
 * promotes PENDING -> READY with a plain `kv.put` (ensure-hands) and releases
 * `lock.<scope>` at the end of its run, in that order. So a lease that reads
 * free has any promotion already durable behind it, and re-reading the entry
 * after the lease read is what turns "nobody was running this a moment ago"
 * into "and the record I am about to act on has not moved since". A conditional
 * delete cannot do that job: it runs after a stop that nothing undoes, so all it
 * can do is report the race, leaving a READY binding that names a workload this
 * pass has already killed.
 *
 * The delete stays conditional on the same revision for the other half of it --
 * a heartbeat re-put between the recheck and here must not have its entry
 * deleted out from under it -- and a lost CAS there is said out loud rather than
 * retried: the workload is already stopped, which is the half that mattered.
 *
 * Returns whether the workload was actually collected, so the pass counts an
 * eviction only where one happened.
 */
async function collectAbandonedPending(
  kv: KV,
  key: string,
  revision: number,
  sessionId: string,
  info: Record<string, unknown>,
  ageMs: number,
): Promise<boolean> {
  const workloadId = String(info.workloadId ?? "");
  const token = typeof info.token === "string" ? info.token : "";
  // The last thing before the irreversible act, and after the lease read for
  // the reason above. Anything at all having been written to this key since the
  // walk -- a promotion, a rebuild's replacement, an idle marker, a heartbeat
  // refresh -- invalidates the evidence this stop rests on, and "leave it" is
  // free: the entry is still there, and the next pass reads it fresh.
  if (!await pendingEntryUnmoved(kv, key, revision, workloadId)) {
    logger.info(
      { sessionId, key, revision, workloadId, ageMs },
      "sweeper.pending_moved_not_collected",
    );
    return false;
  }
  // ERROR, not warn, and deliberately. Nothing reaches this line in a healthy
  // fleet: a run that ends, retries or crashes with its pod alive reaps its own
  // pending entry on the way out. An entry that is two hours old with no lease
  // behind it means a brain died between minting a workload and recording it,
  // or a reap failed silently -- and the GPUs that entry was holding were being
  // billed the whole time. An operator should see every one of these.
  //
  // FOUND, not collected, and the two are separate events because the stop
  // below can decline. This one fires for every abandoned entry, which is what
  // makes it the alarm -- including, and especially, the entries whose stop
  // then fails, since a workload that cannot be stopped is the one still
  // burning GPUs. Saying "collected" here reported a teardown that had not been
  // attempted yet, and the paths that keep the entry return without ever
  // correcting it.
  logger.error(
    {
      sessionId,
      key,
      workloadId,
      runScope: info.runScope,
      createdAt: info.createdAt,
      ageMs,
      horizonMs: SANDBOX_PENDING_ABANDONED_AFTER_MS,
    },
    "sweeper.pending_abandoned_found",
  );
  try {
    const outcome = await stopNamedSandbox(sessionId, info as HandsProbeEntry);
    // Returning is not stopping. `stopNamedSandbox` also returns normally when
    // it cannot address the entry at all and when the provider says this
    // deployment can issue no stop -- and the reasoning in the catch below is
    // about a stop that was not CONFIRMED, which those are just as much as a
    // throw is. Reading them as success is how this collector would delete the
    // last record of a workload it never stopped: exactly the leak it exists to
    // end, arrived at through its own cleanup.
    //
    // `destroyHands` has consulted this outcome since the branch that made it
    // an outcome; this caller was left on the old void contract, and the two
    // being the only callers is what made the difference invisible.
    if (outcome !== "stopped") {
      // Counted the way `destroyHands` counts each: `not_owned` attempted
      // nothing and belongs to whoever holds the lock now, so it is logged and
      // not tallied; `unavailable` is a stop this deployment could not issue,
      // which for a collector is a collection that failed.
      if (outcome === "unavailable") metrics.onSandboxStop("error");
      logger.warn(
        { sessionId, key, workloadId, outcome },
        "sweeper.pending_stop_unconfirmed",
      );
      return false;
    }
    metrics.onSandboxStop("ok");
  } catch (err) {
    metrics.onSandboxStop("error");
    // The entry stays, for the same reason the branch above keeps it: it is the
    // only record of workloadId + platformKey, and deleting it after a stop
    // that was not confirmed leaves a workload nothing can name. The next pass
    // asks again.
    logger.warn({ err, sessionId, key, workloadId }, "sweeper.pending_stop_failed");
    return false;
  }
  revokeHandsToken(token);
  unregisterSandbox(sessionId, info as HandsProbeEntry);
  if (!await deleteHandsEntryIfRevision(kv, key, revision)) {
    // Stopped but not cleaned up: the entry moved under the CAS, so the record
    // is still there and a later pass will read it again. Saying "collected"
    // after this is the same overclaim the split above was made to end, one
    // step further along -- the workload is down, but the thing the collector
    // was asked to remove is not gone.
    logger.warn({ sessionId, key, revision, workloadId }, "sweeper.pending_entry_left_after_stop");
    return true;
  }
  // The claim the event above used to make, now made where it is true: the stop
  // was confirmed AND the entry is gone. Info rather than error -- by this point
  // the thing an operator has to act on has already been reported, and what this
  // adds is that it needed no further action.
  logger.info({ sessionId, key, workloadId, ageMs }, "sweeper.pending_abandoned_collected");
  return true;
}

/**
 * Periodic sweeper: scan all `hands.*` KV entries, health-check each Hands
 * endpoint, delete KV + Workload when unhealthy for too long. Complements
 * the in-task lazy revalidation for long-idle sessions.
 */
async function sweepStaleHands(): Promise<void> {
  const kv = getHandsKv();
  let scanned = 0;
  let evicted = 0;
  try {
    const iter = await kv.keys("hands.*");
    const now = new Date().toISOString();
    for await (const key of iter) {
      scanned += 1;
      const sessionId = sessionIdFromHandsKey(key);
      let info: Record<string, unknown> = {};
      // The revision of the entry THIS pass read, kept for the collector below:
      // it is what the collector re-checks before it stops anything -- the
      // decision is taken here and acted on several reads later -- and what any
      // delete is conditioned on, under the key the decision was read from.
      let revision = 0;
      try {
        const entry = await kv.get(key);
        if (!entry) continue;
        info = JSON.parse(sc.decode(entry.value));
        revision = entry.revision;
      } catch { continue; }

      // A retained container's projection lives in this keyspace too, and it
      // is a copy of the binding it was made from -- same status, same
      // handsUrl, same token -- so it passes every filter below as though it
      // were a session's handle. It is not one. The key names a sandbox
      // generation, so `sessionIdFromHandsKey` hands back a session id no
      // session has, the failure counts pile up under that fabricated id, and
      // where an operator has turned eviction on the destroy that follows stops
      // the container the retention exists to protect and deletes the
      // projection with it -- the live work the retention was taken for, gone,
      // on the evidence of a health check that a container busy with that work
      // can fail. A retention ends one way only: the keepalive sweep reading
      // positive evidence out of the container that its work has finished.
      // keepalive's own walk makes exactly this check before it treats an entry
      // as a session's.
      if (isRetentionEntry(info)) continue;

      // A PENDING entry is USUALLY owned by an in-flight ensureHands -- polling
      // a slow GPU queue, or bootstrapping hands -- and a sweeper must not
      // stop a sandbox a run is still waiting for. That is what the two guards
      // below establish, and only what is left after them is collected.
      //
      // What used to be here instead was an unconditional `continue`, on the
      // reasoning that an abandoned pending entry expires on the bucket TTL and
      // the workload behind it "becomes SaFE's idle-killer problem, not ours".
      // Both halves of that are false, which is why there is a collector here
      // now rather than a comment:
      //
      //  - Nothing expires while the session keeps receiving messages.
      //    `startDeliveryHeartbeat` re-puts `hands.<sid>` every 10s to refresh
      //    its TTL, and it is SESSION-keyed and ownership-blind: it runs for
      //    every task on the session, including the ones that provision nothing.
      //    Measured on a live bucket, an orphan's revision advanced 2 -> 9 under
      //    a non-owner's heartbeat across twice the 5-minute TTL and expired
      //    only once that heartbeat stopped. So the entry is pinned alive by
      //    precisely the tasks that do not own it.
      //  - SaFE's Workload has no idle timeout. This repo states that twice
      //    already -- config.ts, where AGENT_SANDBOX_SESSION_TIMEOUT is refused
      //    outside kubernetes mode, and safe-workload-provider.ts, where
      //    `workloadTimeoutSeconds` says the same thing. `timeout` runs whether
      //    or not anyone is using the sandbox and
      //    `ttlSecondsAfterFinished` is cleanup after it ends. The only thing
      //    actually behind an abandoned workload is that absolute timeout,
      //    SANDBOX_DEFAULT_TIMEOUT_SECONDS: 24 hours of GPUs.
      //
      // And expiry would be the wrong end of it anyway. Every path that can
      // stop the workload -- this sweep, reapPendingHands, the stale_pending
      // destroy in the reuse path, teardown, rollback -- needs the entry to
      // still exist, because the entry is the only record of workloadId +
      // platformKey. Letting it expire deletes the evidence and keeps the leak.
      if (info.status === "pending") {
        if (SANDBOX_PENDING_ABANDONED_AFTER_MS <= 0) continue;
        const createdAt = Date.parse(typeof info.createdAt === "string" ? info.createdAt : "");
        // Age is measured from creation, and the heartbeat above cannot move
        // it: that refresh writes the entry's bytes back unchanged
        // (`kv.update(e.key, sc.encode(e.value), e.revision)`) purely to reset
        // the TTL, so it advances the revision and leaves `createdAt` exactly
        // as `onProvisioned` stamped it. The horizon would be defeated if it
        // were measured from the last write; it is not.
        //
        // An entry with no readable `createdAt` has no age, so it has not been
        // shown to be past anything and is left alone.
        if (!Number.isFinite(createdAt)) continue;
        const ageMs = Date.now() - createdAt;
        if (ageMs < SANDBOX_PENDING_ABANDONED_AFTER_MS) continue;
        // Age says nobody finished; the run lease says whether anybody is still
        // trying. It has to be this and not the age alone, because the two
        // legitimately co-exist: SANDBOX_PENDING_TIMEOUT_SECONDS lets a run
        // queue for three hours, longer than this two-hour horizon, and that
        // run is not abandoned -- it is holding its lease and will fail its own
        // message at its own ceiling.
        //
        // `sessionHasActiveRunLease` is the right read for "is anyone running
        // this", and it is the same one the multi-node sweep below already
        // takes. Two properties matter here. It reads `lock.<scope>`, which a
        // live run re-proves every LOCK_REFRESH_INTERVAL_MS for the whole run
        // and releases only at the end -- so a task merely between statements,
        // between turns of its agent loop, or parked in a long tool call still
        // holds it and reads as active. And it takes the scope from the entry
        // rather than assuming the session id, because under the default
        // RUN_GATE_KEY=workspace a run's lease is at `lock.ws.<workspaceId>`
        // and under a DAG it is at the root task id; looking under the session
        // would find nothing and report "no lease" for a run that has one.
        //
        // Which is why an entry that does not name its scope is skipped rather
        // than guessed at. A PENDING entry written before `runScope` was added
        // to that payload cannot be checked, and "cannot tell" has to mean
        // "leave it": a wrong "no lease" here stops a live user's sandbox.
        if (typeof info.runScope !== "string" || !info.runScope) {
          logger.warn(
            { sessionId, key, workloadId: info.workloadId, ageMs },
            "sweeper.pending_unscoped_not_collected",
          );
          continue;
        }
        //
        // And an unreadable bucket is not an absent lease either, which is the
        // one place this cannot simply call `sessionHasActiveRunLease`: that
        // one folds a failed read into `false`, which is harmless where it is
        // used today (a skipped cluster reclaim, retried next pass) and is a
        // licence to stop a live sandbox here.
        const lease = await readRunLeaseState(kv, info.runScope);
        if (lease !== "free") {
          if (lease === "unknown") {
            logger.warn(
              { sessionId, key, runScope: info.runScope, workloadId: info.workloadId },
              "sweeper.pending_lease_unreadable",
            );
          }
          continue;
        }
        if (await collectAbandonedPending(kv, key, revision, sessionId, info, ageMs)) {
          evicted += 1;
        }
        continue;
      }

      const handsUrl = (info.handsUrl as string) || "";
      if (!handsUrl) continue;

      const health = await checkHandsHealth(handsUrl, SWEEPER_HEALTH_TIMEOUT_MS);
      if (health.ok) { sweeperFailureCounts.delete(sessionId); continue; }

      const fails = (sweeperFailureCounts.get(sessionId) ?? 0) + 1;
      sweeperFailureCounts.set(sessionId, fails);
      logger.info({ sessionId, handsUrl, fails, now, health: health.detail }, "sweeper.unhealthy");

      // Sweeper eviction is opt-in: only when the threshold is > 0. When
      // disabled (<=0) we keep health-checking and logging, but never stop the
      // workload / delete its KV entry on transient health failures. Same
      // contract as SANDBOX_KEEPALIVE_FAIL_LIMIT: MCP /health here is not a
      // destroy license unless an operator turns that on.
      if (SANDBOX_SWEEPER_EVICT_AFTER_FAILURES > 0 && fails >= SANDBOX_SWEEPER_EVICT_AFTER_FAILURES) {
        try {
          // Stop the identity whose health was checked. destroyHands performs
          // revision-CAS cleanup and leaves a newer sibling entry untouched.
          await destroyHands(
            sessionId,
            info as HandsProbeEntry,
            typeof info.token === "string" ? info.token : undefined,
          );
          sweeperFailureCounts.delete(sessionId);
          evicted += 1;
        } catch (err) {
          logger.warn({ err, sessionId }, "sweeper.stop_failed");
        }
      }
    }
    metrics.onSandboxSweeperEvict(evicted);
    logger.info({ scanned, evicted }, "sweeper.pass_complete");
  } catch (err) {
    logger.warn({ err }, "sweeper.pass_failed");
  }
}

/** One health-sweep pass, for tests: the interval version is fire-and-forget. */
export async function sweepStaleHandsForTest(): Promise<void> {
  await sweepStaleHands();
}

export function startSandboxSweeper(): void {
  setInterval(() => { sweepStaleHands().catch(() => {}); }, SWEEPER_INTERVAL_MS);
  logger.info({ intervalMs: SWEEPER_INTERVAL_MS }, "sweeper.started");
}

/**
 * May this session's GPU clusters be reclaimed now?
 *
 * `keepalive === false` comes first and is never waived: it is the only signal
 * that no task is running, and it covers DAG-rooted tasks that the session-keyed
 * task lock misses.
 *
 * Past that there are two kinds of idle and only one waits. A live session
 * between messages waits out MULTI_NODE_IDLE_RECLAIM_MS, so its cluster is still
 * warm when the next message arrives. A handle parked by a session delete skips
 * it: there is no next message to keep anything warm for, so waiting only delays
 * the GPUs going back. See parkHandsHandle for the two configurations where that
 * exemption is load-bearing rather than merely faster.
 */
export function eligibleForClusterReclaim(
  info: {
    keepalive?: unknown;
    sessionDeleted?: unknown;
    idleSince?: unknown;
    workSeenAt?: unknown;
  },
  now: number,
): boolean {
  if (info.keepalive !== false) return false;
  if (info.sessionDeleted === true) return true;
  const idleSince = typeof info.idleSince === "number" ? info.idleSince : 0;
  const workSeenAt = typeof info.workSeenAt === "number" ? info.workSeenAt : 0;
  // Keep this reuse window aligned with keepalive.ts: observed work extends it.
  const reuseWindowStart = Math.max(idleSince, workSeenAt);
  return reuseWindowStart > 0 && now - reuseWindowStart >= MULTI_NODE_IDLE_RECLAIM_MS;
}

/**
 * Periodic multi-node sweeper: reclaim the GPU clusters of sessions whose sandbox
 * has gone idle, and of sessions deleted without a confirmed teardown.
 * eligibleForClusterReclaim above decides which entries qualify.
 *
 * Only reaches sessions that still hold a `hands.*` entry, since the SaFE key it
 * needs to delete a workload lives there. A cluster whose entry has already
 * expired is left to the workload's own `timeout`.
 */
async function sweepIdleMultiNodeClusters(): Promise<void> {
  const kv = getHandsKv();
  let scanned = 0;
  let reclaimed = 0;
  try {
    const iter = await kv.keys("hands.*");
    for await (const key of iter) {
      const sessionId = sessionIdFromHandsKey(key);
      let info: Record<string, unknown> = {};
      try {
        const entry = await kv.get(key);
        if (!entry) continue;
        info = JSON.parse(sc.decode(entry.value));
      } catch { continue; }

      // Not a session's handle -- see the health sweep above for what this
      // keyspace also holds. A projection carries the idle markers of the
      // binding it was copied from and nothing refreshes them, so it reads as
      // reclaimable from the moment it is taken and stays that way for as long
      // as the retention lives; what it would then ask to reclaim is keyed by a
      // session id that never existed, so every sweep spends a control-plane
      // lookup on it for as long as the work it protects runs.
      if (isRetentionEntry(info)) continue;

      if (!eligibleForClusterReclaim(info, Date.now())) continue;
      // The entry says idle; the run lease says whether anyone is using it.
      // Those disagree more often than the entry admits: a reuse that could
      // not clear its idle markers leaves `keepalive:false` and a stale
      // `idleSince` on a sandbox a turn is actively running in, and that is
      // exactly the shape this function reads as its licence. What it does
      // next is delete the user's cluster, which no later pass can undo.
      if (await sessionHasActiveRunLease(kv, sessionId, info.runScope)) {
        logger.info({ sessionId }, "mn_sweeper.skipped_run_in_flight");
        continue;
      }
      const platformKey = String(info.platformKey ?? "");
      if (!platformKey) continue;

      scanned += 1;
      try {
        reclaimed += await reclaimClusters(sessionId, platformKey);
      } catch (err) {
        logger.warn({ err, sessionId }, "mn_sweeper.session_failed");
      }
    }
    if (scanned) logger.info({ scanned, reclaimed }, "mn_sweeper.pass_complete");
  } catch (err) {
    logger.warn({ err }, "mn_sweeper.pass_failed");
  }
}

/** Start the periodic multi-node sweeper. No-op when disabled. */
/** One sweeper pass, for tests: the interval version is fire-and-forget. */
export async function sweepIdleMultiNodeClustersForTest(): Promise<void> {
  await sweepIdleMultiNodeClusters();
}

export function startMultiNodeSweeper(): void {
  if (MULTI_NODE_IDLE_RECLAIM_MS <= 0) {
    logger.info("mn_sweeper.disabled (MULTI_NODE_IDLE_RECLAIM_MS <= 0)");
    return;
  }
  // Its own interval rather than the health sweep's: this one has to come round
  // before a parked handle's TTL runs out, and that budget is unrelated to how
  // often it is worth health-checking a sandbox.
  setInterval(() => { sweepIdleMultiNodeClusters().catch(() => {}); }, MULTI_NODE_SWEEPER_INTERVAL_MS);
  logger.info(
    {
      intervalMs: MULTI_NODE_SWEEPER_INTERVAL_MS,
      idleReclaimMs: MULTI_NODE_IDLE_RECLAIM_MS,
      entryTtlMs: BRAIN_REGISTRY_TTL_MS,
    },
    "mn_sweeper.started",
  );
}

/**
 * Hand an unfinished teardown back to the idle-reclaim path.
 *
 * When session teardown cannot confirm it removed everything, the cheapest
 * correct thing to do is leave the `hands.<sid>` handle behind, marked idle, and
 * let the nets that already exist catch it: sweepIdleMultiNodeClusters above
 * walks `hands.*` and reclaims a deleted session's clusters on its next pass,
 * without the idle window a live session would have to sit through. The pod goes
 * with it, from the other direction -- `keepalive: false` stops the ticker
 * pinging it, so the control-plane's own sandbox idle-GC stops being suppressed.
 *
 * Deliberately does not retry on conflict or error. Losing this hand-off costs
 * the sweeper's path, not the reclamation itself: the workload's own timeout
 * remains behind it.
 */
export async function parkForIdleReclaim(sessionId: string): Promise<void> {
  const { outcome, error } = await parkHandsHandle(getHandsKv(), sessionId);
  switch (outcome) {
    case "parked":
      logger.info({ sessionId }, "hands.parked_for_idle_reclaim");
      return;
    case "gone":
      // Another replica confirmed the teardown and removed the entry, which is
      // further than parking would have got.
      return;
    case "superseded":
      // Every replica runs this teardown, so all of them park and only one can
      // win the conditional write. Losing is the expected outcome and the goal is
      // still met, so this is not a failure. Reporting it as one would mean five
      // misleading warnings per incomplete teardown, burying a real KV outage
      // among them.
      logger.info({ sessionId }, "hands.park_for_idle_reclaim_superseded");
      return;
    case "failed":
      logger.warn(
        { err: (error as Error)?.message || String(error), sessionId },
        "hands.park_for_idle_reclaim_failed",
      );
      return;
  }
}

/**
 * Classify a fatal error message as sandbox-originated. Returns a stable
 * short code (sandbox_* / mn_* / rayjob_* / infera_* ) when the error comes
 * from ensureHands, multi-node cluster provisioning, workload polling, Hands
 * bootstrap, or Hands health — else null. Used to surface a dedicated
 * sandboxStatus.failed event and a user-friendly final_text.
 */
export function classifySandboxFailure(msg: string): string | null {
  if (!msg) return null;
  if (/platformKey is required/i.test(msg)) return "sandbox_auth_missing";
  if (/sandbox_image/i.test(msg) && /missing/i.test(msg)) return "sandbox_image_missing";
  if (/GPU_TEMPLATE_SPEC_PATH/i.test(msg)) return "sandbox_template_missing";
  if (/Create Hands failed: HTTP/i.test(msg)) return "sandbox_create_failed";
  if (/Hands workload .* entered terminal phase/i.test(msg)) return "sandbox_workload_terminal";
  if (/Hands health check failed/i.test(msg)) return "sandbox_health_failed";
  if (/bootstrap\.(mkdir_workspace|install_nodejs|start_hands)/i.test(msg)) return "sandbox_bootstrap_failed";
  if (/multi-node workload create failed/i.test(msg)) return "mn_cluster_create_failed";
  if (/multi-node workload .* entered terminal phase/i.test(msg)) return "mn_cluster_terminal";
  if (/multi-node workload .* not ready within/i.test(msg)) return "mn_cluster_timeout";
  if (/RayJob create failed/i.test(msg)) return "rayjob_create_failed";
  if (/multi-node (request )?requires/i.test(msg)) return "rayjob_config_invalid";
  if (/model is required/i.test(msg) || /multi-node infera request requires/i.test(msg)) {
    return "infera_model_missing";
  }
  return null;
}
