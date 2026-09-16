// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The reference row, and the two crash windows it has to tell apart.
 *
 * A row written on the way back would leave the send window covered by nothing
 * durable, so each state precedes the act it attests. What separates them is
 * exactly one fact -- whether the command can have run -- and getting that
 * wrong in either direction is expensive: reading `dispatched` as a first call
 * runs the work twice, and reading it as permanently unknown strands a request
 * that never went out.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  advanceRow, deleteRunRows, readRow, releaseRow, rowKey, runRowFilter, type BgRowStore,
} from "../src/sandbox/bg-handle-rows.js";
import { bgRowStore, bindBgHandleRowsForTest } from "../src/sandbox/bg-row-store.js";
import { decodeKeyPart, encodeKeyPart } from "@claw/protocol";
import { matchesKvFilter } from "./fixtures/kv-filter.js";

function memoryStore(): BgRowStore & {
  map: Map<string, { value: string; revision: number }>;
  conflictOnce(): void;
} {
  const map = new Map<string, { value: string; revision: number }>();
  let stale = false;
  return {
    map,
    conflictOnce() { stale = true; },
    async read(key) { return map.get(key) ?? null; },
    async write(key, value, expectedRevision) {
      // One injected lost race, so the retry path is exercised rather than
      // assumed: a store that never refuses cannot tell a compare-and-set from
      // an unconditional put.
      if (stale) { stale = false; return false; }
      const current = map.get(key);
      if ((current?.revision ?? null) !== expectedRevision) return false;
      map.set(key, { value, revision: (current?.revision ?? 0) + 1 });
      return true;
    },
    async delete(key, expectedRevision) {
      // Reports the lost race rather than swallowing it, the way the bucket-
      // backed store does: a stub that answered `true` here would let a caller
      // count a row it never removed.
      if (map.get(key)?.revision !== expectedRevision) return false;
      map.delete(key);
      return true;
    },
    async keys(filter) {
      return [...map.keys()].filter((k) => matchesKvFilter(k, filter));
    },
  };
}

const ADDRESS = { ownerScope: "sess", runIdentity: "ktsk_1", shellId: "bg-1" };

test("a key is inside the accepted character set for every address", () => {
  // Base32 rather than the record subtree's own escape scheme: that one escapes
  // with a character the key-value client refuses, so an address carrying any
  // byte it escapes would be unwritable exactly where it is needed.
  const awkward = { ownerScope: "a/b", runIdentity: "ünïcode", shellId: "x.y-z" };
  assert.match(rowKey(awkward), /^[-/=.\w]+$/);
  assert.equal(rowKey(awkward).split(".").length, 4, "and carries no dot of its own");
});

test("the encoding is injective, so two addresses cannot present one key", () => {
  for (const part of ["a", "a.b", "a/b", "", "ünïcode", "x".repeat(80)]) {
    assert.equal(decodeKeyPart(encodeKeyPart(part)), part, part);
  }
  assert.notEqual(
    rowKey({ ownerScope: "a", runIdentity: "b.c", shellId: "d" }),
    rowKey({ ownerScope: "a", runIdentity: "b", shellId: "c.d" }),
  );
});

test("states advance and never go backwards", async () => {
  const store = memoryStore();
  await advanceRow(store, ADDRESS, "gen-1", "issued");
  await advanceRow(store, ADDRESS, "gen-1", "dispatched");
  await advanceRow(store, ADDRESS, "gen-1", "issued");
  assert.equal((await readRow(store, ADDRESS))!.state, "dispatched",
    "a replayed dispatch converges rather than undoing what already happened");

  await advanceRow(store, ADDRESS, "gen-1", "spawn_confirmed");
  assert.equal((await readRow(store, ADDRESS))!.state, "spawn_confirmed");
});

test("a slower writer cannot put an older state back over a newer one", async () => {
  // The read-then-write shape this forbids: a replay that read `dispatched`
  // while the original was confirming would regress the row, and a later
  // resolution would then re-send a start for a shell that already exists.
  const store = memoryStore();
  await advanceRow(store, ADDRESS, "gen-1", "issued");
  await advanceRow(store, ADDRESS, "gen-1", "spawn_confirmed");

  store.conflictOnce();
  await advanceRow(store, ADDRESS, "gen-1", "dispatched");

  assert.equal((await readRow(store, ADDRESS))!.state, "spawn_confirmed",
    "the refused write is re-decided against what is actually there");
});

test("contention that never settles is raised, not silently dropped", async () => {
  const store = memoryStore();
  const alwaysStale: BgRowStore = { ...store, async write() { return false; } };
  await assert.rejects(
    () => advanceRow(alwaysStale, ADDRESS, "gen-1", "issued"),
    /could not be advanced/,
  );
});

test("a new sandbox generation restamps the row rather than inheriting the old state", async () => {
  const store = memoryStore();
  await advanceRow(store, ADDRESS, "gen-1", "spawn_confirmed");
  await advanceRow(store, ADDRESS, "gen-2", "issued");
  const row = (await readRow(store, ADDRESS))!;
  assert.equal(row.generation, "gen-2");
  assert.equal(row.state, "issued", "the previous sandbox's confirmation says nothing about this one");
});

test("a run's rows go when the run ends, and only that run's", async () => {
  const store = memoryStore();
  await advanceRow(store, ADDRESS, "gen-1", "spawn_confirmed");
  await advanceRow(store, { ...ADDRESS, shellId: "bg-2" }, "gen-1", "dispatched");
  await advanceRow(store, { ...ADDRESS, runIdentity: "ktsk_2" }, "gen-1", "spawn_confirmed");

  assert.equal(await deleteRunRows(store, "sess", "ktsk_1"), 2);
  assert.equal(await readRow(store, ADDRESS), null);
  assert.ok(await readRow(store, { ...ADDRESS, runIdentity: "ktsk_2" }),
    "a sibling run under the same owner has not ended");
  assert.match(runRowFilter("sess", "ktsk_1"), /^bgshell\.[A-Z2-7]+\.[A-Z2-7]+\.\*$/);
});

test("the store stub matches subjects the way the bucket does", () => {
  // A stub that matches more than the real bucket makes the tests above pass on
  // a filter production would get nothing back from. `*` is one whole token,
  // never a prefix inside one, which is why the reserved-namespace scan has to
  // narrow in its own code.
  const key = rowKey(ADDRESS);
  assert.ok(matchesKvFilter(key, runRowFilter("sess", "ktsk_1")));
  assert.ok(!matchesKvFilter(key, runRowFilter("sess", "ktsk_2")));
  assert.ok(!matchesKvFilter("hands.retained-ABC", "hands.retained-*"),
    "a wildcard inside a token matches nothing, so a scan spelled that way "
      + "would report a namespace it never looked at");
  assert.ok(matchesKvFilter("hands.retained-ABC", "hands.*"));
  assert.ok(!matchesKvFilter("bgshell.A.B.C.D", "bgshell.A.B.*"),
    "and a wildcard is one token, not the rest of the key");
});

/**
 * A bucket stand-in carrying the two things the map above cannot express:
 * JetStream's delete markers, and a conditioned write that raises rather than
 * returning. Both are what the real store has to absorb, so both have to be
 * here for the store's own code to be exercised at all -- `memoryStore` stands
 * in for the store, and the store is exactly what these two tests are about.
 */
function tombstoneBucket() {
  const map = new Map<
    string, { value: Uint8Array; revision: number; operation: "PUT" | "DEL" }
  >();
  let seq = 0;
  // The shape the client classifies on, both halves of it: JetStream's
  // `err_code` and the text a transport that carries only that would leave.
  const conflict = () => Object.assign(new Error("wrong last sequence"), {
    api_error: { err_code: 10071 },
  });
  return {
    // Returns the delete marker like any other entry, because that is what the
    // client does -- `get` filters nothing, and the marker's payload is empty.
    async get(key: string) { return map.get(key) ?? null; },
    async create(key: string, value: Uint8Array) {
      const current = map.get(key);
      // A live entry refuses; a tombstone is written over, which is the client's
      // own create-over-a-deleted-key behaviour rather than an indulgence here.
      if (current && current.operation !== "DEL") throw conflict();
      map.set(key, { value, revision: ++seq, operation: "PUT" });
      return seq;
    },
    async update(key: string, value: Uint8Array, expected: number) {
      if (map.get(key)?.revision !== expected) throw conflict();
      map.set(key, { value, revision: ++seq, operation: "PUT" });
      return seq;
    },
    async delete(key: string, opts?: { previousSeq?: number }) {
      const current = map.get(key);
      if (opts?.previousSeq !== undefined && current?.revision !== opts.previousSeq) {
        throw conflict();
      }
      map.set(key, { value: new Uint8Array(), revision: ++seq, operation: "DEL" });
    },
    async keys(filter: string) {
      // Deleted keys are not keys: the client's own walk drops DEL and PURGE.
      const hits = [...map.entries()]
        .filter(([k, e]) => e.operation !== "DEL" && matchesKvFilter(k, filter))
        .map(([k]) => k);
      return (async function* () { yield* hits; })();
    },
  };
}

test("a released row reads as absent, not as a row that could not be read", async () => {
  const restore = bindBgHandleRowsForTest(tombstoneBucket() as never);
  try {
    const store = bgRowStore()!;
    await advanceRow(store, ADDRESS, "gen-1", "issued");
    const decided = (await store.read(rowKey(ADDRESS)))!.revision;
    assert.equal(await releaseRow(store, ADDRESS, decided), "released");

    // The marker is still the key's last message. Read as a value it is the
    // empty string, and an empty string is where `readRow` throws -- which
    // reaches `resolveStart` as `rowReadable: false` and refuses a start that
    // was released precisely because it never reached the sandbox. The bucket
    // has no expiry, so the marker never goes and neither does the refusal.
    assert.equal(await readRow(store, ADDRESS), null);

    await advanceRow(store, ADDRESS, "gen-1", "dispatched");
    assert.equal((await readRow(store, ADDRESS))!.state, "dispatched",
      "and the address is usable again, written over its own tombstone");
  } finally {
    restore();
  }
});

/**
 * The three ways a release can end, and why only one of them is a release.
 *
 * `dispatched` is written before the request leaves and stands for the whole
 * spawn round trip, so a confirmation can land anywhere between the read that
 * licensed a release and the delete that performs it. Its caller turns the
 * answer into a sentence for the model -- "nothing ran, issue it again" -- so a
 * delete this call did not perform must not read back as one that it did.
 */
test("a row that moved on after the decision is not released by it", async () => {
  const store = memoryStore();
  await advanceRow(store, ADDRESS, "gen-1", "dispatched");
  const decided = (await store.read(rowKey(ADDRESS)))!.revision;
  // The dispatch this decision is about, confirming its shell meanwhile.
  await advanceRow(store, ADDRESS, "gen-1", "spawn_confirmed");

  assert.equal(await releaseRow(store, ADDRESS, decided), "moved_on");
  assert.equal((await readRow(store, ADDRESS))?.state, "spawn_confirmed",
    "and the one durable record that a shell exists survives a decision taken "
      + "before it was written");
});

test("a confirmation landing at the delete is a lost race, not a release", async () => {
  const real = memoryStore();
  await advanceRow(real, ADDRESS, "gen-1", "dispatched");
  const decided = (await real.read(rowKey(ADDRESS)))!.revision;

  // Staged at the only seam it is visible from: the confirmation arrives
  // strictly between the release's own read and the delete conditioned on it,
  // so the read still answers `dispatched` and the compare-and-set is what
  // catches it.
  const store: BgRowStore = {
    ...real,
    async read(key) {
      const entry = await real.read(key);
      if (entry && key === rowKey(ADDRESS)) {
        await advanceRow(real, ADDRESS, "gen-1", "spawn_confirmed");
      }
      return entry;
    },
  };

  assert.equal(await releaseRow(store, ADDRESS, decided), "moved_on");
  assert.equal((await readRow(real, ADDRESS))?.state, "spawn_confirmed");
});

test("a row someone else removed is absent, not a release this call made", async () => {
  // Absence here is evidence of nothing: a peer releasing on the same evidence
  // and a predecessor's terminal cleanup both produce it, and only the first
  // means the command never ran.
  const store = memoryStore();

  assert.equal(await releaseRow(store, ADDRESS, 1), "absent");
});

test("a row contended at teardown is skipped, and the run's other rows still go", async () => {
  const restore = bindBgHandleRowsForTest(tombstoneBucket() as never);
  try {
    const real = bgRowStore()!;
    await advanceRow(real, ADDRESS, "gen-1", "dispatched");
    await advanceRow(real, { ...ADDRESS, shellId: "bg-2" }, "gen-1", "spawn_confirmed");

    // A live dispatch rewrites the first row between the walk's read of it and
    // the delete conditioned on that read -- the race the conditioning exists
    // for, staged at the only seam it is visible from.
    const contended = rowKey(ADDRESS);
    const store: BgRowStore = {
      ...real,
      async read(key) {
        const entry = await real.read(key);
        if (entry && key === contended) await real.write(key, entry.value, entry.revision);
        return entry;
      },
    };

    assert.equal(await deleteRunRows(store, "sess", "ktsk_1"), 1,
      "the lost race is an answer about one row, not the end of the walk");
    assert.ok(await readRow(real, ADDRESS), "the contended row is left to its writer");
    assert.equal(await readRow(real, { ...ADDRESS, shellId: "bg-2" }), null,
      "and the rows behind it are still reached, rather than stranded for ever "
        + "in a bucket that expires nothing");
  } finally {
    restore();
  }
});
