// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * PROGRESSIVE_SKILLS_ENABLED=true with NO platform-defaults file. The flag
 * decides how plugin skills reach the prompt on its own: a deployment that mounts
 * no default skills still gets the on-demand list for a plugin's skills, and the
 * lazy write, with nothing but the plugin behind the writer.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { startWorld, fakeHands, baseRequest } from "./support/platform-defaults-world.js";
import { startPluginWorld, uniqueSession, skillRow, mcpRow } from "./support/plugin-world.js";

const world = await startWorld();
const pw = await startPluginWorld();
process.env.PROGRESSIVE_SKILLS_ENABLED = "true";
delete process.env.PLATFORM_DEFAULTS_FILE;
pw.put("skills/board-ops/SKILL.md", "---\nname: board-ops\ndescription: Read the agent board\n---\nBOARD-BODY-MARKER\n");
pw.put("skills/board-ops/scripts/api.py", "print('board')\n");
const { AgentEngine } = await import("../src/agent/engine.js");

async function run(script: Parameters<typeof world.script>[0]) {
  let attached = 0;
  const made: Array<ReturnType<typeof fakeHands>> = [];
  const extras = { attachHands: async () => { attached++; const h = fakeHands(); made.push(h); return h as never; } };
  world.script(script);
  world.llmBodies.length = 0;
  await new AgentEngine().execute(
    baseRequest({ session_id: uniqueSession(), plugin_id: 5, plugin_tools: [skillRow(2, "board-ops"), mcpRow(17, pw.mcpUrl)] }),
    (async () => {}) as never, undefined, null as never, extras as never,
  );
  return { attached, calls: made.flatMap((h) => h.calls), prompt: world.llmBodies[0] ?? "" };
}

test.after(async () => { await world.close(); await pw.close(); });

test("flag on, no defaults file: plugin skill listed not inlined; an MCP-only turn starts no sandbox", async () => {
  const before = pw.mcpCalls.length;
  const r = await run([{ tool: "mcp__board__ping", input: {} }, { text: "done" }]);
  assert.ok(!r.prompt.includes("BOARD-BODY-MARKER"));
  assert.match(r.prompt, /board-ops: Read the agent board +\[read \/workspace\/\.skills\/board-ops\/SKILL\.md\]/);
  assert.equal(r.attached, 0);
  assert.equal(pw.mcpCalls.length, before + 1);
});

test("flag on, no defaults file: reading the plugin skill writes its files first", async () => {
  const r = await run([{ tool: "read", input: { path: "/workspace/.skills/board-ops/SKILL.md" } }, { text: "done" }]);
  assert.equal(r.attached, 1);
  const writes = r.calls.map((c, i) => ({ c, i })).filter(({ c }) => c.name === "write");
  assert.deepEqual(writes.map(({ c }) => String(c.args.path)).sort(), [".skills/board-ops/SKILL.md", ".skills/board-ops/scripts/api.py"]);
  const read = r.calls.findIndex((c) => c.name === "read");
  assert.ok(writes.every(({ i }) => i < read));
});
