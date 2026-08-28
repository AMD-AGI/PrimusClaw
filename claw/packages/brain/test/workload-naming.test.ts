// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { test } from "node:test";
import assert from "node:assert/strict";
import { multiNodeWorkloadName, sandboxWorkloadName } from "../src/sandbox/workload-naming.js";

test("every SaFE workload Claw creates shares the claw-<epoch-ms>-<kind> shape", () => {
  assert.equal(sandboxWorkloadName(1785291793209), "claw-1785291793209-sandbox");
  assert.equal(multiNodeWorkloadName("claw-1785291151001", "rayjob"), "claw-1785291151001-ray");
  assert.equal(multiNodeWorkloadName("claw-1785291151001", "infera"), "claw-1785291151001-infera");
});

test("multiNodeWorkloadName is stable for a message id, so a redelivery maps to the same name", () => {
  const first = multiNodeWorkloadName("claw-1785291151001", "rayjob");
  assert.equal(multiNodeWorkloadName("claw-1785291151001", "rayjob"), first);
  assert.notEqual(multiNodeWorkloadName("claw-1785291151002", "rayjob"), first);
});

test("multiNodeWorkloadName sanitises a message id into a legal object name", () => {
  assert.equal(multiNodeWorkloadName("  Claw_ABC/99  ", "rayjob"), "claw-abc-99-ray");
  assert.equal(multiNodeWorkloadName("--edges--", "infera"), "edges-infera");
});

test("multiNodeWorkloadName keeps the name within the 63-character limit", () => {
  const name = multiNodeWorkloadName("m".repeat(80), "infera");
  assert.equal(name.length, 63);
  assert.ok(name.endsWith("-infera"));
  // Truncation must not leave a trailing dash before the suffix.
  assert.ok(!name.includes("--"));
});

test("multiNodeWorkloadName refuses a message id with nothing usable in it", () => {
  assert.throws(() => multiNodeWorkloadName("", "rayjob"), /message_id is required/);
  assert.throws(() => multiNodeWorkloadName("///", "rayjob"), /message_id is required/);
});
