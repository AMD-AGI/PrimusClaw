// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";

test("importing the core package builds every pattern it compiles at load without throwing", async () => {
  const core = await import("../src/index.js");
  assert.equal(typeof core.looksInternal, "function");
  assert.equal(core.looksInternal("redis-proxy:6379 refused"), true);
  assert.equal(core.looksInternal("LOCALHOST is down"), true);
  assert.equal(core.looksInternal("Primus-Gateway timed out"), true);
  assert.equal(core.looksInternal("the connector was revoked"), false);
});
