// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { test } from "node:test";
import assert from "node:assert/strict";
import { isJsonPointer, resolveFirstJsonPointer, resolveJsonPointer } from "../src/json-pointer.js";

const DOC = {
  a: { b: [10, { c: "deep" }, 30] },
  "a/b": "slash",
  "m~n": "tilde",
  "~1": "literal-tilde-one",
  "": "empty-key",
  nothing: null,
  zero: 0,
  flag: false,
  list: ["x"],
};

test("resolves nested objects and arrays", () => {
  assert.deepEqual(resolveJsonPointer(DOC, "/a/b/1/c"), { found: true, value: "deep" });
  assert.deepEqual(resolveJsonPointer(DOC, "/a/b/0"), { found: true, value: 10 });
});

test("decodes ~1 before ~0, per RFC 6901", () => {
  assert.deepEqual(resolveJsonPointer(DOC, "/a~1b"), { found: true, value: "slash" });
  assert.deepEqual(resolveJsonPointer(DOC, "/m~0n"), { found: true, value: "tilde" });
  assert.deepEqual(resolveJsonPointer(DOC, "/~01"), { found: true, value: "literal-tilde-one" });
});

test("the empty pointer is the whole document and '/' is the empty key", () => {
  assert.deepEqual(resolveJsonPointer(DOC, ""), { found: true, value: DOC });
  assert.deepEqual(resolveJsonPointer(DOC, "/"), { found: true, value: "empty-key" });
});

test("falsy values are present; null is absent", () => {
  assert.deepEqual(resolveJsonPointer(DOC, "/zero"), { found: true, value: 0 });
  assert.deepEqual(resolveJsonPointer(DOC, "/flag"), { found: true, value: false });
  assert.deepEqual(resolveJsonPointer(DOC, "/nothing"), { found: false });
});

test("array tokens must be canonical in-range indexes", () => {
  for (const p of ["/a/b/3", "/a/b/-", "/a/b/01", "/a/b/+1", "/a/b/1e0", "/a/b/x", "/a/b/-1"]) {
    assert.deepEqual(resolveJsonPointer(DOC, p), { found: false }, p);
  }
});

test("only own properties are read", () => {
  for (const p of ["/__proto__", "/constructor", "/toString", "/list/length", "/a/__proto__/x"]) {
    assert.deepEqual(resolveJsonPointer(DOC, p), { found: false }, p);
  }
  assert.deepEqual(resolveJsonPointer(JSON.parse('{"__proto__":{"x":1}}'), "/__proto__/x"), { found: true, value: 1 });
});

test("a malformed pointer or a scalar parent is not found rather than a throw", () => {
  for (const p of ["a", "/a~", "/a~2", "/zero/x", "/list/0/x"]) {
    assert.deepEqual(resolveJsonPointer(DOC, p), { found: false }, p);
  }
  assert.equal(isJsonPointer("a"), false);
  assert.equal(isJsonPointer("/a~2"), false);
  assert.equal(isJsonPointer(""), true);
});

test("a list of pointers takes the first that is present", () => {
  assert.deepEqual(resolveFirstJsonPointer(DOC, ["/missing", "/nothing", "/zero", "/a/b/0"]), { found: true, value: 0 });
  assert.deepEqual(resolveFirstJsonPointer(DOC, "/a/b/2"), { found: true, value: 30 });
  assert.deepEqual(resolveFirstJsonPointer(DOC, ["/x", "/y"]), { found: false });
  assert.deepEqual(resolveFirstJsonPointer(DOC, undefined), { found: false });
});
