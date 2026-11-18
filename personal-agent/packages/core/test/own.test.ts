// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import { own } from "../src/index.js";

const PROTOTYPE_NAMES = ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", "isPrototypeOf"];

test("own reads a table's own keys only, like a Python dict's get", () => {
  const table: Readonly<Record<string, string>> = { status: "/status", stop: "/stop" };
  assert.equal(own(table, "status"), "/status");
  assert.equal(own(table, "nope"), undefined);
  for (const name of PROTOTYPE_NAMES) assert.equal(own(table, name), undefined, name);
});

test("own finds a '__proto__' key the table really has (JSON.parse makes it an own key)", () => {
  const parsed = JSON.parse('{"__proto__": "kept", "constructor": "also kept"}') as Record<string, string>;
  assert.equal(own(parsed, "__proto__"), "kept");
  assert.equal(own(parsed, "constructor"), "also kept");
});
