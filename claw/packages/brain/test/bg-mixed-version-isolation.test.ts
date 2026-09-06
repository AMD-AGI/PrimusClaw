// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * B36 -- the mixed-version window must not open a cross-run door.
 *
 * A sandbox whose Hands predates the run-partitioned scheme resolves read, wait
 * and kill by owner scope and id alone. Talking to it while discarding the run
 * identity leaves N10.2.1's first negative case unenforced for as long as it
 * answers: two run identities under one owner -- a later message in a
 * conversation, a sibling node under one graph root -- could read and terminate
 * each other's shells, with no fail-closed refusal anywhere.
 *
 * A reference row cannot supply the missing half by itself: an id is freed when
 * its shell is reaped, a second run may then be given the same one, and the
 * first run's row still names it. So the boundary is folded into the id, by a
 * transform two run identities can never collide under, and the row is used
 * only to narrow what is sent -- never to authorise it.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { mayAddressUnpartitioned, runQualifiedShellId } from "../src/sandbox/bg-start.js";
import { advanceRow, type BgRowStore } from "../src/sandbox/bg-handle-rows.js";
import { decodeKeyPart } from "../src/sandbox/bg-key.js";

function memoryStore(): BgRowStore {
  const map = new Map<string, string>();
  return {
    async get(key) { return map.get(key) ?? null; },
    async put(key, value) { map.set(key, value); },
    async delete(key) { map.delete(key); },
    async keys() { return [...map.keys()]; },
  };
}

test("two run identities under one owner can never present one wire id", () => {
  const mine = runQualifiedShellId("ktsk_1", "server");
  const theirs = runQualifiedShellId("ktsk_2", "server");

  assert.notEqual(mine, theirs,
    "'server' is the obvious name and both runs will pick it; against an "
      + "owner-keyed registry the qualified form is what keeps them apart");

  const [run, id] = mine.split(".");
  assert.equal(decodeKeyPart(run), "ktsk_1");
  assert.equal(decodeKeyPart(id), "server", "and the public id is carried whole, never truncated");
});

test("the transform is total and injective, so no pair can be confused for another", () => {
  // Truncating to fit a length limit would cost exactly this property, which is
  // why nothing here truncates.
  const seen = new Map<string, string>();
  for (const run of ["a", "a.b", "ab", "", "ünïcode"]) {
    for (const id of ["x", "x.y", "xy", "server"]) {
      const wire = runQualifiedShellId(run, id);
      const prior = seen.get(wire);
      assert.equal(prior, undefined, `${prior} and ${run}/${id} collide on ${wire}`);
      seen.set(wire, `${run}/${id}`);
    }
  }
});

test("no read, wait or kill is forwarded for an id this run holds no row for", async () => {
  const store = memoryStore();
  await advanceRow(store, { ownerScope: "sess", runIdentity: "ktsk_1", shellId: "bg-1" },
    "gen-1", "spawn_confirmed");

  assert.equal(
    await mayAddressUnpartitioned(store, { ownerScope: "sess", runIdentity: "ktsk_1", shellId: "bg-1" }),
    true,
  );
  assert.equal(
    await mayAddressUnpartitioned(store, { ownerScope: "sess", runIdentity: "ktsk_2", shellId: "bg-1" }),
    false,
    "a sibling run naming the same id is refused rather than forwarded, and is "
      + "answered exactly as a never-issued id",
  );
  assert.equal(
    await mayAddressUnpartitioned(store, { ownerScope: "sess", runIdentity: "ktsk_1", shellId: "pre-upgrade" }),
    false,
    "a shell predating the rows has no recorded run identity, so no wire form "
      + "can carry a boundary for it and a verbatim carve-out would let any run "
      + "of one owner reach it",
  );
});
