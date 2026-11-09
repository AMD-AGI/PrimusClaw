// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";

test("importing the runtime package (and core through it) does not throw", async () => {
  const runtime = await import("../src/index.js");
  assert.equal(typeof runtime.createClawClient, "function");
});
