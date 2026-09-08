// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Read-only access to the DAG handle rows Brain writes.
 *
 * They live in their own bucket, not among the `dag-handles.*` keys of the
 * registry bucket this process's own sweeper walks -- Brain never writes those,
 * so scanning them enumerates an empty map and a live DAG sandbox reads as a
 * fleet of none.
 *
 * `bindOnly`, because "read-only" has to be true of the attach as well: a
 * create-or-attach would make this process the bucket's creator on a
 * api-first boot and fix its replica count at the JetStream default for the
 * life of the cluster. A failed bind is reported to the caller, never
 * substituted with an empty list.
 */

import { HANDLE_MAP_PREFIX, type HandleInfo } from "@claw/protocol";
import type { KV } from "nats";
import { js } from "./nats.js";

const BUCKET = "DAG_HANDLES";

/**
 * The same bucket, for the one sweep that must also delete from it.
 *
 * `bindOnly` for the reason the module header gives: attaching must never make
 * this process the bucket's creator. Writing is not what that rule is about --
 * reading the wrong bucket is, and a sweep that deletes from the registry
 * bucket instead of this one enumerates an empty map and reaps nothing.
 */
export async function dagHandlesBucket(): Promise<KV> {
  return js.views.kv(BUCKET, { bindOnly: true });
}

export async function listDagHandles(): Promise<Array<[string, Record<string, HandleInfo>]>> {
  const bucket = await js.views.kv(BUCKET, { bindOnly: true });
  const decoder = new TextDecoder();
  const out: Array<[string, Record<string, HandleInfo>]> = [];
  for await (const key of await bucket.keys(`${HANDLE_MAP_PREFIX}.>`)) {
    const entry = await bucket.get(key);
    if (!entry) continue;
    const row = JSON.parse(decoder.decode(entry.value)) as Record<string, HandleInfo>;
    out.push([key.slice(HANDLE_MAP_PREFIX.length + 1), row]);
  }
  return out;
}
