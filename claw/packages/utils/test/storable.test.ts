// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";

import { redactStoredText, redactStoredValue, storableJson, storableJsonText, storableText } from "../src/index.js";

const R = "�";

test("storableText replaces a NUL and each unpaired surrogate, and keeps whole pairs and everything else", () => {
  assert.equal(storableText("a\u0000b\u0000"), `a${R}b${R}`);
  assert.equal(storableText("x\uD800"), `x${R}`, "a high surrogate at the end");
  assert.equal(storableText("\uD800x"), `${R}x`, "a high surrogate before something that is not a low one");
  assert.equal(storableText("\uDC00x"), `${R}x`, "a low surrogate with no high one before it");
  assert.equal(storableText("\uD800𐀀"), `${R}𐀀`, "only the unpaired half of three");
  assert.equal(storableText("emoji 😀 ok"), "emoji 😀 ok");
  const plain = "tab\tline\nfine \\u0000 as written";
  assert.equal(storableText(plain), plain, "an escaped NUL written out as text is text");
  // Called twice in a row on the same kind of input (a global pattern keeps a position between calls).
  assert.equal(storableText("\u0000"), R);
  assert.equal(storableText("\u0000"), R);
});

test("storableJson walks keys and values at any depth, keeps non-strings, and does not change its input", () => {
  const input = { ["k\u0000"]: [{ v: "x\u0000", n: 1, b: true, z: null }, "\uDBFF"], at: new Date(0), plain: "p" };
  const copy = JSON.parse(JSON.stringify(input));
  const out = storableJson(input);
  assert.deepEqual(out, { [`k${R}`]: [{ v: `x${R}`, n: 1, b: true, z: null }, R], at: "1970-01-01T00:00:00.000Z", plain: "p" });
  assert.deepEqual(JSON.parse(JSON.stringify(input)), copy, "the input is unchanged");
  assert.ok(!/\\u0000|\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f])/i.test(storableJsonText(input)), "nothing PostgreSQL's jsonb refuses is left in the text");
});

test("a `__proto__` key in parsed JSON stays a field of the copy and never becomes its prototype", () => {
  const input = JSON.parse('{"__proto__": {"polluted": "x\\u0000"}, "a": 1}') as Record<string, unknown>;
  const out = storableJson(input) as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
  assert.equal((out as { polluted?: unknown }).polluted, undefined);
  assert.deepEqual(JSON.parse(storableJsonText(input)), JSON.parse(`{"__proto__": {"polluted": "x${R}"}, "a": 1}`));
});

test("what redactStoredText and redactStoredValue hand to an INSERT is storable", () => {
  assert.equal(redactStoredText("out\u0000put").text, `out${R}put`);
  assert.deepEqual(redactStoredValue({ message_id: "m\u0000", ["k\u0000"]: "v\uD800", password: "hunter2" }),
    { message_id: `m${R}`, [`k${R}`]: `v${R}`, password: "<redacted>" });
});
