// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What an unfinished session teardown falls back to.
 *
 * A delete that cannot confirm it removed everything hands the session to nets
 * that already exist rather than driving its own retries: marking the
 * `hands.<sid>` handle idle makes sweepIdleMultiNodeClusters reclaim the
 * clusters about five minutes later, and stops anything from pinging the pod, so
 * the control-plane's own idle GC collects that too.
 *
 * Which makes the fields written here the whole contract. `keepalive` must
 * become false — the multi-node sweep requires exactly that and skips the
 * session otherwise — `idleSince` must be set, since the sweep measures the idle
 * window from it and treats a missing value as "not idle yet", and the bearer
 * token must be cleared, because leaving it in a surviving entry keeps a deleted
 * session's token accepted on every other replica.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { StringCodec, type KV } from "nats";

import { MULTI_NODE_IDLE_RECLAIM_MS } from "../src/config.js";
import { bindHandsKv } from "../src/sandbox/registry.js";
import { eligibleForClusterReclaim, parkForIdleReclaim } from "../src/sandbox/reaper.js";

const sc = StringCodec();

const SID = "sess-park-1";
const KEY = `hands.${SID}`;
const REVISION = 4;

interface Stub {
  store: Map<string, Uint8Array>;
  writes: Array<{ key: string; revision: number }>;
  deleted: string[];
}

function bindStub(opts: { entry?: unknown; getError?: Error; updateError?: Error }): Stub {
  const stub: Stub = { store: new Map(), writes: [], deleted: [] };
  if (opts.entry !== undefined) {
    stub.store.set(KEY, sc.encode(JSON.stringify(opts.entry)));
  }
  bindHandsKv({
    async get(key: string) {
      if (opts.getError) throw opts.getError;
      const value = stub.store.get(key);
      return value ? { key, value, revision: REVISION } : null;
    },
    async update(key: string, value: Uint8Array, revision: number) {
      if (opts.updateError) throw opts.updateError;
      stub.writes.push({ key, revision });
      stub.store.set(key, value);
      return REVISION + 1;
    },
    async delete(key: string) {
      stub.deleted.push(key);
      stub.store.delete(key);
    },
  } as unknown as KV);
  return stub;
}

function readBack(stub: Stub): Record<string, unknown> {
  return JSON.parse(sc.decode(stub.store.get(KEY)!)) as Record<string, unknown>;
}

test("the handle is marked idle so the multi-node sweep will claim it", async () => {
  const stub = bindStub({
    entry: { status: "ready", workloadId: "w1", platformKey: "safe-key" },
  });
  const before = Date.now();

  await parkForIdleReclaim(SID);

  const info = readBack(stub);
  assert.equal(info.keepalive, false, "the sweep requires exactly this");
  assert.ok(
    typeof info.idleSince === "number" && info.idleSince >= before,
    "the sweep measures the idle window from idleSince, and treats missing as not-idle",
  );
});

test("the handle is marked as the deleted-session kind of idle", async () => {
  // Which is what lets the sweep skip its idle window, returning the GPUs a
  // window sooner. Without the marker the wait applies, and since it equals the
  // bucket TTL, any entry the keepalive tick does not refresh -- a PENDING one, or
  // all of them where keepalive is switched off -- expires at the exact moment it
  // would have qualified.
  const stub = bindStub({ entry: { status: "ready", platformKey: "k" } });

  await parkForIdleReclaim(SID);

  assert.equal(readBack(stub).sessionDeleted, true);
});

test("a deleted session is eligible for reclaim at once", () => {
  const now = Date.now();

  assert.equal(
    eligibleForClusterReclaim({ keepalive: false, sessionDeleted: true, idleSince: now }, now),
    true,
    "nothing is coming to reuse this cluster, so the window would only delay the GPUs",
  );
});

test("a live session between messages still waits its idle window out", () => {
  // The window exists for this case and must survive the exception above: the
  // next message reuses a still-warm cluster instead of paying to build one.
  const now = Date.now();

  assert.equal(
    eligibleForClusterReclaim({ keepalive: false, idleSince: now }, now),
    false,
  );
  assert.equal(
    eligibleForClusterReclaim({ keepalive: false, idleSince: now - MULTI_NODE_IDLE_RECLAIM_MS }, now),
    true,
  );
});

test("a session with work in flight is never eligible, whatever else it says", () => {
  // keepalive is the only signal that no task is running, so no other field may
  // stand in for it -- including the deleted marker.
  const now = Date.now();

  assert.equal(
    eligibleForClusterReclaim({ sessionDeleted: true, idleSince: 1 }, now),
    false,
  );
});

test("the platform key is preserved, because the sweep authenticates with it", async () => {
  const stub = bindStub({
    entry: { status: "ready", workloadId: "w1", platformKey: "safe-key" },
  });

  await parkForIdleReclaim(SID);

  assert.equal(readBack(stub).platformKey, "safe-key");
  assert.equal(readBack(stub).workloadId, "w1");
});

test("the bearer token is cleared, because a surviving entry keeps it accepted", async () => {
  // revokeSessionHandsToken only clears the registry of the pod that runs it,
  // and isValidHandsToken falls back to scanning `hands.*` -- so a token left in
  // a parked entry stays valid on every other replica, and gets re-memoised
  // there on first use. handsUrl is the deliberate exception: a teardown that
  // could not confirm itself may have left the sandbox running, and the
  // health-check sweeper needs that endpoint to notice.
  const stub = bindStub({
    entry: {
      status: "ready",
      workloadId: "w1",
      platformKey: "safe-key",
      token: "hands-token-xyz",
      handsUrl: "http://sbx:9100/mcp",
    },
  });

  await parkForIdleReclaim(SID);

  const info = readBack(stub);
  assert.equal(info.token, "", "a parked entry must not carry a token that still validates");
  assert.equal(info.handsUrl, "http://sbx:9100/mcp", "kept, so the health sweeper can still probe");
});

test("the write is conditioned on the revision just read", async () => {
  // A concurrent teardown or task completion may be rewriting the same entry;
  // an unconditional put here could resurrect one that was just deleted.
  const stub = bindStub({ entry: { status: "ready", platformKey: "k" } });

  await parkForIdleReclaim(SID);

  assert.deepEqual(stub.writes, [{ key: KEY, revision: REVISION }]);
});

test("the handle is never deleted by this path", async () => {
  // Deleting is what the whole fallback exists to avoid: the sweep walks
  // `hands.*`, so dropping the entry removes the only way to find the session.
  const stub = bindStub({ entry: { status: "ready", platformKey: "k" } });

  await parkForIdleReclaim(SID);

  assert.deepEqual(stub.deleted, []);
});

test("an already-gone handle is not recreated", async () => {
  // Another replica finished the teardown and deleted it. Writing it back would
  // resurrect a handle for a session that is genuinely done.
  const stub = bindStub({});

  await parkForIdleReclaim(SID);

  assert.deepEqual(stub.writes, []);
  assert.equal(stub.store.has(KEY), false);
});

test("a KV failure is swallowed rather than escaping the cleanup handler", async () => {
  // This runs in a `finally` inside the cleanup subscriber's `for await` loop,
  // which has no per-message catch: an escaping error would stop that replica
  // from handling any further session deletes.
  bindStub({ getError: new Error("TIMEOUT") });
  await parkForIdleReclaim(SID);

  bindStub({ entry: { status: "ready" }, updateError: new Error("CONNECTION_CLOSED") });
  await parkForIdleReclaim(SID);
});
