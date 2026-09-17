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
import { DagHandleContendedError, DagHandleScanTimeoutError } from "./errors.js";
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
  _map = new DagHandleMap(natsKvStore(boundBucketAdapter()));
  logger.info({ bucket: BUCKET }, "dag-handles.bound");
  return _map;
}

/**
 * The `DagHandleMap` view of whatever bucket is currently bound.
 *
 * Reads `_kvBucket` on every call rather than closing over the bucket it was
 * built with, which is what lets the map and the direct writes stay the same
 * bucket when one of them is rebound.
 */
function boundBucketAdapter(): NatsLikeKv {
  return {
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

/**
 * Bind a stand-in bucket for the WHOLE module -- the direct CAS writes and the
 * `DagHandleMap` view together -- and return the call that puts the real one
 * back.
 *
 * Wider than `bindDagHandleKvForTest` on purpose, and the width is the point.
 * The behaviour worth testing here is the interaction between the three
 * operations, not any one of them: a registration is refused because a row
 * still names something (`replaceDagHandle`, direct writes), the release that
 * should have cleared that row enumerates through the map (`listAll`), and the
 * question of whether the refusal or the release wins can only be asked with
 * both over the SAME bucket. A test that stubbed one of them would be asserting
 * about its own stub.
 *
 * Standing up real JetStream would be the alternative, and is what the
 * measurement harness does; it is the wrong dependency for a unit suite that
 * every other sandbox test runs without a broker.
 */
export function bindDagHandlesForTest(stub: KV): () => void {
  const prevKv = _kvBucket;
  const prevMap = _map;
  _kvBucket = stub;
  _map = new DagHandleMap(natsKvStore(boundBucketAdapter()));
  return () => { _kvBucket = prevKv; _map = prevMap; };
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
 * One read of the handle table, in the shape both questions about it take.
 *
 * Named because it is now something callers hold and pass on rather than
 * something each of them fetches for itself: see `dagsNamingWorkload` and the
 * `rows` option on `releaseHandlesForWorkload`.
 */
export type DagHandleRows = Array<[string, Record<string, HandleInfo>]>;

/**
 * Which DAGs, in an ALREADY-READ table, still name this container.
 *
 * Pure on purpose, and that is the whole point of it existing separately from
 * the scan. "Who holds this workload" and "free every handle naming this
 * workload" are two questions over one table, and the caller that asks both --
 * the keepalive retention phase -- used to answer them with two enumerations:
 * its own, and then the one `releaseHandlesForWorkload` runs internally. Both
 * were charged to a single `HANDLE_RELEASE_CEILING_MS`, so the pair could not
 * finish inside a budget one of them fits in comfortably, and when it expired
 * the release never ran AND the retention delete behind it never ran either --
 * an idle container retained, refreshed and pinged for ever.
 *
 * Sharing one snapshot is also the stricter answer, not merely the cheaper one.
 * With two scans, a handle registered between them is invisible to the holder
 * check and visible to the release -- so the release could free a reference
 * that nothing had been allowed to rule on. With one, the set the holder check
 * cleared and the set the release acts on are the same set by construction.
 * That a row can still change AFTER the snapshot is handled where it has to be,
 * at the write: every removal re-reads its row and removes the name only while
 * it still names this workload, under the revision it was just read at. A row
 * that appears after the snapshot is simply not freed, which is the direction
 * that keeps a reference rather than takes one.
 *
 * The table is the only durable answer to "who holds this workload", which is
 * why the question is asked of it and not inferred: a DAG node reaches its
 * sandbox by resolving a handle (`lookupDagHandle` on the `sandbox.use` path),
 * so a row naming the container IS a live reference to it and removing the row
 * is removing the reference. The run lease cannot stand in for it: `runScope`
 * is `pickLockKey(request)`, which under the default `RUN_GATE_KEY=workspace`
 * is `ws.<workspaceId>`, and a handle row records neither the lock key nor the
 * workspace -- so a lease read keyed off a handle would answer "no lease" for a
 * perfectly live sibling and delete its handle, which is the defect rather than
 * the fix.
 *
 * Rows are matched the way the release matches them and then one way more.
 * `releaseHandlesForWorkload` frees rows whose `workload_id` equals the id, so
 * every row it could take is covered by the first test; an agent-sandbox row
 * carries `workload_id: ""` and its Router session instead, and the keepalive
 * target's `inst.id` for an agent-sandbox IS that session id, so the second
 * test covers a reference the release cannot currently free at all. Reporting a
 * holder the release could not have freed is the point: a handle nothing here
 * can free is still a handle naming the container, and letting the retention go
 * while it stands would leave the row with no ledger behind it.
 *
 * `pending` rows count. A handle is registered the moment SaFE assigns an id,
 * before the workload can serve anything -- `collectDagTargets` skips those for
 * PINGING because an exec against a queued workload 404s, which is a different
 * question from whether the DAG holds it. It does; that row is the DAG's only
 * reference while it waits for a GPU.
 *
 * Nothing here decides what to do about an unreadable table, because nothing
 * here reads one: the caller's scan throws and never reaches this. The one case
 * that is not an exception is an UNBOUND map, where `listAllDagHandles` answers
 * `[]` and this answers "nobody" -- covered from the other side, since the
 * release such an answer lets through throws `not_initialized` on the same
 * unbound map before it frees anything.
 */
export function dagsNamingWorkload(rows: DagHandleRows, workloadId: string): string[] {
  if (!workloadId) return [];
  const held: string[] = [];
  for (const [dagRoot, handles] of rows) {
    for (const info of Object.values(handles)) {
      if (info.workload_id === workloadId || info.session_id === workloadId) {
        held.push(dagRoot);
        break;
      }
    }
  }
  return held;
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
        // Same class as the release scan below, because it is the same
        // statement -- the store did not answer in time -- and nothing about
        // which question was being asked changes what the next read can
        // return. Only the release path's caller consults `isRetryable`; this
        // one is reached from the keepalive sweep, which has its own handling.
        // The class is shared so the two cannot drift into disagreeing about
        // what a timeout means.
        () => reject(new DagHandleScanTimeoutError(`dag-handles holder scan exceeded ${RELEASE_SCAN_TIMEOUT_MS}ms`)),
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
  /**
   * Lets a caller say a name may be taken despite still being on record.
   *
   * The one case is a RETAINED workload: retention hands the container to the
   * retention store and frees the name, and when that free does not land -- a
   * lost ACK, a crash between the two -- the stale handle would otherwise
   * refuse every replacement for the life of the DAG. Asked of the caller
   * rather than looked up here, because retention lives in the hands bucket and
   * this module owns a different one.
   */
  opts?: { mayTakeFrom?: (previousWorkloadId: string) => Promise<boolean> },
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
    // What the INCOMING registration names, which is not always a workload id:
    // an agent-sandbox records `workload_id: ""` and carries its Router session
    // instead. `handleIdentityKey` is the one place that knows both shapes.
    const incoming = handleIdentityKey(info);
    // Refuse to take the name from a DIFFERENT workload that is still on
    // record. `create` refused this too, and replacing that refusal with an
    // unconditional write is what let a redelivery -- whose `hands.<session>`
    // expired while this handle, in a bucket with no TTL, kept naming a
    // running workload -- overwrite the only reference to it.
    //
    // Compared against what this registration NAMES, not against its
    // `workload_id`. The guard used to read `previous && info.workload_id &&
    // previous !== info.workload_id`, so an empty `workload_id` short-circuited
    // the whole refusal -- and an agent-sandbox registration, which always
    // carries one, walked over a handle still naming a live SaFE workload and
    // took its only reference with it. An absent workload id is NOT evidence
    // that the handle on record is stale; it is evidence that the incoming
    // sandbox is named some other way. A registration that names nothing at all
    // -- neither id, so `incoming` is null -- is refused for the same reason,
    // rather than being handed a name nothing could then find it by.
    //
    // The comparison stays one-sided on purpose: `previous` is the previous
    // WORKLOAD id and deliberately not its identity key, so a previous
    // agent-sandbox entry is still overwritable. Making it symmetric would
    // protect a name that nothing can free. `releaseHandlesForWorkload` matches
    // rows on `info.workload_id`, which an agent-sandbox row leaves empty, and
    // none of its three callers can therefore free one: the reaper's post-stop
    // release and retention both pass a SaFE workload id, and keepalive's sweep
    // passes `inst.id`, which for an agent-sandbox is its Router session id and
    // so matches no row's `workload_id` either. Refusing on that side would
    // wedge the handle for the life of the DAG. Keying the release by identity
    // too is what would earn the other half of this guard.
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
    if (previous && previous !== incoming) {
      // Unless the workload it names has been RETAINED -- handed over to the
      // retention store because work was still running in it while this session
      // moved on. That hand-over frees the name, and normally does so itself;
      // this is the recovery for when that delete did not land, or its ACK was
      // lost, or the process died between the two. Without it a stale handle
      // refuses every replacement for the life of the DAG.
      //
      // Checked here rather than trusted from the release, because "the release
      // threw" does not mean "the delete did not happen", and the durable
      // retention record is the thing that actually settles whose it is.
      if (opts?.mayTakeFrom && await opts.mayTakeFrom(previous)) {
        logger.warn(
          { dagRootTaskId, handleName, previous, workloadId: info.workload_id },
          "dag-handles.taking_name_from_retained_workload",
        );
      } else throw new Error(
        `dag-handle ${handleName} for ${dagRootTaskId} still names ${previous}; `
        + `refusing to point it at ${incoming ?? "a registration naming neither a workload nor a session"} `
        + `before that one is released`,
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
 * Every DAG handle currently registered, for the keepalive census.
 *
 * A DAG node's sandbox is reachable only through this map, so a sweep that
 * walks session keys alone leaves it unpinged -- and after a restart that is
 * every DAG sandbox this replica did not create.
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
 *
 * Except where it shares one, which is what `opts.rows` is for. The scan is by
 * far the expensive half of this call -- the CASes that follow touch only the
 * rows that actually name the workload, usually one -- so a caller that has
 * already enumerated the table for a question of its own must be able to hand
 * that enumeration over rather than pay for a second one out of the same
 * budget. It is the caller's own deadline the second scan was overrunning, and
 * measured rather than assumed: see the note on `dagsNamingWorkload`.
 */
export async function releaseHandlesForWorkload(
  workloadId: string,
  /**
   * A table read the caller has ALREADY taken, used instead of scanning again.
   *
   * For the one caller that has to ask a second question over the same table
   * before it may issue this release at all -- the keepalive retention phase,
   * which must establish that no other DAG still names the container. Without
   * this it enumerated the table, and then this function enumerated it again,
   * under one shared deadline; the doubling is what pushed the pair past
   * `HANDLE_RELEASE_CEILING_MS` and stopped anything from ever being released.
   *
   * It narrows what gets freed and never widens it: the rows only decide which
   * (DAG, handle) pairs are ATTEMPTED, and each attempt below still re-reads
   * its row and removes the name only while that row still names this workload,
   * conditional on the revision it was just read at. So a snapshot that has
   * gone stale can cause a name to be left alone -- the direction that keeps a
   * reference -- and can never cause somebody else's to be taken.
   *
   * Omitted by the three callers that release after a confirmed stop
   * (`reapPendingHands`, `retainInsteadOfDestroying`, and the gone-workload
   * branch in `recoverOrRetainUnusableSandbox`): each of those has no second
   * question to ask and their release stays absolute, scanning for itself.
   */
  opts?: { rows?: DagHandleRows },
): Promise<void> {
  if (!workloadId) return;
  const kv = _kvBucket;
  // Checked BEFORE the rows are consulted, and it has to stay that way. An
  // unbound map makes `listAllDagHandles` answer `[]` rather than throw, so a
  // caller that hands over such a snapshot would otherwise get a release that
  // silently found nothing to free -- and the keepalive caller reads a
  // successful release as licence to delete the retention records behind it.
  // The throw here is what makes "the table could not be read" reach that
  // caller as a failure instead of as an empty table.
  if (!kv) throw new Error("dag-handles.not_initialized -- call initDagHandles(js) at boot");
  const dec = new TextDecoder();
  const enc = new TextEncoder();

  // Bounded: the caller is on a teardown path and an abort cannot interrupt an
  // await. What the enumeration goes on doing afterwards is not cancellable
  // here; what matters is that the caller stops waiting on it.
  let timer: NodeJS.Timeout;
  const rows = opts?.rows ?? await Promise.race([
    getMap().listAll().finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new DagHandleScanTimeoutError(`dag-handles release scan exceeded ${RELEASE_SCAN_TIMEOUT_MS}ms`)),
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
      // Whether this name was actually let go. Exhausting the retries used to
      // return as though it had been: the caller then deleted the retention
      // records that were the container's remaining reference, and the handle
      // it still had stayed behind with nothing to recover it from. A release
      // that did not happen has to say so.
      let freed = false;
      // Kept apart from `freed` because the two ways this loop can end without
      // freeing anything want OPPOSITE handling from the task that called it,
      // and only this loop can still tell them apart. See the throws below.
      let rowUnreadable = false;
      for (let attempt = 0; attempt < REGISTER_CAS_ATTEMPTS; attempt += 1) {
        const key = `${HANDLE_MAP_PREFIX}.${dagRoot}`;
        const entry = await kv.get(key);
        // No row, a tombstone, or an empty value: nothing names this workload
        // here, which is the same outcome as having removed it.
        if (!entry || entry.operation === "DEL" || entry.operation === "PURGE") { freed = true; break; }
        if (entry.value.length === 0) { freed = true; break; }
        // Unreadable is NOT that: it may name this workload and we cannot see
        // it, so it falls through to the refusal below rather than reporting a
        // release that was never made.
        const parsed: unknown = JSON.parse(dec.decode(entry.value));
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
          rowUnreadable = true;
          break;
        }
        const row = parsed as Record<string, unknown>;

        const held = getHandleEntry(row, name);
        const heldId = typeof held === "string"
          ? held
          : (held as { workload_id?: string } | undefined)?.workload_id;
        // Already gone, or moved on to something else: not ours to remove.
        if (heldId !== workloadId) { freed = true; break; }

        delete row[name];
        try {
          if (Object.keys(row).length === 0) {
            await kv.delete(key, { previousSeq: entry.revision });
          } else {
            await kv.update(key, enc.encode(JSON.stringify(row)), entry.revision);
          }
          logger.info({ dagRootTaskId: dagRoot, handleName: name, workloadId }, "dag-handles.released");
          freed = true;
          break;
        } catch (e) {
          if (!isRevisionConflict(e)) throw e;
          logger.info({ dagRootTaskId: dagRoot, handleName: name, attempt }, "dag-handles.release_retry");
        }
      }
      if (!freed) {
        // Two failures, and they used to share one throw and one sentence:
        // "N attempts exhausted, OR its row could not be read". That message
        // was honest about not knowing, and the not-knowing was the defect --
        // the task runner reads an error and decides whether to nak or to fail
        // the task, and those two want opposite answers. Split here rather than
        // guessed at there, because here is the last place the difference still
        // exists. `replaceDagHandle` already splits its own two the same way.
        //
        // A row that does not parse as an object will not parse next time
        // either: whatever wrote it is still what is in the bucket, and the
        // release is not retried against it -- for the same reason
        // `replaceDagHandle` raises on this rather than looping. It stays an
        // ordinary Error, which the runner fails the task on. That is the
        // direction that gets an operator to look.
        if (rowUnreadable) {
          throw new Error(
            `dag-handle ${name} for ${dagRoot} was not released from ${workloadId}: `
            + `dag-handles row ${HANDLE_MAP_PREFIX}.${dagRoot} is not a JSON object`,
          );
        }
        // Everything else that reaches here is the loop having re-read the row
        // REGISTER_CAS_ATTEMPTS times, found the handle still naming this
        // workload every time, and lost the conditional write every time. The
        // `break`s above do not: each of them means the name is no longer on
        // this workload, which IS released as far as this call is concerned, so
        // each sets `freed`.
        //
        // Losing that race says something about another writer, not about
        // anything being broken: the row moved because a sibling node of this
        // same DAG registered a handle of its own into it. How long such a
        // burst lasts is not claimed here and has not been measured -- what is
        // claimed is only that the next read of this row can return something
        // different, which is not true of any other failure this function has.
        // So it is raised as the thing it is, and `isRetryable` naks the
        // delivery rather than ending the task -- see the class.
        throw new DagHandleContendedError(
          `dag-handle ${name} for ${dagRoot} was not released from ${workloadId}: `
          + `${REGISTER_CAS_ATTEMPTS} attempts exhausted, the row changing under each`,
        );
      }
    }
  }
}

export async function listAllDagHandles(): Promise<DagHandleRows> {
  // Not bound is not unreadable: the sweep can start before the bucket is
  // attached, and treating that as a failed read would mark every census
  // incomplete until it is. A bucket that is bound and cannot be read still
  // throws, which is the case that matters.
  if (!_map) return [];
  return _map.listAll();
}

export async function isValidDagHandleToken(token: string): Promise<boolean> {
  if (!token || !_kvBucket) return false;
  try {
    // Drained before the first `get`: `keys()` is an ordered-consumer
    // subscription and awaiting another JetStream request inside `for await`
    // stalls its pump, ending the consumer early with no error (measured at 1
    // key out of 21 live ones on the real bucket -- see @claw/utils' kv store).
    // A truncated scan here does not fail loudly: a token that IS valid is not
    // found, `registry.ts` caches that in `deniedTokens`, and the sandbox.use
    // node it belongs to is answered 401 from then on.
    const keys: string[] = [];
    for await (const key of await _kvBucket.keys()) keys.push(key);
    for (const key of keys) {
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
