// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `SKILL_HINTS_IN_SYSTEM_USERS`, the per-user canary for `SKILL_HINTS_IN_SYSTEM`, through the real engine. The global flag is
 * off here, as on every deployment; only the listed user's turns move the hints.
 *
 *   U1 a listed user's turn has the skill list and the MCP server hint in the system message, and none after the user's words
 *   U2 another user's turn, on the same engine, keeps them after the user's words and has none in the system message
 */
import test from "node:test";
import assert from "node:assert/strict";
import { startWorld, skillZip, fakeHands, baseRequest } from "./support/platform-defaults-world.js";
import { startPluginWorld, uniqueSession } from "./support/plugin-world.js";

const pw = await startPluginWorld();
const world = await startWorld({
  skills: [{ tool_id: 11 }],
  mcp_servers: { fleet: { type: "http", url: pw.mcpUrl, token: "<SAFE_API_KEY>" } },
});
process.env.PROGRESSIVE_SKILLS_ENABLED = "true";
delete process.env.SKILL_HINTS_IN_SYSTEM;
process.env.SKILL_HINTS_IN_SYSTEM_USERS = " canary-user , other-canary ";
world.setTools([{ id: 11, name: "fleet-ops", zip: skillZip("fleet-ops", "SKILL-BODY", "Operate the GPU fleet") }]);
const { AgentEngine } = await import("../src/agent/engine.js");
test.after(async () => { await world.close(); await pw.close(); });

async function run(userId: string) {
  world.script([{ text: "ok" }]);
  world.llmBodies.length = 0;
  await new AgentEngine().execute(
    baseRequest({ session_id: uniqueSession(), user_id: userId, prompt: "how many nodes?" }),
    (async () => {}) as never, undefined, null as never,
    { attachHands: async () => fakeHands() as never } as never,
  );
  const body = JSON.parse(world.llmBodies[0]!) as { system?: unknown; messages: Array<{ role: string; content: unknown }> };
  const text = (c: unknown) => (typeof c === "string" ? c : JSON.stringify(c));
  return {
    system: text(body.system ?? body.messages.find((m) => m.role === "system")?.content ?? ""),
    user: text(body.messages.filter((m) => m.role === "user").at(-1)!.content),
  };
}

test("U1 a listed user's hints are in the system message and not after the user's words", async () => {
  const r = await run("canary-user");
  assert.match(r.system, /\[Skills and tools\]/);
  assert.match(r.system, /fleet-ops: Operate the GPU fleet/);
  assert.match(r.system, /Available MCP servers: fleet/);
  assert.ok(!r.user.includes("fleet-ops") && !r.user.includes("Available MCP servers"), r.user);
  assert.ok(r.user.includes("how many nodes?"));
});

test("U2 a user not in the list keeps the hints after the user's words", async () => {
  const r = await run("someone-else");
  assert.ok(!r.system.includes("[Skills and tools]") && !r.system.includes("fleet-ops"), r.system);
  assert.match(r.user, /fleet-ops/);
  assert.match(r.user, /Available MCP servers: fleet/);
  assert.ok(r.user.indexOf("how many nodes?") < r.user.indexOf("fleet-ops"), "the hints follow the user's words");
});
