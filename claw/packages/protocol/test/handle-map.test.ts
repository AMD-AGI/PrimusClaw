// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `DagHandleMap` storage, for handle names that are not ordinary keys.
 *
 * The property under test is that a handle name which collides with an object
 * member -- `__proto__`, `constructor` -- is stored and enumerated as a real
 * own key. Admission accepts those names, so a DAG can declare one, and a
 * plain `row[name] = info` silently sets the row's prototype instead: the
 * registration reports success, the row serialises as `{}`, and Backend reads
 * the DAG as holding no sandbox while a live workload keeps its GPU.
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
test("a handle named __proto__ is stored, not silently swallowed", async () => {
  // `row[name] = info` looks total and is not. `__proto__` hits
  // `Object.prototype`'s setter, so the assignment sets the row's prototype
  // instead of adding a key and the row serialises as `{}` -- a registration
  // that reports success while storing nothing, which Backend then reads as a
  // DAG holding no sandbox and answers `nothing_held` for a live workload.
  //
  // Admission accepts the name, so this is reachable by writing a DAG, not
  // only by an attacker. Reuse does not go through the workload-label
  // validation the create path has.
  const map = new DagHandleMap(memoryStore());

  await map.create("dag-p", "__proto__", { workload_id: "W-proto" });

  assert.equal(
    (await map.lookup("dag-p", "__proto__"))?.workload_id, "W-proto",
    "the handle has to come back, or a live sandbox has no reference at all",
  );
  assert.deepEqual(
    Object.keys(await map.listForDag("dag-p")), ["__proto__"],
    "and it has to be a real own key, which is what teardown enumerates",
  );
  // `listAll` builds its own per-DAG object the same way and is what the
  // sweeper walks, so it needs the same cover -- reverting it alone left every
  // other assertion here green.
  const all = await map.listAll();
  assert.deepEqual(
    Object.keys(all.find(([dag]) => dag === "dag-p")![1]), ["__proto__"],
    "the sweeper's enumeration has to see it too, or it reaps a DAG it reads as empty",
  );
  assert.equal(
    await map.destroy("dag-p", "__proto__"), "W-proto",
    "and it has to be findable again when the sandbox is torn down",
  );
});

test("a handle the row does not hold is absent, not inherited", async () => {
  // The mirror of the write: `row["__proto__"]` on a row without that key
  // answers `Object.prototype`, and `row["constructor"]` answers a function.
  // Judged by shape rather than by ownership, either could be mistaken for an
  // entry -- or, worse, `destroy` could report having removed one.
  const map = new DagHandleMap(memoryStore());
  await map.create("dag-q", "main", { workload_id: "W-1" });

  // Each of these is a distinct way an inherited member could be mistaken for
  // a handle. `__proto__` answers an object, `constructor` answers a function,
  // and `toString` answers a function too -- read by shape rather than by
  // ownership, the first is the dangerous one, because an object with no
  // `workload_id` is exactly what a legacy entry check has to reject.
  assert.equal(await map.lookup("dag-q", "__proto__"), null);
  assert.equal(await map.lookup("dag-q", "constructor"), null);
  assert.equal(await map.lookup("dag-q", "toString"), null);
  assert.equal(await map.destroy("dag-q", "constructor"), null);
  assert.equal(
    await map.destroy("dag-q", "__proto__"), null,
    "and destroy must not claim to have removed something the row never held",
  );
  assert.equal(
    (await map.lookup("dag-q", "main"))?.workload_id, "W-1",
    "and the real handle is untouched by any of that",
  );
});
