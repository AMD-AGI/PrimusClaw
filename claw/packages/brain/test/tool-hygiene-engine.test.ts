// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The engine's half of tool hygiene, through the real engine and loop with only
 * the LLM faked.
 *
 *   T1 the skill-writing tools reach the model only when the request says the API
 *      keeps saved skills (`user_skills_enabled`; from an older API,
 *      `skill_evolution_enabled`), and never in a session that acts as a user
 *   T2 an MCP server that does not connect is told to the user (a progress
 *      event) and to the model (a line in the prompt)
 */
import test from "node:test";
import assert from "node:assert/strict";
import { startWorld, baseRequest } from "./support/platform-defaults-world.js";

const world = await startWorld();
const { AgentEngine } = await import("../src/agent/engine.js");
test.after(async () => { await world.close(); });

async function run(over: Record<string, unknown>) {
  world.llmBodies.length = 0;
  world.script([{ text: "done" }]);
  const events: Array<Record<string, unknown>> = [];
  await new AgentEngine().execute(
    baseRequest({ session_id: `s-${Math.random().toString(36).slice(2)}`, ...over }),
    (async (e: Record<string, unknown>) => { events.push(e); }) as never,
    undefined, null as never,
    // A sandbox the turn never asks for: nothing here runs a sandbox tool.
    { attachHands: async () => { throw new Error("no sandbox expected"); } } as never,
  );
  const body = JSON.parse(world.llmBodies[0] ?? "{}") as {
    tools?: Array<{ name: string }>; messages: Array<{ role: string; content: unknown }>;
  };
  const last = body.messages[body.messages.length - 1];
  const userText = typeof last.content === "string"
    ? last.content
    : (last.content as Array<{ text?: string }>).map((b) => b.text ?? "").join("");
  return { tools: (body.tools ?? []).map((t) => t.name), userText, events };
}

const SKILL_WRITERS = ["save_skill", "add_skill_file", "update_skill_file", "remove_skill_file"];

test("T1 skill tools reach the model only with user_skills_enabled, or skill_evolution_enabled from an API without it", async () => {
  const off = await run({});
  assert.ok(!off.tools.includes("save_skill"), "offered with saving off");
  assert.ok(off.tools.includes("bash"), "the tool list is the real one");
  const on = await run({ user_skills_enabled: true });
  for (const name of SKILL_WRITERS) assert.ok(on.tools.includes(name), `${name} missing with user_skills_enabled`);
  // The API says which switch decides: auto-evolution on and the user's own skills off offers nothing.
  const autoOnly = await run({ user_skills_enabled: false, skill_evolution_enabled: true });
  for (const name of SKILL_WRITERS) assert.ok(!autoOnly.tools.includes(name), `${name} offered with user_skills_enabled false`);
  // An API from before the field: the old one decides, as it did.
  const legacy = await run({ skill_evolution_enabled: true });
  for (const name of SKILL_WRITERS) assert.ok(legacy.tools.includes(name), `${name} missing from an older API's request`);
  // A session that acts as a user never saves into the requester's skills.
  const acting = await run({ user_skills_enabled: true, withhold_sandbox_keys: true });
  for (const name of SKILL_WRITERS) assert.ok(!acting.tools.includes(name), `${name} offered to a session that acts as a user`);
});

test("T2 an MCP server that is down is told to the user and to the model", async () => {
  const r = await run({ mcp_servers: { docs: { type: "http", url: "http://127.0.0.1:1/mcp", token: "t" } } });
  const ev = r.events.find((e) => e.type === "statusUpdate" && e.event === "mcp_unavailable");
  assert.ok(ev, `no mcp_unavailable event in ${JSON.stringify(r.events.map((e) => e.type))}`);
  assert.deepEqual((ev.servers as Array<{ name: string }>).map((s) => s.name), ["docs"]);
  assert.match(r.userText, /Unavailable this turn: MCP server\(s\) docs \(/);

  const healthy = await run({});
  assert.ok(!healthy.events.some((e) => e.event === "mcp_unavailable"));
  assert.doesNotMatch(healthy.userText, /Unavailable this turn/);
});
