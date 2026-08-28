// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Validating a token nobody issued is the expensive case, and it is the one an
 * attacker controls.
 *
 * A hit on the token cache is O(1). A miss walks the whole `hands.*` bucket
 * with a `get` per key, and then the whole DAG handle bucket the same way. The
 * caller is the internal endpoint that serves the Hands binary to code running
 * *inside* a sandbox, so a bogus token can be replayed as fast as the network
 * allows and each replay pays for both scans against NATS. Remembering the
 * denial bounds that to one scan per token per window.
 *
 * The denial must not outlive issuance, though: a sandbox coming up fetches
 * its binary moments after its token is written.
 */
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { StringCodec } from "nats";
import type { KV } from "nats";
import {
  bindHandsKv,
  isValidHandsToken,
  registerHandsToken,
  revokeHandsToken,
} from "../src/sandbox/registry.js";
import { bindDagHandleKvForTest } from "../src/sandbox/handles.js";

const sc = StringCodec();
let restoreDag: (() => void) | null = null;
afterEach(() => { restoreDag?.(); restoreDag = null; });

/** Both buckets, counting every read the validation performs. */
function countingBuckets(handsEntries: Record<string, unknown>): { reads: () => number } {
  let reads = 0;
  const handsKv = {
    async keys() {
      return (async function* () { for (const k of Object.keys(handsEntries)) yield k; })();
    },
    async get(key: string) {
      reads += 1;
      const v = handsEntries[key];
      return v ? { key, value: sc.encode(JSON.stringify(v)), revision: 1 } : null;
    },
    async put() { return 1; },
    async delete() {},
  } as unknown as KV;
  const dagKv = {
    async keys() {
      return (async function* () { yield "dag-root-1"; })();
    },
    async get(key: string) {
      reads += 1;
      return { key, value: sc.encode(JSON.stringify({ main: { token: "handle-token" } })), revision: 1 };
    },
  };
  bindHandsKv(handsKv);
  restoreDag = bindDagHandleKvForTest(dagKv as never);
  return { reads: () => reads };
}

test("a token nobody issued is only looked up once", async () => {
  const { reads } = countingBuckets({
    "hands.s1": { token: "real-token" },
    "hands.s2": { token: "other-token" },
  });

  assert.equal(await isValidHandsToken("bogus"), false);
  const afterFirst = reads();
  assert.ok(afterFirst > 0, "the first attempt has to actually search");

  for (let i = 0; i < 5; i++) {
    assert.equal(await isValidHandsToken("bogus"), false, "still denied");
  }
  assert.equal(reads(), afterFirst,
    `a replayed bogus token must cost nothing; ${reads() - afterFirst} extra `
    + `KV reads means the endpoint can be used to hammer NATS`);
});

test("a denial recorded before a token existed does not outlive it", async () => {
  // The positive lookup runs first, so while a token sits in the token map the
  // denial cannot be reached. It becomes reachable again the moment the token
  // leaves that map -- an LRU eviction on a busy deployment, or the revocation
  // below -- and a denial recorded before the token was ever issued must not be
  // what answers then. Clearing it at issuance is what keeps the two in step.
  const { reads } = countingBuckets({});

  assert.equal(await isValidHandsToken("late"), false);
  const afterDeny = reads();

  registerHandsToken("sess-late", "late");
  assert.equal(await isValidHandsToken("late"), true, "issued tokens validate");
  assert.equal(reads(), afterDeny, "from the token map, without searching");

  revokeHandsToken("late");
  await isValidHandsToken("late");
  assert.ok(reads() > afterDeny,
    "once the token has left the token map the question is open again: a "
    + "denial cached before it was issued must not still be answering");
});

test("a store that could not answer is not remembered as a denial", async () => {
  // "Searched and not found" is worth caching; "could not search" is not. The
  // caller is bootstrap, which walks every binary source back to back with no
  // delay -- so one blip cached as a denial fails all of them and the sandbox
  // never comes up, with a token that was valid the whole time.
  let down = true;
  const kv = {
    async keys() {
      if (down) throw new Error("no responders");
      return (async function* () { yield "hands.s1"; })();
    },
    async get(key: string) {
      if (down) throw new Error("no responders");
      return { key, value: sc.encode(JSON.stringify({ token: "real" })), revision: 1 };
    },
    async put() { return 1; },
    async delete() {},
  } as unknown as KV;
  bindHandsKv(kv);
  restoreDag = bindDagHandleKvForTest({
    async keys() { return (async function* () { /* nothing */ })(); },
    async get() { return null; },
  } as never);

  assert.equal(await isValidHandsToken("real"), false, "nothing can be confirmed while it is down");

  down = false;
  assert.equal(await isValidHandsToken("real"), true,
    "once the store answers, a valid token must validate -- a denial cached "
    + "during the outage would lock it out for the whole cache window");
});
