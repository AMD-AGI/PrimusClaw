// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Finding a retry-pending lease when the caller does not know the gate key.
 *
 * Keepalive is the caller that does not: it walks READY sandboxes and asks "did
 * an attempt for this session exit retryably and never come back?", holding only
 * a session id. The answer decides whether an orphaned sandbox is reclaimed, so
 * a lookup that cannot find the entry does not fail loudly -- it reports "no
 * pending retry", keeps pinging, and leaves a GPU attached to a session nobody
 * is talking to.
 *
 * The lease is stored under `retry-pending.<sid>.<gateKey>`, and a gate key is
 * `ws.<workspaceId>`. Nothing escapes the dot, so the key has one more subject
 * token than a `.*` filter can span. These tests are about the arithmetic of
 * tokens, which is why the KV stub implements it rather than matching prefixes.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { StringCodec, type KV } from "nats";

import { getRetryPending, markRetryPending } from "../src/tasks/retry-pending.js";
import { makeKv } from "./nats-kv-stub.js";

const sc = StringCodec();
const SID = "ksess_abc";

function entry(lockKey?: string) {
  return {
    sessionId: SID,
    lockKey,
    createdAtMs: 1_000,
    deadlineMs: 2_000,
    graceSec: 1,
  };
}

/** A KV holding one lease, written through the production key builder. */
async function kvWith(lockKey?: string): Promise<{ kv: KV; keys: Map<string, unknown> }> {
  const keys = new Map<string, unknown>();
  const kv = makeKv(keys) as KV;
  await markRetryPending(kv, entry(lockKey));
  return { kv, keys };
}

test("a lease under a workspace gate key is found without being told the key", async () => {
  // The regression: `ws.kws_1` is two tokens, so the key is
  // retry-pending.<sid>.ws.kws_1 and a `retry-pending.<sid>.*` scan matches
  // nothing at all. Keepalive then never reclaims the sandbox.
  const { kv, keys } = await kvWith("ws.kws_1");
  assert.ok(
    [...keys.keys()].some((k) => k === `retry-pending.${SID}.ws.kws_1`),
    "the stored key really does carry an unescaped dot",
  );

  const found = await getRetryPending(kv, SID);
  assert.equal(found?.lockKey, "ws.kws_1");
});

test("a lease under a session gate key is still found", async () => {
  // RUN_GATE_KEY can be set back to `session`, and a message from an API too old
  // to bind workspaces falls back to it, so the single-token shape has to keep
  // working alongside the other.
  const { kv } = await kvWith(SID);
  const found = await getRetryPending(kv, SID);
  assert.equal(found?.lockKey, SID);
});

test("a lease written before gate keys existed is still found", async () => {
  const { kv } = await kvWith(undefined);
  const found = await getRetryPending(kv, SID);
  assert.equal(found?.sessionId, SID);
});

test("the scan does not reach into another session's leases", async () => {
  // `>` is wider than `*`, so it is worth pinning that it stays under the
  // session: acting on another session's lease would destroy a live sandbox.
  const keys = new Map<string, unknown>();
  const kv = makeKv(keys) as KV;
  await markRetryPending(kv, { ...entry("ws.kws_1"), sessionId: "ksess_other" });

  assert.equal(await getRetryPending(kv, SID), null);
});

test("a lease naming a different session is discarded rather than believed", async () => {
  // The scan finds keys by session id, but the body is what decides. A mismatch
  // means the key was built from something stale, and acting on it would reclaim
  // the wrong sandbox -- so it is dropped, and cleared so it stops being found.
  const key = `retry-pending.${SID}.ws.kws_1`;
  const keys = new Map<string, unknown>([
    [key, sc.encode(JSON.stringify({ ...entry("ws.kws_1"), sessionId: "ksess_other" }))],
  ]);
  const kv = makeKv(keys) as KV;

  assert.equal(await getRetryPending(kv, SID), null);
  assert.equal(keys.has(key), false, "and the bad entry is deleted");
});
