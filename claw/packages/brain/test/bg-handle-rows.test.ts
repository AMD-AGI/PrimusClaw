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
  advanceRow, deleteRunRows, readRow, rowKey, runRowFilter, type BgRowStore,
} from "../src/sandbox/bg-handle-rows.js";
import { decodeKeyPart, encodeKeyPart } from "../src/sandbox/bg-key.js";
import { matchesKvFilter } from "./fixtures/kv-filter.js";

function memoryStore(): BgRowStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    async get(key) { return map.get(key) ?? null; },
    async put(key, value) { map.set(key, value); },
    async delete(key) { map.delete(key); },
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
