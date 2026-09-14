// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A handle has to name the sandbox the DAG is actually holding.
 *
 * Two sequential, raceless cases had it naming something else, and both ended
 * with Backend reporting a release that never happened:
 *
 *   - **Reuse.** `ensureHands` returns early when it adopts a warm sandbox, and
 *     that return skipped handle registration entirely. T1 creates W and ends;
 *     a DAG in the same session reuses W; the handle still belongs to T1, so
 *     the reusing DAG's map is empty. Cancelling it stops nothing and answers
 *     `nothing_held` -- and the sweeper, reading only T1, tears W down under
 *     the DAG now running on it.
 *   - **Rebuild.** The old workload is stopped and its handle left in place, so
 *     re-registering the replacement hit `DagHandleMap.create`'s refusal to
 *     overwrite, the exception was swallowed, and the new sandbox ran
 *     unreferenced. A cancel then stopped the corpse, got a 404, and called the
 *     sandbox released.
 *
 * `create`'s refusal is right against a mistaken double-create and wrong at the
 * two moments a handle legitimately changes hands, which is the whole reason
 * `replaceDagHandle` exists.
 *
 * Coverage:
 *   H1 replace takes over a name that maps to a different workload
 *   H2 replace creates the entry when the name is free
 *   H3 replace leaves other handles of the same DAG alone
 *   H4 the reuse path registers, so an adopted sandbox is not unowned
 */
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { StringCodec } from "nats";

import { initDagHandles, lookupDagHandle, replaceDagHandle } from "../src/sandbox/handles.js";

const sc = StringCodec();

/** An in-memory stand-in for the DAG_HANDLES bucket. */
function fakeJs(initial: Record<string, unknown> = {}) {
  const rows: Record<string, unknown> = { ...initial };
  const kv = {
    async get(key: string) {
      const v = rows[key];
      return v === undefined ? null : { key, value: sc.encode(JSON.stringify(v)), revision: 1 };
    },
    async put(key: string, value: Uint8Array) {
      rows[key] = JSON.parse(new TextDecoder().decode(value));
      return 1;
    },
    async delete(key: string) { delete rows[key]; },
    async keys() { return (async function* () { for (const k of Object.keys(rows)) yield k; })(); },
  };
  return { rows, js: { views: { kv: async () => kv } } as never };
}

// `initDagHandles` memoises, so the first call binds the map for the whole
// file and later calls return it unchanged. That is fine here and deliberately
// not worked around: each test uses its own DAG id, so they share one store
// without sharing any state, and a test that accidentally depended on
// another's rows would be asserting about a DAG it never wrote.
const store = fakeJs();
before(async () => { await initDagHandles(store.js); });

test("H1 replace takes over a name that maps to a different workload", async () => {
  // Exactly what `create` refuses. A rebuild has already stopped W-old, so the
  // refusal protects a reference that is dead while the live one goes
  // unrecorded -- the worst of both.
  await replaceDagHandle("dag-1", "main", { workload_id: "W-old" });
  await replaceDagHandle("dag-1", "main", { workload_id: "W-new" });

  assert.equal(
    (await lookupDagHandle("dag-1", "main"))?.workload_id, "W-new",
    "the handle has to name the sandbox that exists, not the one that was stopped",
  );
});

test("H2 replace creates the entry when the name is free", async () => {
  // The reuse case: nothing was registered for this DAG at all.
  await replaceDagHandle("dag-2", "main", { workload_id: "W-1" });

  assert.equal((await lookupDagHandle("dag-2", "main"))?.workload_id, "W-1");
});

test("H3 replace leaves other handles of the same DAG alone", async () => {
  // One row holds every handle of a DAG, and replace destroys before it
  // creates -- so a replacement that took the row with it would drop the
  // siblings' only reference, which is the failure it exists to prevent.
  await replaceDagHandle("dag-3", "train", { workload_id: "W-train" });
  await replaceDagHandle("dag-3", "eval", { workload_id: "W-eval" });

  await replaceDagHandle("dag-3", "train", { workload_id: "W-train-2" });

  assert.equal((await lookupDagHandle("dag-3", "train"))?.workload_id, "W-train-2");
  assert.equal(
    (await lookupDagHandle("dag-3", "eval"))?.workload_id, "W-eval",
    "the sibling is untouched",
  );
});

test("H4 the reuse path registers, so an adopted sandbox is not unowned", () => {
  // Asserted on the source, as the sibling test for the SaFE namespace field
  // does, because reaching this branch through `ensureHands` needs a live KV,
  // a provider and a session. What matters is structural and visible here: the
  // early return that adopts a warm sandbox does not get to return before
  // ownership has moved.
  const src = readFileSync(
    fileURLToPath(new URL("../src/sandbox/ensure-hands.ts", import.meta.url)),
    "utf-8",
  );
  const branch = src.slice(src.indexOf("const reused = await tryReuseSessionSandbox("));
  const body = branch.slice(0, branch.indexOf("\n  }") + 4);

  assert.match(
    body, /await registerReusedDagHandle\([\s\S]*?\);\s*\n\s*return reused;/,
    "ownership must move with the sandbox, before the reuse path returns",
  );
  // And it must be a replace: the name may already map to whatever created the
  // sandbox this DAG is adopting, which is precisely the case `create` refuses.
  const helper = src.slice(src.indexOf("async function registerReusedDagHandle("));
  assert.match(helper.slice(0, helper.indexOf("\n}")), /await replaceDagHandle\(/);
});
