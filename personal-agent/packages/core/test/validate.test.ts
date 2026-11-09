// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { parseInput } from "../src/index.js";

const Item = z.object({ id: z.string(), count: z.number().int(), tags: z.array(z.string()) });

test("parseInput returns the parsed value of a valid input", () => {
  const result = parseInput("test.item", Item, { id: "a", count: 2, tags: ["x"], extra: true });
  assert.deepEqual(result, { ok: true, value: { id: "a", count: 2, tags: ["x"] } });
});

test("parseInput reports the paths of the bad fields, never their values", () => {
  const result = parseInput("test.item", Item, { id: 7, count: "sk-secret-value", tags: [1, "ok", 2] });
  assert.ok(!result.ok);
  assert.equal(result.error.kind, "invalid_input");
  assert.equal(result.error.what, "test.item");
  assert.deepEqual(result.error.paths, ["id", "count", "tags.0", "tags.2"]);
  assert.doesNotMatch(JSON.stringify(result.error), /sk-secret-value/);
});

test("parseInput names the root when the input is not an object at all", () => {
  const result = parseInput("test.item", Item, "nope");
  assert.deepEqual(result, { ok: false, error: { kind: "invalid_input", what: "test.item", paths: ["(root)"] } });
});
