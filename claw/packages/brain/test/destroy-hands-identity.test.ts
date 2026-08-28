// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** CAS deletion that keeps a concurrent DAG sibling's session entry intact. */
import test from "node:test";
import assert from "node:assert/strict";
import { deleteHandsEntryIfRevision } from "../src/sandbox/reaper.js";

test("delete is conditional on the revision read before remote stop", async () => {
  const calls: unknown[][] = [];
  const kv = {
    async delete(...args: unknown[]) {
      calls.push(args);
    },
  };
  assert.equal(await deleteHandsEntryIfRevision(kv, "hands.s1", 17), true);
  assert.deepEqual(calls, [["hands.s1", { previousSeq: 17 }]]);
});

test("a revision conflict preserves the replacement entry", async () => {
  const kv = {
    async delete() {
      throw new Error("wrong last sequence");
    },
  };
  assert.equal(await deleteHandsEntryIfRevision(kv, "hands.s1", 17), false);
});
