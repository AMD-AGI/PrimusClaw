// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Walks over a KV listing must see every key, not only the first.
 *
 * The deployed nats.js client ends an open `keys()` listing as soon as another
 * KV operation is awaited inside it (see kv-listing-stub.ts). Three walks read
 * each key while the listing was still open, so each saw exactly one key:
 *
 *   - token validation on a replica that did not issue the token denied it
 *     unless the sandbox happened to be the bucket's first key -- the binary
 *     download a sandbox makes at start-up failed with 403;
 *   - the keepalive census renewed and pinged one sandbox per sweep;
 *   - the retry-pending lookup stopped at the first lease it could not use.
 *
 * Each case puts the key that matters somewhere other than first.
 */
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { StringCodec, type KV } from "nats";

import { listingEndsOnOtherOps } from "./kv-listing-stub.js";
import { makeKv } from "./nats-kv-stub.js";
import { bindHandsKv, isValidHandsToken } from "../src/sandbox/registry.js";
import { bindDagHandleKvForTest } from "../src/sandbox/handles.js";
import { getRetryPending } from "../src/tasks/retry-pending.js";

const sc = StringCodec();
let restoreDag: (() => void) | null = null;
afterEach(() => { restoreDag?.(); restoreDag = null; });

/** A bucket of hands records, in insertion order, behind the faithful listing. */
function handsBucket(entries: Array<[string, unknown]>): { kv: KV; updated: string[] } {
  const values = new Map(entries.map(([k, v]) => [k, sc.encode(JSON.stringify(v))]));
  const updated: string[] = [];
  const raw = {
    async keys(filter = ">") {
      const prefix = filter.replace(/[*>]$/, "");
      const matched = [...values.keys()].filter((k) => k.startsWith(prefix));
      return (async function* () { yield* matched; })();
    },
    async get(key: string) {
      const value = values.get(key);
      return value ? { key, value, revision: 1, operation: "PUT" } : null;
    },
    async update(key: string) { updated.push(key); return 2; },
    async put() { return 1; },
    async create() { return 1; },
    async delete() {},
  };
  return { kv: listingEndsOnOtherOps(raw) as unknown as KV, updated };
}

/** A DAG handle bucket holding nothing, so only the hands scan can validate. */
function noDagHandles(): void {
  restoreDag = bindDagHandleKvForTest(listingEndsOnOtherOps({
    async keys() { return (async function* () {})(); },
    async get() { return null; },
  }) as never);
}

test("the stub reproduces the defect: a read inside the listing ends it after one key", async () => {
  // Without this the tests below could pass against a stub that never ends a
  // listing early, and would then say nothing about the client in production.
  const { kv } = handsBucket([["hands.s1", {}], ["hands.s2", {}], ["hands.s3", {}]]);
  const seenReading: string[] = [];
  for await (const key of await kv.keys("hands.*")) {
    seenReading.push(key);
    await kv.get(key);
  }
  assert.deepEqual(seenReading, ["hands.s1"]);
  const seenListing: string[] = [];
  for await (const key of await kv.keys("hands.*")) seenListing.push(key);
  assert.deepEqual(seenListing, ["hands.s1", "hands.s2", "hands.s3"]);
});

test("a token recorded under a sandbox that is not the bucket's first key validates", async () => {
  const { kv } = handsBucket([
    ["hands.s1", { token: "first-token" }],
    ["hands.s2", { token: "second-token" }],
    ["hands.s3", { token: "third-token" }],
  ]);
  bindHandsKv(kv);
  noDagHandles();

  assert.equal(await isValidHandsToken("third-token"), true,
    "the last key's token was denied: the scan stopped after the first key");
  assert.equal(await isValidHandsToken("second-token"), true);
  assert.equal(await isValidHandsToken("never-issued"), false, "and a token nobody issued is still denied");
});

test("the keepalive census renews every ready sandbox, not only the first", async () => {
  const { runKeepaliveTickForTest } = await import("../src/sandbox/keepalive.js");
  const { bindSandboxProviders } = await import("../src/sandbox/factory.js");
  const ready = (sid: string) => ({
    status: "ready", provider: "agent-sandbox", sessionId: sid,
    sandboxName: `sbx-${sid}`, namespace: "ns",
  });
  const { kv, updated } = handsBucket([
    ["hands.ka-1", ready("ka-1")],
    ["hands.ka-2", ready("ka-2")],
    ["hands.ka-3", ready("ka-3")],
  ]);
  const provider = {
    kind: "agent-sandbox",
    async get() { return { running: true, healthy: true, state: "running" }; },
    async exec() { return { stdout: "", stderr: "", exitCode: 0 }; },
    async stop() {},
  };
  const restore = bindSandboxProviders({ safeWorkload: provider as never, agentSandbox: provider as never });
  try {
    await runKeepaliveTickForTest({ kv });
  } finally {
    restore();
  }
  assert.deepEqual(
    [...new Set(updated)].sort(),
    ["hands.ka-1", "hands.ka-2", "hands.ka-3"],
    "every ready record is renewed; one renewed means the walk ended after its first key",
  );
});

test("a retry-pending lease behind an unusable first entry is still found", async () => {
  const SID = "ksess_scan";
  const values = new Map<string, unknown>();
  // Listed first and unusable: it names another session, so the lookup deletes
  // it and moves on -- which, mid-listing, is exactly the operation that ended
  // the listing.
  values.set(`retry-pending.${SID}.ws.kws_stale`, sc.encode(JSON.stringify({
    sessionId: "someone-else", deadlineMs: 1, createdAtMs: 0, graceSec: 1,
  })));
  values.set(`retry-pending.${SID}.ws.kws_live`, sc.encode(JSON.stringify({
    sessionId: SID, lockKey: "ws.kws_live", deadlineMs: 2_000, createdAtMs: 1_000, graceSec: 1,
  })));
  const kv = listingEndsOnOtherOps(makeKv(values) as object) as unknown as KV;

  const found = await getRetryPending(kv, SID);
  assert.equal(found?.lockKey, "ws.kws_live",
    "the live lease was not found: the scan stopped after the stale first entry");
});
