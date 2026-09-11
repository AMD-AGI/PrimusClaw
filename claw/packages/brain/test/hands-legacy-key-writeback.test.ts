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
import {
  markHandsIdle, registerSandbox, runKeepaliveTickForTest, unregisterSandbox,
} from "../src/sandbox/keepalive.js";
import { markRetryPending } from "../src/tasks/retry-pending.js";
import { filterToRegExp } from "./nats-kv-stub.js";

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
type SeedableKv = KV & { seed(key: string, value: string): void };

function kvHolding(held: string, value: unknown = BINDING): { kv: SeedableKv; writes: Writes } {
  const writes: Writes = { updated: [], deleted: [] };
  const store = new Map<string, { value: Uint8Array; revision: number }>([
    [held, { value: sc.encode(JSON.stringify(value)), revision: REVISION }],
  ]);
  const kv = {
    seed(key: string, raw: string) {
      store.set(key, { value: sc.encode(raw), revision: REVISION });
    },
    async get(key: string) {
      const found = store.get(key);
      return found ? { key, value: found.value, revision: found.revision } : null;
    },
    async keys(filter = ">") {
      const re = filterToRegExp(filter);
      const matched = [...store.keys()].filter((k) => re.test(k));
      return (async function* () { yield* matched; })();
    },
    async put(key: string, v: Uint8Array) {
      store.set(key, { value: v, revision: REVISION });
      return REVISION;
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
  } as unknown as SeedableKv;
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

test("an expired retry deletes the record it examined, not a re-derived key", async () => {
  // The sweep drops an orphaned READY sandbox when the retry that owned it was
  // never redelivered. Deleting a key re-derived from the session id leaves the
  // legacy record behind -- so the next sweep finds it, pings a workload nobody
  // is coming back for, and the sandbox is held open indefinitely.
  const { kv, writes } = kvHolding(LEGACY_KEY);
  bindHandsKv(kv);
  await markRetryPending(kv, {
    sessionId: SESSION_ID,
    createdAtMs: 0,
    deadlineMs: 1,
    graceSec: 0,
    workloadId: "wl-1",
  });

  await runKeepaliveTickForTest({ kv, countActiveShells: async () => 0 });

  assert.deepEqual(writes.deleted.filter((k) => k.startsWith("hands.")), [LEGACY_KEY],
    "the orphaned record was left behind and a re-derived key deleted instead");
});

test("an expired retry leaves a canonical sibling of another generation alone", async () => {
  // Both keys present, the binding under the legacy name. Re-deriving the
  // canonical key here does not merely miss -- it deletes a different, live
  // generation of the same session.
  const { kv, writes } = kvHolding(LEGACY_KEY);
  kv.seed(CANONICAL_KEY, JSON.stringify({ ...BINDING, workloadId: "wl-newer" }));
  bindHandsKv(kv);
  await markRetryPending(kv, {
    sessionId: SESSION_ID,
    createdAtMs: 0,
    deadlineMs: 1,
    graceSec: 0,
    workloadId: "wl-1",
  });

  await runKeepaliveTickForTest({ kv, countActiveShells: async () => 0 });

  assert.ok(!writes.deleted.includes(CANONICAL_KEY),
    "a live sibling generation was deleted by a key re-derived from the session id");
});

test("an expired retry on a locally registered generation deletes that one", async () => {
  // The local registry names one particular sandbox and carries no KV key, so
  // the record has to be found by identity. A canonical-first read returns the
  // sibling here -- a different, live generation of the same session -- and
  // deleting it strands the workload it names while leaving the orphan behind.
  const { kv, writes } = kvHolding(LEGACY_KEY);
  kv.seed(CANONICAL_KEY, JSON.stringify({ ...BINDING, workloadId: "wl-newer" }));
  bindHandsKv(kv);
  const local = {
    provider: "safe-workload" as const,
    workloadId: "wl-1",
    platformKey: "pk-1",
    sessionId: SESSION_ID,
    sandboxName: "sb-1",
    namespace: "ns-1",
  };
  registerSandbox(SESSION_ID, local);
  await markRetryPending(kv, {
    sessionId: SESSION_ID,
    createdAtMs: 0,
    deadlineMs: 1,
    graceSec: 0,
    workloadId: "wl-1",
  });

  try {
    await runKeepaliveTickForTest({ kv, countActiveShells: async () => 0 });
  } finally {
    unregisterSandbox(SESSION_ID, local);
  }

  assert.ok(!writes.deleted.includes(CANONICAL_KEY),
    "the live sibling generation was deleted instead of the registered one");
  assert.ok(writes.deleted.includes(LEGACY_KEY),
    "the generation the local registry named was left behind");
});

test("an expired retry deletes nothing when no record names the registered generation", async () => {
  // Neither key holds the generation the registry names. Deleting the one that
  // happens to answer would strand a live workload; an orphan is the cheaper
  // wrong answer and the bucket TTL takes it.
  const { kv, writes } = kvHolding(CANONICAL_KEY, { ...BINDING, workloadId: "wl-someone-else" });
  bindHandsKv(kv);
  const local = {
    provider: "safe-workload" as const,
    workloadId: "wl-gone",
    platformKey: "pk-1",
    sessionId: SESSION_ID,
    sandboxName: "sb-gone",
    namespace: "ns-1",
  };
  registerSandbox(SESSION_ID, local);
  await markRetryPending(kv, {
    sessionId: SESSION_ID,
    createdAtMs: 0,
    deadlineMs: 1,
    graceSec: 0,
    workloadId: "wl-gone",
  });

  try {
    await runKeepaliveTickForTest({ kv, countActiveShells: async () => 0 });
  } finally {
    unregisterSandbox(SESSION_ID, local);
  }

  assert.deepEqual(writes.deleted.filter((k) => k.startsWith("hands.")), [],
    "a record naming a different sandbox was deleted");
});
