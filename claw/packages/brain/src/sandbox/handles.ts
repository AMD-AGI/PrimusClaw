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

/**
 * Ceiling on the handle cleanup that follows a stop.
 *
 * `listAll()` drives an ordered consumer, and the SDK rebuilds and retries it
 * indefinitely when JetStream is unavailable while the core connection stays
 * healthy -- the iterator never ends. This runs inside teardown and inside the
 * pending-write rollback, and a task's own abort does not interrupt an await,
 * so without a ceiling a cleanup can wedge a rebuild or the NAK behind it.
 *
 * Expiring leaves the handle in place, which is the safe direction: the
 * workload is already stopped, so the stale entry costs a refused registration
 * that a later sweep clears, not a lost reference to something live.
 */
const RELEASE_SCAN_TIMEOUT_MS = 10_000;

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
/**
 * Does this DAG hold a handle naming this workload?
 *
 * The authoritative answer to "is this mine to tear down", and a different
 * question from who first wrote the session entry. A task that REUSED another
 * task's sandbox registers its own handle on that workload, and from then on it
 * is as much a holder as the task that created it -- which is the case a check
 * against the entry's original writer gets wrong.
 */
/**
 * The key a handle is compared on.
 *
 * SaFE workloads are named by `workload_id`. An agent-sandbox is not -- it
 * records `workload_id: ""` and carries the Router session id instead -- so
 * comparing on the workload id alone silently matched nothing for those, and
 * an ownership question asked about a Router sandbox got the answer "nobody
 * else holds it" for free.
 */
export function handleIdentityKey(
  info: { workload_id?: string; session_id?: string } | string | null | undefined,
): string | null {
  if (!info) return null;
  // Non-empty by the guard above, so no `|| null` is needed here.
  if (typeof info === "string") return info;
  if (info.workload_id) return info.workload_id;
  return info.session_id ? `sandbox-session:${info.session_id}` : null;
}

/**
 * Does any DAG OTHER than this one hold a handle naming this workload?
 *
 * `dagHoldsWorkload` answers "am I a holder", which is the right question for
 * "may I rebuild it" and the wrong one for "may I destroy it": being a holder
 * does not make you the only one. A DAG that reused another's sandbox holds a
 * handle on it while the creator is still running on it, and permission read
 * off that handle alone stopped a workload somebody was using.
 *
 * Scans, like `releaseHandlesForWorkload`, because the registry is keyed by DAG
 * and the question is keyed by workload -- the reverse index this PR defers.
 * Bounded by the same deadline, and a scan that cannot complete answers YES:
 * the cost of being wrong that way is a refused rebuild, and the cost of being
 * wrong the other way is stopping a live workload.
 */
export async function workloadHeldByOtherDag(
  mineDagRootTaskId: string,
  workloadId: string,
): Promise<boolean> {
  if (!workloadId) return false;
  let timer: NodeJS.Timeout;
  const rows = await Promise.race([
    getMap().listAll().finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`dag-handles holder scan exceeded ${RELEASE_SCAN_TIMEOUT_MS}ms`)),
        RELEASE_SCAN_TIMEOUT_MS,
      );
      timer.unref?.();
    }),
  ]);
  for (const [dagRoot, handles] of rows) {
    if (dagRoot === mineDagRootTaskId) continue;
    for (const info of Object.values(handles)) {
      if (handleIdentityKey(info) === workloadId) return true;
    }
  }
  return false;
}

export async function dagHoldsWorkload(
  dagRootTaskId: string,
  workloadId: string,
): Promise<boolean> {
  const held = await getMap().listForDag(dagRootTaskId);
  return Object.values(held).some((h) => handleIdentityKey(h) === workloadId);
}

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
    // A legacy entry is the bare workload id, which the protocol still
    // accepts. Read as an object it answers `undefined`, and the refusal below
    // then treats the only reference to a live workload as absent -- the exact
    // overwrite this refusal exists to prevent, on the oldest rows.
    const prevRaw = getHandleEntry(row, handleName);
    const previous = typeof prevRaw === "string"
      ? prevRaw
      : (prevRaw as { workload_id?: string } | undefined)?.workload_id;
    // Refuse to take the name from a DIFFERENT workload that is still on
    // record. `create` refused this too, and replacing that refusal with an
    // unconditional write is what let a redelivery -- whose `hands.<session>`
    // expired while this handle, in a bucket with no TTL, kept naming a
    // running workload -- overwrite the only reference to it.
    //
    // A round of review was spent instead carrying the displaced id forward
    // and stopping it at teardown. That mechanism grew five ways to lose the
    // carried id: a silent cap, a CAS retry that dropped it, a pre-destroy
    // record that did not include it, an empty current id that skipped it, and
    // a legacy string entry that never produced one. Refusing is smaller and
    // has no state to lose.
    //
    // The cost is real and is the point: a turn fails rather than silently
    // taking a name from something nobody released, and the map still names
    // the workload, so it stays findable. Whoever legitimately replaces a
    // workload removes its handle when they stop it -- see `runRebuild` --
    // so this refusal is not on the path of an ordinary rebuild.
    if (previous && info.workload_id && previous !== info.workload_id) {
      throw new Error(
        `dag-handle ${handleName} for ${dagRootTaskId} still names ${previous}; `
        + `refusing to point it at ${info.workload_id} before that one is released`,
      );
    }
    // One write that sets the key, never a delete followed by a create: an
    // absent handle is how Backend decides a DAG holds no sandbox, so a
    // replacement must not look, even for an instant, like never having had
    // one.
    // Not `row[handleName] = ...`: a handle named `__proto__` would hit the
    // prototype setter, and the row would serialise as `{}` -- a registration
    // that reports success and stores nothing, which Backend reads as a DAG
    // holding no sandbox.
    setHandleEntry(row, handleName, {
      ...info, created_at: info.created_at ?? new Date().toISOString(),
    });

    try {
      const payload = enc.encode(JSON.stringify(row));
      if (keyExists) await kv.update(key, payload, entry!.revision);
      else await kv.create(key, payload);
      logger.info(
        { dagRootTaskId, handleName, workloadId: info.workload_id, previousWorkloadId: previous },
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
/**
 * Free every handle naming `workloadId`, because it has just been stopped.
 *
 * The counterpart to `replaceDagHandle` refusing to take a name from a
 * workload still on record. Sited here, by workload rather than by handle,
 * because the callers that stop one do not all know which DAG named it:
 * `reapPendingHands` has a session and a workload id and nothing else, and it
 * stops workloads on the ordinary retryable-provisioning path. Leaving the
 * handle behind there turns a routine retry into a permanent failure -- the
 * redelivered task cannot register, because the name still points at the
 * workload the reaper stopped.
 *
 * Scans, for the same reason the Backend's shared-holder check does: the
 * question is "who names this workload", and the registry is keyed the other
 * way round. Teardown is not a hot path.
 */
export async function releaseHandlesForWorkload(workloadId: string): Promise<void> {
  if (!workloadId) return;
  const kv = _kvBucket;
  if (!kv) throw new Error("dag-handles.not_initialized -- call initDagHandles(js) at boot");
  const dec = new TextDecoder();
  const enc = new TextEncoder();

  // Bounded: the caller is on a teardown path and an abort cannot interrupt an
  // await. What the enumeration goes on doing afterwards is not cancellable
  // here; what matters is that the caller stops waiting on it.
  let timer: NodeJS.Timeout;
  const rows = await Promise.race([
    getMap().listAll().finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`dag-handles release scan exceeded ${RELEASE_SCAN_TIMEOUT_MS}ms`)),
        RELEASE_SCAN_TIMEOUT_MS,
      );
      timer.unref?.();
    }),
  ]);

  for (const [dagRoot, handles] of rows) {
    const names = Object.entries(handles)
      .filter(([, info]) => info.workload_id === workloadId)
      .map(([name]) => name);
    if (names.length === 0) continue;

    // Revision-conditional, and bound to the workload. `DagHandleMap.destroy`
    // is an unconditional rewrite of the whole row, so a handle registered
    // between the scan above and the write below is deleted with it -- the
    // same lost update the removal on the Backend side was made conditional
    // to prevent, reintroduced here. And the entry may have moved on to a
    // different workload since the scan, which is somebody else's and must
    // not be removed on the strength of a stale read.
    for (const name of names) {
      for (let attempt = 0; attempt < REGISTER_CAS_ATTEMPTS; attempt += 1) {
        const key = `${HANDLE_MAP_PREFIX}.${dagRoot}`;
        const entry = await kv.get(key);
        if (!entry || entry.operation === "DEL" || entry.operation === "PURGE") break;
        if (entry.value.length === 0) break;
        const parsed: unknown = JSON.parse(dec.decode(entry.value));
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) break;
        const row = parsed as Record<string, unknown>;

        const held = getHandleEntry(row, name);
        const heldId = typeof held === "string"
          ? held
          : (held as { workload_id?: string } | undefined)?.workload_id;
        // Already gone, or moved on to something else: not ours to remove.
        if (heldId !== workloadId) break;

        delete row[name];
        try {
          if (Object.keys(row).length === 0) {
            await kv.delete(key, { previousSeq: entry.revision });
          } else {
            await kv.update(key, enc.encode(JSON.stringify(row)), entry.revision);
          }
          logger.info({ dagRootTaskId: dagRoot, handleName: name, workloadId }, "dag-handles.released");
          break;
        } catch (e) {
          if (!isRevisionConflict(e)) throw e;
          logger.info({ dagRootTaskId: dagRoot, handleName: name, attempt }, "dag-handles.release_retry");
        }
      }
    }
  }
}

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
