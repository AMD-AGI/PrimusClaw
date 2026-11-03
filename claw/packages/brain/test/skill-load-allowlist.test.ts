// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `load_skill` and `tools_allowlist` (claw-241 review).
 *
 * `load_skill` is a tool like any other: a run whose `tools_allowlist` does not name it is not offered
 * it and the router refuses it. That is every allowlist written before the tool existed (for example
 * `["read", "bash", "mcp__x__*"]`). The prompt must not tell such a run to call a tool it was never
 * given, nor forbid it the `read` it was given: a skill that was readable with `read` stays readable.
 * So the hint, and the advice a refused sub-agent dispatch gets, follow the tools the run really has:
 *
 *   - `load_skill` allowed (no list, an empty list, or a list that names it): load it, no sandbox.
 *   - `load_skill` not allowed: the wording from before the tool existed, read SKILL.md with `read`.
 *
 * Through the real engine and agent loop; only the edges are fake (LLM, object store, Hands, MCP).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { startWorld, fakeHands, baseRequest, type Turn } from "./support/platform-defaults-world.js";
import { startPluginWorld, uniqueSession, skillRow, mcpRow } from "./support/plugin-world.js";

const world = await startWorld();
const pw = await startPluginWorld();
process.env.PROGRESSIVE_SKILLS_ENABLED = "true";
delete process.env.PLATFORM_DEFAULTS_FILE;

const md = (name: string, desc: string, marker: string) => `---\nname: ${name}\ndescription: ${desc}\n---\n${marker}\n`;
pw.put("skills/board-ops/SKILL.md", md("board-ops", "Read the agent board", "BOARD-BODY-MARKER"));
pw.put("skills/board-ops/scripts/api.py", "print('board')\n");
pw.put("skills/fleet-ops/SKILL.md", md("fleet-ops", "Operate the fleet", "FLEET-BODY-MARKER"));
// Enough long-described skills that the capped on-demand list cannot hold them all.
const MANY = Array.from({ length: 30 }, (_, i) => `many-${String(i).padStart(2, "0")}`);
for (const n of MANY) pw.put(`skills/${n}/SKILL.md`, md(n, `${n} ${"d".repeat(280)}`, `BODY-OF-${n}`));

const { AgentEngine } = await import("../src/agent/engine.js");
const { buildProgressiveSkillHint, listProgressiveSkills } = await import("../src/agent/prompt.js");
const { toolNotAllowedMessage } = await import("../src/tools/allowlist.js");
test.after(async () => { await world.close(); await pw.close(); });

const SKILL_ROWS = [skillRow(2, "board-ops"), skillRow(3, "fleet-ops")];
/** What a pre-load_skill allowlist looked like: tools the run could read and run things with. */
const OLD_LIST = ["read", "bash", "task", "mcp__board__*"];

async function run(over: Record<string, unknown>, script: Turn[]) {
  let attached = 0;
  const made: Array<ReturnType<typeof fakeHands>> = [];
  const extras = { attachHands: async () => { attached++; const h = fakeHands(); made.push(h); return h as never; } };
  world.script(script);
  world.llmBodies.length = 0;
  await new AgentEngine().execute(
    baseRequest({ session_id: uniqueSession(), plugin_id: 5, plugin_tools: [...SKILL_ROWS, mcpRow(17, pw.mcpUrl)], ...over }),
    (async () => {}) as never, undefined, null as never, extras as never,
  );
  const bodies = [...world.llmBodies];
  return {
    attached,
    calls: made.flatMap((h) => h.calls),
    bodies,
    prompt: bodies[0] ?? "",
    offered: (JSON.parse(bodies[0] ?? "{}").tools ?? []).map((t: { name: string }) => t.name) as string[],
  };
}

// --- the prompt, on its own ---

const hintSkills = [
  { name: "board-ops", description: "Read the agent board", toolId: 1, localDir: "/x" },
  { name: "fleet-ops", description: "Operate the fleet", toolId: 2, localDir: "/y" },
];

test("hint: with load_skill allowed (the default) it tells the model to load, and gives no path to read", () => {
  for (const hint of [buildProgressiveSkillHint(hintSkills, "/workspace"), buildProgressiveSkillHint(hintSkills, "/workspace", true)]) {
    assert.match(hint, /load it with the load_skill tool/);
    assert.match(hint, /do not read or cat its files/);
    assert.ok(!hint.includes("[read "), "no per-skill read path");
  }
});

test("hint: with load_skill not allowed it is the wording from before the tool: read SKILL.md, with the path on each line, no mention of load_skill", () => {
  const hint = buildProgressiveSkillHint(hintSkills, "/workspace", false);
  assert.ok(!hint.includes("load_skill"), "a tool the run does not have is not named");
  assert.ok(!/do not read or cat/.test(hint), "the one tool it has is not forbidden");
  assert.match(hint, /read its SKILL\.md with the read tool and follow it/);
  assert.match(hint, /Supporting files live next to SKILL\.md in the same directory/);
  assert.match(hint, /- board-ops: Read the agent board {3}\[read \/workspace\/\.skills\/board-ops\/SKILL\.md\]/);
  assert.match(hint, /- fleet-ops: Operate the fleet {3}\[read \/workspace\/\.skills\/fleet-ops\/SKILL\.md\]/);
  assert.match(buildProgressiveSkillHint(hintSkills, "", false), /\[read \.skills\/board-ops\/SKILL\.md\]/, "no session dir: the relative base");
});

test("list: the read path is part of each line, so it counts against the size cap that decides what is listed", () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ name: `skill-${String(i).padStart(2, "0")}`, description: "d".repeat(100), toolId: i, localDir: "/z" }));
  const load = listProgressiveSkills(many, "/workspace/session", true);
  const read = listProgressiveSkills(many, "/workspace/session", false);
  assert.ok(read.listed.length < load.listed.length, `read mode fits fewer (${read.listed.length} < ${load.listed.length})`);
  assert.ok(read.lines.length <= 8000 && load.lines.length <= 8000, "both stay inside the cap");
  assert.equal(read.omitted, many.length - read.listed.length);
});

// --- through the engine ---

test("an allowlist from before load_skill (read, bash, an MCP server): the tool is not offered, the prompt reads SKILL.md with read, and that read works", async () => {
  const r = await run({ tools_allowlist: OLD_LIST }, [
    { tool: "read", input: { path: "/workspace/.skills/board-ops/SKILL.md" } },
    { text: "done" },
  ]);
  assert.ok(!r.offered.includes("load_skill"), "not offered");
  assert.ok(r.offered.includes("read") && r.offered.includes("bash"), "the tools the list names are");
  assert.ok(!r.prompt.includes("load_skill"), "nothing in the request mentions a tool the run does not have");
  assert.ok(!/do not read or cat/.test(r.prompt), "and `read` is not forbidden");
  assert.match(r.prompt, /board-ops: Read the agent board {3}\[read [^\]]*\.skills\/board-ops\/SKILL\.md\]/);
  assert.match(r.prompt, /read its SKILL\.md with the read tool/);
  // The skill is usable as it was: the read starts the sandbox, the skill's files are written first.
  assert.equal(r.attached, 1);
  const names = r.calls.map((c) => c.name);
  assert.ok(names.indexOf("read") > names.lastIndexOf("write"), "every skill file precedes the read");
  const body = r.calls.find((c) => c.name === "write" && String(c.args.path).endsWith(".skills/board-ops/SKILL.md"));
  assert.ok(String(body?.args.contents).includes("BOARD-BODY-MARKER"), "the skill's own SKILL.md is what the read finds");
});

test("a model that calls load_skill anyway on such a run is refused, and nothing starts a sandbox", async () => {
  const r = await run({ tools_allowlist: OLD_LIST }, [
    { tool: "load_skill", input: { name: "board-ops" } },
    { text: "done" },
  ]);
  assert.ok(r.bodies[1].includes(JSON.stringify(toolNotAllowedMessage("load_skill")).slice(1, -1)), "the allowlist's own refusal");
  assert.ok(!r.bodies[1].includes("BOARD-BODY-MARKER"), "no skill text came back");
  assert.equal(r.attached, 0);
});

test("an allowlist that names load_skill, by name or by a prefix pattern: it is offered, the prompt says load it, no read path, no sandbox", async () => {
  for (const list of [[...OLD_LIST, "load_skill"], [...OLD_LIST, "load_*"]]) {
    const r = await run({ tools_allowlist: list }, [{ tool: "load_skill", input: { name: "board-ops" } }, { text: "done" }]);
    assert.ok(r.offered.includes("load_skill"), `offered with ${JSON.stringify(list.at(-1))}`);
    assert.match(r.prompt, /load it with the load_skill tool/);
    assert.ok(!r.prompt.includes("[read "), "no read path advertised");
    assert.ok(r.bodies[1].includes("BOARD-BODY-MARKER"), "the skill is served");
    assert.equal(r.attached, 0, "and no sandbox started for it");
  }
});

test("no allowlist, and an empty one (no restriction): load_skill wording, as without this change", async () => {
  for (const over of [{}, { tools_allowlist: [] }]) {
    const r = await run(over, [{ text: "done" }]);
    assert.ok(r.offered.includes("load_skill"));
    assert.match(r.prompt, /load it with the load_skill tool/);
    assert.ok(!r.prompt.includes("[read "));
  }
});

test("without load_skill the on-demand list is capped by the longer lines it now has: every skill is listed or contained, none dropped", async () => {
  const r = await run({ tools_allowlist: OLD_LIST, plugin_tools: MANY.map((n, i) => skillRow(100 + i, n)) }, [{ text: "done" }]);
  const listed = MANY.filter((n) => r.prompt.includes(`${n}: ${n} ddd`));
  const inlined = MANY.filter((n) => r.prompt.includes(`BODY-OF-${n}`));
  assert.ok(listed.length > 0 && inlined.length > 0, `both paths exercised (listed ${listed.length}, inlined ${inlined.length})`);
  assert.deepEqual(MANY.filter((n) => !listed.includes(n) && !inlined.includes(n)), [], "no skill is neither listed nor inlined");
  assert.deepEqual(listed.filter((n) => inlined.includes(n)), [], "no skill is both");
  assert.ok(!r.prompt.includes("more skills not listed"));
  const withTool = await run({ plugin_tools: MANY.map((n, i) => skillRow(100 + i, n)) }, [{ text: "done" }]);
  const listedWithTool = MANY.filter((n) => withTool.prompt.includes(`${n}: ${n} ddd`));
  assert.ok(listed.length < listedWithTool.length, `the read path costs room (${listed.length} < ${listedWithTool.length})`);
});

const TWO_SKILL_PATHS = {
  description: "read the skill files",
  prompt: "Read /workspace/.skills/board-ops/SKILL.md and /workspace/.skills/fleet-ops/SKILL.md in parallel and summarise them",
  subagent_type: "explore",
};

/** The refusal text itself, apart from the rest of the request (whose prompt names the tools too). */
const refusalOf = (body: string) => body.match(/Error: do not dispatch sub-agents to read skill files[^"]*/)?.[0] ?? "";

test("sub-agent skill-read refusal follows the run's tools: without load_skill it says read, with it it says load_skill", async () => {
  const without = refusalOf((await run({ tools_allowlist: OLD_LIST }, [{ tool: "task", input: TWO_SKILL_PATHS }, { text: "done" }])).bodies[1]);
  assert.match(without, /^Error: do not dispatch sub-agents to read skill files/, "the refusal itself is there");
  assert.match(without, /Use the `read` tool directly/);
  assert.ok(!without.includes("load_skill"), "a tool the run does not have is not suggested");

  const withTool = refusalOf((await run({ tools_allowlist: [...OLD_LIST, "load_skill"] }, [{ tool: "task", input: TWO_SKILL_PATHS }, { text: "done" }])).bodies[1]);
  assert.match(withTool, /^Error: do not dispatch sub-agents to read skill files/);
  assert.match(withTool, /Use the `load_skill` tool directly/);
  assert.ok(!/`read`/.test(withTool), "a read of a skill path is a sandbox call: not suggested");

  const unrestricted = refusalOf((await run({}, [{ tool: "task", input: TWO_SKILL_PATHS }, { text: "done" }])).bodies[1]);
  assert.match(unrestricted, /Use the `load_skill` tool directly/);
});
