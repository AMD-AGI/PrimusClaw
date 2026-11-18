// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import { cryptoRandom } from "../src/index.js";

test("bytes gives the length asked, and two draws differ", () => {
  assert.equal(cryptoRandom.bytes(0).length, 0);
  const a = cryptoRandom.bytes(32);
  assert.equal(a.length, 32);
  assert.ok(a instanceof Uint8Array);
  assert.notDeepEqual(a, cryptoRandom.bytes(32));
});

test("hexId is 32 lowercase hex characters, the shape of uuid4().hex", () => {
  const ids = new Set(Array.from({ length: 50 }, () => cryptoRandom.hexId()));
  assert.equal(ids.size, 50);
  for (const id of ids) assert.match(id, /^[0-9a-f]{32}$/);
});

test("int stays in [0, max) and fraction in [0, 1)", () => {
  for (let i = 0; i < 200; i++) {
    const n = cryptoRandom.int(7);
    assert.ok(Number.isInteger(n) && n >= 0 && n < 7);
    const f = cryptoRandom.fraction();
    assert.ok(f >= 0 && f < 1);
  }
});
