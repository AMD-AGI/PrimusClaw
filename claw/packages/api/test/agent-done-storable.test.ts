// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// What `storableText` / `storableJson` change, and what they must leave alone.
// The Postgres side of this (that the replaced characters are the ones the
// database refuses) is `agent-done-unstorable-pg.test.ts`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { storableJson, storableText, unstorableSqlState, type Replacements } from "../src/tasks/storable.js";

const R = "�";

test("U+0000 and lone surrogates become U+FFFD, valid pairs and everything else stay", () => {
  const tally: Replacements = { count: 0 };
  assert.equal(storableText("a\u0000b", tally), `a${R}b`);
  assert.equal(storableText("hi \uD800", tally), `hi ${R}`, "a high surrogate at the end");
  assert.equal(storableText("\uDC00 lo", tally), `${R} lo`, "a low surrogate with no high one before it");
  assert.equal(storableText("\uDC00\uD800", tally), `${R}${R}`, "a pair in the wrong order is two lone halves");
  assert.equal(tally.count, 5);
  const kept = "emoji \u{1F600}, tab\t, newline\n, \u0001 control, CJK 中文";
  assert.equal(storableText(kept, tally), kept);
  assert.equal(tally.count, 5, "nothing storable is counted");
});

test("every string in a JSON value is made storable, keys included", () => {
  const tally: Replacements = { count: 0 };
  const input = {
    "k\u0000": ["x\uD83D", { deep: "y\u0000" }],
    n: 3, b: true, z: null, ok: "\u{1F600}",
  };
  assert.deepEqual(storableJson(input, tally), {
    [`k${R}`]: [`x${R}`, { deep: `y${R}` }],
    n: 3, b: true, z: null, ok: "\u{1F600}",
  });
  assert.equal(tally.count, 3);
  assert.equal(input["k\u0000"][0], "x\uD83D", "the input is not modified");
});

test("a __proto__ key in a body stays a key", () => {
  const body = JSON.parse('{"__proto__": {"polluted": true}, "a": "x\\u0000"}') as Record<string, unknown>;
  const out = storableJson(body) as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
  assert.equal((out as { polluted?: unknown }).polluted, undefined);
  assert.deepEqual(Object.keys(out), ["__proto__", "a"]);
  assert.equal(out.a, `x${R}`);
});

test("only the SQLSTATEs a resend cannot change are unstorable", () => {
  for (const code of ["22021", "22P05", "22P02", "22003"]) assert.equal(unstorableSqlState({ code }), code);
  for (const code of ["40001", "57P01", "53300", "23505", undefined]) assert.equal(unstorableSqlState({ code }), null);
  assert.equal(unstorableSqlState(null), null);
  assert.equal(unstorableSqlState(new Error("boom")), null);
});
