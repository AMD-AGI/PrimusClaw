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

function memoryStore(seed: Record<string, string | null> = {}): HandsKeyStore & {
  map: Map<string, string | null>;
} {
  const map = new Map(Object.entries(seed));
  return {
    map,
    async keys(filter) {
      const re = new RegExp(`^${filter.replace(/[.]/g, "\\.").replace(/\*/g, ".*")}$`);
      return [...map.keys()].filter((k) => re.test(k));
    },
    async get(key) {
      if (!map.has(key)) return null;
      const value = map.get(key)!;
      // A stored null stands for an entry that exists and cannot be read.
      if (value === null) throw new Error("unreadable");
      return value;
    },
    async put(key, value) { map.set(key, value); },
    async delete(key) { map.delete(key); },
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
  assert.equal(store.map.get(moved), session(colliding));
  assert.equal(sessionIdFromHandsKey(moved), colliding,
    "and the session is still reachable under the key every reader now derives");
});

test("a retention's own entry is left exactly as it is", async () => {
  const key = `hands.${RETAINED_PREFIX}GENAAA`;
  const store = memoryStore({ [key]: retention() });

  const result = await migrateReservedSessionKeys(store);

  assert.deepEqual(result.migrated, []);
  assert.equal(store.map.get(key), retention(),
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
  assert.equal(store.map.get(handsSessionKey(colliding)), session("someone-else"),
    "two sessions cannot both own one binding");
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
