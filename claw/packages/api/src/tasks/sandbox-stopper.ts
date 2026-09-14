// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Backend-side sandbox destruction (task-design.md §9.4 / §9.5).
 *
 * Backend is the *only* normal destroyer; Brain only rolls back sandboxes
 * it created when KV bookkeeping fails inside its own create path. Three
 * entry points feed this module:
 *
 *   1. agent_done callback handler: if the calling task is the last user
 *      of any handle (per DAG `handle_last_user` derived map).
 *   2. DAG root transition handler: tear every remaining handle of a
 *      finished / cancelled DAG.
 *   3. Sweeper: orphan handles whose DAG row no longer exists.
 *
 * Both KV destroy and SaFE workload stop are idempotent.
 */
import { DagHandleMap, type HandleInfo } from "@claw/protocol";
import type { KVStore } from "@claw/utils";
import pino from "pino";
import { readTrustedSessionCredentials } from "../auth/session-credentials.js";
import { SAFE_API_URL } from "../config.js";
import { kv as natsKv } from "../infra/nats.js";
import { db } from "../infra/db.js";

const logger = pino({ name: "sandbox-stopper" });

/** Unchanged from before this file reported outcomes. */
const SAFE_STOP_TIMEOUT_MS = 15_000;
/**
 * The confirming read is shorter than the stop it follows. It runs inside a
 * cancel request, once per handle, and its answer when it times out is the same
 * `unconfirmed` a caller gets from not asking -- so a slow SaFE must cost the
 * request as little as possible rather than doubling its worst case.
 */
const SAFE_READ_TIMEOUT_MS = 5_000;

/**
 * Its own key space beside `dag-handles.<root>`, not a field inside the handle
 * entry: the entry is deleted before the stop runs, so anything kept there is
 * gone exactly when it would be needed.
 */
const UNRELEASED_PREFIX = "dag-unreleased";

let _handleMap: DagHandleMap | null = null;
let _kvStore: KVStore | null = null;

/** Build the DagHandleMap on demand using the existing NATS KV bucket. */
function handleMap(): DagHandleMap {
  _handleMap ??= new DagHandleMap(kvStore());
  return _handleMap;
}

/** The adapter behind both the handle map and the unreleased record. */
function kvStore(): KVStore {
  if (_kvStore) return _kvStore;
  // Adapt the in-process NATS KV (which the API already owns) into the
  // KVStore interface DagHandleMap expects. We rely on the same encoding
  // contract Brain uses to write handle entries: a JSON object payload.
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  const ks: KVStore = {
    // `null` means the key is not there. It used to also mean "the read
    // threw", which the teardown path below now has to be able to tell apart:
    // a bucket that cannot be read says nothing about what a DAG holds, and
    // classifying that as "holds nothing" is how an unreadable registry turns
    // into a confident `nothing_held` while a workload keeps its GPU. A
    // corrupt payload is the same kind of unknown, so it throws rather than
    // reading as absent. Callers that genuinely do not care still get one --
    // the sweeper tick already contains its sweeps.
    async get(key) {
      const entry = await natsKv.get(key);
      if (!entry) return null;
      try {
        return JSON.parse(dec.decode(entry.value)) as Record<string, unknown>;
      } catch (e) {
        throw new Error(`handle map entry ${key} is not readable JSON: ${(e as Error).message}`);
      }
    },
    async put(key, value) {
      await natsKv.put(key, enc.encode(JSON.stringify(value)));
    },
    async delete(key) {
      await natsKv.delete(key);
    },
    async scanPrefix(prefix) {
      const filter = prefix.endsWith(".") ? `${prefix}>` : `${prefix}.>`;
      const iter = await natsKv.keys(filter);
      const out: Array<[string, Record<string, unknown>]> = [];
      for await (const key of iter) {
        if (!key.startsWith(prefix)) continue;
        const entry = await natsKv.get(key);
        if (!entry) continue;
        try {
          out.push([key, JSON.parse(dec.decode(entry.value))]);
        } catch { /* skip */ }
      }
      return out;
    },
  };
  _kvStore = ks;
  return _kvStore;
}

/**
 * Seam over the handle registry, in the shape `events/consumer.ts` uses for the
 * tombstone bucket and for the same reason: `handleMap()` closes over the
 * module-scoped NATS KV, which is a live binding on a frozen module namespace
 * and so cannot be substituted. A plain object can be, and every registry call
 * on the teardown path goes through these two methods, which is what makes the
 * outcomes below testable without a NATS server.
 */
export const handleRegistry = {
  destroy(dagRootTaskId: string, handleName: string): Promise<string | null> {
    return handleMap().destroy(dagRootTaskId, handleName);
  },
  listForDag(dagRootTaskId: string): Promise<Record<string, HandleInfo>> {
    return handleMap().listForDag(dagRootTaskId);
  },
  listAll(): Promise<Array<[string, Record<string, HandleInfo>]>> {
    return handleMap().listAll();
  },
};

/** KV key holding the handles of one DAG whose release was never established. */
function unreleasedKey(dagRootTaskId: string): string {
  return `${UNRELEASED_PREFIX}.${dagRootTaskId}`;
}

/**
 * The record that survives a teardown, so a later call can tell "this DAG never
 * held anything" from "this DAG held something and letting go of it failed".
 *
 * Without it the second cancel of a DAG whose stop failed reads an empty handle
 * map -- emptied by the first cancel, before that stop was even attempted --
 * and reports `nothing_held`, which is the very inference this feature exists to
 * refuse, arriving through the back door. The same hole is reachable whenever
 * anything else got to the handles first: a concurrent cancel, the agent_done
 * path, or the sweeper.
 *
 * It is written only on the unhappy path, cleared as soon as a release for that
 * handle is established, and read only when the handle map has nothing to say.
 * A DAG whose handles were all released confirmed therefore leaves nothing
 * behind and answers `nothing_held` on a repeat call, which is accurate: nothing
 * is held and nothing escaped.
 */
export const unreleasedRecord = {
  async mark(dagRootTaskId: string, handleName: string, workloadId: string): Promise<void> {
    const k = unreleasedKey(dagRootTaskId);
    const existing = (await kvStore().get(k)) ?? {};
    existing[handleName] = { workload_id: workloadId, at: new Date().toISOString() };
    await kvStore().put(k, existing);
  },
  async clear(dagRootTaskId: string, handleName: string): Promise<void> {
    const k = unreleasedKey(dagRootTaskId);
    const existing = await kvStore().get(k);
    if (!existing || !(handleName in existing)) return;
    delete existing[handleName];
    if (Object.keys(existing).length === 0) await kvStore().delete(k);
    else await kvStore().put(k, existing);
  },
  async any(dagRootTaskId: string): Promise<boolean> {
    const existing = await kvStore().get(unreleasedKey(dagRootTaskId));
    return !!existing && Object.keys(existing).length > 0;
  },
};

/**
 * What a caller is entitled to believe about a sandbox after a teardown ran.
 *
 * The three values are deliberately not a boolean. "the stop failed" and "there
 * was never anything to stop" have the same shape -- nothing is running for this
 * task now -- but opposite meanings for whoever is counting leaked GPUs, and a
 * caller that cannot tell them apart is back where it started.
 *
 *   - `confirmed`   every handle held is established to be gone. Not merely
 *                   accepted -- see `safeStopWorkload` for why a 2xx from
 *                   SaFE's stop is not that.
 *   - `unconfirmed` at least one handle's release was not established: a
 *                   non-2xx, a timeout, an unset `SAFE_API_URL`, a registry
 *                   that could not be read, a teardown still in flight, or a
 *                   handle this path cannot stop at all.
 *   - `nothing_held` this DAG holds no handle and none is on record as having
 *                   escaped release. Nothing was leaked.
 *
 * `nothing_held` is deliberately NOT "the handle map is empty". The map is
 * emptied before the stop is attempted, so emptiness alone is consistent with a
 * release that failed on an earlier call; `unreleasedRecord` below is what keeps
 * those apart across calls.
 *
 * `unconfirmed` is the conservative answer and every uncertain case collapses
 * into it; it never means "definitely still running", only "not established".
 */
export type ReleaseOutcome = "confirmed" | "unconfirmed" | "nothing_held";

/**
 * Whether SaFE still knows this workload, asked after a stop was accepted.
 *
 * `false` only for a 404/410, which is the one answer that means the object is
 * gone. Every other outcome -- a 200, a 5xx, a timeout, an unreadable response
 * -- is `true` in the sense that matters here: this side did not establish the
 * workload's absence. The caller reports `unconfirmed` for all of them.
 */
async function safeWorkloadStillPresent(
  workloadId: string,
  platformKey: string,
): Promise<boolean> {
  try {
    const resp = await fetch(`${SAFE_API_URL}/api/v1/workloads/${workloadId}`, {
      headers: platformKey ? { Authorization: `Bearer ${platformKey}` } : {},
      signal: AbortSignal.timeout(SAFE_READ_TIMEOUT_MS),
    });
    return !(resp.status === 404 || resp.status === 410);
  } catch (e) {
    logger.warn({ workloadId, err: (e as Error).message }, "safe.release_read_exception");
    return true;
  }
}

/**
 * Stop one SaFE workload and say whether the workload is actually gone.
 *
 * Every branch that used to `return` after a `logger.warn` now answers
 * `unconfirmed` instead, which is the first half of the point: the logging was
 * already correct, it just went somewhere no caller could read. Failure is
 * still not thrown -- cleanup must not fail the cancellation that triggered it.
 *
 * The second half is that **a 2xx from the stop is not a release.** SaFE's
 * `stopWorkload` sets the Workload's phase and issues a Kubernetes delete, then
 * returns; the data-plane objects are torn down afterwards by the job-manager's
 * reconcile loop, which requeues every 10s for as long as any remain and only
 * then drops `WorkloadFinalizer`. So a 200 and a Pod still holding a GPU
 * coexist on any normal controller latency, and persist on a controller that is
 * stuck. Reporting that as `confirmed` would re-tell the exact lie this field
 * was added to stop telling, one layer further in.
 *
 * That same finalizer is what makes the truth cheap to read: the Workload
 * survives in etcd until the teardown finishes, so one GET separates "gone"
 * from "still going". This waits for no teardown -- it reads once and answers
 * `unconfirmed` if the object is still there, because at that instant it is.
 *
 * A 404 from the stop itself is `confirmed` without a second call: SaFE does
 * not know the workload, which is the state the stop was reaching for.
 */
async function safeStopWorkload(
  workloadId: string,
  platformKey: string,
): Promise<ReleaseOutcome> {
  // Defensive, and no longer the only guard: stopSandboxByHandle answers the
  // empty-workload-id case before reaching here, because it is the one caller
  // that can tell an unstoppable handle from an absent one. Kept so a future
  // caller cannot turn "no id to call with" into a silent success.
  if (!workloadId) return "unconfirmed";
  if (!SAFE_API_URL) {
    logger.warn({ workloadId }, "safe.stop_skipped_no_url");
    return "unconfirmed";
  }
  try {
    const resp = await fetch(`${SAFE_API_URL}/api/v1/workloads/${workloadId}/stop`, {
      method: "POST",
      headers: platformKey ? { Authorization: `Bearer ${platformKey}` } : {},
      signal: AbortSignal.timeout(SAFE_STOP_TIMEOUT_MS),
    });
    if (resp.status === 404) return "confirmed";
    if (!resp.ok) {
      const body = await resp.text();
      logger.warn({ workloadId, status: resp.status, body: body.slice(0, 200) }, "safe.stop_failed");
      return "unconfirmed";
    }
  } catch (e) {
    logger.warn({ workloadId, err: (e as Error).message }, "safe.stop_exception");
    return "unconfirmed";
  }
  if (await safeWorkloadStillPresent(workloadId, platformKey)) {
    logger.warn({ workloadId }, "safe.stop_accepted_but_not_released");
    return "unconfirmed";
  }
  return "confirmed";
}

async function loadPlatformKeyForSession(sessionId: string): Promise<string> {
  const r = await db.query(`SELECT config FROM claw_sessions WHERE session_id = $1`, [sessionId]);
  if (r.rowCount === 0) return "";
  return readTrustedSessionCredentials(r.rows[0].config).platformKey;
}

/**
 * Destroy one handle's mapping and stop the workload behind it, reporting
 * which of the two actually happened.
 *
 * The ordering below is load-bearing and is the reason this function has to
 * return anything at all: `destroy` runs FIRST and the stop may then fail, so
 * after this returns the handle map is empty either way. **An empty handle map
 * is evidence the attempt was made, not that it worked** -- nothing downstream
 * may infer release from it, which is why an outcome short of `confirmed` is
 * also written to `unreleasedRecord` before it is returned. The return value
 * answers this call; the record answers the next one.
 *
 * `destroy` distinguishes two falsy results and so does this:
 *   - `null`  -- no handle of that name was registered: `nothing_held`.
 *   - `""`    -- a handle was registered with no SaFE workload id behind it.
 *                agent-sandbox handles are written this way (see Brain's
 *                ensureHands), and this path has never had a way to stop one.
 *                Something is held and this code did not release it, so the
 *                honest answer is `unconfirmed`, not `nothing_held`.
 *
 * Nothing thrown from here escapes. A registry that will not answer, a session
 * whose credentials cannot be read, a KV write that fails -- each is a reason
 * this call established nothing, which is what `unconfirmed` says, and none is
 * a reason to abandon the remaining handles or to fail a cancellation whose
 * verdict is already written. That containment lives here rather than at the
 * caller so every entry point gets it: the cancel route, the agent_done path,
 * and the sweeper.
 */
export async function stopSandboxByHandle(
  dagRootTaskId: string,
  handleName: string,
  sessionId: string,
): Promise<ReleaseOutcome> {
  let wid: string | null;
  try {
    wid = await handleRegistry.destroy(dagRootTaskId, handleName);
  } catch (e) {
    // The mapping may or may not have been removed and the stop was never
    // attempted, so this says nothing about the workload either way.
    logger.warn(
      { dagRootTaskId, handleName, err: (e as Error).message },
      "sandbox.handle_destroy_failed",
    );
    return "unconfirmed";
  }
  if (wid === null) return "nothing_held";
  if (wid === "") {
    logger.warn({ dagRootTaskId, handleName }, "sandbox.stop_unsupported_handle");
    await rememberOutcome(dagRootTaskId, handleName, "", "unconfirmed");
    return "unconfirmed";
  }

  let released: ReleaseOutcome;
  try {
    const platformKey = await loadPlatformKeyForSession(sessionId);
    released = await safeStopWorkload(wid, platformKey);
  } catch (e) {
    // Reaching the credentials is part of issuing the stop; failing to is a
    // stop that did not happen, not an error for the cancel to raise.
    logger.warn(
      { dagRootTaskId, handleName, workloadId: wid, err: (e as Error).message },
      "sandbox.stop_precondition_failed",
    );
    released = "unconfirmed";
  }

  logger.info({ dagRootTaskId, handleName, workloadId: wid, released }, "sandbox.destroyed");
  await rememberOutcome(dagRootTaskId, handleName, wid, released);
  return released;
}

/**
 * Keep or drop this handle's entry in the record, without letting the
 * bookkeeping decide the answer.
 *
 * A failed write is logged and swallowed deliberately. The outcome it was
 * about is already established and already being returned to this caller; all
 * that is lost is the next caller's ability to see it, and turning that into an
 * exception would throw away the answer this call did get.
 */
async function rememberOutcome(
  dagRootTaskId: string,
  handleName: string,
  workloadId: string,
  released: ReleaseOutcome,
): Promise<void> {
  try {
    if (released === "confirmed") await unreleasedRecord.clear(dagRootTaskId, handleName);
    else await unreleasedRecord.mark(dagRootTaskId, handleName, workloadId);
  } catch (e) {
    logger.warn(
      { dagRootTaskId, handleName, released, err: (e as Error).message },
      "sandbox.unreleased_record_write_failed",
    );
  }
}

/**
 * Tear down every handle currently registered for the given DAG and aggregate
 * what that established.
 *
 * `confirmed` requires every handle to be confirmed, so one failing stop in a
 * DAG of many cannot be averaged away by its neighbours. A per-handle
 * `nothing_held` inside a DAG that did hold handles is also not confirmation:
 * it means the entry vanished between the snapshot and the destroy, so some
 * other destroyer took it and this call cannot vouch for what that one did.
 *
 * An empty snapshot is the case that needs the record rather than the map. It
 * is reached by a DAG that never held a handle and by one whose handles some
 * earlier call already removed -- including a first cancel whose stop failed --
 * and the map cannot tell those apart by construction. So `nothing_held` is
 * answered only when the record also has nothing outstanding, and a registry
 * that cannot be read answers neither.
 */
export async function stopAllHandlesForDag(
  dagRootTaskId: string,
  sessionId: string,
): Promise<ReleaseOutcome> {
  let handles: string[];
  try {
    handles = Object.keys(await handleRegistry.listForDag(dagRootTaskId));
  } catch (e) {
    logger.warn(
      { dagRootTaskId, err: (e as Error).message },
      "sandbox.handle_list_failed",
    );
    return "unconfirmed";
  }

  if (handles.length === 0) {
    try {
      return (await unreleasedRecord.any(dagRootTaskId)) ? "unconfirmed" : "nothing_held";
    } catch (e) {
      logger.warn(
        { dagRootTaskId, err: (e as Error).message },
        "sandbox.unreleased_record_read_failed",
      );
      return "unconfirmed";
    }
  }

  let allConfirmed = true;
  for (const handle of handles) {
    const released = await stopSandboxByHandle(dagRootTaskId, handle, sessionId);
    if (released !== "confirmed") allConfirmed = false;
  }
  return allConfirmed ? "confirmed" : "unconfirmed";
}
