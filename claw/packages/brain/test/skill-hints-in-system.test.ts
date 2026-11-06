// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `SKILL_HINTS_IN_SYSTEM`, through the real engine, and the per-tool timing a run reports (`tool_stats.first_ok_ms` / `last_ok_ms`).
 * The flag is read once at import, so this file sets it on before it imports the engine; `prompt-hints-default` (the other tests of
 * the platform defaults) runs with it off, as every deployment does.
 *
 *   H1 on: the skill list and the MCP server hint are in the system message, and the user's message ends with the user's words
 *   H2 the same hints, built from the same inputs, are what the default puts after the message (`buildPrompt` with the flag off)
 *   S1 a run reports, for each tool that answered, when its first and last good call ended, from the start of the loop
 *   S2 the stamp is when the tool returned, not when a PostToolUse hook after it finished
 */
import test from "node:test";
import assert from "node:assert/strict";
import { startWorld, skillZip, fakeHands, baseRequest, type Turn } from "./support/platform-defaults-world.js";
import { startPluginWorld, uniqueSession, mcpRow, hooksRow } from "./support/plugin-world.js";

const pw = await startPluginWorld();
const world = await startWorld({
  skills: [{ tool_id: 11 }],
  mcp_servers: { fleet: { type: "http", url: pw.mcpUrl, token: "<SAFE_API_KEY>" } },
});
process.env.PROGRESSIVE_SKILLS_ENABLED = "true";
process.env.SKILL_HINTS_IN_SYSTEM = "true";
world.setTools([{ id: 11, name: "fleet-ops", zip: skillZip("fleet-ops", "SKILL-BODY", "Operate the GPU fleet") }]);
const HOOK_MS = 600;
pw.put("hooks/h31/hooks.json", JSON.stringify({ hooks: { PostToolUse: [{ command: "hooks/post.sh", matcher: "^mcp__board__ping$" }] } }));
pw.put("hooks/h31/post.sh", "#!/bin/sh\necho '{}'\n");
const { AgentEngine } = await import("../src/agent/engine.js");
const { buildPrompt, buildSkillAndMcpHints } = await import("../src/agent/prompt.js");
test.after(async () => { await world.close(); await pw.close(); });

async function run(turns: Turn[], over: Record<string, unknown> = {}, slowHook = false) {
  world.script(turns);
  world.llmBodies.length = 0;
  const hands = () => {
    const h = fakeHands();
    if (!slowHook) return h;
    // The hook's command is slow; everything else the sandbox answers at once.
    const call = h.callTool.bind(h);
    h.callTool = async (name: string, args: Record<string, unknown>) => {
      if (String(args.command ?? "").includes("post.sh")) await new Promise((r) => setTimeout(r, HOOK_MS));
      return call(name, args);
    };
    return h;
  };
  const result = await new AgentEngine().execute(
    baseRequest({ session_id: uniqueSession(), prompt: "how many nodes?", ...over }),
    (async () => {}) as never, undefined, null as never,
    { attachHands: async () => hands() as never } as never,
  );
  const body = JSON.parse(world.llmBodies[0]!) as { system?: unknown; messages: Array<{ role: string; content: unknown }> };
  const text = (c: unknown) => (typeof c === "string" ? c : JSON.stringify(c));
  return {
    result,
    system: text(body.system ?? body.messages.find((m) => m.role === "system")?.content),
    user: text(body.messages.filter((m) => m.role === "user").at(-1)!.content),
  };
}

test("H1 with the flag on, the hints are in the system message and not after the user's words", async () => {
  const r = await run([{ text: "ok" }]);
  assert.match(r.system, /\[Skills and tools\]/);
  assert.match(r.system, /fleet-ops: Operate the GPU fleet/);
  assert.match(r.system, /Available MCP servers: fleet/);
  assert.ok(!r.user.includes("fleet-ops") && !r.user.includes("Available MCP servers"), r.user);
  assert.ok(r.user.includes("how many nodes?"));
});

test("H2 the hints are the ones the default puts after the message", () => {
  const skills = [{ name: "fleet-ops", description: "Operate the GPU fleet" }];
  const hints = buildSkillAndMcpHints({}, ["fleet"], "/workspace", skills, true);
  const after = buildPrompt("q", {}, ["fleet"], "m", "/workspace", "", undefined, skills, "", true, false);
  assert.ok(after.includes(hints.skillHint.replace(/^\n/, "")) && after.includes(hints.mcpHint.trim()), "the default carries them after the words");
  const none = buildPrompt("q", {}, ["fleet"], "m", "/workspace", "", undefined, skills, "", true, true);
  assert.ok(!none.includes("fleet-ops") && !none.includes("Available MCP servers"), "and with the flag, buildPrompt leaves them out");
});

test("S1 a run reports when each tool's first and last good call ended", async () => {
  const r = await run([
    { tool: "mcp__fleet__ping", input: {} },
    { tool: "mcp__fleet__ping", input: {} },
    { text: "two pings" },
  ]);
  const stats = r.result.toolStats;
  assert.equal(stats.by_tool_ok?.mcp__fleet__ping, 2);
  const first = stats.first_ok_ms?.mcp__fleet__ping;
  const last = stats.last_ok_ms?.mcp__fleet__ping;
  assert.equal(typeof first, "number");
  assert.equal(typeof last, "number");
  assert.ok(first! >= 0 && last! >= first! && last! <= r.result.elapsedMs, JSON.stringify({ first, last, elapsed: r.result.elapsedMs }));
  // A tool the run never called has no stamp.
  assert.equal(stats.first_ok_ms?.mcp__fleet__other, undefined);
});

test("S2 the stamp is when the tool returned, not when a hook after it finished", async () => {
  const r = await run(
    [{ tool: "mcp__board__ping", input: {} }, { text: "pinged" }],
    { plugin_id: 9, plugin_tools: [mcpRow(5, pw.mcpUrl), hooksRow(31)] },
    true,
  );
  const stats = r.result.toolStats;
  assert.equal(stats.by_tool_ok?.mcp__board__ping, 1);
  const at = stats.last_ok_ms?.mcp__board__ping;
  assert.equal(typeof at, "number");
  assert.ok(r.result.elapsedMs - at! >= HOOK_MS - 50, `stamped before the ${HOOK_MS} ms hook: ${JSON.stringify({ at, elapsed: r.result.elapsedMs })}`);
});
