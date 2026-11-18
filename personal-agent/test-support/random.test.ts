// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import { SeededRandom } from "./index.js";

test("the same seed gives the same sequence, another seed another", () => {
  const a = new SeededRandom(42);
  const b = new SeededRandom(42);
  assert.equal(a.hexId(), b.hexId());
  assert.deepEqual(a.bytes(8), b.bytes(8));
  assert.notEqual(new SeededRandom(1).hexId(), new SeededRandom(2).hexId());
});

test("its values have the shapes of the port", () => {
  const r = new SeededRandom();
  assert.match(r.hexId(), /^[0-9a-f]{32}$/);
  assert.equal(r.bytes(5).length, 5);
  for (let i = 0; i < 100; i++) {
    const n = r.int(3);
    assert.ok(Number.isInteger(n) && n >= 0 && n < 3);
    const f = r.fraction();
    assert.ok(f >= 0 && f < 1);
  }
});
