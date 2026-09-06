// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * B41 -- the reserved retention namespace has to be disjoint at upgrade time,
 * not only for keys minted afterwards.
 *
 * A container retained because it still holds live work keeps its binding in
 * the keyspace the keepalive sweep walks, under the fixed marker `retained-`
 * followed by the sandbox generation. Refusing to mint new session keys under
 * that marker protects a fresh deployment and nothing else: a session whose own
 * id already begins with it is indistinguishable from a retention by key shape,
 * so the first retention minted under a matching generation writes over a live
 * session's binding -- and the sweep then pings one of them and reclaims the
 * other as idle.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  RETAINED_PREFIX, handsSessionKey, migrateReservedSessionKeys, sessionIdFromHandsKey,
  type HandsKeyStore,
} from "../src/sandbox/hands-key.js";
import { matchesKvFilter } from "./fixtures/kv-filter.js";

function memoryStore(seed: Record<string, string | null> = {}): HandsKeyStore & {
  map: Map<string, { value: string | null; revision: number }>;
  bumpOnRead: Set<string>;
} {
  const map = new Map(
    Object.entries(seed).map(([k, v]) => [k, { value: v, revision: 1 }] as const),
  );
  /** Keys another writer rewrites between the read and the delete. */
  const bumpOnRead = new Set<string>();
  return {
    map,
    bumpOnRead,
    async keys(filter) {
      return [...map.keys()].filter((k) => matchesKvFilter(k, filter));
    },
    async read(key) {
      const entry = map.get(key);
      if (!entry) return null;
      // A stored null stands for an entry that exists and cannot be read.
      if (entry.value === null) throw new Error("unreadable");
      const seen = { value: entry.value, revision: entry.revision };
      if (bumpOnRead.has(key)) map.set(key, { ...entry, revision: entry.revision + 1 });
      return seen;
    },
    async create(key, value) {
      if (map.has(key)) return false;
      map.set(key, { value, revision: 1 });
      return true;
    },
    async delete(key, expectedRevision) {
      if (map.get(key)?.revision !== expectedRevision) return false;
      map.delete(key);
      return true;
    },
  };
}

const session = (id: string) => JSON.stringify({ status: "ready", handsUrl: `http://${id}/mcp` });
const retention = () => JSON.stringify({ status: "ready", protected: true, handsUrl: "http://kept/mcp" });

test("a session already sitting under the reserved marker is moved out of it", async () => {
  const colliding = `${RETAINED_PREFIX}ABCDEF`;
  const store = memoryStore({ [`hands.${colliding}`]: session(colliding) });

  const result = await migrateReservedSessionKeys(store);

  assert.deepEqual(result.migrated, [`hands.${colliding}`]);
  assert.equal(store.map.has(`hands.${colliding}`), false,
    "the reserved key is free, so a retention can take it without destroying a session");
  const moved = handsSessionKey(colliding);
  assert.equal(store.map.get(moved)!.value, session(colliding));
  assert.equal(sessionIdFromHandsKey(moved), colliding,
    "and the session is still reachable under the key every reader now derives");
});

test("a retention's own entry is left exactly as it is", async () => {
  const key = `hands.${RETAINED_PREFIX}GENAAA`;
  const store = memoryStore({ [key]: retention() });

  const result = await migrateReservedSessionKeys(store);

  assert.deepEqual(result.migrated, []);
  assert.equal(store.map.get(key)!.value, retention(),
    "protection is carried in the value, so the marker in the key is not what "
      + "decides which entries are a retention's");
});

test("an unreadable entry fails the migration rather than being dropped", async () => {
  // It may name a live sandbox. Deleting it, or passing over it silently, is
  // precisely the loss this scan exists to prevent.
  const key = `hands.${RETAINED_PREFIX}BROKEN`;
  const store = memoryStore({ [key]: null, [`hands.${RETAINED_PREFIX}BADJSON`]: "{not json" });

  const result = await migrateReservedSessionKeys(store);

  assert.deepEqual(result.conflicted.sort(), [key, `hands.${RETAINED_PREFIX}BADJSON`].sort());
  assert.deepEqual(result.migrated, []);
  assert.ok(store.map.has(key), "left in place for operator repair");
});

test("a destination already occupied is reported, never overwritten", async () => {
  const colliding = `${RETAINED_PREFIX}TAKEN`;
  const store = memoryStore({
    [`hands.${colliding}`]: session(colliding),
    [handsSessionKey(colliding)]: session("someone-else"),
  });

  const result = await migrateReservedSessionKeys(store);

  assert.deepEqual(result.conflicted, [`hands.${colliding}`]);
  assert.equal(store.map.get(handsSessionKey(colliding))!.value, session("someone-else"),
    "two sessions cannot both own one binding");
});

test("a migration that crashed between the copy and the delete resumes", async () => {
  // Both keys exist and the destination holds this move's own bytes. Calling
  // that a conflict makes the next startup refuse to boot on its own unfinished
  // work, with no way forward but a manual edit.
  const colliding = `${RETAINED_PREFIX}HALFWAY`;
  const store = memoryStore({
    [`hands.${colliding}`]: session(colliding),
    [handsSessionKey(colliding)]: session(colliding),
  });

  const result = await migrateReservedSessionKeys(store);

  assert.deepEqual(result.resumed, [`hands.${colliding}`]);
  assert.deepEqual(result.conflicted, [], "not a conflict, and not a refusal to start");
  assert.equal(store.map.has(`hands.${colliding}`), false, "the delete is finished");
  assert.equal(store.map.get(handsSessionKey(colliding))!.value, session(colliding));
});

test("a destination another replica just wrote is never overwritten", async () => {
  // A rolling upgrade runs this scan on several replicas at once against one
  // bucket. Create-not-put is what makes the second one a no-op instead of a
  // write over the first one's copy.
  const colliding = `${RETAINED_PREFIX}RACE`;
  const store = memoryStore({ [`hands.${colliding}`]: session(colliding) });
  store.map.set(handsSessionKey(colliding), { value: session("already-copied"), revision: 1 });

  const result = await migrateReservedSessionKeys(store);

  assert.deepEqual(result.conflicted, [`hands.${colliding}`],
    "different content is a different session, and overwriting it loses a live binding");
  assert.equal(store.map.get(handsSessionKey(colliding))!.value, session("already-copied"));
});

test("a source rewritten between the read and the delete keeps its entry", async () => {
  // The delete is conditioned on the revision the copied value came from, so a
  // session that rewrote its own binding meanwhile is not deleted out from
  // under itself.
  const colliding = `${RETAINED_PREFIX}BUSY`;
  const store = memoryStore({ [`hands.${colliding}`]: session(colliding) });
  store.bumpOnRead.add(`hands.${colliding}`);

  const result = await migrateReservedSessionKeys(store);

  assert.deepEqual(result.migrated, []);
  assert.deepEqual(result.conflicted, [`hands.${colliding}`]);
  assert.ok(store.map.has(`hands.${colliding}`), "reported for repair, not destroyed");
});

test("no session id can be keyed into the reserved namespace afterwards", () => {
  // The forward half of the same guarantee: the mapping is total and injective,
  // so a plain key never begins with the marker and no two ids share a key.
  for (const id of [`${RETAINED_PREFIX}x`, "=already-rekeyed", "ordinary-session"]) {
    const key = handsSessionKey(id);
    assert.ok(!key.slice("hands.".length).startsWith(RETAINED_PREFIX), id);
    assert.equal(sessionIdFromHandsKey(key), id, id);
  }
  assert.notEqual(handsSessionKey(`${RETAINED_PREFIX}a`), handsSessionKey(`${RETAINED_PREFIX}b`));
});
