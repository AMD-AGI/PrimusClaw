// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The engine's half of tool hygiene, through the real engine and loop with only
 * the LLM faked.
 *
 *   T1 the skill-writing tools reach the model only when the request says skill
 *      self-evolution is on
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

test("T1 skill tools reach the model only with skill_evolution_enabled", async () => {
  const off = await run({});
  assert.ok(!off.tools.includes("save_skill"), "offered with self-evolution off");
  assert.ok(off.tools.includes("bash"), "the tool list is the real one");
  const on = await run({ skill_evolution_enabled: true });
  for (const name of ["save_skill", "add_skill_file", "update_skill_file", "remove_skill_file"]) {
    assert.ok(on.tools.includes(name), `${name} missing with self-evolution on`);
  }
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
