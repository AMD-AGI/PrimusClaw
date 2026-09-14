// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Brain-side wrapper around `@claw/utils` DagHandleMap (task-design.md §9.4).
 *
 * Two callers:
 *
 *   - sandbox.create with `handle`: after a successful SaFE workload create,
 *     `replaceDagHandle(...)` writes the handle info so downstream DAG
 *     nodes can `sandbox.use` it.
 *   - sandbox.use: `lookupDagHandle(...)` returns the cached HandleInfo so
 *     Brain can short-circuit ensureHands and immediately build a
 *     HandsClient against the existing workload.
 *
 * Both reads and writes go through the same `DAG_HANDLES` NATS JetStream
 * KV bucket so every Brain pod sees the same view. Sandbox-stopper (in
 * Backend) writes to the same bucket via the api-side wrapper.
 */
import type { JetStreamClient, KV } from "nats";
import { StringCodec } from "nats";
import {
  DagHandleMap, HANDLE_MAP_PREFIX, getHandleEntry, setHandleEntry, type HandleInfo,
} from "@claw/protocol";
import { natsKvStore, type NatsLikeKv } from "@claw/utils";
import { DAG_HANDLES_REPLICAS } from "../config.js";
import pino from "pino";

const logger = pino({ name: "dag-handles" });
const sc = StringCodec();

const BUCKET = "DAG_HANDLES";

let _kvBucket: KV | null = null;
let _map: DagHandleMap | null = null;

/** Bind to the JetStream KV bucket. Idempotent. */
export async function initDagHandles(js: JetStreamClient): Promise<DagHandleMap> {
  if (_map) return _map;
  // No TTL by default: DAG handles live as long as their owning DAG, which
  // can be hours for long-running KA evaluations. Sweeper destroys orphans.
  //
  // The replica count has to be passed on this first call, because that is the
  // only one that creates anything: `views.kv` on a bucket that already exists
  // attaches to it and ignores the options, so a bucket first opened without
  // them keeps the JetStream default of one replica until something corrects
  // it. Correcting that drift is api's job -- it is the side that implements
  // the reconcile, and this function is handed a JetStreamClient alone. api
  // reconciles this bucket now; it did not when this comment was written,
  // which is why it used to say "for the life of the cluster". See
  // `ensureKvBucket`.
  _kvBucket = await js.views.kv(BUCKET, { replicas: DAG_HANDLES_REPLICAS });
  const adapter: NatsLikeKv = {
    async get(key) {
      const entry = await _kvBucket!.get(key);
      if (!entry) return null;
      return { value: entry.value };
    },
    async put(key, value) {
      return _kvBucket!.put(key, value);
    },
    async delete(key) {
      return _kvBucket!.delete(key);
    },
    async keys(filter) {
      return _kvBucket!.keys(filter);
    },
  };
  _map = new DagHandleMap(natsKvStore(adapter));
  logger.info({ bucket: BUCKET }, "dag-handles.bound");
  return _map;
}

/**
 * Bind a stand-in bucket; returns the call that puts the real one back.
 *
 * Only the two reads `isValidDagHandleToken` makes, because binding the whole
 * bucket means standing up JetStream, and the thing worth testing is how a
 * handle row is read -- which is exactly where it was wrong.
 */
export function bindDagHandleKvForTest(
  stub: Pick<KV, "keys" | "get">,
): () => void {
  const prev = _kvBucket;
  _kvBucket = stub as KV;
  return () => { _kvBucket = prev; };
}

function getMap(): DagHandleMap {
  if (!_map) throw new Error("dag-handles.not_initialized -- call initDagHandles(js) at boot");
  return _map;
}

export async function lookupDagHandle(
  dagRootTaskId: string,
  handleName: string,
): Promise<HandleInfo | null> {
  return await getMap().lookup(dagRootTaskId, handleName);
}

/** How many times a registration re-reads a row that moved under it. */
const REGISTER_CAS_ATTEMPTS = 5;

/** How many displaced workloads one handle carries before the oldest is dropped. */
const SUPERSEDED_LIMIT = 8;

/**
 * Point an existing handle at a different workload, or create it if absent.
 *
 * `DagHandleMap.create` refuses a name that already maps elsewhere so a
 * mistaken double-create cannot silently lose a reference. That is the wrong
 * answer at the two moments a handle legitimately changes hands -- a rebuild,
 * where the previous workload has already been stopped, and a session reuse,
 * where a DAG adopts a sandbox another task created. Both were reaching for
 * `create`, being rejected, and having the rejection swallowed by the caller,
 * so the map named a stopped workload or nothing at all while a live sandbox
 * ran unreferenced.
 *
 * Written here against the bucket rather than through `DagHandleMap`, for the
 * reason Backend's `destroyHandleCas` is: the map's writes carry no revision,
 * and Backend now removes handles under a revision-conditional write. A plain
 * read-modify-write from this side resurrects an entry Backend has just
 * removed -- reviving a reference to a workload that was stopped, or undoing
 * the removal of one that was not -- so the two writers have to agree on the
 * same row version. Conflicts re-read and retry.
 *
 * It moves the name and frees nothing: the rebuild path has already stopped
 * the old workload, and the reuse path must not stop a sandbox it is adopting.
 *
 * **It throws when it cannot commit -- a refused write, an unreadable row, an
 * unparseable one -- and callers must not swallow that.** A
 * registration is the record that makes a sandbox findable and stoppable, so a
 * turn that cannot write one is holding a workload nothing can account for:
 * Backend's teardown finds no handle, reports the DAG holds nothing, and stops
 * nothing. Failing the turn is loud and recoverable; succeeding with an
 * unregistered sandbox is neither.
 *
 * What that does NOT add is a turn failing because the map was never bound:
 * `initDagHandles` is awaited unqualified in `index.ts` boot and nothing
 * catches it, so a process that is serving has a bound map by construction and
 * `not_initialized` is reachable only from a test. The failures this newly
 * surfaces are writes that were genuinely refused -- which is the trade being
 * made on purpose, and the only one.
 */
export async function replaceDagHandle(
  dagRootTaskId: string,
  handleName: string,
  info: HandleInfo,
): Promise<void> {
  const kv = _kvBucket;
  if (!kv) throw new Error("dag-handles.not_initialized -- call initDagHandles(js) at boot");
  const key = `${HANDLE_MAP_PREFIX}.${dagRootTaskId}`;
  const dec = new TextDecoder();
  const enc = new TextEncoder();

  for (let attempt = 0; attempt < REGISTER_CAS_ATTEMPTS; attempt += 1) {
    const entry = await kv.get(key);
    // Two different questions, and conflating them wedges the write. "Is there
    // a row to build on" governs what gets parsed; "does the key exist" governs
    // whether the write may be a `create`. They come apart for an entry that is
    // present with an empty value: there is nothing to build on, but the key is
    // there, so `create` is refused for as long as it is retried and the
    // registration fails against a row it could perfectly well have updated.
    // A DEL/PURGE tombstone is the opposite case -- no key to collide with, so
    // `create` is right, which is what the client itself does over a tombstone.
    const tombstoned = !!entry
      && (entry.operation === "DEL" || entry.operation === "PURGE");
    const keyExists = !!entry && !tombstoned;
    const emptyRow = !entry || tombstoned || entry.value.length === 0;

    let row: Record<string, unknown> = {};
    if (!emptyRow) {
      const parsed: unknown = JSON.parse(dec.decode(entry!.value));
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error(`dag-handles row ${key} is not a JSON object`);
      }
      row = parsed as Record<string, unknown>;
    }
    const prevEntry = getHandleEntry(row, handleName) as
      { workload_id?: string; superseded_workload_ids?: string[] } | undefined;
    const previous = prevEntry?.workload_id;
    // Carry forward any workload this name is being taken away from, unless it
    // is the one being written. `create` used to refuse this overwrite exactly
    // so a reference could not be lost, and replacing that refusal with an
    // unconditional write reintroduced the loss: a redelivery whose session
    // entry has expired -- BRAIN_REGISTRY has a TTL, DAG_HANDLES does not --
    // finds the handle still naming a workload that is still running, and
    // overwrites it. Teardown then stops the replacement and reports the DAG
    // released while the original keeps its GPU.
    //
    // Bounded, because this is evidence and not a log: a handle that churns
    // must not grow the row without limit. The oldest are dropped first, and
    // losing the oldest is the least bad thing to lose.
    const carried = [
      ...(prevEntry?.superseded_workload_ids ?? []),
      ...(previous && previous !== info.workload_id ? [previous] : []),
    ].filter((id, i, all) => id && id !== info.workload_id && all.indexOf(id) === i)
      .slice(-SUPERSEDED_LIMIT);
    // One write that sets the key, never a delete followed by a create: an
    // absent handle is how Backend decides a DAG holds no sandbox, so a
    // replacement must not look, even for an instant, like never having had
    // one.
    // Not `row[handleName] = ...`: a handle named `__proto__` would hit the
    // prototype setter, and the row would serialise as `{}` -- a registration
    // that reports success and stores nothing, which Backend reads as a DAG
    // holding no sandbox.
    setHandleEntry(row, handleName, {
      ...info,
      created_at: info.created_at ?? new Date().toISOString(),
      ...(carried.length > 0 ? { superseded_workload_ids: carried } : {}),
    });

    try {
      const payload = enc.encode(JSON.stringify(row));
      if (keyExists) await kv.update(key, payload, entry!.revision);
      else await kv.create(key, payload);
      logger.info(
        {
          dagRootTaskId, handleName, workloadId: info.workload_id,
          previousWorkloadId: previous, supersededWorkloadIds: carried,
        },
        "dag-handles.replaced",
      );
      return;
    } catch (e) {
      if (!isRevisionConflict(e)) throw e;
      logger.info({ dagRootTaskId, handleName, attempt }, "dag-handles.register_retry");
    }
  }
  throw new Error(
    `dag-handles row for ${dagRootTaskId} kept changing under ${REGISTER_CAS_ATTEMPTS} attempts`,
  );
}

/**
 * NATS reports a failed `previousSeq` (and a `create` on an existing key) as a
 * "wrong last sequence" API error. Anything unrecognised is deliberately not
 * treated as a conflict, so a real failure is raised rather than retried into
 * the attempt limit and raised later with worse context.
 */
function isRevisionConflict(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /wrong last sequence|conflict|key exists/i.test(msg);
}

/**
 * Cross-replica validation for a token owned by a DAG sandbox handle.
 *
 * One value holds every handle for a DAG, keyed by handle name -- see
 * DagHandleMap.create, which writes `existing[handleName] = info`. So the token
 * is one level in, and reading it off the top of the value never matched
 * anything: the fallback that exists for a node whose token lives only in the
 * handle map, because a sibling owns `hands.<sessionId>`, always answered no.
 */
export async function isValidDagHandleToken(token: string): Promise<boolean> {
  if (!token || !_kvBucket) return false;
  try {
    const keys = await _kvBucket.keys();
    for await (const key of keys) {
      const entry = await _kvBucket.get(key);
      if (!entry) continue;
      try {
        const row = JSON.parse(sc.decode(entry.value)) as unknown;
        if (!row || typeof row !== "object") continue;
        for (const handle of Object.values(row as Record<string, unknown>)) {
          const candidate = (handle as { token?: unknown } | null)?.token;
          if (typeof candidate === "string" && candidate === token) return true;
        }
      } catch { /* malformed handle — skip */ }
    }
  } catch (err) {
    logger.warn({ err: String(err) }, "dag-handles.token_lookup_failed");
  }
  return false;
}
