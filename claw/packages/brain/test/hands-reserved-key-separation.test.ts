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
  handsSessionKey, isReservedRetentionKey, isRetentionEntry,
  migrateReservedSessionKeys, sessionIdFromHandsKey, type HandsKeyStore,
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
    async replace(key, value, expectedRevision) {
      if (map.get(key)?.revision !== expectedRevision) return false;
      map.set(key, { value, revision: expectedRevision + 1 });
      return true;
    },
    async delete(key, expectedRevision) {
      if (map.get(key)?.revision !== expectedRevision) return false;
      map.delete(key);
      return true;
    },
  };
}

const session = (id: string, createdAt = "2026-01-01T00:00:00.000Z") =>
  JSON.stringify({ status: "ready", handsUrl: `http://${id}/mcp`, createdAt });
const retention = () => JSON.stringify({ status: "ready", protected: true, handsUrl: "http://kept/mcp" });

test("no session id can be keyed into the reserved namespace", () => {
  // The forward half: total and injective, so a plain key never begins with
  // either marker and no two ids share a key.
  assert.equal(handsSessionKey("sess_ordinary"), "hands.sess_ordinary");
  const key = handsSessionKey(`${RETAINED_PREFIX}odd`);
  assert.ok(!isReservedRetentionKey(key), "re-keyed out of the reserved namespace");
  assert.equal(sessionIdFromHandsKey(key), `${RETAINED_PREFIX}odd`, "and still resolves back");
  assert.notEqual(handsSessionKey(`${RETAINED_PREFIX}a`), handsSessionKey(`${RETAINED_PREFIX}b`));
});

test("a pre-existing colliding entry is migrated out, collision-safely", async () => {
  const colliding = `${RETAINED_PREFIX}ABCDEF`;
  const store = memoryStore({ [`hands.${colliding}`]: session(colliding) });

  const result = await migrateReservedSessionKeys(store);

  assert.deepEqual(result.migrated, [`hands.${colliding}`]);
  assert.equal(store.map.has(`hands.${colliding}`), false, "the reserved key is free");
  assert.equal(store.map.get(handsSessionKey(colliding))!.value, session(colliding),
    "and the session is reachable under the key every reader now derives");
  await assert.doesNotReject(() => assertRetentionSeparation(store));
});

test("a migration that crashed between the copy and the delete resumes", async () => {
  const colliding = `${RETAINED_PREFIX}HALFWAY`;
  const store = memoryStore({
    [`hands.${colliding}`]: session(colliding),
    [handsSessionKey(colliding)]: session(colliding),
  });

  const result = await migrateReservedSessionKeys(store);

  assert.deepEqual(result.resumed, [`hands.${colliding}`]);
  assert.deepEqual(result.conflicted, [], "not a conflict, and not a refusal to start");
  assert.equal(store.map.has(`hands.${colliding}`), false, "the delete is finished");
});

test("a destination another replica already wrote differently is never overwritten", async () => {
  const colliding = `${RETAINED_PREFIX}TAKEN`;
  const store = memoryStore({
    [`hands.${colliding}`]: session(colliding),
    [handsSessionKey(colliding)]: session("someone-else"),
  });

  const result = await migrateReservedSessionKeys(store);

  assert.deepEqual(result.conflicted, [`hands.${colliding}`]);
  assert.equal(store.map.get(handsSessionKey(colliding))!.value, session("someone-else"));
  await assert.rejects(() => assertRetentionSeparation(store), ReservedKeyCollision,
    "and what the migration could not resolve refuses the deployment");
});

test("a source rewritten between the read and the delete keeps its entry", async () => {
  const colliding = `${RETAINED_PREFIX}BUSY`;
  const store = memoryStore({ [`hands.${colliding}`]: session(colliding) });
  store.bumpOnRead.add(`hands.${colliding}`);

  const result = await migrateReservedSessionKeys(store);

  assert.deepEqual(result.migrated, []);
  assert.deepEqual(result.conflicted, [`hands.${colliding}`]);
  assert.ok(store.map.has(`hands.${colliding}`), "reported for repair, not destroyed");
});

test("the value tells a retention from a session, whatever the key looks like", () => {
  assert.equal(isRetentionEntry(JSON.parse(retention())), true);
  assert.equal(isRetentionEntry(JSON.parse(session("x"))), false,
    "a session entry under the prefix inherits nothing from sitting there");
  assert.equal(isReservedRetentionKey(`hands.${RETAINED_PREFIX}GEN`), true);
  assert.equal(isReservedRetentionKey("hands.sess_ordinary"), false);
});

test("a collision the migration could not resolve refuses the deployment", async () => {
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

test("an id whose key shape would be ambiguous is refused, not encoded", () => {
  // A single-character marker could not separate an encoded key from a raw id
  // that happened to look like one -- `=MZXW6` is valid base32, so it decoded
  // to something no session answered to. The marker's second character is
  // outside base32, and an id carrying it has no unambiguous key at all, so it
  // is rejected by name rather than repaired.
  assert.doesNotThrow(() => handsSessionKey("=MZXW6"),
    "a single = is an ordinary id now; only the two-character marker is reserved");
  assert.equal(handsSessionKey("=MZXW6"), "hands.=MZXW6");
  assert.equal(sessionIdFromHandsKey("hands.=MZXW6"), "=MZXW6");

  assert.throws(() => handsSessionKey("=.looks-encoded"), /no unambiguous key/);
});

test("a validly base32-shaped raw id is not mistaken for an encoded key", async () => {
  // The case the old rule got wrong: nothing about this id's remainder should
  // make the scan treat its key as one this scheme wrote.
  const raw = "=MZXW6";
  const store = memoryStore({ [`hands.${raw}`]: session(raw) });

  const result = await migrateReservedSessionKeys(store);

  assert.deepEqual(result.migrated, [], "an ordinary id needs no migration");
  assert.deepEqual(result.conflicted, []);
  assert.equal(store.map.get(`hands.${raw}`)!.value, session(raw), "and is left alone");
  assert.equal(sessionIdFromHandsKey(`hands.${raw}`), raw);
});

test("a properly encoded key is not mistaken for a legacy one", async () => {
  // The scan has to tell an entry this scheme wrote from one that predates it,
  // or every sweep would migrate its own output forever.
  const encoded = handsSessionKey(`${RETAINED_PREFIX}x`);
  const store = memoryStore({ [encoded]: session("x") });

  const result = await migrateReservedSessionKeys(store);

  assert.deepEqual(result.migrated, []);
  assert.deepEqual(result.conflicted, []);
  assert.ok(store.map.has(encoded));
});

test("an old reader and a new writer overlap without either losing the binding", async () => {
  // The rollout window itself: an old pod reads and writes only the legacy
  // name and knows nothing of the other. A new pod that looked at the canonical
  // key alone would read a live session as having no sandbox and provision a
  // second, so it reads through -- and the migration is what eventually retires
  // the legacy name once no old pod is writing it.
  const colliding = `${RETAINED_PREFIX}OVERLAP`;
  const legacy = `hands.${colliding}`;
  const store = memoryStore({ [legacy]: session("written-by-an-old-pod") });

  // Before the migration runs, the new-format destination does not exist.
  assert.equal(store.map.has(handsSessionKey(colliding)), false);
  // A read-through finds the binding under the name the old pod wrote.
  const readThrough = async (id: string) =>
    (await store.read(handsSessionKey(id))) ?? (await store.read(`hands.${id}`));
  assert.equal((await readThrough(colliding))!.value, session("written-by-an-old-pod"));

  await migrateReservedSessionKeys(store);
  assert.equal((await readThrough(colliding))!.value, session("written-by-an-old-pod"),
    "and it still resolves afterwards, now under the canonical name");

  // An old pod writing again mid-window re-creates the legacy key with a newer
  // binding. Two names for one session never converge on their own: one is
  // routed to and the other swept, so the pair is resolved rather than reported
  // and left. The newer binding names the sandbox that replaced the other.
  const newer = session("written-again", "2026-06-01T00:00:00.000Z");
  store.map.set(legacy, { value: newer, revision: 1 });

  const second = await migrateReservedSessionKeys(store);

  assert.deepEqual(second.converged, [legacy]);
  assert.deepEqual(second.conflicted, []);
  assert.equal(store.map.has(legacy), false, "one binding, under one name");
  assert.equal((await readThrough(colliding))!.value, newer);
});

test("an older stray never overwrites the binding that replaced it", async () => {
  // The other direction of the same race: convergence has to pick the live
  // sandbox, not whichever key the scan happened to walk.
  const colliding = `${RETAINED_PREFIX}STALE`;
  const store = memoryStore({
    [`hands.${colliding}`]: session("older", "2026-01-01T00:00:00.000Z"),
    [handsSessionKey(colliding)]: session("newer", "2026-06-01T00:00:00.000Z"),
  });

  const result = await migrateReservedSessionKeys(store);

  assert.deepEqual(result.converged, []);
  assert.deepEqual(result.conflicted, [`hands.${colliding}`]);
  assert.equal(store.map.get(handsSessionKey(colliding))!.value,
    session("newer", "2026-06-01T00:00:00.000Z"),
    "the newer binding stands and the operator is told about the stray");
});
