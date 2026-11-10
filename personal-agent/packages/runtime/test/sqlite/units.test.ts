// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// JSON text as Python writes it, typed column reads, and the stored-secret keys.
import assert from "node:assert/strict";
import { test } from "node:test";

import { Fernet, StoreSecrets, tokenHex, tokenUrlsafe, drawCode } from "@primusclaw/personal-agent-runtime";

import { col } from "../../src/sqlite/database.js";
import { jsonFlags, jsonList, jsonStrings, parseJson, pyJsonDumps, storedObject } from "../../src/sqlite/py-json.js";
import { SeededRandom } from "../../../../test-support/index.js";

test("JSON text is Python's json.dumps default: spaced separators, non-ASCII escaped", () => {
  assert.equal(
    pyJsonDumps({ a: [1, "x"], b: null, c: true, d: false }),
    '{"a": [1, "x"], "b": null, "c": true, "d": false}',
  );
  assert.equal(pyJsonDumps('密钥 🔑\u007f\n"/'), '"\\u5bc6\\u94a5 \\ud83d\\udd11\\u007f\\n\\"/"');
  assert.equal(pyJsonDumps({ skipped: undefined, n: 1.5 }), '{"n": 1.5}');
  assert.equal(pyJsonDumps(undefined), "null");
  assert.deepEqual(
    [pyJsonDumps(Number.NaN), pyJsonDumps(Infinity), pyJsonDumps(-Infinity)],
    ["NaN", "Infinity", "-Infinity"],
  );
  assert.throws(() => pyJsonDumps(() => 1), TypeError);
});

test("stored JSON that is not what a column holds reads as nothing", () => {
  assert.equal(parseJson(null), undefined);
  assert.equal(parseJson("{"), undefined);
  assert.deepEqual(jsonList("[1, 2]"), [1, 2]);
  assert.deepEqual(jsonList('{"a": 1}'), []);
  assert.deepEqual(jsonStrings('["a", 1, "b"]'), ["a", "b"]);
  assert.deepEqual(jsonFlags('{"a": true, "b": 1, "c": false}'), { a: true, c: false });
  assert.deepEqual(jsonFlags("[true]"), {});
  assert.deepEqual(jsonFlags("null"), {});
  assert.deepEqual(storedObject('{"a": 1}'), { a: 1 });
  assert.equal(storedObject("[1]"), null);
});

test("column reads coerce as the store's columns hold them", () => {
  const row = { s: "x", n: 2, b: 3n, nul: null, blob: Uint8Array.from([104, 105]), empty: new Uint8Array(), z: "0" };
  assert.deepEqual(
    [col.str(row, "n"), col.str(row, "b"), col.str(row, "blob"), col.str(row, "nul"), col.str(row, "missing")],
    ["2", "3", "hi", "", ""],
  );
  assert.deepEqual([col.num(row, "b"), col.num(row, "z"), col.num(row, "nul"), col.num(row, "blob")], [3, 0, 0, 0]);
  assert.deepEqual(
    [col.strOrNull(row, "nul"), col.strOrNull(row, "s"), col.numOrNull(row, "nul"), col.numOrNull(row, "n")],
    [null, "x", null, 2],
  );
  assert.deepEqual(
    [col.bool(row, "blob"), col.bool(row, "empty"), col.bool(row, "nul"), col.bool(row, "z"), col.bool(row, "b")],
    [true, false, false, true, true],
  );
  assert.deepEqual(col.bytes(row, "s"), new TextEncoder().encode("x"));
  assert.equal(col.bytes(row, "blob"), row.blob);
});

test("the stored-secret keys: at least one, the first encrypts and hashes, every one reads", () => {
  assert.throws(() => new StoreSecrets([]), RangeError);
  const old = Fernet.generateKey();
  const fresh = Fernet.generateKey();
  const before = new StoreSecrets([old]);
  const both = new StoreSecrets([fresh, old], () => 1_000);
  const token = before.encrypt("ak-1");
  assert.equal(both.decrypt(token), "ak-1");
  assert.equal(new StoreSecrets([fresh]).decrypt(token), null);
  assert.equal(both.hashes("CODE").length, 2);
  assert.equal(both.hashes("CODE")[1], before.primaryHash("CODE"));
  assert.throws(() => both.decrypt(new TextEncoder().encode(both.all.encrypt(Uint8Array.from([0xff])))), TypeError);
});

test("random ids are Python's token_urlsafe / token_hex shapes, codes come from their alphabet", () => {
  const random = new SeededRandom(3);
  assert.match(tokenUrlsafe(random, 12), /^[A-Za-z0-9_-]{16}$/);
  assert.match(tokenUrlsafe(random, 9), /^[A-Za-z0-9_-]{12}$/);
  assert.match(tokenHex(random, 8), /^[0-9a-f]{16}$/);
  assert.match(drawCode(random, "AB", 8), /^[AB]{8}$/);
});
