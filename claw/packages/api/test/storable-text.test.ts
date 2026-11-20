// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the write boundary does to text Postgres cannot store.
 *
 * The database's side of it -- TEXT refusing NUL, jsonb refusing NUL and lone
 * surrogate escapes -- is shown against a real server in
 * pending-drain-quarantine.test.ts (Q7). These are the edges of the replacement
 * itself: what it must change, and everything it must leave alone.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { storableJson, storableOptionalText, storableText } from "../src/infra/storable-text.js";

test("NUL and both kinds of lone surrogate become U+FFFD", () => {
  assert.equal(storableText("a\u0000b"), "a�b");
  assert.equal(storableText("\uD800"), "�");
  assert.equal(storableText("\uDC00"), "�");
  assert.equal(storableText("x\uD800𐀀y"), "x�𐀀y", "a high half before a full pair");
  assert.equal(storableText("\uDC00\uD800"), "��", "halves in the wrong order are two lone halves");
});

test("text that was storable is returned unchanged", () => {
  const ok = "plain, 中文, emoji 😀, tab\t, newline\n, U+FFFD �, \u0001";
  assert.equal(storableText(ok), ok);
  assert.equal(storableText(""), "");
});

test("only strings are touched, and every string in a JSON value is", () => {
  assert.equal(storableOptionalText(null), null);
  assert.equal(storableOptionalText(undefined), undefined);
  assert.equal(storableOptionalText("a\u0000"), "a�");
  assert.deepEqual(
    storableJson({ "k\u0000": ["v\uD800", 1, true, null, { deep: "\u0000" }] }),
    { "k�": ["v�", 1, true, null, { deep: "�" }] },
  );
  const json = JSON.stringify(storableJson({ v: "\uDC00\u0000" }));
  assert.ok(!/\\u0000|\\udc00/i.test(json), "no escape jsonb refuses survives the round trip");
});
