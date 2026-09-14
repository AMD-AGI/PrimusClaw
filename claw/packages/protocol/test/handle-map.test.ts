// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `DagHandleMap.replace`: moving a handle to a different workload.
 *
 * `create` refuses a name that already maps elsewhere, so a mistaken
 * double-create cannot silently lose a reference. That is the wrong answer at
 * the two moments a handle legitimately changes hands -- a rebuild, where the
 * previous workload has already been stopped, and a session reuse, where a DAG
 * adopts a sandbox another task created. Both were reaching for `create`,
 * being rejected, and having the rejection swallowed by the caller, leaving
 * the map naming a stopped workload or nothing at all while a live sandbox ran
 * unreferenced.
 *
 * The property worth a test of its own is that the replacement is ONE write.
 * The obvious spelling -- destroy then create -- leaves the handle momentarily
 * absent, and an absent handle is exactly how Backend's teardown decides a DAG
 * holds no sandbox. A cancel landing in that window would answer "nothing
 * held" for a workload that is running, which is the false clear this whole
 * line of work exists to remove, reintroduced one layer down.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { KVStore } from "@claw/utils";

import { DagHandleMap } from "../src/sandbox/handle-map.js";

/** The in-memory store the class is documented against. */
function memoryStore(): KVStore {
  const rows = new Map<string, Record<string, unknown>>();
  return {
    async get(k) { return rows.get(k) ?? null; },
    async put(k, v) { rows.set(k, structuredClone(v)); },
    async delete(k) { rows.delete(k); },
    async scanPrefix(prefix) {
      return [...rows.entries()].filter(([k]) => k.startsWith(prefix));
    },
  };
}
test("replace never leaves the handle absent, even for an instant", async () => {
  // The failure this guards is asymmetric and easy to reintroduce, because the
  // obvious spelling of "replace" is destroy-then-create. Backend's teardown
  // decides a DAG holds no sandbox by finding no handle, so a cancel landing
  // between those two writes answers "nothing held" for a workload that is
  // running -- the exact false clear the release-confirmation work exists to
  // remove, reintroduced one layer down.
  //
  // Asserted by watching every write: a store that records what the key held
  // after each one, so an intermediate state with the handle missing is
  // visible even though it would be gone by the time the call returns.
  const seen: Array<string[]> = [];
  const rows = new Map<string, Record<string, unknown>>();
  const watched = {
    async get(k: string) { return rows.get(k) ?? null; },
    async put(k: string, v: Record<string, unknown>) {
      rows.set(k, structuredClone(v));
      seen.push(Object.keys(v).sort());
    },
    async delete(k: string) { rows.delete(k); seen.push([]); },
    async scanPrefix() { return [...rows.entries()] as Array<[string, Record<string, unknown>]>; },
  };
  const map = new DagHandleMap(watched);

  await map.create("dag-1", "main", { workload_id: "W-old" });
  await map.create("dag-1", "other", { workload_id: "W-other" });
  seen.length = 0;

  const previous = await map.replace("dag-1", "main", { workload_id: "W-new" });

  assert.equal(previous, "W-old", "the caller is told what the name used to point at");
  assert.equal(
    (await map.lookup("dag-1", "main"))?.workload_id, "W-new",
    "and the name now points at the replacement",
  );
  assert.deepEqual(
    seen, [["main", "other"]],
    "exactly one write, and `main` is present in it -- never a state without the handle",
  );
  assert.equal(
    (await map.lookup("dag-1", "other"))?.workload_id, "W-other",
    "the sibling handle in the same row is untouched",
  );
});

test("replace creates the handle when the name is free", async () => {
  const map = new DagHandleMap(memoryStore());
  assert.equal(await map.replace("dag-2", "main", { workload_id: "W-1" }), null,
    "nothing was there, and the caller is told so rather than guessing");
  assert.equal((await map.lookup("dag-2", "main"))?.workload_id, "W-1");
});
