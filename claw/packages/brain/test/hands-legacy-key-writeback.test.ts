// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Every reader and writer of a session binding agrees on which key holds it.
 *
 * A session id under the reserved prefix is re-keyed on write, so during a
 * rolling upgrade its binding can sit under the legacy name an old replica
 * still writes. A reader that looks only at the canonical key reads a live
 * session as having no sandbox; a writer that derives the canonical key from a
 * revision read off the legacy one loses its write to a conflict it then
 * resolves against an absent entry. Both fail silently, which is why each path
 * is pinned here rather than left to the migration alone.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { StringCodec, type KV } from "nats";

import { handsSessionKey, legacyHandsKey } from "../src/sandbox/hands-key.js";
import { bindHandsKv } from "../src/sandbox/registry.js";
import { readHandsProbeEntry } from "../src/sandbox/container-probe.js";
import { markHandsIdle } from "../src/sandbox/keepalive.js";

const sc = StringCodec();

/** A session id under the reserved prefix, so its canonical key is re-keyed. */
const SESSION_ID = "retained-ROLLING";
const LEGACY_KEY = legacyHandsKey(SESSION_ID);
const CANONICAL_KEY = handsSessionKey(SESSION_ID);
const REVISION = 11;

const BINDING = {
  status: "ready",
  provider: "safe-workload",
  workloadId: "wl-1",
  platformKey: "pk-1",
  sessionId: SESSION_ID,
  sandboxName: "sb-1",
  namespace: "ns-1",
  handsUrl: "http://hands:9100/mcp",
  token: "tok-1",
};

interface Writes {
  updated: Array<{ key: string; revision: number; value: string }>;
  deleted: string[];
}

/**
 * A bucket holding the binding under `held` only. Every other key answers
 * absent, so a caller that derives its own key is caught rather than served.
 */
function kvHolding(held: string, value: unknown = BINDING): { kv: KV; writes: Writes } {
  const writes: Writes = { updated: [], deleted: [] };
  const store = new Map<string, { value: Uint8Array; revision: number }>([
    [held, { value: sc.encode(JSON.stringify(value)), revision: REVISION }],
  ]);
  const kv = {
    async get(key: string) {
      const found = store.get(key);
      return found ? { key, value: found.value, revision: found.revision } : null;
    },
    async update(key: string, value: Uint8Array, revision: number) {
      const found = store.get(key);
      if (!found || found.revision !== revision) {
        throw Object.assign(new Error("wrong last sequence"), { code: "10071" });
      }
      writes.updated.push({ key, revision, value: sc.decode(value) });
      store.set(key, { value, revision: revision + 1 });
      return revision + 1;
    },
    async delete(key: string) {
      writes.deleted.push(key);
      store.delete(key);
    },
  } as unknown as KV;
  return { kv, writes };
}

/** markHandsIdle is fire-and-forget, so let its promise chain settle. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

test("the container probe finds a binding held under the legacy key", async () => {
  const { kv } = kvHolding(LEGACY_KEY);
  bindHandsKv(kv);

  const entry = await readHandsProbeEntry(SESSION_ID);

  // Without the read-through this is null, which the probe's caller turns into
  // `dead` and then rebuilds over a live sandbox.
  assert.notEqual(entry, null, "a live binding under the legacy key read as absent");
  assert.equal(entry?.workloadId, "wl-1");
});

test("the container probe still reads the canonical key", async () => {
  const { kv } = kvHolding(CANONICAL_KEY);
  bindHandsKv(kv);

  assert.equal((await readHandsProbeEntry(SESSION_ID))?.workloadId, "wl-1");
});

test("a probe finds nothing when the bucket holds nothing", async () => {
  const { kv } = kvHolding("hands.someone-else");
  bindHandsKv(kv);

  assert.equal(await readHandsProbeEntry(SESSION_ID), null);
});

test("idle parking writes back to the key the binding was read from", async () => {
  const { kv, writes } = kvHolding(LEGACY_KEY);

  markHandsIdle(kv, SESSION_ID, "wl-1");
  await settle();

  assert.deepEqual(writes.updated.map((w) => w.key), [LEGACY_KEY],
    "the idle marker was written to a key the binding does not sit under");
  assert.equal(writes.updated[0]?.revision, REVISION);
  assert.equal(JSON.parse(writes.updated[0]!.value).keepalive, false);
});

test("idle parking leaves a binding for a different workload alone", async () => {
  const { kv, writes } = kvHolding(LEGACY_KEY);

  markHandsIdle(kv, SESSION_ID, "wl-other");
  await settle();

  assert.deepEqual(writes.updated, []);
});
