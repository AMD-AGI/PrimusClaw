// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * When the API says memory is off for this user, the agent must not be told
 * "Memory saved" for a write the API will drop. The tool is withheld from the
 * schema list, and a call that arrives anyway is refused explicitly.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { ToolRouter } from "../src/tools/router.js";

const input = { category: "preference", content: "the user likes tabs" };

test("memory on (default): save_memory is offered and reports success", async () => {
  const router = new ToolRouter(null);
  assert.ok(router.getToolSchemas().some((t) => t.name === "save_memory"));
  const outcome = { isError: false };
  const out = await router.route("save_memory", input, undefined, outcome);
  assert.match(out, /Memory saved/);
  assert.equal(outcome.isError, false);
  assert.equal(router.pendingMemories.length, 1);
});

test("memory off: save_memory is not offered", () => {
  const router = new ToolRouter(null);
  router.memoryEnabled = false;
  assert.ok(!router.getToolSchemas().some((t) => t.name === "save_memory"));
  // the other tools are untouched
  assert.ok(router.getToolSchemas().some((t) => t.name === "save_skill"));
});

test("memory off: a call that arrives anyway is refused and buffers nothing", async () => {
  const router = new ToolRouter(null);
  router.memoryEnabled = false;
  const outcome = { isError: false };
  const out = await router.route("save_memory", input, undefined, outcome);
  assert.doesNotMatch(out, /Memory saved/);
  assert.match(out, /turned off.*nothing was saved/);
  assert.equal(outcome.isError, true);
  assert.equal(router.pendingMemories.length, 0);
});
