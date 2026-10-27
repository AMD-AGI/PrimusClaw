// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * File set, PROGRESSIVE_SKILLS_ENABLED off: only the MCP servers are mounted.
 * Skills are neither fetched, listed, nor written.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { startWorld, skillZip, fakeHands, baseRequest } from "./support/platform-defaults-world.js";

const world = await startWorld({
  skills: [{ tool_id: 11 }],
  mcp_servers: { safe: { type: "http", url: "http://127.0.0.1:1/mcp", token: "<SAFE_API_KEY>" } },
});
world.setTools([{ id: 11, name: "fleet-ops", zip: skillZip("fleet-ops", "BODY", "Operate the GPU fleet") }]);
const { AgentEngine } = await import("../src/agent/engine.js");

test.after(() => world.close());

test("skills flag off: MCP mounted, no skill traffic, no list, no write", async () => {
  const hands = fakeHands();
  world.script([{ tool: "read", input: { path: "/workspace/.skills/fleet-ops/SKILL.md" } }, { text: "done" }]);
  await new AgentEngine().execute(baseRequest(), (async () => {}) as never, undefined, hands as never);
  const body = world.llmBodies[0];
  assert.match(body, /Available MCP servers: safe/);
  assert.ok(!body.includes("Platform Skills"));
  assert.equal(world.listCalls, 0);
  assert.deepEqual(world.downloads, []);
  assert.equal(hands.calls.filter((c) => c.name === "write").length, 0);
});
