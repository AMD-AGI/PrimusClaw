// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * B41 -- the retention namespace stays separate for the length of an upgrade,
 * not only at the moment the migration ran.
 *
 * A session whose id begins with the reserved marker has a pre-migration key
 * that is byte-for-byte a retention's key for one generation. The migration
 * moves such a binding to the canonical name and removes the old one -- and an
 * old replica, which knows only the old name, writes it back afterwards. A
 * retention minted in that window must not write over it: the binding names a
 * live sandbox, and replacing it leaves that sandbox reachable by nothing.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  RetentionKeyCollision, retainContainer, retentionKey, type RetentionStore,
} from "../src/sandbox/retain-container.js";
import { handsSessionKey, legacyHandsKey, RETAINED_PREFIX } from "../src/sandbox/hands-key.js";
import { encodeKeyPart } from "@claw/protocol";

/** The generation whose retention key is also this session's pre-migration one. */
const GENERATION = "sb-generation-1";
const COLLIDING_SESSION = `${RETAINED_PREFIX}${encodeKeyPart(GENERATION)}`;
const SESSION_BINDING = JSON.stringify({
  status: "ready", provider: "safe-workload", workloadId: "wl-live",
  handsUrl: "http://sandbox-live:9100/mcp",
});

function memoryStore(seed: Record<string, string> = {}): RetentionStore & {
  map: Map<string, { value: string; revision: number }>;
} {
  const map = new Map(
    Object.entries(seed).map(([k, v]) => [k, { value: v, revision: 1 }] as const),
  );
  return {
    map,
    async read(key) {
      const entry = map.get(key);
      return entry ? { value: entry.value, revision: entry.revision } : null;
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
    async delete(key) { map.delete(key); },
  };
}

const retain = (store: RetentionStore, sessionKey: string) => retainContainer({
  store,
  sessionKey,
  generation: GENERATION,
  binding: { status: "ready", workloadId: "wl-retained" },
  verdict: "protected",
  detail: "live_work_present",
});

test("a binding an old replica rewrote under the reserved name is not written over", async () => {
  // Exactly the interleaving the migration window admits: the scan moved this
  // session's binding to the canonical key and deleted the old one, an old
  // replica wrote the old name again, and a retention for the matching
  // generation now wants that key.
  const store = memoryStore({ [legacyHandsKey(COLLIDING_SESSION)]: SESSION_BINDING });
  const other = handsSessionKey("sess-retaining");
  store.map.set(other, { value: SESSION_BINDING, revision: 1 });

  await assert.rejects(() => retain(store, other), RetentionKeyCollision);

  assert.equal(store.map.get(retentionKey(GENERATION))!.value, SESSION_BINDING,
    "the live session's binding is exactly as the old replica left it");
  assert.ok(store.map.has(other),
    "and the retaining session keeps its own binding, so its container is still named");
});

test("a retention already under the key is this generation's own, and is refreshed", async () => {
  // A crash between the two writes leaves the retention key taken and the
  // session key still there. Calling that a collision would refuse the repair
  // of the process's own unfinished work.
  const store = memoryStore();
  const sessionKey = handsSessionKey("sess-retaining");
  store.map.set(sessionKey, { value: SESSION_BINDING, revision: 1 });
  await retain(store, sessionKey);
  store.map.set(sessionKey, { value: SESSION_BINDING, revision: 1 });

  await assert.doesNotReject(() => retain(store, sessionKey));

  const held = JSON.parse(store.map.get(retentionKey(GENERATION))!.value) as
    { protected: boolean };
  assert.equal(held.protected, true);
  assert.equal(store.map.has(sessionKey), false, "and the session key goes, as it did the first time");
});

test("a free key is taken and the session key released, as before", async () => {
  const store = memoryStore();
  const sessionKey = handsSessionKey("sess-retaining");
  store.map.set(sessionKey, { value: SESSION_BINDING, revision: 1 });

  const key = await retain(store, sessionKey);

  assert.equal(key, retentionKey(GENERATION));
  assert.equal(store.map.has(sessionKey), false);
});
