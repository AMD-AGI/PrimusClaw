// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A replayed tool call's input has to be a JSON object on both model wires, or
 * the endpoint rejects the whole request and the session never recovers. These
 * rows are the shapes a stored or streamed input can actually take; every one
 * must come out as an object, and the ones that carried something must not
 * have it thrown away.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { coerceToolInput, isPlainObject } from "../src/tool-input.js";

const cases: Array<{ name: string; raw: unknown; want: Record<string, unknown> }> = [
  { name: "plain object is kept", raw: { a: 1, b: "x" }, want: { a: 1, b: "x" } },
  { name: "empty object is kept", raw: {}, want: {} },
  { name: "undefined means no arguments", raw: undefined, want: {} },
  { name: "null means no arguments", raw: null, want: {} },
  { name: "empty string means no arguments", raw: "", want: {} },
  { name: "whitespace string means no arguments", raw: "  \n", want: {} },
  { name: "empty array means no arguments", raw: [], want: {} },
  { name: "string holding an object is parsed", raw: '{"path":"/x","n":2}', want: { path: "/x", n: 2 } },
  { name: "string holding an empty array means no arguments", raw: "[]", want: {} },
  { name: "string holding null means no arguments", raw: "null", want: {} },
  // The shape the redactor used to leave in a stored argumentsDetail.
  { name: "redaction placeholder is wrapped", raw: "<redacted>", want: { value: "<redacted>" } },
  { name: "truncated JSON string is wrapped raw", raw: '{"path":"/x', want: { value: '{"path":"/x' } },
  { name: "non-empty array is wrapped", raw: [1, 2], want: { value: [1, 2] } },
  { name: "string holding a non-empty array is wrapped parsed", raw: "[1,2]", want: { value: [1, 2] } },
  { name: "string holding a string is wrapped parsed", raw: '"hello"', want: { value: "hello" } },
  { name: "number is wrapped", raw: 7, want: { value: 7 } },
  { name: "boolean is wrapped", raw: false, want: { value: false } },
];

for (const c of cases) {
  test(`coerceToolInput: ${c.name}`, () => {
    const got = coerceToolInput(c.raw);
    assert.deepEqual(got, c.want);
    assert.ok(isPlainObject(got), "result must be a plain object");
    // The wire carries JSON.stringify(input); it must decode to an object.
    const wire = JSON.parse(JSON.stringify(got));
    assert.ok(isPlainObject(wire));
  });
}

test("coerceToolInput returns the same reference for a plain object", () => {
  const o = { k: 1 };
  assert.equal(coerceToolInput(o), o);
});

test("isPlainObject rejects arrays, null and class instances", () => {
  assert.equal(isPlainObject([]), false);
  assert.equal(isPlainObject(null), false);
  assert.equal(isPlainObject(new Date()), false);
  assert.equal(isPlainObject(Object.create(null)), true);
});
