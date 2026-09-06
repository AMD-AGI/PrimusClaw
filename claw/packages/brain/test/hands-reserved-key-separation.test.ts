// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * B41 -- the reserved retention namespace has to be separate from session keys
 * at upgrade time, for entries that already exist.
 *
 * The separation is carried by the entry's value, not by the key's shape: only
 * a retention writes the protection marker, so a session binding that happens
 * to sit under the prefix is unambiguously not one. What that alone does not
 * cover is the one generation whose key such a binding occupies -- a container
 * retained under it could not keep its binding and would be reclaimed as idle
 * with its work in it. There is no automatic repair that is safe during a
 * rolling upgrade, because a key one replica moves is one the others still read
 * under its old name, so the deployment is refused instead.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  RETAINED_PREFIX, ReservedKeyCollision, assertRetentionSeparation,
  handsSessionKey, isReservedRetentionKey, isRetentionEntry, sessionIdFromHandsKey,
  type HandsKeyStore,
} from "../src/sandbox/hands-key.js";
import { matchesKvFilter } from "./fixtures/kv-filter.js";

function memoryStore(seed: Record<string, string | null> = {}): HandsKeyStore {
  const map = new Map(Object.entries(seed));
  return {
    async keys(filter) {
      return [...map.keys()].filter((k) => matchesKvFilter(k, filter));
    },
    async read(key) {
      if (!map.has(key)) return null;
      const value = map.get(key)!;
      // A stored null stands for an entry that exists and cannot be read.
      if (value === null) throw new Error("unreadable");
      return { value };
    },
  };
}

const session = (id: string) => JSON.stringify({ status: "ready", handsUrl: `http://${id}/mcp` });
const retention = () => JSON.stringify({ status: "ready", protected: true, handsUrl: "http://kept/mcp" });

test("a session key is the session id, and stays that way", () => {
  // Re-keying a colliding id was tried and is worse than what it fixed: through
  // a rolling upgrade one side would move a key the other still reads under its
  // old name, producing two divergent bindings for one session.
  for (const id of ["sess_ordinary", `${RETAINED_PREFIX}odd`, "=weird"]) {
    assert.equal(handsSessionKey(id), `hands.${id}`, id);
    assert.equal(sessionIdFromHandsKey(handsSessionKey(id)), id, id);
  }
});

test("the value tells a retention from a session, whatever the key looks like", () => {
  assert.equal(isRetentionEntry(JSON.parse(retention())), true);
  assert.equal(isRetentionEntry(JSON.parse(session("x"))), false,
    "a session entry under the prefix inherits nothing from sitting there");
  assert.equal(isReservedRetentionKey(`hands.${RETAINED_PREFIX}GEN`), true);
  assert.equal(isReservedRetentionKey("hands.sess_ordinary"), false);
});

test("a pre-existing session binding under the reserved prefix refuses the deployment", async () => {
  const colliding = `${RETAINED_PREFIX}ABCDEF`;
  const store = memoryStore({
    "hands.sess_ordinary": session("ordinary"),
    [`hands.${colliding}`]: session(colliding),
  });

  await assert.rejects(
    () => assertRetentionSeparation(store),
    (err: unknown) => err instanceof ReservedKeyCollision
      && err.message.includes(`hands.${colliding}`)
      && /reclaimed with its work/.test(err.message),
    "named, and with the consequence stated, because the repair is an operator's",
  );
});

test("a retention's own entry is not a collision", async () => {
  const store = memoryStore({
    [`hands.${RETAINED_PREFIX}GEN`]: retention(),
    "hands.sess_ordinary": session("ordinary"),
  });
  await assert.doesNotReject(() => assertRetentionSeparation(store));
});

test("an entry that cannot be read is refused, not passed over", async () => {
  // It may be either, and a check that passed on what it could not open would
  // be no check.
  for (const broken of [null, "{not json"]) {
    const store = memoryStore({ [`hands.${RETAINED_PREFIX}BROKEN`]: broken });
    await assert.rejects(() => assertRetentionSeparation(store), ReservedKeyCollision, String(broken));
  }
});

test("an ordinary deployment starts", async () => {
  const store = memoryStore({
    "hands.sess_a": session("a"),
    "hands.sess_b": session("b"),
  });
  await assert.doesNotReject(() => assertRetentionSeparation(store));
  await assert.doesNotReject(() => assertRetentionSeparation(memoryStore()));
});

test("the walk asks for whole session keys, because a wildcard is one token", async () => {
  // A filter spelling the marker into the token matches nothing at all, and the
  // check would report a namespace it never looked at.
  const asked: string[] = [];
  const store: HandsKeyStore = {
    async keys(filter) { asked.push(filter); return []; },
    async read() { return null; },
  };
  await assertRetentionSeparation(store);
  assert.deepEqual(asked, ["hands.*"]);
  assert.ok(!matchesKvFilter(`hands.${RETAINED_PREFIX}X`, `hands.${RETAINED_PREFIX}*`));
  assert.ok(matchesKvFilter(`hands.${RETAINED_PREFIX}X`, "hands.*"));
});
