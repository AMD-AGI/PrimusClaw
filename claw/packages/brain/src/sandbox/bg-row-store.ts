// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The reference rows as key-value entries, bound once at boot.
 *
 * Their own bucket with no expiry at all: a run whose budget is configured off
 * has no deadline, so no finite number bounds how long one of these must
 * answer, and a lowered bucket TTL is applied downward to entries already
 * written -- narrowing rows out from under runs already stamped. A row is
 * removed when its run ends, never because time passed.
 */

import { StringCodec, type JetStreamClient, type KV } from "nats";
import { isRevisionConflict } from "@claw/utils";
import pino from "pino";
import type { BgRowStore } from "./bg-handle-rows.js";

const sc = StringCodec();
const logger = pino({ name: "bg-handle-rows" });
const BUCKET = "BG_HANDLE_ROWS";

let bucket: KV | null = null;

export async function initBgHandleRows(js: JetStreamClient): Promise<void> {
  bucket = await js.views.kv(BUCKET, { ttl: 0 });
  logger.info({ bucket: BUCKET }, "bg-handle-rows.bound");
}

/** Swap the bucket for a stand-in; returns the call that puts it back. */
export function bindBgHandleRowsForTest(stub: KV | null): () => void {
  const previous = bucket;
  bucket = stub;
  return () => { bucket = previous; };
}

/** The store, or null where the bucket could not be bound. */
export function bgRowStore(): BgRowStore | null {
  if (!bucket) return null;
  const kv = bucket;
  return {
    async read(key) {
      const entry = await kv.get(key);
      return entry === null ? null : { value: sc.decode(entry.value), revision: entry.revision };
    },
    async write(key, value, expectedRevision) {
      try {
        if (expectedRevision === null) await kv.create(key, sc.encode(value));
        else await kv.update(key, sc.encode(value), expectedRevision);
        return true;
      } catch (err) {
        if (isRevisionConflict(err)) return false;
        throw err;
      }
    },
    async delete(key, expectedRevision) {
      await kv.delete(key, { previousSeq: expectedRevision });
    },
    async keys(filter) {
      const out: string[] = [];
      for await (const key of await kv.keys(filter)) out.push(key);
      return out;
    },
  };
}
