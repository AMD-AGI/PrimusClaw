// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `storableJson`: what PostgreSQL's jsonb refuses (NUL, a lone surrogate)
 * becomes U+FFFD, and everything else is left exactly as it was. The database
 * side of it, a refused write turned into a stored one, is in a2a-push.test.ts.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { storableJson } from "../src/notifications/storable-json.js";

test("NUL and lone surrogates become U+FFFD, in values and keys, at any depth", () => {
  const input = {
    "k\u0000ey": "a\u0000b",
    list: ["high \ud83d alone", "low \ude00 alone", ["\u0000"]],
    nested: { swapped: "\ude00\ud83d", doubled: "\ud83d😀" },
  };
  assert.deepEqual(storableJson(input), {
    "k�ey": "a�b",
    list: ["high � alone", "low � alone", ["�"]],
    nested: { swapped: "��", doubled: "�😀" },
  });
});

test("a value that was already storable comes back equal", () => {
  const input = {
    text: "plain, 中文, an emoji 😀, a tab\tand \u0001 control",
    n: 3, f: 1.5, yes: true, nothing: null, empty: "", list: [1, "two", { three: 3 }],
  };
  assert.deepEqual(storableJson(input), input);
  assert.equal(storableJson("x"), "x");
  assert.equal(storableJson(7), 7);
  assert.equal(storableJson(null), null);
});

test("the input is not modified", () => {
  const input = { a: "x\u0000y", b: ["\ud800"] };
  storableJson(input);
  assert.deepEqual(input, { a: "x\u0000y", b: ["\ud800"] });
});

test("an object with its own JSON form keeps it", () => {
  const when = new Date("2026-11-20T00:00:00Z");
  assert.equal(JSON.stringify(storableJson({ when })), JSON.stringify({ when }));
});
