// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { StringCodec, type KV, type KvEntry } from "nats";
import { randomUUID } from "crypto";
import pino from "pino";
import type { ExecuteRequest } from "@claw/protocol";
import { isRevisionConflict } from "@claw/utils";
import { metrics } from "../infra/metrics.js";
import {
  BRAIN_REGISTRY_TTL_MS, LOCK_REFRESH_INTERVAL_MS, RUN_GATE_KEY,
  TASK_LOCK_DEAD_HOLDER_MS, TASK_LOCK_NAK_BASE_MS, TASK_LOCK_NAK_MAX_MS,
} from "../config.js";

const logger = pino({ name: "task-lock" });
const sc = StringCodec();

// ===== Task Execution Lock (NATS KV) =====
//
// Lock granularity is `lockKey`: `request.dag_root_task_id` when the task
// carries a DAG root, else `request.session_id` for the chat path (1
// session ⇄ 1 root task). Callers compute it once via `pickLockKey(request)`
// before any other handleTask work happens.
//
// Keying on dag_root_task_id instead of session_id avoids one batch-style
// DAG's lock starving the other N-1 roots that fan out into the same
// hidden session, while chat's empty dag_root_task_id still falls back to
// sessionId for correct per-session serialisation.

// INV-13 (checkpoint-architecture-redesign §18.3.1): NATS KV session locks
// use a JSON value carrying a per-process holderId UUID so a long-paused
// brain pod cannot accidentally delete a lock that has already been reaped
// by TTL and re-acquired by a different pod. BRAIN_HOLDER_ID is generated
// once per process; unlike the env-driven BRAIN_ID (which can match across
// pod restarts when the deployment reuses the same name), this UUID is
// unique per incarnation, so "holder mismatch on release" reliably means
// "someone else owns this lock now".
const BRAIN_HOLDER_ID = randomUUID();

interface LockValue {
  holderId: string;
  /**
   * Stream sequence of the message this lock was taken for.
   *
   * Stable across redeliveries of that message, which is what lets a
   * redelivered copy tell "a sibling is holding my lock" apart from "the run
   * I would be duplicating is my own". Optional: a lock written by a pod from
   * before this field existed carries no value, and readers treat that as an
   * unknown holder rather than as a match.
   */
  seq?: number;
  /**
   * The pod this process runs in, when its BRAIN_ID is that pod's name.
   *
   * A container that crashes and is restarted in place keeps its pod name and
   * gets a new holder id, so this is what lets the restarted process recognise
   * the locks its previous incarnation died holding and give them back at once
   * (`releaseLocksOfPreviousIncarnation`), instead of every run on the pod
   * waiting out the registry TTL. Absent everywhere else -- a local brain whose
   * id several processes may share must never be able to release another's.
   */
  pod?: string;
  /**
   * Minted by each `acquireTaskLock` and carried by every renewal of that
   * acquisition. The holder id is per process, so it cannot tell two runs of
   * the same lock key in one process apart, and the stream sequence may be
   * absent; this can. A renewal that conflicted reads it back to decide
   * whether the entry is its own stored write (see refreshTaskLock).
   */
  acq?: string;
  /**
   * The run (claw_tasks.task_id) this lock was taken for, when the caller knew
   * it. What lets another brain that the API has handed that same run tell the
   * lock of a holder lost with its node from a lock some other run of the key
   * still holds (`acquireTaskLock`'s takeover). Absent on locks from pods
   * before this field, which are therefore never taken over.
   */
  task?: string;
  acquiredAt: number;
  lastRenewedAt: number;
}

/**
 * This process's pod name, if and only if it is also its BRAIN_ID.
 *
 * The chart sets BRAIN_ID to $(POD_NAME), which names exactly one live process
 * at a time; nothing else is trusted to. Read from the environment each call so
 * a test can set it.
 */
export function incarnationPod(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const pod = (env.POD_NAME ?? "").trim();
  const brainId = (env.BRAIN_ID ?? "").trim();
  return pod && pod === brainId ? pod : undefined;
}

// In-process map of lockKey -> last-known NATS KV revision. Populated on a
// successful acquireTaskLock, advanced on each successful refreshTaskLock
// CAS, and consulted by releaseTaskLock when issuing its holder-checked
// CAS delete. A brain pod handles one in-flight task per lockKey at a time
// (activeAbort guard above the call sites), so concurrent map mutation on
// the same key is structurally impossible inside a single event loop.
const lockRevisions = new Map<string, number>();

// lockKey -> the stream sequence the lock was taken for. Kept here rather than
// re-read from the bucket because refreshTaskLock rewrites the whole value
// every 10s and would otherwise drop the field on the first renewal.
const lockSeqs = new Map<string, number>();

// lockKey -> the acquisition (LockValue.acq) the local entries belong to.
const lockAcquisitions = new Map<string, string>();

// lockKey -> the run the lock was taken for (LockValue.task), carried by every
// renewal for the same reason as the stream sequence above.
const lockTasks = new Map<string, string>();

// lockKey -> when this pod last proved it still holds the lock. The bucket
// expires an entry nobody refreshes, so this is the only local evidence of how
// close the claim is to lapsing while renewals are failing.
const lockProvenAt = new Map<string, number>();

/** Drop all local memory of a lock we no longer hold. */
function forgetLock(lockKey: string): void {
  lockRevisions.delete(lockKey);
  lockSeqs.delete(lockKey);
  lockAcquisitions.delete(lockKey);
  lockTasks.delete(lockKey);
  lockProvenAt.delete(lockKey);
}

/**
 * How long a run may go without proving it still holds its lock.
 *
 * One refresh interval short of the TTL, so the decision is taken while the
 * claim is still ours rather than after: at the moment the entry expires,
 * nothing stands between a redelivered copy and the lock, and the copy of the
 * run that cannot renew is the one that has to stop.
 */
export function lockProofDeadlineMs(
  ttlMs: number = BRAIN_REGISTRY_TTL_MS,
  refreshMs: number = LOCK_REFRESH_INTERVAL_MS,
): number {
  return Math.max(refreshMs, ttlMs - refreshMs);
}

/**
 * Whether the lock can expire between two renewals of a perfectly healthy run.
 *
 * The interval has to leave room for a second attempt inside the TTL, and the
 * deadline above cannot stand in for that: at a refresh interval at or above
 * the TTL its floor collapses to the interval itself, so a run keeps renewing
 * successfully while the entry it is renewing lapses in the gaps between. A
 * redelivered copy then finds the lock free and executes the same turn beside
 * the run that never noticed losing it -- two agents in one workspace, which is
 * the whole of what the lock is for. Reported at startup rather than enforced
 * here, because the two numbers are set independently and neither is wrong on
 * its own.
 */
export function lockExpiresBetweenRenewals(
  ttlMs: number = BRAIN_REGISTRY_TTL_MS,
  refreshMs: number = LOCK_REFRESH_INTERVAL_MS,
): boolean {
  return refreshMs * 2 > ttlMs;
}

let _kv: KV | null = null;

/**
 * Whether a KV read means "this lock is gone" rather than "here is the lock".
 *
 * NATS KV reports a deleted key as a DEL/PURGE entry carrying an empty
 * payload, not as a miss, so a truthy `kv.get` result does not imply the lock
 * is still held. Decoding one yields "", `JSON.parse("")` throws, and the
 * release path used to read that as a legacy pre-INV13 lock — which is why
 * every replica logged hundreds of `legacy_value_format_skip` warnings for
 * locks it had just correctly deleted. The empty-payload check stands in for
 * `operation` in case a client version leaves it unset.
 */
export function isTombstone(entry: { operation?: string; value?: Uint8Array } | KvEntry): boolean {
  const op = String((entry as { operation?: string }).operation ?? "");
  return op === "DEL" || op === "PURGE" || !entry.value || entry.value.length === 0;
}

/**
 * Delay before redelivering a task that could not start because another
 * handler holds its lock.
 *
 * Such a task is healthy, but each redelivery still spends one of
 * TASK_MAX_DELIVER — see TASK_LOCK_NAK_BASE_MS for why a flat delay dropped
 * tasks queued behind long-running siblings. Jitter keeps the brain replicas
 * from retrying in lockstep.
 */
export function lockContentionNakMs(
  deliveryCount: number,
  random: () => number = Math.random,
): number {
  const attempt = Math.max(1, Math.floor(deliveryCount) || 1);
  const backoff = Math.min(
    TASK_LOCK_NAK_MAX_MS,
    TASK_LOCK_NAK_BASE_MS * 2 ** (attempt - 1),
  );
  return Math.round(backoff * (0.75 + 0.25 * random()));
}

export type TaskLockState =
  | { known: true; held: false; seq: null }
  | { known: true; held: true; seq: number | null }
  // The read itself failed. Nothing was learned about this lock, which is a
  // third answer and not a synonym for the first: see readTaskLock.
  | { known: false; held: false; seq: null };

/**
 * How many times the probe asks before reporting that it could not find out.
 *
 * Affordable because of where this runs: the poison guard, at most once per
 * delivery and only from TASK_POISON_DELIVERY_COUNT onward. Nothing on the hot
 * path waits on it, so a transient NATS blip is worth a few hundred
 * milliseconds to turn back into a real answer rather than into a verdict
 * taken without one.
 */
const LOCK_PROBE_ATTEMPTS = 3;
const LOCK_PROBE_RETRY_MS = 150;

/**
 * Who holds this lock, if anyone, without taking it.
 *
 * `seq` is the stream sequence the holder took it for, or null when the value
 * predates that field or cannot be parsed. Callers need it to separate the two
 * things a held lock can mean: a sibling is running (real contention) or this
 * very message is already being executed somewhere, in which case whoever runs
 * it owns the ack and nobody else may resolve it.
 *
 * Read-only on purpose -- acquireTaskLock would create the lock as a side
 * effect.
 *
 * A failed read reports `known: false` rather than "not held". The distinction
 * exists because of the second question above: while the probe only chose
 * between two failure *labels*, answering "not held" was a harmless
 * simplification of "I could not find out", costing at worst a misleading log
 * line. Deciding whether a run is alive is not that kind of question -- there
 * the same simplification tells the guard nobody is executing the message,
 * which is how a task that is running gets reported as failed. Callers must
 * treat an unknown probe as a reason to wait, not as permission to act.
 */
export async function readTaskLock(lockKey: string): Promise<TaskLockState> {
  let entry;
  for (let attempt = 1; ; attempt++) {
    try {
      entry = await getKv().get(`lock.${lockKey}`);
      break;
    } catch (e) {
      if (attempt >= LOCK_PROBE_ATTEMPTS) {
        logger.warn({ err: e, lockKey, attempts: attempt }, "lock.probe_failed");
        return { known: false, held: false, seq: null };
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_PROBE_RETRY_MS));
    }
  }
  if (!entry || isTombstone(entry)) return { known: true, held: false, seq: null };
  try {
    const v = JSON.parse(sc.decode(entry.value)) as Partial<LockValue>;
    return { known: true, held: true, seq: typeof v.seq === "number" ? v.seq : null };
  } catch {
    // Legacy plain-string lock from a pre-INV13 pod: held, holder unknown.
    return { known: true, held: true, seq: null };
  }
}

/**
 * Bind the BRAIN_REGISTRY KV bucket used for `lock.<key>` entries. Must be
 * called once from index.ts main() before the first task arrives.
 */
export function bindTaskLockKv(kv: KV): void {
  _kv = kv;
}

function getKv(): KV {
  if (!_kv) throw new Error("tasks/lock.ts: bindTaskLockKv() must be called before use");
  return _kv;
}

/**
 * The runs that are continuations of one another: one DAG's nodes, or one
 * conversation's turns.
 *
 * Two things are scoped to this rather than to a single run. It is what the gate
 * keyed on before it started keying on files, so it is the fallback below. And
 * it is the scope a background shell is addressable in: a shell started in one
 * chat turn has to be pollable in the next, and a DAG node inheriting an
 * upstream node's sandbox has to be able to reach what that node left running.
 *
 * Deliberately not the gate key. The gate is free to widen -- it now keys on the
 * workspace, which several unrelated sessions can share -- and letting the
 * addressing scope widen with it would hand one session's shells to another,
 * which is the thing the scope exists to prevent.
 */
export function pickRunScope(request: ExecuteRequest): string {
  return request.dag_root_task_id || request.session_id;
}

/**
 * Shell-filing key: a DAG node's task or node id, or empty for a conversation.
 * Throws when a DAG request has neither a task id nor a node id.
 */
export function pickShellRun(request: ExecuteRequest): string {
  const isDagNode = !!(request.dag_root_task_id || request.dag_node_id);
  if (!isDagNode) return "";
  const shellRun = request.task_id || request.dag_node_id;
  if (!shellRun) throw new Error("DAG shell scope requires a non-empty task_id or dag_node_id");
  return shellRun;
}

/**
 * Compute the lock key for a request: which runs are allowed to overlap.
 *
 * The question the key is answering is whether two runs write the same files.
 * It used to answer a different one -- do they share a session, or a DAG root
 * -- and those are proxies that are wrong in both directions. Two DAG roots
 * over one session share that session's directory and ran in parallel anyway
 * (4.12: they overwrite each other's workspace and checkpoint). A chat turn
 * and a DAG task on one session likewise took different keys and overlapped.
 *
 * Serialising the *write* would not have been enough, and this is the part
 * that is easy to get wrong: a run restores its copy of the files when its
 * sandbox opens, not when it syncs. Two runs that merely queue for the write
 * both restored the same starting state, so the second one still syncs a tree
 * that never contained the first one's changes -- and the sync is an rsync
 * with `--delete`, so those changes are removed rather than merged. The unit
 * that has to be serialised is restore-execute-sync, which is the run, which
 * is this gate.
 *
 * `RUN_GATE_KEY=session` restores the old proxy, for a deployment that would
 * rather have the overlap than the queue.
 */
export function pickLockKey(request: ExecuteRequest): string {
  // An app run does not write the session's files. It runs in an app sandbox of its
  // own, so the question this key answers ("do two runs write the same files") has
  // the answer no for it, and it must not queue the session's conversation behind
  // an application that lives for hours (a foreground turn naked on `ws.<id>` until
  // its delivery budget ran out). Its own key still keeps a second handler of the
  // same run from starting on another pod.
  if (request.mode === "app" && request.task_id) return `app.${request.task_id}`;
  const fallback = pickRunScope(request);
  if (RUN_GATE_KEY !== "workspace") return fallback;
  if (request.files_workspace_id) return `ws.${request.files_workspace_id}`;
  // Reached only for a message from an API too old to bind workspaces, since
  // a newer one that fails to bind is refused outright (see gateBindingError).
  // Those messages drain within one rollout; the log is how you know they
  // have, because until they do this deployment is not gating on files.
  logger.error(
    { sessionId: request.session_id, taskId: request.task_id, fallback },
    "task.gate_key_missing_workspace",
  );
  return fallback;
}

/**
 * Why this run must not execute, or null if it may.
 *
 * The gate can only serialise runs that say which files they write. A run
 * that does not say, under a deployment configured to gate on files, would
 * get a key that lets it overlap a run writing the same directory -- and the
 * loser of that race does not see an error, it sees its files deleted by the
 * other run's sync. Refusing is the louder failure, and the cheaper one.
 *
 * Conditioned on the dispatcher's own promise rather than on the id alone,
 * because during a rolling upgrade the two reasons an id can be missing need
 * opposite responses: an old API never sends one and its runs are fine, a new
 * API that failed to bind is the case worth refusing. Without the promise this
 * check would either be useless or would fail every run until the API caught
 * up.
 */
export function gateBindingError(request: ExecuteRequest): string | null {
  if (RUN_GATE_KEY !== "workspace") return null;
  if (!request.files_workspace_required) return null;
  if (request.files_workspace_id) return null;
  return "This run was not bound to a workspace, so it cannot be serialised "
    + "against other runs writing the same files. Refusing to execute rather "
    + "than risk overwriting them. Retry the request; if it keeps happening, "
    + "the workspace bookkeeping in the API is failing.";
}

/**
 * How a caller that the API has handed a run may treat a lock it finds held.
 *
 * `taskId` names the run; `takeOverDeadHolder` says the API has already fenced
 * every earlier attempt at it (a claimed doorbell: the claim bumped the row's
 * `claim_count`, so the previous holder's lease renewals and settlement are
 * refused from here on). Only then may a lock left by a holder lost with its
 * node be taken over -- see {@link deadHolderTakeover}.
 */
export interface AcquireOptions {
  taskId?: string;
  takeOverDeadHolder?: boolean;
}

/**
 * Whether a held lock is a dead holder's that this caller may take over, and
 * how long it has gone unrenewed.
 *
 * All of these, or the lock stays where it is:
 *   - the takeover is on (TASK_LOCK_DEAD_HOLDER_MS > 0) and the caller holds a
 *     fenced claim on a named run (`takeOverDeadHolder` + `taskId`);
 *   - the lock was taken for that very run. A lock some other run of the key
 *     holds -- the previous turn of the same session, say -- is never taken,
 *     however stale: the API has not declared that run's holder dead;
 *   - it is not this process's own;
 *   - nobody has written it for TASK_LOCK_DEAD_HOLDER_MS, by the store's own
 *     timestamp. A live holder rewrites it every LOCK_REFRESH_INTERVAL_MS.
 *
 * Exported for the unit test that pins each condition.
 */
export function deadHolderTakeover(
  held: Partial<LockValue> | null,
  writtenAt: Date | undefined,
  opts: AcquireOptions,
  now: number = Date.now(),
  thresholdMs: number = TASK_LOCK_DEAD_HOLDER_MS,
): { ok: true; staleMs: number } | { ok: false } {
  if (thresholdMs <= 0 || !opts.takeOverDeadHolder || !opts.taskId) return { ok: false };
  if (!held || held.task !== opts.taskId || held.holderId === BRAIN_HOLDER_ID) return { ok: false };
  if (!(writtenAt instanceof Date) || Number.isNaN(writtenAt.getTime())) return { ok: false };
  const staleMs = now - writtenAt.getTime();
  return staleMs >= thresholdMs ? { ok: true, staleMs } : { ok: false };
}

function recordAcquired(lockKey: string, rev: number, value: LockValue): void {
  lockRevisions.set(lockKey, rev);
  lockProvenAt.set(lockKey, Date.now());
  if (value.seq !== undefined) lockSeqs.set(lockKey, value.seq);
  if (value.task !== undefined) lockTasks.set(lockKey, value.task);
  else lockTasks.delete(lockKey);
  lockAcquisitions.set(lockKey, value.acq!);
}

export async function acquireTaskLock(
  lockKey: string, seq?: number, opts: AcquireOptions = {},
): Promise<boolean> {
  const acq = randomUUID();
  const value: LockValue = {
    holderId: BRAIN_HOLDER_ID,
    seq,
    pod: incarnationPod(),
    acq,
    task: opts.taskId || undefined,
    acquiredAt: Date.now(),
    lastRenewedAt: Date.now(),
  };
  try {
    // kv.create returns the revision number assigned by NATS server.
    const rev = await getKv().create(`lock.${lockKey}`, sc.encode(JSON.stringify(value)));
    recordAcquired(lockKey, Number(rev), value);
    return true;
  } catch {
    // Key exists. Unlike the pre-INV13 implementation we do NOT steal even
    // when the stored holderId looks familiar — BRAIN_HOLDER_ID is a per-
    // process UUID, so a matching holderId across pod restarts is mathema-
    // tically impossible. If the lock really belongs to a dead pod it will
    // expire via bucket TTL (BRAIN_REGISTRY_TTL_MS, refreshed every 10s
    // by the live owner's keepAlive).
    try {
      const entry = await getKv().get(`lock.${lockKey}`);
      if (entry && !isTombstone(entry)) {
        // Always overwritten below on both the try and catch paths, so no
        // initial value is needed here.
        let holderInfo: string;
        let held: Partial<LockValue> | null = null;
        try {
          held = JSON.parse(sc.decode(entry.value)) as Partial<LockValue>;
          holderInfo = String(held.holderId ?? "(none)");
        } catch {
          // Legacy plain-string lock from a pre-INV13 brain pod in a
          // rolling-upgrade window; render it as such for the log.
          holderInfo = `legacy:${sc.decode(entry.value)}`;
        }
        const takeover = deadHolderTakeover(held, entry.created, opts);
        if (takeover.ok) {
          // A CAS on the revision just read: if the holder renewed in between
          // it is alive after all, the write fails, and the lock stays its.
          try {
            const rev = await getKv().update(`lock.${lockKey}`, sc.encode(JSON.stringify(value)), entry.revision);
            recordAcquired(lockKey, Number(rev), value);
            logger.warn(
              { lockKey, taskId: opts.taskId, previousHolder: holderInfo, previousPod: held?.pod, staleMs: takeover.staleMs },
              "lock.dead_holder_taken_over",
            );
            metrics.onDeadHolderLockTakenOver();
            return true;
          } catch (e) {
            logger.info({ err: e, lockKey }, "lock.dead_holder_takeover_lost_race");
            return false;
          }
        }
        logger.info({ lockKey, holder: holderInfo }, "lock.held_by_other");
      }
    } catch (e) {
      logger.warn({ err: e, lockKey }, "lock.acquire_recheck_failed");
    }
    return false;
  }
}

/**
 * What a renewal attempt established about who holds the lock.
 *
 * `lost` is the one the caller has to act on: a revision conflict means another
 * replica now owns this lock, so it is running or about to run the same task
 * against the same sandbox and workspace. `error` is deliberately separate —
 * an unreachable store says nothing about ownership, and treating it as a loss
 * would stop healthy runs during a NATS blip.
 *
 * `expired` is what a long enough run of those errors becomes. Nobody has taken
 * the lock yet, as far as this pod can tell, but nobody could tell it if they
 * had: the entry lives on a TTL, the renewals that would have extended it are
 * not landing, and past the point where it can still be ours a redelivery may
 * take it at any moment. Acted on like a loss, because the alternative is
 * finding out by way of two workers in one workspace.
 */
export type LockRenewal = "renewed" | "not_held" | "lost" | "expired" | "error";

/**
 * Refresh lock TTL to prevent expiry during long tasks. Call periodically.
 *
 * Returns the outcome rather than swallowing it. The renewal is the only signal
 * a running task gets that its lease is gone, and it used to be a `void` call
 * behind `.catch(() => {})`, so the one thing worth knowing — that a second
 * replica had taken the task over — was recorded nowhere the run could see.
 */
export async function refreshTaskLock(lockKey: string): Promise<LockRenewal> {
  const rev = lockRevisions.get(lockKey);
  if (rev === undefined) {
    // Either acquireTaskLock was never called for this key, or a conflict
    // established that the lock is somebody else's. Both are worth a line:
    // renewals stop here and say nothing further, and a run whose renewals
    // have gone quiet used to be indistinguishable from one being renewed.
    logger.warn({ lockKey }, "lock.refresh.not_held");
    return "not_held";
  }
  const value: LockValue = {
    holderId: BRAIN_HOLDER_ID,
    seq: lockSeqs.get(lockKey),
    pod: incarnationPod(),
    acq: lockAcquisitions.get(lockKey),
    task: lockTasks.get(lockKey),
    acquiredAt: 0,
    lastRenewedAt: Date.now(),
  };
  try {
    const newRev = await getKv().update(
      `lock.${lockKey}`,
      sc.encode(JSON.stringify(value)),
      rev,
    );
    // Recorded only while the local entry is still this acquisition's: a
    // renewal answered after its run released the key must not overwrite the
    // revision a later run of the key is renewing from.
    if (lockAcquisitions.get(lockKey) === value.acq) {
      lockRevisions.set(lockKey, Number(newRev));
      lockProvenAt.set(lockKey, Date.now());
    }
    return "renewed";
  } catch (e) {
    // A CAS conflict means the entry moved since the revision we remember. That
    // is usually somebody else taking the lock -- the TTL expired while our
    // event loop was paused and a competitor grabbed it -- but not always: a
    // renewal whose PubAck timed out may still have been stored, and then the
    // entry moved because of *us*. That is exactly what a JetStream stall looks
    // like from here (2026-11-06: two TIMEOUTs, then "wrong last sequence" on
    // five healthy runs, each of which stood down and stalled for eleven minutes
    // with nobody else holding its lock). So the entry is read back before
    // anything is concluded, and the lock is only given up when it names
    // another holder.
    if (isRevisionConflict(e)) {
      // A renewal that outlived its run: the key was released and acquired
      // again in this process while this CAS was in flight, so the local
      // record is the later run's. Nothing here is this renewal's to read
      // back, adopt or forget.
      if (lockAcquisitions.get(lockKey) !== value.acq) {
        logger.warn({ lockKey }, "lock.refresh_stale_renewal_ignored");
        return "lost";
      }
      const outcome = await renewOverOwnCommittedWrite(lockKey, value);
      if (outcome !== "lost") return outcome === "renewed" ? "renewed" : renewalFailed(lockKey, e);
      logger.warn({ err: e, lockKey }, "lock.refresh_cas_lost");
      // Forgotten only if the local record is still this acquisition's: the
      // read-back awaited, and a later run of the key may have taken it since.
      if (lockAcquisitions.get(lockKey) === value.acq) forgetLock(lockKey);
      return "lost";
    }
    return renewalFailed(lockKey, e);
  }
}

/**
 * After a revision conflict: is the entry still ours, and if so renew it.
 *
 * Ours means this process's holder id *and* this acquisition's id. The holder
 * id is unique per process, so a match cannot be a different pod; the
 * acquisition id keeps a later run of the same lock key in this same process
 * from being mistaken for this one (and, through the local check around the
 * write, keeps a renewal that outlived its run from writing at all). Anything
 * else -- another holder, a value that does not parse, an entry that is gone --
 * is the conflict meaning what it always meant.
 *
 * `error` is a read or a write that did not answer, which says nothing about
 * ownership; the caller treats it like any other transport failure.
 */
async function renewOverOwnCommittedWrite(
  lockKey: string,
  value: LockValue,
): Promise<"renewed" | "lost" | "error"> {
  const key = `lock.${lockKey}`;
  let entry: KvEntry | null;
  try {
    entry = await getKv().get(key);
  } catch {
    return "error";
  }
  if (!entry || isTombstone(entry)) return "lost";
  let held: Partial<LockValue>;
  try {
    held = JSON.parse(sc.decode(entry.value)) as Partial<LockValue>;
  } catch {
    return "lost";
  }
  if (held.holderId !== BRAIN_HOLDER_ID || !value.acq || held.acq !== value.acq) return "lost";
  // Asked again after the read: the run this renewal belongs to may have
  // released the key, and another run taken it, while the read was in flight.
  if (lockAcquisitions.get(lockKey) !== value.acq) return "lost";
  try {
    const newRev = await getKv().update(key, sc.encode(JSON.stringify(value)), entry.revision);
    if (lockAcquisitions.get(lockKey) !== value.acq) return "lost";
    lockRevisions.set(lockKey, Number(newRev));
    lockProvenAt.set(lockKey, Date.now());
    logger.info({ lockKey, revision: Number(newRev) }, "lock.refresh_adopted_own_write");
    return "renewed";
  } catch (e) {
    // A second conflict inside one renewal is somebody else writing, not a
    // timed-out write of ours: nothing of ours was in flight in between.
    return isRevisionConflict(e) ? "lost" : "error";
  }
}

/** A renewal that did not land and established nothing about ownership. */
function renewalFailed(lockKey: string, e: unknown): LockRenewal {
  // Forgetting the revision here used to end renewals for the rest of the run:
  // every later tick found no revision, returned "not_held" without attempting
  // anything, and said nothing -- so one NATS blip left the lock to expire under
  // a healthy run, and the redelivery that took it over five minutes later ran
  // the same task against the same sandbox while the original carried on. The
  // revision is kept instead: a CAS with a stale one cannot take a lock from
  // anybody, it can only fail (and be read back, above), and the release path
  // reads the entry's own revision rather than this map.
  const staleForMs = Date.now() - (lockProvenAt.get(lockKey) ?? Date.now());
  const expired = staleForMs >= lockProofDeadlineMs();
  logger.warn({ err: e, lockKey, staleForMs, expired }, "lock.refresh_failed");
  return expired ? "expired" : "error";
}

export async function releaseTaskLock(lockKey: string): Promise<void> {
  const key = `lock.${lockKey}`;
  let entry;
  try {
    entry = await getKv().get(key);
  } catch (e) {
    logger.warn({ err: e, lockKey }, "lock.release.get_failed");
    // Nothing was learned about the lock, and a release has no renewal left for
    // the local revision to serve. Kept, it would sit there for the life of the
    // process on any lockKey nothing acquires again -- a deleted session's.
    forgetLock(lockKey);
    return;
  }
  if (!entry || isTombstone(entry)) {
    forgetLock(lockKey);
    return; // reaped by TTL, by a competing brain, or by our own earlier release
  }

  let value: Partial<LockValue> | null = null;
  try {
    value = JSON.parse(sc.decode(entry.value)) as Partial<LockValue>;
  } catch {
    // Legacy plain-string lock from a pre-INV13 brain pod still in the
    // cluster. Per decision 4A: do NOT attempt to identify the holder
    // (BRAIN_ID can match by env), do NOT delete (would corrupt INV-13).
    // The bucket TTL will reap it once the legacy owner stops renewing.
    logger.warn({ lockKey }, "lock.release.legacy_value_format_skip");
    metrics.onLockReleaseSkipped("legacy_format");
    forgetLock(lockKey);
    return;
  }

  if (value?.holderId !== BRAIN_HOLDER_ID) {
    // INV-13 protection: the lock now belongs to someone else (e.g. our
    // event loop hung past the bucket TTL and a new pod grabbed it). A
    // plain delete here would create an unlocked window — refuse and
    // record the diagnostic counter for alerting.
    logger.warn(
      {
        lockKey,
        ourHolderId: BRAIN_HOLDER_ID,
        currentHolderId: value?.holderId,
        lockAge: value?.acquiredAt ? Date.now() - value.acquiredAt : null,
      },
      "lock.release.skipped_not_holder_INV13_protected",
    );
    metrics.onLockReleaseSkipped("not_holder");
    forgetLock(lockKey);
    return;
  }

  try {
    // CAS delete: NATS rejects if revision moved between our get() and
    // delete() (i.e. a competitor wrote during that window). Cast required
    // because @types/nats narrows the second arg to `Partial<MsgRequest>`
    // without `previousSeq` in 2.29.x; the server-side option is real.
    await getKv().delete(key, { previousSeq: entry.revision } as any);
  } catch (e: any) {
    const errMsg = String(e?.message ?? e);
    if (errMsg.includes("wrong last sequence")) {
      logger.warn(
        { lockKey, rev: entry.revision },
        "lock.release.cas_lost_INV13_protected",
      );
      metrics.onLockReleaseSkipped("cas_lost");
    } else {
      logger.error({ err: e, lockKey }, "lock.release.delete_failed");
    }
  } finally {
    forgetLock(lockKey);
  }
}

/**
 * Give back the locks this pod's previous process died holding.
 *
 * Called once at start, before anything is claimed, so nothing this process
 * holds can be among them: a lock naming this pod under a different holder id
 * is the previous incarnation's, and that process is gone. Deleted with a CAS
 * on the revision just read, so a lock that changed hands in between is left
 * to whoever has it. Returns how many were released; never throws -- a start
 * that cannot do this is no worse off than before it existed, its runs simply
 * wait out the TTL.
 */
export async function releaseLocksOfPreviousIncarnation(pod: string): Promise<number> {
  let released = 0;
  try {
    const kv = getKv();
    const keys: string[] = [];
    for await (const key of await kv.keys("lock.>")) keys.push(key);
    for (const key of keys) {
      try {
        const entry = await kv.get(key);
        if (!entry || isTombstone(entry)) continue;
        let held: Partial<LockValue>;
        try {
          held = JSON.parse(sc.decode(entry.value)) as Partial<LockValue>;
        } catch {
          continue;
        }
        if (held.pod !== pod || held.holderId === BRAIN_HOLDER_ID) continue;
        await kv.delete(key, { previousSeq: entry.revision } as any);
        released++;
        logger.warn({ key, pod, previousHolder: held.holderId }, "lock.previous_incarnation_released");
      } catch (err) {
        logger.warn({ err, key }, "lock.previous_incarnation_release_failed");
      }
    }
  } catch (err) {
    logger.warn({ err, pod }, "lock.previous_incarnation_scan_failed");
  }
  return released;
}
