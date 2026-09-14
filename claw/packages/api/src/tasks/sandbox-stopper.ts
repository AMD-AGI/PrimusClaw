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
import { createHash } from "node:crypto";
import pino from "pino";
import { readTrustedSessionCredentials } from "../auth/session-credentials.js";
import { SAFE_API_URL } from "../config.js";
import { kvDagHandles } from "../infra/nats.js";
import { db } from "../infra/db.js";

const logger = pino({ name: "sandbox-stopper" });

/** Unchanged from before this file reported outcomes. */
const SAFE_STOP_TIMEOUT_MS = 15_000;

/**
 * A rejection is not required to be an `Error`, and every catch on this path
 * exists to keep a cancellation alive -- so reading `.message` off whatever
 * arrived, and throwing a TypeError out of the handler when it was `undefined`,
 * would defeat the containment at exactly the moment it is needed.
 */
function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

let _handleMap: DagHandleMap | null = null;

/** The part of the NATS KV surface this adapter uses. */
export interface KvLike {
  get(key: string): Promise<{ operation?: string; value: Uint8Array } | null>;
  put(key: string, value: Uint8Array): Promise<unknown>;
  delete(key: string): Promise<unknown>;
  keys(filter: string): Promise<AsyncIterable<string>>;
}

/** Build the DagHandleMap on demand using the existing NATS KV bucket. */
function handleMap(): DagHandleMap {
  _handleMap ??= new DagHandleMap(makeKvStore(kvDagHandles as unknown as KvLike));
  return _handleMap;
}

/**
 * Adapt a NATS KV bucket into the KVStore interface DagHandleMap expects,
 * using the same encoding contract Brain writes handle entries with: a JSON
 * object payload.
 *
 * Takes the bucket rather than closing over the module's own, because what it
 * decides -- which answers mean "absent", which mean "unknown" -- is now load
 * bearing for whether a DAG can be reported as holding nothing, and that
 * decision deserves to be exercised directly rather than only through a NATS
 * server.
 */
export function makeKvStore(kv: KvLike): KVStore {
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  return {
    // `null` means the key is not there. It used to also mean "the read
    // threw", which the teardown path below now has to be able to tell apart:
    // a bucket that cannot be read says nothing about what a DAG holds, and
    // classifying that as "holds nothing" is how an unreadable registry turns
    // into a confident `nothing_held` while a workload keeps its GPU. A
    // corrupt payload is the same kind of unknown, so it throws rather than
    // reading as absent. Callers that genuinely do not care still get one --
    // the sweeper tick already contains its sweeps.
    async get(key) {
      const entry = await kv.get(key);
      if (!entry) return null;
      // A deleted key is not an absent one to `kv.get`: it answers with the
      // tombstone, whose value is empty. The client filters DEL/PURGE on its
      // watch paths and deliberately not here, so this is where "deleted" has
      // to become "absent" -- and above all must not become "corrupt", which is
      // what an empty body parses as now that a parse failure throws. Every
      // handle this module destroys leaves one of these behind, so getting it
      // wrong would report a clean teardown as unreadable.
      if (entry.operation === "DEL" || entry.operation === "PURGE") return null;
      if (entry.value.length === 0) return null;
      let parsed: unknown;
      try {
        parsed = JSON.parse(dec.decode(entry.value));
      } catch (e) {
        throw new Error(`handle map entry ${key} is not readable JSON: ${errText(e)}`);
      }
      // `JSON.parse` is happy with `null`, `false` and `7`, and the cast that
      // used to follow it was happy with all three. `DagHandleMap` then reads
      // them as a DAG holding no handles -- an unknown wearing the one answer
      // that must never be invented. Shape is as much of the contract as syntax.
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`handle map entry ${key} is not a JSON object`);
      }
      return parsed as Record<string, unknown>;
    },
    async put(key, value) {
      await kv.put(key, enc.encode(JSON.stringify(value)));
    },
    async delete(key) {
      await kv.delete(key);
    },
    async scanPrefix(prefix) {
      const filter = prefix.endsWith(".") ? `${prefix}>` : `${prefix}.>`;
      const iter = await kv.keys(filter);
      const out: Array<[string, Record<string, unknown>]> = [];
      for await (const key of iter) {
        if (!key.startsWith(prefix)) continue;
        // Same three answers as `get`, and for the same reasons: a tombstone or
        // an empty value is a key that is gone, while an entry that will not
        // parse is an unknown. A scan that silently skipped the last of those
        // would hand the sweeper a short list of DAGs and call it complete.
        const entry = await kv.get(key);
        if (!entry) continue;
        if (entry.operation === "DEL" || entry.operation === "PURGE") continue;
        if (entry.value.length === 0) continue;
        out.push([key, JSON.parse(dec.decode(entry.value)) as Record<string, unknown>]);
      }
      return out;
    },
  };
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
  lookup(dagRootTaskId: string, handleName: string): Promise<HandleInfo | null> {
    return handleMap().lookup(dagRootTaskId, handleName);
  },
  listForDag(dagRootTaskId: string): Promise<Record<string, HandleInfo>> {
    return handleMap().listForDag(dagRootTaskId);
  },
  listAll(): Promise<Array<[string, Record<string, HandleInfo>]>> {
    return handleMap().listAll();
  },
};

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
 * **It lives on the DAG root's `metadata`, not in the KV bucket beside the
 * handle map**, for three reasons that all point the same way:
 *
 *   - Lifetime. `BRAIN_REGISTRY` is short-lived coordination state with a
 *     bucket-wide TTL (`BRAIN_REGISTRY_TTL_MS`, five minutes by default, sized
 *     for `lock.<key>`). A leaked GPU outlives five minutes; evidence of one
 *     that expires on that schedule is evidence only for as long as nobody was
 *     going to look.
 *   - Concurrency. A JSON blob under one KV key is read-modify-write, and the
 *     adapter's `put` carries no revision, so two cancels racing lose a mark
 *     and the lost one is a workload reported as released. Each write here is
 *     one statement, atomic on the row, and merges rather than replaces.
 *   - Reach. `publicTaskRow` strips only the three credential fields, so
 *     anything on `metadata` is already readable through `GET /v1/tasks/:taskId`
 *     -- the caller can see *which* handle was not released and what workload it
 *     was, which is the part a `released: "unconfirmed"` alone cannot say.
 *
 * Written only on the unhappy path, cleared as soon as a release for that
 * handle is established, and read only when the handle map has nothing to say.
 * A DAG whose handles were all released confirmed therefore leaves nothing
 * behind and answers `nothing_held` on a repeat call, which is accurate:
 * nothing is held and nothing escaped.
 */
/**
 * The key one outstanding entry is filed under: a digest, not a readable name.
 *
 * Two requirements meet here and only a digest satisfies both.
 *
 * Identity. A handle name is reused -- a rebuild registers a second workload
 * under the same name -- so keying by name alone lets one workload's outcome
 * overwrite or clear another's. An older stop succeeding and clearing a newer
 * one's failure is a confirmed release invented out of two unrelated events.
 * The key has to name the workload, not just the handle.
 *
 * Redaction. The record's whole point is to be readable through
 * `GET /v1/tasks/:taskId`, and `redactPublicJson` replaces the value under any
 * key that *contains a sensitive word* -- `isSensitiveKey` splits the key into
 * words and matches each. Handle names are chosen by whoever wrote the DAG, so
 * a DAG may legitimately declare one called `token` or `auth`, and any key
 * carrying that name as a word -- `token`, `w-1:token`, `handle_token` alike --
 * comes back `"[REDACTED]"`, taking the workload id with it. The caller is left
 * knowing a sandbox leaked and not which one, which is the half that mattered.
 *
 * So the key is `sha256(handle \0 workload)`, truncated: stable, unique per
 * workload instance, and made only of hex, which cannot spell any word the
 * redactor looks for. Both names live in the VALUE, where they are data --
 * `handle` and `workload_id` are not sensitive keys, which U8 pins.
 */
function entryKey(handleName: string, workloadId: string): string {
  return createHash("sha256")
    .update(`${handleName}\u0000${workloadId}`)
    .digest("hex")
    .slice(0, 16);
}

export const unreleasedRecord = {
  async mark(dagRootTaskId: string, handleName: string, workloadId: string): Promise<void> {
    // One statement, so two cancels racing cannot lose each other's mark the
    // way a read-then-write pair would. `||` merges at each level, so a sibling
    // key written between this statement's read and its write survives.
    await db.query(
      `UPDATE claw_tasks
          SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                'sandbox_release',
                COALESCE(metadata -> 'sandbox_release', '{}'::jsonb) || jsonb_build_object(
                  'unreleased',
                  COALESCE(metadata -> 'sandbox_release' -> 'unreleased', '{}'::jsonb)
                    || jsonb_build_object($2::text, $3::jsonb)
                ))
        WHERE task_id = $1 AND dag_node_id = '__dag_root__'`,
      [
        dagRootTaskId,
        entryKey(handleName, workloadId),
        JSON.stringify({
          handle: handleName,
          workload_id: workloadId,
          at: new Date().toISOString(),
        }),
      ],
    );
  },
  async clear(dagRootTaskId: string, handleName: string, workloadId: string): Promise<void> {
    await db.query(
      `UPDATE claw_tasks
          SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                'sandbox_release',
                COALESCE(metadata -> 'sandbox_release', '{}'::jsonb) || jsonb_build_object(
                  'unreleased',
                  COALESCE(metadata -> 'sandbox_release' -> 'unreleased', '{}'::jsonb) - $2::text
                ))
        WHERE task_id = $1 AND dag_node_id = '__dag_root__'`,
      [dagRootTaskId, entryKey(handleName, workloadId)],
    );
  },
  async any(dagRootTaskId: string): Promise<boolean> {
    const r = await db.query(
      `SELECT COALESCE(metadata -> 'sandbox_release' -> 'unreleased', '{}'::jsonb)
                <> '{}'::jsonb AS outstanding
         FROM claw_tasks WHERE task_id = $1 AND dag_node_id = '__dag_root__'`,
      [dagRootTaskId],
    );
    // No root row is not "nothing outstanding": the row a mark would have been
    // written to is not there to be read, so this establishes nothing. The
    // caller turns that into `unconfirmed`, as it does every other unknown.
    if (r.rowCount === 0) throw new Error(`no dag root row for ${dagRootTaskId}`);
    return r.rows[0].outstanding === true;
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
 *   - `confirmed`   SaFE accepted the stop for every handle held (2xx, or a
 *                   404 saying it does not know the workload). Read
 *                   `safeStopWorkload` before leaning on this: SaFE's teardown
 *                   is asynchronous, so accepted is the strongest thing its API
 *                   can be asked, and it is weaker than "the GPU is free".
 *   - `unconfirmed` at least one handle's release was not established: a
 *                   non-2xx, a timeout, an unset `SAFE_API_URL`, a registry
 *                   that could not be read, or a handle this path cannot stop
 *                   at all.
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
 * Stop one SaFE workload and say whether SaFE accepted the stop.
 *
 * Every branch that used to `return` after a `logger.warn` now answers
 * `unconfirmed` instead, which is the point: the logging was already correct,
 * it just went somewhere no caller could read. Failure is still not thrown --
 * cleanup must not fail the cancellation that triggered it.
 *
 * A 404 counts as `confirmed`. SaFE does not know the workload, which is the
 * state the stop was reaching for.
 *
 * ## What `confirmed` does and does not establish
 *
 * It establishes that SaFE accepted the stop, which is the strongest thing this
 * API can be asked. It does NOT establish that the GPU is free at that instant,
 * and the difference is real rather than pedantic: `stopWorkload` sets the
 * Workload's phase and issues a Kubernetes delete, then returns, while the
 * job-manager tears the data-plane objects down afterwards -- requeuing every
 * 10s for as long as any remain and only then dropping `WorkloadFinalizer`. So
 * a 200 and a Pod still holding a GPU coexist on any normal controller latency.
 *
 * A round of review tried to close that gap here, by following an accepted stop
 * with a `GET /api/v1/workloads/<id>` and confirming only on a 404. That does
 * not work, and the reason is recorded so it is not tried again: the
 * apiserver's read is **database-backed**, not etcd-backed. `GetWorkload`
 * filters on `is_deleted = false`, and the stop path writes
 * `SetWorkloadStopped` -- phase, end_time, deletion_time -- and never
 * `is_deleted`. The read therefore answers 200 for a workload that stopped
 * perfectly normally, so wiring it in would have reported `unconfirmed` for
 * every successful cancellation in the fleet. A field that cries wolf
 * constantly is worse than the silence it replaces: the one real failure
 * becomes indistinguishable from the noise.
 *
 * The finalizer state that would actually answer the question lives on the CR
 * in etcd and no endpoint Claw can reach exposes it. Closing this properly
 * needs a data-plane-completion signal from SaFE. Until there is one,
 * `confirmed` means accepted, says so wherever it is documented, and the
 * failures it now surfaces -- a refused stop, a timeout, an unreachable SaFE,
 * an unconfigured one -- are exactly the ones that were silently dropped
 * before, which is what this change was asked for.
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
    if (!resp.ok && resp.status !== 404) {
      const body = await resp.text();
      logger.warn({ workloadId, status: resp.status, body: body.slice(0, 200) }, "safe.stop_failed");
      return "unconfirmed";
    }
    return "confirmed";
  } catch (e) {
    logger.warn({ workloadId, err: errText(e) }, "safe.stop_exception");
    return "unconfirmed";
  }
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
  // Read before destroying, and record before destroying, because `destroy` is
  // the point of no return: it drops the mapping, and anything not written
  // down by then cannot be recovered from anywhere. Between the drop and the
  // first write there used to be a window in which the handle existed in
  // neither place, and a concurrent cancel landing in it read an empty map and
  // an empty record and answered `nothing_held` for a workload still running.
  // A process dying in that window left the same state permanently.
  //
  // The cost is one extra KV read per handle, on a path that is already making
  // an HTTP call to SaFE. The lookup failing is itself an unknown: it may mean
  // no such handle, and it may mean an unreachable bucket, so it does not get
  // to be `nothing_held`.
  let known: HandleInfo | null;
  try {
    known = await handleRegistry.lookup(dagRootTaskId, handleName);
  } catch (e) {
    logger.warn(
      { dagRootTaskId, handleName, err: errText(e) },
      "sandbox.handle_lookup_failed",
    );
    return "unconfirmed";
  }
  if (known === null) return "nothing_held";
  if (!known.workload_id) {
    // agent-sandbox handles are registered with `workload_id: ""` (Brain's
    // ensureHands), and this path has never had a way to stop one. Something
    // IS held and this code cannot release it, so `nothing_held` would assert
    // the opposite of what is true. The mapping is still dropped, as before.
    logger.warn({ dagRootTaskId, handleName }, "sandbox.stop_unsupported_handle");
    await rememberOutcome(dagRootTaskId, handleName, "", "unconfirmed");
    await handleRegistry.destroy(dagRootTaskId, handleName).catch((e) => {
      logger.warn(
        { dagRootTaskId, handleName, err: errText(e) },
        "sandbox.handle_destroy_failed",
      );
    });
    return "unconfirmed";
  }

  // On record first, so the window below is one this can be recovered from
  // rather than one that loses the handle. Cleared by a release that lands.
  await rememberOutcome(dagRootTaskId, handleName, known.workload_id, "unconfirmed");

  let wid: string | null;
  try {
    wid = await handleRegistry.destroy(dagRootTaskId, handleName);
  } catch (e) {
    // The delete may or may not have committed, and the stop was not attempted
    // either way. Both possibilities are already on record above, which is the
    // point of writing it first.
    logger.warn(
      { dagRootTaskId, handleName, workloadId: known.workload_id, err: errText(e) },
      "sandbox.handle_destroy_failed",
    );
    return "unconfirmed";
  }
  // Someone else destroyed it between the lookup and here. They own whatever
  // they did with it; this call established nothing, and the entry recorded
  // above keeps the DAG from reading the gap as `nothing_held`.
  if (wid === null) return "unconfirmed";

  let released: ReleaseOutcome;
  try {
    const platformKey = await loadPlatformKeyForSession(sessionId);
    released = await safeStopWorkload(wid, platformKey);
  } catch (e) {
    // Reaching the credentials is part of issuing the stop; failing to is a
    // stop that did not happen, not an error for the cancel to raise.
    logger.warn(
      { dagRootTaskId, handleName, workloadId: wid, err: errText(e) },
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
    // Cleared by identity: this release confirms THIS workload, and says
    // nothing about another one a rebuild registered under the same name.
    if (released === "confirmed") {
      await unreleasedRecord.clear(dagRootTaskId, handleName, workloadId);
    } else {
      await unreleasedRecord.mark(dagRootTaskId, handleName, workloadId);
    }
  } catch (e) {
    // Swallowed, and not a silent loss of evidence: this record lives on
    // `claw_tasks`, and a database that cannot take this write is one that
    // could not take the cancellation's own verdict either -- that write
    // happens first and throws, so the request fails loudly long before it
    // reaches here. What is left for this catch is the narrow case of a write
    // that fails on its own, where the outcome is still returned to this
    // caller and only the next caller's view of it is lost.
    //
    // `workloadId` deliberately: this warning is the only trace of a handle
    // whose record was not written, and without the id an operator has to
    // correlate it against a separate `sandbox.destroyed` line to learn which
    // workload to go and look for.
    logger.warn(
      { dagRootTaskId, handleName, workloadId, released, err: errText(e) },
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
      { dagRootTaskId, err: errText(e) },
      "sandbox.handle_list_failed",
    );
    return "unconfirmed";
  }

  if (handles.length === 0) {
    try {
      return (await unreleasedRecord.any(dagRootTaskId)) ? "unconfirmed" : "nothing_held";
    } catch (e) {
      logger.warn(
        { dagRootTaskId, err: errText(e) },
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
  if (!allConfirmed) return "unconfirmed";

  // Confirming this call's own loop is not confirming the DAG. The snapshot
  // above is of the handles still registered *now*, and a handle that leaked
  // earlier is no longer among them: the agent_done path tears down a handle as
  // soon as its last user finishes, and the sweeper and a concurrent cancel
  // both reach the same handles by other routes. Each of those removes the
  // mapping and leaves its failure only in the record, so a later cancel that
  // released everything it could see would otherwise report `confirmed` over
  // the top of a workload nobody released.
  try {
    return (await unreleasedRecord.any(dagRootTaskId)) ? "unconfirmed" : "confirmed";
  } catch (e) {
    logger.warn(
      { dagRootTaskId, err: errText(e) },
      "sandbox.unreleased_record_read_failed",
    );
    return "unconfirmed";
  }
}
