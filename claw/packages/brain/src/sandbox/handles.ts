// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Brain-side wrapper around `@claw/utils` DagHandleMap (task-design.md §9.4).
 *
 * Two callers:
 *
 *   - sandbox.create with `handle`: after a successful SaFE workload create,
 *     `registerDagHandle(...)` writes the handle info so downstream DAG
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

export async function registerDagHandle(
  dagRootTaskId: string,
  handleName: string,
  info: HandleInfo,
): Promise<void> {
  try {
    await getMap().create(dagRootTaskId, handleName, info);
    logger.info(
      { dagRootTaskId, handleName, workloadId: info.workload_id },
      "dag-handles.registered",
    );
  } catch (e) {
    logger.warn(
      { dagRootTaskId, handleName, err: (e as Error).message },
      "dag-handles.register_failed",
    );
    throw e;
  }
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
