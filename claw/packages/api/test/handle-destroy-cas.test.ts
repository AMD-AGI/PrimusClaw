// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Removing one handle must not discard a handle registered beside it.
 *
 * `DagHandleMap.destroy` rewrites the whole DAG row and its write carries no
 * revision, so a registration landing between the read and the write is simply
 * overwritten. That has never been reachable: this module is the only caller of
 * `destroy` anywhere — Brain registers and looks up, never destroys — and its
 * calls went to the wrong bucket until this branch fixed that. Fixing the
 * bucket is what makes the lost update reachable, which makes it this branch's
 * to avoid rather than to note.
 *
 * The cost is not a misreport, it is a whole sandbox:
 *
 *   API    reads `{a: Wa}`, prepares to write the row without `a`
 *   Brain  registers `b`, writing `{a: Wa, b: Wb}`
 *   API    writes `{}` — `b` is gone, and with it the only reference to Wb
 *
 * Nothing then knows Wb exists: not the cancel, not the record, not a later
 * sweep. It holds its GPU until something outside Claw notices. A misreport at
 * least leaves the evidence intact; this destroys it.
 *
 * Driven against a fake bucket with real revision semantics, because the
 * property under test IS the revision check — a fake without one would pass
 * whether the code sent a revision or not.
 *
 * Coverage:
 *   C1 a registration landing mid-destroy survives, and the retry still removes
 *      the handle it was asked to remove
 *   C2 the row is deleted, conditionally, when the last handle goes
 *   C3 a row that will not settle raises rather than silently giving up
 *   C4 a non-conflict failure is raised, not retried away
 */
import test from "node:test";
import assert from "node:assert/strict";

const { destroyHandleCas } = await import("../src/tasks/sandbox-stopper.js");

/** A KV bucket that enforces `previousSeq` the way NATS does. */
function fakeBucket(initial: Record<string, unknown>) {
  const enc = new TextEncoder();
  let value: Uint8Array | null = enc.encode(JSON.stringify(initial));
  let revision = 1;
  let onRead: (() => void) | null = null;
  const conflicts: number[] = [];

  return {
    conflicts,
    current: () => (value === null ? null : JSON.parse(new TextDecoder().decode(value))),
    /** Runs once, after the next read, to land a concurrent write. */
    interleave(f: () => void) { onRead = f; },
    /** A concurrent registration, as Brain makes it. */
    register(name: string, workloadId: string) {
      const row = value === null ? {} : JSON.parse(new TextDecoder().decode(value));
      row[name] = { workload_id: workloadId };
      value = enc.encode(JSON.stringify(row));
      revision += 1;
    },
    kv: {
      async get() {
        const snapshot = value === null
          ? null
          : { value, revision, operation: "PUT" as const };
        const f = onRead; onRead = null; f?.();
        return snapshot;
      },
      async update(_k: string, data: Uint8Array, rev: number) {
        if (rev !== revision) { conflicts.push(rev); throw new Error("wrong last sequence: 3"); }
        value = data; revision += 1; return revision;
      },
      async delete(_k: string, opts?: { previousSeq: number }) {
        if (opts && opts.previousSeq !== revision) {
          conflicts.push(opts.previousSeq);
          throw new Error("wrong last sequence: 3");
        }
        value = null; revision += 1;
      },
      async put() { throw new Error("unconditional put must not be used on this path"); },
      async keys() { return (async function* () {})(); },
    },
  };
}

/** The production removal, against a bucket with real revision semantics. */
function destroy(bucket: ReturnType<typeof fakeBucket>, handle: string) {
  return destroyHandleCas(
    bucket.kv as unknown as Parameters<typeof destroyHandleCas>[0],
    "t-root",
    handle,
  );
}

test("C1 a registration landing mid-destroy survives the removal", async () => {
  const bucket = fakeBucket({ a: { workload_id: "Wa" } });
  // Brain registers `b` in the window between this destroy's read and write.
  bucket.interleave(() => bucket.register("b", "Wb"));

  const wid = await destroy(bucket, "a");

  assert.equal(wid, "Wa", "the handle asked for is still the one removed");
  assert.deepEqual(
    bucket.current(), { b: { workload_id: "Wb" } },
    "and Wb -- registered while this was deciding -- keeps its only reference",
  );
  assert.equal(bucket.conflicts.length, 1, "which takes exactly one conflict and one retry");
});

test("C2 the row is deleted, conditionally, when the last handle goes", async () => {
  const bucket = fakeBucket({ only: { workload_id: "W1" } });

  assert.equal(await destroy(bucket, "only"), "W1");
  assert.equal(bucket.current(), null, "an empty row is removed rather than left behind");
});

test("C3 a row that will not settle raises rather than silently giving up", async () => {
  // Returning null here would read as "no such handle", which the teardown
  // renders as `nothing_held` -- inventing the one answer it must never invent
  // out of a bucket that is simply too busy to write to.
  const bucket = fakeBucket({ a: { workload_id: "Wa" } });
  let n = 0;
  const spin = () => { bucket.interleave(() => { bucket.register(`x${n++}`, "Wx"); spin(); }); };
  spin();

  await assert.rejects(() => destroy(bucket, "a"), /kept changing/);
});

test("C4 a non-conflict failure is raised, not retried away", async () => {
  // Two handles, so removing one rewrites the row rather than deleting it --
  // otherwise this asserts nothing about `update` at all.
  const bucket = fakeBucket({ a: { workload_id: "Wa" }, b: { workload_id: "Wb" } });
  bucket.kv.update = async () => { throw new Error("nats: no responders"); };

  await assert.rejects(() => destroy(bucket, "a"), /no responders/);
  assert.deepEqual(bucket.conflicts, [], "a broken bucket is not a busy one");
});
