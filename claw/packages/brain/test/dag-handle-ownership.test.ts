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
 *   H11 releasing by workload frees the name, and only for the workload named
 *   H12 a legacy bare-string entry still counts as a workload on record
 *   H13 releasing does not delete a handle registered while it decided
 *   H14 releasing does not take a handle that has moved to another workload
 *   H15 a release scan that hangs does not wedge the caller
 *   H16 a rollback whose stop failed keeps the handle
 *   H17 a rollback whose first remedy fails keeps trying the other one
 *   H18 an exhausted rollback keeps trying until a dependency comes back
 *   H19 recovery does not take a session entry the session has moved on to
 *   H20 a recorded entry does not end the recovery -- only a landed stop does
 *   H21 an empty PUT is replaced, not create-conflicted forever
 *   H22 the reaper's identity check is wired through both call sites
 */
import test, { before } from "node:test";
import assert from "node:assert/strict";
import { StringCodec } from "nats";

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { rollbackUnregisterableWorkload } from "../src/sandbox/ensure-hands.js";
import {
  bindDagHandleKvForTest,
  initDagHandles,
  lookupDagHandle,
  releaseHandlesForWorkload,
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
    // Enforces `previousSeq` the way NATS does. A fake that deleted
    // unconditionally would supply the protection these tests are checking --
    // the conditional delete is exactly what stops a row being removed after
    // somebody added a handle to it.
    async delete(key: string, opts?: { previousSeq?: number }) {
      if (opts?.previousSeq !== undefined && opts.previousSeq !== revs[key]) {
        throw new Error(`wrong last sequence: ${revs[key]}`);
      }
      delete rows[key]; delete revs[key];
    },
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
  await releaseHandlesForWorkload("W-old");
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

  await releaseHandlesForWorkload("W-train");
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
  // The hook lives in `makeOnProvisioned` now -- main's #35 lifted it out of
  // ensureHands so the admission ceiling could wrap it. Same hook, same
  // requirement: the handle is written from inside it.
  const decl = src.slice(src.indexOf("export function makeOnProvisioned"));
  // Past the deps type literal, whose own `\n})` would otherwise end the slice
  // before the body it is meant to be reading.
  const hook = decl.slice(decl.indexOf("}): (workloadId: string) => Promise<void> {"));
  const body = hook.slice(0, hook.indexOf("\n}"));

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
    /await rollbackUnregisterableWorkload\(/,
    "and that failure has to roll the workload back before it rethrows, not just log it",
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

test("H11 releasing by workload frees the name, and only for the workload named", async () => {
  // The other half of the refusal: whoever stops a workload frees its handle,
  // which is why an ordinary rebuild never meets the refusal above. Keyed by
  // workload rather than by handle, because the callers that stop one do not
  // all know which DAG named it -- `reapPendingHands` has a session and an id.
  await replaceDagHandle("dag-11", "main", { workload_id: "W-old" });

  await releaseHandlesForWorkload("W-someone-else");
  assert.equal(
    (await lookupDagHandle("dag-11", "main"))?.workload_id, "W-old",
    "a handle that has moved on belongs to whoever moved it",
  );

  await releaseHandlesForWorkload("W-old");
  assert.equal(await lookupDagHandle("dag-11", "main"), null);
  await replaceDagHandle("dag-11", "main", { workload_id: "W-new" });
  assert.equal(
    (await lookupDagHandle("dag-11", "main"))?.workload_id, "W-new",
    "and the freed name is available to the replacement",
  );
});

test("H12 a legacy bare-string entry still counts as a workload on record", async () => {
  // The protocol accepts `{main: "W-old"}` -- the workload id with no wrapper.
  // Read as an object it answers `undefined`, so the refusal saw no previous
  // workload and let a replacement take the only reference to a live one. The
  // oldest rows are exactly the ones most likely to name something long-lived.
  const legacy = fakeJs({ "dag-handles.dag-12": { main: "W-legacy" } });
  const restore = bindDagHandleKvForTest(legacy.kv as never);
  try {
    await assert.rejects(
      () => replaceDagHandle("dag-12", "main", { workload_id: "W-new" }),
      /still names W-legacy/,
    );
  } finally {
    restore();
  }
});

test("H13 releasing does not delete a handle registered while it decided", async () => {
  // The lost update the Backend's removal was made conditional to prevent,
  // reintroduced in the release. It needs a precise interleave, which is why
  // the first version of this test passed with the protection removed:
  // `destroy` removes ONE key and only deletes the whole row when its own
  // snapshot leaves it empty. So the registration has to land after that
  // snapshot is read and before the delete goes out -- landing earlier just
  // means the remover sees it and leaves it alone.
  await replaceDagHandle("dag-13", "a", { workload_id: "W-a" });

  const key = "dag-handles.dag-13";
  const realGet = store.kv.get.bind(store.kv);
  let reads = 0;
  store.kv.get = (async (k: string) => {
    const entry = await realGet(k);
    // The SECOND read of this row is the remover's own, after the scan.
    if (k === key && ++reads === 2) {
      await replaceDagHandle("dag-13", "b", { workload_id: "W-b" });
    }
    return entry;
  }) as typeof store.kv.get;
  try {
    await releaseHandlesForWorkload("W-a");
  } finally {
    store.kv.get = realGet;
  }

  assert.equal(
    (await lookupDagHandle("dag-13", "b"))?.workload_id, "W-b",
    "the handle registered while the remover decided keeps its only reference",
  );
  assert.equal(await lookupDagHandle("dag-13", "a"), null, "and the released one is gone");
});

test("H14 releasing does not take a handle that has moved to another workload", async () => {
  // The scan says this handle names W-old; by the time the write goes out it
  // may name something else, which belongs to whoever moved it.
  await replaceDagHandle("dag-14", "main", { workload_id: "W-old" });

  const key = "dag-handles.dag-14";
  const realGet = store.kv.get.bind(store.kv);
  let reads = 0;
  store.kv.get = (async (k: string) => {
    if (k === key && ++reads === 2) {
      await releaseHandlesForWorkload("W-old");
      await replaceDagHandle("dag-14", "main", { workload_id: "W-newer" });
    }
    return realGet(k);
  }) as typeof store.kv.get;
  try {
    await releaseHandlesForWorkload("W-old");
  } finally {
    store.kv.get = realGet;
  }

  assert.equal(
    (await lookupDagHandle("dag-14", "main"))?.workload_id, "W-newer",
    "a handle that has moved on is not removed on a stale read of the old workload",
  );
});

test("H15 a release scan that hangs does not wedge the caller", async () => {
  // `listAll()` drives an ordered consumer, and the SDK rebuilds and retries it
  // indefinitely when JetStream is unavailable while the core connection stays
  // healthy. This runs inside teardown and inside the pending-write rollback,
  // and a task's own abort does not interrupt an await -- so unbounded, a
  // cleanup can wedge the rebuild or the NAK behind it.
  //
  // Expiring leaves the handle in place, which is the safe direction: the
  // workload is already stopped, so a stale entry costs a refused registration
  // that a later sweep clears, not a lost reference to something live.
  const restore = bindDagHandleKvForTest({
    async get() { return null; },
    async create() { return 1; },
    async update() { return 1; },
    async put() { return 1; },
    async delete() {},
    async keys() { return new Promise(() => { /* never settles */ }); },
  } as never);
  const started = process.hrtime.bigint();
  try {
    await assert.rejects(
      () => releaseHandlesForWorkload("W-any"),
      /release scan exceeded/,
    );
  } finally {
    restore();
  }
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs < 30_000, `must not wait indefinitely (waited ${Math.round(elapsedMs)}ms)`);
});

test("H16 a rollback whose stop failed keeps the handle", async () => {
  // The failure branch my own earlier fix introduced. Releasing the handle
  // after a stop that did NOT land leaves a workload that exists with no
  // handle and no session entry -- findable by nothing, and strictly worse
  // than the stuck retry the release was added to prevent.
  const r = await rollbackCase({ stopFails: 99, putFails: 0 });
  assert.equal(r.calls.release, 0, "a stop that never landed must not free the handle");
  assert.equal(r.outcome, "recorded");
});


const rollbackCase = async (opts: {
  stopFails: number; putFails: number; releaseFails?: number; inlineRetry?: boolean;
  /** A session entry already present when the rollback runs. */
  sessionEntry?: { workloadId: string } | null;
  /** Another workload takes the session slot after this many writes. */
  stolenAfterPuts?: number;
  /** The KV operation the existing entry carries. */
  entryOperation?: string;
  /** The existing entry is a zero-byte PUT. */
  emptyValue?: boolean;
}) => {
  const calls = { stop: 0, put: 0, release: 0 };
  const puts: string[] = [];
  let detached: Promise<void> | null = null;
  const rowOp = opts.entryOperation ?? "PUT";
  let row: { value: Uint8Array; revision: number } | null = opts.sessionEntry
    ? { value: opts.emptyValue ? new Uint8Array(0) : sc.encode(JSON.stringify(opts.sessionEntry)), revision: 7 }
    : null;
  const write = (value: Uint8Array) => {
    calls.put += 1;
    if (calls.put <= opts.putFails) throw new Error("kv down");
    row = { value, revision: (row?.revision ?? 0) + 1 };
    puts.push(JSON.parse(new TextDecoder().decode(value)).workloadId);
  };
  const outcome = await rollbackUnregisterableWorkload({
    sessionId: "s1", workloadId: "W1", namespace: "ns", platformKey: "pk",
    pendingPayload: sc.encode(JSON.stringify({ status: "pending", workloadId: "W1" })),
    kv: {
      async get() {
        if (opts.stolenAfterPuts !== undefined && puts.length >= opts.stolenAfterPuts) {
          row = { value: sc.encode(JSON.stringify({ workloadId: "W2" })), revision: 99 };
        }
        return row ? { ...row, operation: rowOp } : null;
      },
      async create(_key: string, value: Uint8Array) {
        if (row) throw new Error("wrong last sequence: key exists");
        write(value);
        return 1;
      },
      async update(_key: string, value: Uint8Array, revision: number) {
        if (row?.revision !== revision) throw new Error(`wrong last sequence: ${row?.revision}`);
        write(value);
        return row!.revision;
      },
    },
    deps: {
      // Runs the detached recovery inline with no delays, so the exhausted
      // path is observable without waiting out its real backoff.
      detach: opts.inlineRetry ? (fn) => { detached = fn(); } : () => {},
      retryDelaysMs: [0, 0, 0],
      async stop() {
        calls.stop += 1;
        if (calls.stop <= opts.stopFails) throw new Error("503 from SaFE");
      },
      async release() {
        calls.release += 1;
        if (calls.release <= (opts.releaseFails ?? 0)) throw new Error("kv down");
      },
    },
  });
  if (detached) await detached;
  return { outcome, calls, puts, finalEntry: row };
};

test("H17 a rollback whose first remedy fails keeps trying the other one", async () => {
  // Round 28 found the hole this closes. The branch that runs when the early
  // registration fails returns BEFORE the caller writes the session entry, so
  // whatever it leaves behind is the only record of a workload that is running.
  // It had one shot at each remedy, where the normal pending write gets three:
  // a 503 from SaFE plus a single transient KV error left the workload live
  // with no handle and no session entry -- nothing for a sweep to find.
  //
  // Either remedy is sufficient, so the loop stops at the first one that lands.
  const a = await rollbackCase({ stopFails: 99, putFails: 1 });
  assert.equal(a.outcome, "recorded", "a transient KV error must not end the rollback");
  assert.deepEqual(a.puts, ["W1"], "the session entry must be written");
  assert.equal(a.calls.stop, 2, "and the stop retried alongside it");

  // A stop that comes good on a later round is the better outcome: a workload
  // that no longer exists needs no record at all.
  const b = await rollbackCase({ stopFails: 1, putFails: 99 });
  assert.equal(b.outcome, "stopped");
  assert.equal(b.calls.release, 1, "a landed stop frees the name it may have taken");

  // Both remedies failing every round is the one case with nothing left to try.
  // It must not be reported as a successful rollback.
  const c = await rollbackCase({ stopFails: 99, putFails: 99 });
  assert.equal(c.outcome, "orphaned");
  assert.equal(c.calls.stop, 3);
  assert.equal(c.calls.put, 3);

  // A stop that landed and a release that did not leaves the handle naming
  // something that is gone, so the release is retried too.
  const d = await rollbackCase({ stopFails: 0, putFails: 0, releaseFails: 1 });
  assert.equal(d.outcome, "stopped");
  assert.equal(d.calls.release, 2);
  assert.deepEqual(d.puts, [], "a stop that landed needs no session entry");
});

test("H18 an exhausted rollback keeps trying until a dependency comes back", async () => {
  // Round 29. When every synchronous round fails, nothing durable can be
  // written -- SaFE and KV ARE the only durable stores this process has, and
  // both are what just failed. So the workload is live, unreferenced, and the
  // caller is about to throw; `reapPendingHands` returns immediately on a
  // session entry that was never written, and nothing else is looking.
  //
  // What the exhausted path still holds is the workload id. Both failures are
  // transient by hypothesis, so it keeps trying: the round 29 repro restores
  // the dependencies, and one attempt after that has to be enough.
  const recovered = await rollbackCase({ stopFails: 3, putFails: 99, inlineRetry: true });
  assert.equal(recovered.outcome, "orphaned", "the synchronous result is still a failure");
  assert.equal(recovered.calls.stop, 4, "and the fourth stop -- after recovery -- lands");
  assert.equal(recovered.calls.release, 1, "a stop that landed frees the name it may have taken");

  // Recording makes it findable, but does NOT end the recovery -- see H20.
  const viaKv = await rollbackCase({ stopFails: 99, putFails: 3, inlineRetry: true });
  assert.ok(viaKv.puts.length > 0 && viaKv.puts.every((w) => w === "W1"),
    "the session entry lands once KV comes back");
  assert.equal(viaKv.calls.stop, 6, "and the stop keeps being tried after it");

  // The retries are bounded, not a loop that runs forever.
  const never = await rollbackCase({ stopFails: 99, putFails: 99, inlineRetry: true });
  assert.equal(never.calls.stop, 6, "3 synchronous rounds + 3 retry attempts, then it stops");

  // And without the seam, the caller is not made to wait on any of it: the
  // task this belonged to has already failed.
  const t0 = process.hrtime.bigint();
  const detachedByDefault = await rollbackCase({ stopFails: 99, putFails: 99 });
  assert.equal(detachedByDefault.outcome, "orphaned");
  assert.ok(Number(process.hrtime.bigint() - t0) < 3e9, "the rollback must not block on recovery");
});

test("H19 recovery does not take a session entry the session has moved on to", async () => {
  // Round 30. The recovery can wake long after the task that owned W1 failed,
  // by which time the same session may be creating W2 -- and `hands.<session>`
  // holds ONE entry. Writing W1's old pending payload over W2's took W2's only
  // reference to give W1 one that W2's own `ready` write then overwrote, so
  // both ended up unreferenced -- and the loop, counting the write as success,
  // had already exited. No process death, no exhausted window.
  const moved = await rollbackCase({
    stopFails: 99, putFails: 0, inlineRetry: true, sessionEntry: { workloadId: "W2" },
  });
  assert.deepEqual(moved.puts, [], "W2's entry must not be taken");
  assert.equal(
    JSON.parse(new TextDecoder().decode(moved.finalEntry!.value)).workloadId, "W2",
    "the session entry still names the workload that is actually using it",
  );
  // Declining is not success: the entry is spoken for and will stay spoken for,
  // so the stop is the remedy that remains, and it has to keep being tried.
  assert.equal(moved.outcome, "orphaned");
  assert.equal(moved.calls.stop, 6, "the rounds and the retries all still run");

  // An entry this workload wrote itself is still its own to refresh.
  const ours = await rollbackCase({
    stopFails: 99, putFails: 0, sessionEntry: { workloadId: "W1" },
  });
  assert.deepEqual(ours.puts, ["W1"]);
  assert.equal(ours.outcome, "recorded");
});

test("H20 a recorded entry does not end the recovery -- only a landed stop does", async () => {
  // Round 31, the mirror of H19. There, W1's recovery overwrote W2's entry.
  // Here W1's recovery wins the race and writes FIRST, into an empty slot --
  // CAS is satisfied, there is nobody to decline for -- and then W2 finishes
  // provisioning and its own pending write takes the slot back, because that
  // write is the normal unconditional one. W1 is unreferenced again, and the
  // recovery, having counted its write as success, had already exited.
  //
  // `hands.<sessionId>` is ONE slot and it belongs to whichever workload the
  // session is currently creating, so a recorded entry is never W1's to keep.
  // Only a stop that landed means there is no longer a workload to track.
  const taken = await rollbackCase({
    stopFails: 99, putFails: 0, inlineRetry: true, stolenAfterPuts: 1,
  });
  // One synchronous round -- the record succeeded, which ends that phase -- and
  // then all three retries, none of which stop trying just because it wrote.
  assert.equal(taken.calls.stop, 4, "the stop has to keep being tried after the slot is lost");
  assert.deepEqual(taken.puts, ["W1"], "and it declines to take the slot back");
  assert.equal(taken.outcome, "recorded", "the synchronous result is unchanged");
  assert.equal(
    JSON.parse(new TextDecoder().decode(taken.finalEntry!.value)).workloadId, "W2",
    "and the workload that took the slot keeps it",
  );

  // A stop that lands IS terminal -- there is nothing left to track.
  const stopped = await rollbackCase({ stopFails: 3, putFails: 0, inlineRetry: true });
  assert.equal(stopped.calls.stop, 4, "it stops trying the moment the stop lands");
  assert.equal(stopped.calls.release, 1, "and frees the name that stop may have taken");
});

test("H21 an empty PUT is replaced, not create-conflicted forever", async () => {
  // Round 31 (B). Splitting on "has a usable value" and routing everything else
  // to `create` looked equivalent and was not. The heartbeat reads a tombstone
  // and re-`update`s it, and NATS does not carry the DEL operation across an
  // update -- so the bucket holds a PUT with a zero-byte value. `create` takes
  // an absent key or a tombstone, not that, so it conflicted on every attempt
  // where the unconditional `put` this replaced just succeeded.
  //
  // A key that exists is replaced by revision, whatever state it is in.
  const empty = await rollbackCase({
    stopFails: 99, putFails: 0, sessionEntry: { workloadId: "" }, emptyValue: true,
  });
  assert.deepEqual(empty.puts, ["W1"], "an empty PUT must not block the write");
  assert.equal(empty.outcome, "recorded");

  // A real tombstone is replaced the same way, and is nobody's claim.
  const tombstoned = await rollbackCase({
    stopFails: 99, putFails: 0, sessionEntry: { workloadId: "W2" },
    entryOperation: "DEL",
  });
  assert.deepEqual(tombstoned.puts, ["W1"]);
});


test("H22 the reaper's identity check is wired through every call site", async () => {
  // The rule itself is exercised against the real function in
  // reap-pending-task-identity.test.ts, and the lease guard against the real
  // runner in task-runner-terminal-release.test.ts (R9). What is left here is
  // the wiring neither can see: the entry has to record who wrote it, and no
  // failure path may reach the reaper except through the one method that
  // supplies the identity and checks the lease. A guard nobody routes through
  // is a guard that never fires.
  const runnerSrc = readFileSync(
    fileURLToPath(new URL("../src/tasks/runner.ts", import.meta.url)), "utf-8");
  assert.equal(
    (runnerSrc.match(/await this\.reapOwnPendingHands\(\)/g) || []).length, 2,
    "both failure paths go through the wrapper");
  assert.equal(
    (runnerSrc.match(/fx\(\)\.reapPendingHands\(/g) || []).length, 1,
    "and only the wrapper calls the reaper itself");
  const wrapper = runnerSrc.slice(runnerSrc.indexOf("private async reapOwnPendingHands"));
  const body = wrapper.slice(0, wrapper.indexOf("\n  }"));
  // Asked twice -- before the reap, and from inside it just before the stop --
  // through the one predicate, so there is a single rule to keep true.
  assert.match(body, /if \(!this\.stillOwnsLock\(\)\)/,
    "a holder that lost the lock must not tear anything down");
  assert.match(body, /stillOwned: \(\) => this\.stillOwnsLock\(\)/,
    "and it is asked again on the far side of the reaper's read");
  assert.match(body, /taskId: this\.request\.task_id/,
    "and the reap it does make is bound to this task");
  const predicate = runnerSrc.slice(runnerSrc.indexOf("private stillOwnsLock()"));
  assert.match(predicate.slice(0, predicate.indexOf("\n  }")), /LEASE_LOST_ABORT_REASON/,
    "which is where the lease-lost rule itself lives");
  const ehSrc = readFileSync(
    fileURLToPath(new URL("../src/sandbox/ensure-hands.ts", import.meta.url)), "utf-8");
  const payload = ehSrc.slice(ehSrc.indexOf("const pendingPayload = sc.encode"));
  assert.match(payload.slice(0, payload.indexOf("}));")), /taskId: deps\.taskId/,
    "and the entry has to record who wrote it");
  assert.match(ehSrc, /taskId: request\.task_id \?\? null,\n\s+dagRootTaskId:/,
    "which means ensureHands has to pass it in");
});

test("H23 the merge's own four seams", async () => {
  // Round 41 reviewed only the merge commit, and found four defects that exist
  // in neither parent -- each side correct alone, wrong combined. They are
  // checked structurally because each is a line whose CORRECTNESS comes from
  // the other side of the merge, and the behaviour they change lives behind a
  // cluster, a bucket migration or a Node microtask.
  const eh = readFileSync(
    fileURLToPath(new URL("../src/sandbox/ensure-hands.ts", import.meta.url)), "utf-8");

  // B1: #35 introduced a canonical session key and a migration that resolves it
  // against the legacy spelling. A rollback still writing the raw name reads
  // past a live READY row on the canonical key, reports `recorded` over it, and
  // the next migration promotes this pending row over that live sandbox.
  const rollback = eh.slice(eh.indexOf("const recordPending = async"));
  assert.match(rollback.slice(0, rollback.indexOf("};")), /handsSessionKey\(sessionId\)/,
    "the rollback has to write the key everything else reads");
  assert.equal(/const key = `hands\.\$\{sessionId\}`/.test(eh), false,
    "and the legacy spelling must not come back");

  // B2: retention is a handover. The container stays alive for its live work
  // and the retention record owns it; leaving the handle on it makes the
  // replacement unregisterable and the rollback then stops the replacement --
  // every retry, permanently.
  const retain = eh.slice(eh.indexOf("async function retainInsteadOfDestroying"));
  assert.match(retain.slice(0, retain.indexOf("\n}")), /releaseHandlesForWorkload\(/,
    "a handed-over container must not keep the DAG's handle");

  // B4: #35 made `releaseSlot` default true. This call undoes an ADOPTION, so
  // the sandbox it stops pinging is one somebody else built and is still
  // running -- releasing its slot lets a provision take a place the fleet has
  // not vacated.
  assert.match(eh, /unregisterSandbox\(adoptedSession, identity, \{ releaseSlot: false \}\)/,
    "undoing an adoption does not free the adopted sandbox's slot");

  // B3: a `then` that is a function makes the lazy bind a thenable, so the
  // await that receives it calls `proxy.then(resolve, reject)` and the promise
  // never settles.
  const nats = readFileSync(
    fileURLToPath(new URL("../../api/src/infra/nats.ts", import.meta.url)), "utf-8");
  const bind = nats.slice(nats.indexOf("export async function bindDagHandles"));
  assert.match(bind.slice(0, bind.indexOf("\n}")), /prop === "then"/,
    "the lazy bind must not look like a promise to await");
});
