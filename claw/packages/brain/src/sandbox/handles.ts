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
import { DagHandleMap, type HandleInfo } from "@claw/protocol";
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
  // them keeps the JetStream default of one replica for the life of the
  // cluster. Correcting that drift needs a JetStreamManager, which this
  // package does not hold; the API side does it for the buckets it owns in
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

/**
 * Point an existing handle at a different workload, or create it if absent.
 *
 * This replaced a `registerDagHandle` that wrapped `create` directly. That one
 * is gone rather than kept beside this: it had no callers left, and leaving a
 * "refuse if the name exists" primitive next to a "take the name over" one is
 * leaving the exact footgun that produced the bug -- three call sites reached
 * for the stricter of the two, had the rejection swallowed, and ran live
 * sandboxes the map did not name.
 *
 * `create` deliberately refuses to overwrite a name that already maps
 * elsewhere, so that a mistaken double-create cannot silently lose a
 * reference. That guard is right for a fresh registration and wrong for the
 * two moments a handle legitimately changes hands:
 *
 *   - a rebuild, where the old workload has already been stopped and the same
 *     handle must now name its replacement;
 *   - a session reuse, where a DAG takes over a warm sandbox another task
 *     created.
 *
 * Before this existed both went through `create`, were rejected, and had the
 * rejection swallowed at the call site -- leaving the map naming a workload
 * that is gone (rebuild) or absent entirely (reuse), while a live sandbox ran
 * unreferenced. Backend then stopped the wrong thing, or nothing, and reported
 * success either way.
 *
 * The replacement is a single write -- see `DagHandleMap.replace`. Spelling it
 * as destroy-then-create would open a window in which the handle resolves to
 * nothing, and an absent handle is precisely how Backend's teardown decides a
 * DAG holds no sandbox: a cancel landing in that window would answer "nothing
 * held" for a running workload, which is the failure this whole change exists
 * to remove. The old workload id comes back from the write and is logged,
 * because it is the one identifier that otherwise disappears at exactly the
 * moment somebody may need to go looking for it.
 *
 * Stopping the old workload is NOT this function's job and must not become it:
 * the rebuild path has already stopped it, and the reuse path must not stop a
 * sandbox it is adopting. This moves the name; it does not free anything.
 */
export async function replaceDagHandle(
  dagRootTaskId: string,
  handleName: string,
  info: HandleInfo,
): Promise<void> {
  const previous = await getMap().replace(dagRootTaskId, handleName, info);
  logger.info(
    { dagRootTaskId, handleName, workloadId: info.workload_id, previousWorkloadId: previous },
    "dag-handles.replaced",
  );
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
