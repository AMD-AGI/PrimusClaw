// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a deleted session's `hands.<sid>` handle is left as, and why.
 *
 * The session's GPU clusters are reached only through the cleanup notification,
 * an unretried core-NATS publish: when no Brain replica is up at that moment it
 * is lost. The delete handler destroys the sandbox workload itself, but it has
 * no way to address the clusters -- their workload id is the message id, nothing
 * records them, and only a CLAW_SESSION_ID list query can enumerate them. So the
 * handle is parked rather than deleted, and Brain's idle sweeper reclaims them
 * from it.
 *
 * That makes the exact shape of the parked entry the contract, and each field
 * below is load-bearing for a different reader.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { StringCodec, type KV } from "nats";

import { parkHandsForIdleReclaim } from "../src/sessions/teardown.js";

const sc = StringCodec();

const SID = "sess-park-api-1";
const KEY = `hands.${SID}`;
const REVISION = 7;

interface Stub {
  kv: KV;
  store: Map<string, Uint8Array>;
  writes: Array<{ key: string; revision: number }>;
  deleted: string[];
}

function makeStub(opts: {
  entry?: unknown;
  getError?: Error;
  updateError?: Error;
}): Stub {
  const store = new Map<string, Uint8Array>();
  const writes: Array<{ key: string; revision: number }> = [];
  const deleted: string[] = [];
  if (opts.entry !== undefined) {
    store.set(KEY, sc.encode(JSON.stringify(opts.entry)));
  }
  const kv = {
    async get(key: string) {
      if (opts.getError) throw opts.getError;
      const value = store.get(key);
      return value ? { key, value, revision: REVISION } : null;
    },
    async update(key: string, value: Uint8Array, revision: number) {
      if (opts.updateError) throw opts.updateError;
      writes.push({ key, revision });
      store.set(key, value);
      return REVISION + 1;
    },
    // Kept only so the assertions can prove it is never called: parking must not
    // remove an entry, since the entry is the only route back to the clusters.
    async delete(key: string) {
      deleted.push(key);
      store.delete(key);
    },
  } as unknown as KV;
  return { kv, store, writes, deleted };
}

function readBack(stub: Stub): Record<string, unknown> {
  return JSON.parse(sc.decode(stub.store.get(KEY)!)) as Record<string, unknown>;
}

function readyEntry(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "ready",
    workloadId: "wl-1",
    platformKey: "safe-key",
    token: "hands-token-abc",
    handsUrl: "http://sbx:9100/mcp",
    ...extra,
  };
}

test("the handle is marked idle, which is what the multi-node sweep selects on", async () => {
  const stub = makeStub({ entry: readyEntry() });
  const before = Date.now();

  await parkHandsForIdleReclaim(stub.kv, SID);

  const info = readBack(stub);
  assert.equal(info.keepalive, false, "the sweep skips any session without exactly this");
  assert.ok(
    typeof info.idleSince === "number" && info.idleSince >= before,
    "the sweep measures the idle window from idleSince and reads missing as not-idle",
  );
  assert.deepEqual(stub.deleted, [], "deleting is what parking exists to avoid");
});

test("the handle is marked as the deleted-session kind of idle", async () => {
  // Brain's sweep reclaims these without waiting out its idle threshold, which
  // usually just returns the GPUs sooner. It matters more from here: that
  // threshold equals the bucket TTL, so an entry nobody refreshes expires exactly
  // as it becomes eligible, and the case this parking exists for is the one where
  // no Brain replica was up to do the refreshing.
  const stub = makeStub({ entry: readyEntry() });

  await parkHandsForIdleReclaim(stub.kv, SID);

  assert.equal(readBack(stub).sessionDeleted, true);
});

test("the platform key survives, because the sweep authenticates the DELETEs with it", async () => {
  const stub = makeStub({ entry: readyEntry() });

  await parkHandsForIdleReclaim(stub.kv, SID);

  assert.equal(readBack(stub).platformKey, "safe-key");
});

test("status is left as it was", async () => {
  // Parking says nothing about what state the sandbox reached, and other readers
  // still act on it: collectTargets only refreshes the TTL of a ready entry, and
  // the health-check sweep skips anything pending.
  const stub = makeStub({ entry: readyEntry() });

  await parkHandsForIdleReclaim(stub.kv, SID);

  assert.equal(readBack(stub).status, "ready");
});

test("the bearer token is cleared and the hands URL is kept", async () => {
  // The token, because a surviving entry keeps a deleted session's token accepted
  // on every replica -- isValidHandsToken falls back to scanning `hands.*`.
  //
  // The URL stays, because the health-check sweep skips an entry without one and
  // the pod may well still be running: this handler's own destroy reaches only a
  // SaFE workload with a platform key and a configured API URL, which leaves the
  // agent-sandbox mode and the empty-key case untouched.
  const stub = makeStub({ entry: readyEntry() });

  await parkHandsForIdleReclaim(stub.kv, SID);

  const info = readBack(stub);
  assert.equal(info.token, "");
  assert.equal(info.handsUrl, "http://sbx:9100/mcp");
});

test("the write is conditioned on the revision just read", async () => {
  // Brain's own teardown deletes this entry concurrently. An unconditional put
  // would resurrect the handle of a session that is genuinely finished, and
  // collectTargets would then hold its platform key alive for the whole reuse
  // window.
  const stub = makeStub({ entry: readyEntry() });

  await parkHandsForIdleReclaim(stub.kv, SID);

  assert.deepEqual(stub.writes, [{ key: KEY, revision: REVISION }]);
});

test("a pending handle is parked too", async () => {
  // An in-flight ensureHands may already have provisioned workloads, and this
  // entry's platform key is the only way back to them -- dropping it strands
  // whatever was created. Nothing refreshes a PENDING entry's TTL either -- the
  // keepalive tick does refresh parked handles, but takes only READY ones -- so
  // unlike those this could never survive to clear the idle window. Here
  // `sessionDeleted` is not just faster, it is what makes acting on the entry
  // possible at all.
  const stub = makeStub({
    entry: { status: "pending", workloadId: "wl-1", platformKey: "safe-key" },
  });

  await parkHandsForIdleReclaim(stub.kv, SID);

  assert.deepEqual(stub.deleted, [], "dropping it would strand the platform key");
  const info = readBack(stub);
  assert.equal(info.keepalive, false);
  assert.equal(info.sessionDeleted, true);
  assert.equal(info.platformKey, "safe-key");
});

test("an already-gone handle is not recreated", async () => {
  // Brain's teardown confirmed and deleted it first. Writing it back would
  // resurrect a handle for a session with nothing left to reclaim.
  const stub = makeStub({});

  await parkHandsForIdleReclaim(stub.kv, SID);

  assert.deepEqual(stub.writes, []);
  assert.equal(stub.store.has(KEY), false);
});

test("a KV failure never escapes into the delete handler", async () => {
  // This runs partway through DELETE /v1/sessions/:id, after the sandbox has
  // been destroyed and before the DB rows are soft-deleted. An escaping error
  // would fail the request and leave the session half-deleted.
  //
  // Every branch is driven through here, including both halves of the error
  // triage: `wrong last sequence` is a Brain replica getting there first, which
  // is routine, while any other failure costs the reclaim path and is warned
  // about. The levels themselves are not asserted -- this module's pino instance
  // writes to a destination with no seam to capture.
  await parkHandsForIdleReclaim(makeStub({ getError: new Error("TIMEOUT") }).kv, SID);
  await parkHandsForIdleReclaim(
    makeStub({ entry: readyEntry(), updateError: new Error("wrong last sequence") }).kv,
    SID,
  );
  await parkHandsForIdleReclaim(
    makeStub({ entry: readyEntry(), updateError: new Error("CONNECTION_CLOSED") }).kv,
    SID,
  );
});
