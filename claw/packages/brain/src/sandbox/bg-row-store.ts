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
      // A deleted key is not a missing one to this client. JetStream keeps the
      // delete marker as the key's last message, and `get` hands that marker
      // back like any other entry -- same shape, tombstone revision, empty
      // payload. Decoded and returned as a value, that empty string reaches the
      // `JSON.parse` every caller here does and throws, and a throw out of a row
      // read means one thing upstream: the row could not be read, which
      // `resolveStart` is obliged to answer `rowReadable: false` to.
      //
      // That is the one answer a released row must never produce. `releaseRow`
      // drops a row precisely because its start positively never reached the
      // sandbox, so the retry that follows would be refused as unresolvable --
      // and the bucket has no expiry, so the marker stands and the refusal is
      // permanent. Absence is what a tombstone means; it is reported as absence.
      if (entry === null || entry.operation === "DEL" || entry.operation === "PURGE") return null;
      return { value: sc.decode(entry.value), revision: entry.revision };
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
      // Classified the way `write` classifies it, and for the same reason: a
      // revision-conditioned delete loses the same race a conditioned write
      // does, and losing it is routine rather than a store failure. Raised
      // instead, it leaves the loop in `deleteRunRows` on its first contended
      // row, so the remaining shells of a multi-shell run are never reached --
      // into a bucket created with no expiry, where nothing else will ever
      // remove them.
      try {
        await kv.delete(key, { previousSeq: expectedRevision });
        return true;
      } catch (err) {
        if (isRevisionConflict(err)) return false;
        throw err;
      }
    },
    async keys(filter) {
      const out: string[] = [];
      for await (const key of await kv.keys(filter)) out.push(key);
      return out;
    },
  };
}
