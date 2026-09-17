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
 * The teardown reaches this through `destroyHandleCas`, not `DagHandleMap`:
 * the class method is what the lost update belongs to, and the production path
 * stopped using it when this was fixed.
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
 *   C5 the removal is bound to the workload it was asked to remove
 *   C6 the rewrite path is conditional too, not only the delete path
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
    /** A rebuild re-registering the same name against a new workload. */
    replace(name: string, workloadId: string) {
      const row = value === null ? {} : JSON.parse(new TextDecoder().decode(value));
      row[name] = { workload_id: workloadId };
      value = enc.encode(JSON.stringify(row));
      revision += 1;
    },
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
      // Real NATS semantics, and the distinction matters: an ABSENT revision
      // is an unconditional write that succeeds, not a conflict. An earlier
      // version of this fake treated `undefined` as a permanent conflict,
      // which made C1 pass whether or not the code sent a revision -- the fake
      // was supplying the protection the test claimed to be checking.
      async update(_k: string, data: Uint8Array, rev?: number) {
        if (rev !== undefined && rev !== revision) {
          conflicts.push(rev); throw new Error("wrong last sequence: 3");
        }
        value = data; revision += 1; return revision;
      },
      async delete(_k: string, opts?: { previousSeq?: number }) {
        if (opts?.previousSeq !== undefined && opts.previousSeq !== revision) {
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
function destroy(
  bucket: ReturnType<typeof fakeBucket>,
  handle: string,
  expect?: string,
) {
  return destroyHandleCas(
    bucket.kv as unknown as Parameters<typeof destroyHandleCas>[0],
    "t-root",
    handle,
    expect,
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

test("C2 the row is deleted when the last handle goes, and conditionally", async () => {
  // Two assertions, because the delete path has its own revision argument and
  // nothing else here exercises it. The uncontended case proves an emptied row
  // is removed rather than left as `{}`; the contended one proves the removal
  // is conditional, which the title claimed and the previous version of this
  // test did not check at all -- it passed with the delete's `previousSeq`
  // dropped entirely.
  const quiet = fakeBucket({ only: { workload_id: "W1" } });
  assert.equal(await destroy(quiet, "only"), "W1");
  assert.equal(quiet.current(), null, "an emptied row is removed, not left behind");

  const contended = fakeBucket({ only: { workload_id: "W1" } });
  // A registration lands after the read that decided the row would be empty.
  contended.interleave(() => contended.register("b", "Wb"));

  assert.equal(await destroy(contended, "only"), "W1");
  assert.deepEqual(
    contended.current(), { b: { workload_id: "Wb" } },
    "the row was no longer empty by the time the write went out, so it must not be deleted",
  );
  assert.equal(contended.conflicts.length, 1, "which the revision on the delete is what catches");
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

test("C5 the removal is bound to the workload it was asked to remove", async () => {
  // The revision check stops a concurrent registration being overwritten; it
  // does not stop a RETRY removing the wrong thing. Between the re-read and
  // the write, a rebuild can register a different workload under the same
  // handle name -- one this call never recorded and never meant to stop --
  // and removing that entry drops the only reference to a live sandbox. That
  // is the failure the revision check exists to prevent, arriving by the other
  // door.
  const bucket = fakeBucket({ a: { workload_id: "Wa" } });
  // The handle keeps its name and changes its workload while this decides.
  bucket.interleave(() => bucket.replace("a", "Wa2"));

  const wid = await destroy(bucket, "a", "Wa");

  assert.equal(wid, null, "the workload it was asked about is gone; this call removed nothing");
  assert.deepEqual(
    bucket.current(), { a: { workload_id: "Wa2" } },
    "and the workload that took its place keeps its only reference",
  );
});

test("C6 the rewrite path is conditional too, not only the delete path", async () => {
  // C1 looks like it covers this and does not. Its first write is the DELETE
  // (its row empties), so it pins the delete's `previousSeq` and says nothing
  // about the update's revision -- with that argument dropped, C1 still
  // passes. The two writes are separate arguments in separate branches and
  // need separate cover.
  //
  // Here the row does not empty, so the removal is a rewrite, and a
  // registration landing after the read is one an unconditional rewrite would
  // silently discard.
  const bucket = fakeBucket({ a: { workload_id: "Wa" }, b: { workload_id: "Wb" } });
  bucket.interleave(() => bucket.register("c", "Wc"));

  assert.equal(await destroy(bucket, "a"), "Wa");
  assert.deepEqual(
    bucket.current(), { b: { workload_id: "Wb" }, c: { workload_id: "Wc" } },
    "Wc registered while this was deciding, and a rewrite without a revision would drop it",
  );
  assert.equal(bucket.conflicts.length, 1);
});
