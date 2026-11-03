// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * PROGRESSIVE_SKILLS_ENABLED=true through the real engine and agent loop: plugin
 * skills are listed by name + description (the same hint platform defaults get)
 * and read on demand, instead of every SKILL.md body being inlined.
 *
 * Before: the flag covered only platform-default skills; a plugin skill of the
 * same name overrode the default and stayed inlined, and plugin-only skills were
 * always inlined, so a plugin with a dozen skills sent ~110K chars of SKILL.md
 * bodies on every turn.
 *
 * Pins: bodies are not in the prompt, one hint line per plugin skill with the
 * read path; a plugin skill that shadows a default is listed once, with the
 * plugin's description; a skill the capped list has no room for stays inlined
 * (never silently dropped); plugin and default skills share the one lazy writer
 * (written before the read, once); an MCP-only turn still starts no sandbox; a
 * hooks plugin lists its skills too but keeps writing them up front, once.
 * The flag-off prompt is pinned in plugin-turn-lazy-sandbox.test.ts.
 *
 * Reading a listed skill is not sandbox work (claw-241): the model loads it with
 * `load_skill`, which Brain answers from its own copy. Pins at the bottom: a turn
 * that only loads skills and calls an MCP tool starts no sandbox and writes
 * nothing; a bad name or file is an error, still with no sandbox; and running a
 * skill's script still starts the sandbox, with the script written there first.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { startWorld, skillZip, fakeHands, baseRequest, type Turn } from "./support/platform-defaults-world.js";
import { startPluginWorld, uniqueSession, skillRow, mcpRow, hooksRow } from "./support/plugin-world.js";

const world = await startWorld({ skills: [{ tool_id: 11 }, { tool_id: 12 }] });
const pw = await startPluginWorld();
process.env.PROGRESSIVE_SKILLS_ENABLED = "true";
world.setTools([
  // Shadowed by the plugin skill of the same name below.
  { id: 11, name: "board-ops", zip: skillZip("board-ops", "DEFAULT-BOARD-BODY", "default board copy") },
  { id: 12, name: "fleet-default", zip: skillZip("fleet-default", "DEFAULT-FLEET-BODY", "Platform fleet helper") },
]);

const skillMd = (name: string, desc: string, marker: string) => `---\nname: ${name}\ndescription: ${desc}\n---\n${marker}\n`;
pw.put("skills/board-ops/SKILL.md", skillMd("board-ops", "Read the agent board", "BOARD-BODY-MARKER"));
pw.put("skills/board-ops/scripts/api.py", "print('board')\n");
pw.put("skills/board-ops/references/extra.md", "EXTRA-REF-MARKER\n");
pw.put("skills/fleet-ops/SKILL.md", skillMd("fleet-ops", "Operate the fleet", "FLEET-BODY-MARKER"));
pw.put("skills/fleet-ops/scripts/run.py", "print('fleet')\n");
pw.put("hooks/h30/hooks.json", JSON.stringify({ hooks: { SessionStart: [{ command: "hooks/start.sh" }] } }));
pw.put("hooks/h30/start.sh", "#!/bin/sh\necho '{}'\n");
// Enough long-described skills that the capped on-demand list cannot hold them all.
const MANY = Array.from({ length: 30 }, (_, i) => `many-${String(i).padStart(2, "0")}`);
for (const n of MANY) pw.put(`skills/${n}/SKILL.md`, skillMd(n, `${n} ${"d".repeat(280)}`, `BODY-OF-${n}`));

const { AgentEngine } = await import("../src/agent/engine.js");
const onEvent = async () => {};
const SKILL_ROWS = [skillRow(2, "board-ops"), skillRow(3, "fleet-ops")];

type Call = { name: string; args: Record<string, unknown> };
function skillWrites(calls: Call[]): Array<{ at: number; file: string }> {
  const out: Array<{ at: number; file: string }> = [];
  calls.forEach((c, at) => {
    if (c.name !== "write") return;
    const p = String(c.args.path);
    const i = p.indexOf(".skills/");
    if (i >= 0) out.push({ at, file: p.slice(i) });
  });
  return out;
}

async function run(over: Record<string, unknown>, script: Turn[]) {
  let attached = 0;
  const made: Array<ReturnType<typeof fakeHands>> = [];
  const extras = { attachHands: async () => { attached++; const h = fakeHands(); made.push(h); return h as never; } };
  world.script(script);
  world.llmBodies.length = 0;
  const result = await new AgentEngine().execute(baseRequest({ session_id: uniqueSession(), ...over }), onEvent as never, undefined, null as never, extras as never);
  return { attached, calls: made.flatMap((h) => h.calls), prompt: world.llmBodies[0] ?? "", bodies: [...world.llmBodies], result };
}

test.after(async () => { await world.close(); await pw.close(); });

test("plugin skill bodies are not in the prompt; each is listed with its description; the load tool is offered", async () => {
  const r = await run({ plugin_id: 5, plugin_tools: [...SKILL_ROWS, mcpRow(17, pw.mcpUrl)] }, [{ text: "done" }]);
  assert.ok(!r.prompt.includes("BOARD-BODY-MARKER") && !r.prompt.includes("FLEET-BODY-MARKER"), "no plugin body inlined");
  assert.ok(!r.prompt.includes("=== SKILL: board-ops"), "no inline block for a listed skill");
  assert.match(r.prompt, /board-ops: Read the agent board\\n/);
  assert.match(r.prompt, /fleet-ops: Operate the fleet\\n/);
  assert.ok(!r.prompt.includes("[read "), "no read path is advertised: a skill is loaded, not opened in a sandbox");
  assert.equal(r.prompt.split("load on demand").length - 1, 1, "one on-demand list, not one per source");
  assert.equal(r.attached, 0);
});

test("a plugin skill that shadows a platform default is listed once, with the plugin's description; other defaults stay listed", async () => {
  const r = await run({ plugin_id: 5, plugin_tools: [...SKILL_ROWS] }, [{ text: "done" }]);
  assert.equal(r.prompt.split("board-ops:").length - 1, 1, "listed once");
  assert.ok(!r.prompt.includes("default board copy"), "the default's description is not used");
  assert.match(r.prompt, /fleet-default: Platform fleet helper/);
});

test("an MCP-only turn starts no sandbox and writes nothing, flag on", async () => {
  const before = pw.mcpCalls.length;
  const r = await run({ plugin_id: 5, plugin_tools: [...SKILL_ROWS, mcpRow(17, pw.mcpUrl)] }, [{ tool: "mcp__board__ping", input: {} }, { text: "done" }]);
  assert.equal(r.attached, 0);
  assert.deepEqual(skillWrites(r.calls), []);
  assert.equal(pw.mcpCalls.length, before + 1, "the MCP tool ran in Brain");
});

test("reading a plugin skill and a default skill: one sandbox, each skill's files written before its read, once", async () => {
  const r = await run({ plugin_id: 5, plugin_tools: [...SKILL_ROWS] }, [
    { tool: "read", input: { path: "/workspace/.skills/board-ops/SKILL.md" } },
    { tool: "read", input: { path: "/workspace/.skills/board-ops/references/extra.md" } },
    { tool: "read", input: { path: "/workspace/.skills/fleet-default/SKILL.md" } },
    { text: "done" },
  ]);
  assert.equal(r.attached, 1);
  const writes = skillWrites(r.calls);
  const files = writes.map((w) => w.file).sort();
  assert.deepEqual(files, [
    ".skills/board-ops/SKILL.md", ".skills/board-ops/references/extra.md", ".skills/board-ops/scripts/api.py",
    ".skills/fleet-default/SKILL.md", ".skills/fleet-default/references/extra.md",
  ]);
  const firstRead = r.calls.findIndex((c) => c.name === "read" && String(c.args.path).includes("board-ops/SKILL.md"));
  assert.ok(writes.filter((w) => w.file.startsWith(".skills/board-ops")).every((w) => w.at < firstRead), "board-ops files precede its read");
  const defaultRead = r.calls.findIndex((c) => c.name === "read" && String(c.args.path).includes("fleet-default/SKILL.md"));
  assert.ok(writes.filter((w) => w.file.startsWith(".skills/fleet-default")).every((w) => w.at < defaultRead), "the default's files precede its read");
  const body = r.calls.find((c) => c.name === "write" && String(c.args.path).endsWith("board-ops/SKILL.md"));
  assert.ok(String(body?.args.contents).includes("BOARD-BODY-MARKER"), "the plugin's own SKILL.md body is what is written");
});

test("a skill the capped list has no room for stays inlined: every skill is listed or contained, none dropped", async () => {
  const r = await run({ plugin_id: 5, plugin_tools: MANY.map((n, i) => skillRow(100 + i, n)) }, [{ text: "done" }]);
  const listed = MANY.filter((n) => r.prompt.includes(`${n}: ${n} ddd`));
  const inlined = MANY.filter((n) => r.prompt.includes(`BODY-OF-${n}`));
  assert.ok(listed.length > 0 && inlined.length > 0, `both paths exercised (listed ${listed.length}, inlined ${inlined.length})`);
  assert.deepEqual(MANY.filter((n) => !listed.includes(n) && !inlined.includes(n)), [], "no skill is neither listed nor inlined");
  assert.deepEqual(listed.filter((n) => inlined.includes(n)), [], "no skill is both");
  assert.ok(!r.prompt.includes("more skills not listed"), "no skill is reported as silently omitted");
  assert.equal(r.attached, 0);
});

test("hooks plugin: skills are listed, not inlined, and written up front exactly once", async () => {
  const r = await run({ plugin_id: 5, plugin_tools: [...SKILL_ROWS, hooksRow(30)] }, [
    { tool: "read", input: { path: "/workspace/.skills/board-ops/SKILL.md" } },
    { text: "done" },
  ]);
  assert.ok(!r.prompt.includes("BOARD-BODY-MARKER"));
  assert.match(r.prompt, /board-ops: Read the agent board/);
  assert.equal(r.attached, 1);
  const board = skillWrites(r.calls).filter((w) => w.file.startsWith(".skills/board-ops"));
  assert.equal(board.length, 3, "three files, written once each");
  assert.ok(skillWrites(r.calls).some((w) => w.file.startsWith(".skills/fleet-ops")), "the other plugin skill is on disk too");
});

const LOAD_BOARD = { tool: "load_skill", input: { name: "board-ops" } } as const;

test("a turn that only loads skills and calls an MCP tool provisions no sandbox, writes nothing, and the model gets every skill text", async () => {
  const before = pw.mcpCalls.length;
  const r = await run({ plugin_id: 5, plugin_tools: [...SKILL_ROWS, mcpRow(17, pw.mcpUrl)] }, [
    LOAD_BOARD,
    { tool: "load_skill", input: { name: "board-ops", file: "references/extra.md" } },
    { tool: "load_skill", input: { name: "fleet-default" } },
    { tool: "mcp__board__ping", input: {} },
    { text: "done" },
  ]);
  assert.equal(r.attached, 0, "attachHands (the only way to provisionHands) was never called");
  assert.deepEqual(r.calls, [], "no call reached any sandbox");
  assert.equal(pw.mcpCalls.length, before + 1, "the MCP tool ran in Brain");
  assert.ok(r.bodies[0].includes('"name":"load_skill"'), "the tool is among those the model was offered");
  assert.ok(r.bodies[1].includes("BOARD-BODY-MARKER"), "SKILL.md is the result of the first load");
  assert.ok(r.bodies[1].includes("references/extra.md") && r.bodies[1].includes("scripts/api.py"), "with the list of the skill's other files");
  assert.ok(r.bodies[1].includes("/workspace/.skills/board-ops/"), "and where its scripts run");
  assert.ok(r.bodies[2].includes("EXTRA-REF-MARKER"), "a supporting file is the result of the second");
  assert.ok(r.bodies[3].includes("DEFAULT-FLEET-BODY"), "a platform default is served the same way");
  assert.equal(r.result.skillsUsed["board-ops"], 1, "loading SKILL.md is the skill being used");
});

test("load_skill with an unknown skill, a missing file or an escaping path is an error to the model and starts no sandbox", async () => {
  const r = await run({ plugin_id: 5, plugin_tools: [...SKILL_ROWS] }, [
    { tool: "load_skill", input: { name: "nope" } },
    { tool: "load_skill", input: { name: "board-ops", file: "references/missing.md" } },
    { tool: "load_skill", input: { name: "board-ops", file: "../fleet-ops/SKILL.md" } },
    { tool: "load_skill", input: { name: "board-ops", file: "/etc/passwd" } },
    { tool: "load_skill", input: { name: "board-ops", file: "references" } },
    { text: "done" },
  ]);
  assert.equal(r.attached, 0);
  assert.deepEqual(r.calls, []);
  assert.match(r.bodies[1], /no skill named 'nope'\. Available: [^"]*board-ops/);
  assert.match(r.bodies[2], /has no file 'references\/missing\.md'/);
  assert.match(r.bodies[3], /must be a path inside the skill's directory/);
  assert.match(r.bodies[4], /must be a path inside the skill's directory/);
  assert.match(r.bodies[5], /has no file 'references'/);
  assert.ok(!r.bodies.join("").includes("root:"), "nothing outside the skill was read");
  assert.equal(r.result.skillsUsed["board-ops"], undefined, "a refused load is not the skill being used");
});

test("counter-example: running a skill's script still starts the sandbox, and the script is written there first", async () => {
  const r = await run({ plugin_id: 5, plugin_tools: [...SKILL_ROWS] }, [
    LOAD_BOARD,
    { tool: "bash", input: { command: "python3 /workspace/.skills/board-ops/scripts/api.py" } },
    { text: "done" },
  ]);
  assert.equal(r.attached, 1, "the sandbox is started, by the bash and by nothing before it");
  const names = r.calls.map((c) => c.name);
  assert.ok(!names.includes("read"), "the load did not become a sandbox read");
  const bashAt = names.indexOf("bash");
  assert.ok(bashAt > 0, "the bash ran");
  assert.equal(names.slice(0, bashAt).every((n) => n === "write"), true, "the only sandbox calls before it are the skill's writes");
  const script = r.calls.find((c) => c.name === "write" && String(c.args.path).endsWith(".skills/board-ops/scripts/api.py"));
  assert.equal(String(script?.args.contents), "print('board')\n", "the script itself is on the sandbox disk");
  assert.ok(r.calls.some((c) => c.name === "write" && String(c.args.path).endsWith(".skills/board-ops/SKILL.md")), "with its SKILL.md");
  assert.equal(r.calls.filter((c) => c.name === "write" && String(c.args.path).includes(".skills/fleet")).length, 0, "other skills stay on Brain");
  assert.ok(r.bodies[1].includes("BOARD-BODY-MARKER"), "and the load was answered before any of it");
});

test("a model that reads the skill file with the read tool anyway still gets it, from the sandbox, written first", async () => {
  const r = await run({ plugin_id: 5, plugin_tools: [...SKILL_ROWS] }, [
    { tool: "read", input: { path: "/workspace/.skills/board-ops/SKILL.md" } },
    { text: "done" },
  ]);
  assert.equal(r.attached, 1);
  const names = r.calls.map((c) => c.name);
  assert.ok(names.indexOf("read") > names.lastIndexOf("write"), "every skill file precedes the read");
});

test("hooks plugin: the skill is served by load_skill with no sandbox read, though its sandbox exists", async () => {
  const r = await run({ plugin_id: 5, plugin_tools: [...SKILL_ROWS, hooksRow(30)] }, [LOAD_BOARD, { text: "done" }]);
  assert.equal(r.attached, 1, "the hooks plugin keeps its sandbox up front");
  assert.ok(!r.calls.some((c) => c.name === "read"), "the load is not a sandbox call");
  assert.ok(r.bodies[1].includes("BOARD-BODY-MARKER"));
});
