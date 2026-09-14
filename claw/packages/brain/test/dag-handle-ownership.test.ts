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
 *   H1 a rebuild takes the name once the old workload is released
 *   H2 replace creates the entry when the name is free
 *   H3 replace leaves other handles of the same DAG alone
 *   H4 a registration that cannot be written fails the turn
 *   H5 a row that moved under the write is re-read, not overwritten
 *   H6 an existing empty row is updated, not create-and-conflicted
 *   H7 the handle is registered while the workload is provisioning, not after
 *   H8 Brain's own row writer stores a `__proto__` handle too
 *   H9 a handle is not taken from a workload still on record
 *   H10 re-registering the same workload is allowed, and enriches it
 *   H11 releasing a handle frees the name, and only for the workload named
 */
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { StringCodec } from "nats";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  bindDagHandleKvForTest,
  initDagHandles,
  lookupDagHandle,
  releaseDagHandle,
  replaceDagHandle,
} from "../src/sandbox/handles.js";

const sc = StringCodec();

/**
 * An in-memory stand-in for the DAG_HANDLES bucket, with real revision
 * semantics: `create` refuses an existing key and `update` refuses a stale
 * revision, the way NATS does. A fake that accepted both unconditionally would
 * supply the protection these tests are meant to be checking.
 */
function fakeJs(initial: Record<string, unknown> = {}) {
  const rows: Record<string, unknown> = { ...initial };
  const revs: Record<string, number> = {};
  for (const k of Object.keys(rows)) revs[k] = 1;
  const kv = {
    async get(key: string) {
      const v = rows[key];
      return v === undefined
        ? null
        : { key, value: sc.encode(JSON.stringify(v)), revision: revs[key] ?? 1, operation: "PUT" };
    },
    async create(key: string, value: Uint8Array) {
      if (rows[key] !== undefined) throw new Error("wrong last sequence: key exists");
      rows[key] = JSON.parse(new TextDecoder().decode(value));
      revs[key] = 1;
      return 1;
    },
    async update(key: string, value: Uint8Array, rev: number) {
      if ((revs[key] ?? 0) !== rev) throw new Error(`wrong last sequence: ${revs[key]}`);
      rows[key] = JSON.parse(new TextDecoder().decode(value));
      revs[key] = rev + 1;
      return revs[key];
    },
    async put(key: string, value: Uint8Array) {
      rows[key] = JSON.parse(new TextDecoder().decode(value));
      revs[key] = (revs[key] ?? 0) + 1;
      return revs[key];
    },
    async delete(key: string) { delete rows[key]; delete revs[key]; },
    async keys() { return (async function* () { for (const k of Object.keys(rows)) yield k; })(); },
  };
  return { rows, kv, js: { views: { kv: async () => kv } } as never };
}

// `initDagHandles` memoises, so the first call binds the map for the whole
// file and later calls return it unchanged. That is fine here and deliberately
// not worked around: each test uses its own DAG id, so they share one store
// without sharing any state, and a test that accidentally depended on
// another's rows would be asserting about a DAG it never wrote.
const store = fakeJs();
before(async () => {
  await initDagHandles(store.js);
  // `replaceDagHandle` writes straight to the bucket, so the tests that assert
  // on its results have to be bound to the same one `lookupDagHandle` reads.
  bindDagHandleKvForTest(store.kv as never);
});

test("H1 a rebuild takes the name once the old workload is released", async () => {
  // The sequence a rebuild really performs: stop the old sandbox, free its
  // handle, then register the replacement. Taking the name without the middle
  // step is what H9 forbids, and it is forbidden because the map is the only
  // reference to a workload nobody stopped.
  await replaceDagHandle("dag-1", "main", { workload_id: "W-old" });
  await releaseDagHandle("dag-1", "main", "W-old");
  await replaceDagHandle("dag-1", "main", { workload_id: "W-new" });

  assert.equal(
    (await lookupDagHandle("dag-1", "main"))?.workload_id, "W-new",
    "the handle names the sandbox that exists, not the one that was stopped",
  );
});

test("H2 replace creates the entry when the name is free", async () => {
  // The reuse case: nothing was registered for this DAG at all.
  await replaceDagHandle("dag-2", "main", { workload_id: "W-1" });

  assert.equal((await lookupDagHandle("dag-2", "main"))?.workload_id, "W-1");
});

test("H3 replace leaves other handles of the same DAG alone", async () => {
  // One row holds every handle of a DAG, so a replacement is a rewrite of that
  // whole row -- one conditional write, never a delete and a create. A version
  // that dropped the row and rebuilt it would take the siblings' only
  // reference with it, which is the failure this pins.
  await replaceDagHandle("dag-3", "train", { workload_id: "W-train" });
  await replaceDagHandle("dag-3", "eval", { workload_id: "W-eval" });

  await releaseDagHandle("dag-3", "train", "W-train");
  await replaceDagHandle("dag-3", "train", { workload_id: "W-train-2" });

  assert.equal((await lookupDagHandle("dag-3", "train"))?.workload_id, "W-train-2");
  assert.equal(
    (await lookupDagHandle("dag-3", "eval"))?.workload_id, "W-eval",
    "the sibling is untouched",
  );
});

test("H4 a registration that cannot be written fails the turn", async () => {
  // The failure mode the source-level version of this test could not see: an
  // early `return` inserted at the top of the helper left both of its regexes
  // matching. What matters is not that the call is written, it is that a
  // sandbox nobody could record ownership for is never handed back as if it
  // were owned.
  //
  // A registration is the only record Backend has of what a DAG holds. Swallow
  // its failure and the DAG runs a workload whose cancel reports `nothing_held`
  // and issues no stop, while the pod keeps its GPU. Failing the turn is loud
  // and retryable; succeeding quietly is how the leak becomes invisible.
  const broken = fakeJs();
  broken.js = {
    views: {
      kv: async () => ({
        async get() { return null; },
        async create() { throw new Error("nats: no responders"); },
        async update() { throw new Error("nats: no responders"); },
        async put() { throw new Error("nats: no responders"); },
        async delete() {},
        async keys() { return (async function* () {})(); },
      }),
    },
  } as never;
  const restore = bindDagHandleKvForTest(
    (await (broken.js as unknown as { views: { kv: () => Promise<unknown> } }).views.kv()) as never,
  );
  try {
    await assert.rejects(
      () => replaceDagHandle("dag-4", "main", { workload_id: "W-1" }),
      /no responders/,
      "a registration that cannot commit must raise, not return quietly",
    );
  } finally {
    restore();
  }
});

test("H5 a conflicting row is re-read rather than overwritten", async () => {
  // Backend removes handles under a revision-conditional write. A plain
  // read-modify-write from this side resurrects an entry Backend has just
  // removed -- reviving a reference to a stopped workload, or undoing the
  // removal of one that is still running. The two writers have to agree on the
  // same row version, so a conflict re-reads instead of clobbering.
  let revision = 7;
  let row: Record<string, unknown> = { other: { workload_id: "W-other" } };
  let rejectedOnce = false;
  const enc = new TextEncoder();
  const bucket = {
    async get() {
      return { value: enc.encode(JSON.stringify(row)), revision, operation: "PUT" };
    },
    async update(_k: string, data: Uint8Array, rev: number) {
      if (!rejectedOnce) {
        // Backend commits between this caller's read and its write.
        rejectedOnce = true;
        row = {};
        revision += 1;
        throw new Error("wrong last sequence: 8");
      }
      assert.equal(rev, revision, "the retry writes against the version it just read");
      row = JSON.parse(new TextDecoder().decode(data));
      return ++revision;
    },
    async create() { throw new Error("key exists"); },
    async put() { throw new Error("unconditional put must not be used here"); },
    async delete() {},
    async keys() { return (async function* () {})(); },
  };
  const restore = bindDagHandleKvForTest(bucket as never);
  try {
    await replaceDagHandle("dag-5", "main", { workload_id: "W-new" });
  } finally {
    restore();
  }

  assert.deepEqual(
    Object.keys(row), ["main"],
    "the retry built on what Backend left behind, rather than restoring the stale row",
  );
});

test("H8 Brain's own writer stores a __proto__ handle, not only the map's", async () => {
  // `replaceDagHandle` writes the row itself rather than going through
  // `DagHandleMap`, so the protocol package's coverage says nothing about it:
  // reverting this writer alone to a plain assignment left every test in both
  // packages green. It is the writer every registration in Brain goes through.
  let stored: Record<string, unknown> = {};
  const enc = new TextEncoder();
  const restore = bindDagHandleKvForTest({
    async get() { return null; },
    async create(_k: string, v: Uint8Array) {
      stored = JSON.parse(new TextDecoder().decode(v)); return 1;
    },
    async update() { throw new Error("not reached"); },
    async put() { throw new Error("unconditional put must not be used here"); },
    async delete() {},
    async keys() { return (async function* () {})(); },
  } as never);
  void enc;
  try {
    await replaceDagHandle("dag-8", "__proto__", { workload_id: "W-proto" });
  } finally {
    restore();
  }

  assert.deepEqual(
    Object.keys(stored), ["__proto__"],
    "a plain assignment here serialises the row as {} and reports success anyway",
  );
  assert.equal(
    (stored as Record<string, { workload_id: string }>)["__proto__"]!.workload_id, "W-proto",
  );
});

test("H6 an existing empty row is updated, not create-and-conflicted", async () => {
  // Two questions that come apart: "is there a row to build on" and "does the
  // key exist". An entry present with an empty value answers no to the first
  // and yes to the second, and conflating them sends a `create` at a key that
  // is already there -- refused, retried five times, refused five times, and
  // the registration fails against a row it could perfectly well have updated.
  let revision = 3;
  let value = new Uint8Array();       // present, and empty
  let createAttempts = 0;
  const bucket = {
    async get() { return { value, revision, operation: "PUT" }; },
    async create() { createAttempts += 1; throw new Error("wrong last sequence: key exists"); },
    async update(_k: string, data: Uint8Array, rev: number) {
      assert.equal(rev, revision, "the update carries the revision it read");
      value = data; return ++revision;
    },
    async put() { throw new Error("unconditional put must not be used here"); },
    async delete() {},
    async keys() { return (async function* () {})(); },
  };
  const restore = bindDagHandleKvForTest(bucket as never);
  try {
    await replaceDagHandle("dag-6", "main", { workload_id: "W-1" });
  } finally {
    restore();
  }

  assert.equal(createAttempts, 0, "the key exists, so this was never a create");
  assert.equal(
    (JSON.parse(new TextDecoder().decode(value)) as Record<string, { workload_id: string }>)
      .main.workload_id,
    "W-1",
  );
});

test("H7 the handle is registered while the workload is provisioning, not after", () => {
  // The window this closes: the workload exists from the moment SaFE assigns
  // its id, and poll, bootstrap and health all happen before the registration
  // at the end of ensureHands. A cancel arriving in there found no handle,
  // concluded the DAG held nothing, and said so -- while the workload it had
  // missed kept its GPU.
  //
  // Asserted structurally because reaching `onProvisioned` needs a provider
  // and a cluster. What matters is where the call sits: inside the hook that
  // fires on workload assignment, and rolling the workload back if it cannot
  // be written, exactly as the pending KV write beside it already does.
  const src = readFileSync(
    fileURLToPath(new URL("../src/sandbox/ensure-hands.ts", import.meta.url)),
    "utf-8",
  );
  const hook = src.slice(
    src.indexOf("const onProvisioned = async (workloadId: string)"),
  );
  const body = hook.slice(0, hook.indexOf("\n  };"));

  assert.match(body, /await replaceDagHandle\(/,
    "the handle has to be recorded while the workload is provisioning");
  // Ordered, not merely present. The hook already contained a `stop(` for the
  // pending KV write's own rollback, so matching "a stop exists somewhere in
  // the hook" passed with the new rollback deleted outright. What this needs
  // is that THIS registration's failure is the one followed by a stop.
  const failure = body.slice(body.indexOf("pending_register_failed_rollback"));
  assert.notEqual(failure, "", "the early registration needs its own rollback log");
  assert.match(
    failure.slice(0, failure.indexOf("throw")),
    /getSafeWorkloadProvider\(\)\.stop\(/,
    "and that failure has to stop the workload before it rethrows, not just log it",
  );
});

test("H9 a handle is not taken from a workload still on record", async () => {
  // `create` refused this, and replacing that refusal with an unconditional
  // write is what let a redelivery overwrite the only reference to a running
  // workload: `hands.<session>` expires with BRAIN_REGISTRY's TTL while this
  // handle, in a bucket with no TTL, keeps naming it. The turn fails instead,
  // and the map goes on naming the workload -- which is what keeps it
  // findable.
  //
  // A round was spent on the alternative -- carry the displaced id forward and
  // stop it at teardown -- and it grew five ways to lose that id. Refusing has
  // no state to lose.
  await replaceDagHandle("dag-9", "main", { workload_id: "W-live" });

  await assert.rejects(
    () => replaceDagHandle("dag-9", "main", { workload_id: "W-new" }),
    /still names W-live/,
  );
  assert.equal(
    (await lookupDagHandle("dag-9", "main"))?.workload_id, "W-live",
    "and the name still points at the workload nobody released",
  );
});

test("H10 re-registering the same workload is allowed, and enriches it", async () => {
  // The refusal must not block the ordinary case it sits next to: the early
  // provisioning write and the final one name the SAME workload, and the
  // second adds the connection fields.
  await replaceDagHandle("dag-10", "main", { workload_id: "W-1" });
  await replaceDagHandle("dag-10", "main", { workload_id: "W-1", hands_url: "http://h" });

  const held = await lookupDagHandle("dag-10", "main");
  assert.equal(held?.workload_id, "W-1");
  assert.equal(held?.hands_url, "http://h", "the second write enriches rather than being refused");
});

test("H11 releasing a handle frees the name, and only for the workload named", async () => {
  // The other half of the refusal: whoever stops a workload frees its handle,
  // which is why an ordinary rebuild never meets the refusal above.
  await replaceDagHandle("dag-11", "main", { workload_id: "W-old" });

  await releaseDagHandle("dag-11", "main", "W-someone-else");
  assert.equal(
    (await lookupDagHandle("dag-11", "main"))?.workload_id, "W-old",
    "a handle that has moved on belongs to whoever moved it",
  );

  await releaseDagHandle("dag-11", "main", "W-old");
  assert.equal(await lookupDagHandle("dag-11", "main"), null);
  await replaceDagHandle("dag-11", "main", { workload_id: "W-new" });
  assert.equal(
    (await lookupDagHandle("dag-11", "main"))?.workload_id, "W-new",
    "and the freed name is available to the replacement",
  );
});
