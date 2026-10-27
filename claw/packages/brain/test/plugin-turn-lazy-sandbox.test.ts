// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A turn of a session with plugin tools must not wait for a sandbox it does not
 * use. Through the real engine and agent loop (progressive skills OFF, the
 * default); only the network edges are fake: LLM, S3, an MCP server, Hands.
 *
 * Before: AgentEngine.execute() passed `await sandbox()` into
 * resolvePluginToolsFromMessage for every plugin, and uploaded every plugin
 * skill directory up front, so a turn that only called MCP tools paid a sandbox
 * cold start (10-18 s) first.
 *
 * Now: only a hooks-type tool gets the sandbox up front; a plugin's skill files
 * are written the first time a sandbox tool names `.skills`, before that call.
 * Pins, each as a row of the table below: an MCP-only turn starts no sandbox
 * and writes nothing; a turn that reads a skill gets the sandbox and every file
 * of that skill (supporting files too) before the read, once; a call that never
 * names `.skills` starts the sandbox but writes no skill; listing `.skills`
 * writes all of them; a hooks plugin keeps its up-front sandbox and writes; the
 * prompt is unchanged with the flag off.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { startWorld, fakeHands, baseRequest, type Turn } from "./support/platform-defaults-world.js";
import { startPluginWorld, skillRow, mcpRow, hooksRow } from "./support/plugin-world.js";

const world = await startWorld();
const pw = await startPluginWorld();
delete process.env.PROGRESSIVE_SKILLS_ENABLED;

const skillMd = (name: string, desc: string, marker: string) => `---\nname: ${name}\ndescription: ${desc}\n---\n${marker}\n`;
pw.put("skills/board-ops/SKILL.md", skillMd("board-ops", "Read the agent board", "BOARD-BODY-MARKER"));
pw.put("skills/board-ops/scripts/api.py", "print('board')\n");
pw.put("skills/board-ops/references/extra.md", "extra\n");
pw.put("skills/fleet-ops/SKILL.md", skillMd("fleet-ops", "Operate the fleet", "FLEET-BODY-MARKER"));
pw.put("skills/fleet-ops/scripts/run.py", "print('fleet')\n");
pw.put("hooks/h30/hooks.json", JSON.stringify({ hooks: { SessionStart: [{ command: "hooks/start.sh" }] } }));
pw.put("hooks/h30/start.sh", "#!/bin/sh\necho '{}'\n");

const { AgentEngine } = await import("../src/agent/engine.js");
let events: Array<Record<string, unknown>> = [];
const onEvent = async (e: unknown) => { events.push(e as Record<string, unknown>); };

const SKILL_ROWS = [skillRow(2, "board-ops"), skillRow(3, "fleet-ops")];
const BOARD_FILES = ["SKILL.md", "scripts/api.py", "references/extra.md"].map((f) => `.skills/board-ops/${f}`);
const FLEET_FILES = ["SKILL.md", "scripts/run.py"].map((f) => `.skills/fleet-ops/${f}`);

type Call = { name: string; args: Record<string, unknown> };
/** Paths of skill files written, in call order, with the index of the call that wrote them. */
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

async function run(over: Record<string, unknown>, shape?: (h: ReturnType<typeof fakeHands>) => void) {
  let attached = 0;
  const made: Array<ReturnType<typeof fakeHands>> = [];
  const extras = { attachHands: async () => { attached++; const h = fakeHands(); shape?.(h); made.push(h); return h as never; } };
  events = [];
  world.llmBodies.length = 0;
  const result = await new AgentEngine().execute(baseRequest(over), onEvent as never, undefined, null as never, extras as never);
  return { attached, made, result, prompt: world.llmBodies[0] ?? "" };
}

test.after(async () => { await world.close(); await pw.close(); });

interface Row {
  name: string;
  tools: unknown[];
  script: Turn[];
  /** sandboxes the turn may start */
  attached: number;
  /** skill files that must have been written, by the sandbox's own record */
  written: string[];
  /** every skill file written, in order, must be among `written` (nothing extra) */
  exact?: boolean;
  /** a call that must come after every write of `written` */
  after?: { name: string; pathIncludes: string };
}

const rows: Row[] = [
  {
    name: "skills + MCP, a turn that calls only the MCP tool: no sandbox, nothing written",
    tools: [...SKILL_ROWS, mcpRow(17, pw.mcpUrl)],
    script: [{ tool: "mcp__board__ping", input: {} }, { text: "done" }],
    attached: 0, written: [], exact: true,
  },
  {
    name: "a turn that reads a skill file: sandbox + that skill's every file (supporting too) before the read",
    tools: [...SKILL_ROWS, mcpRow(17, pw.mcpUrl)],
    script: [{ tool: "read", input: { path: "/workspace/.skills/board-ops/SKILL.md" } }, { text: "done" }],
    attached: 1, written: BOARD_FILES, exact: true, after: { name: "read", pathIncludes: "board-ops/SKILL.md" },
  },
  {
    name: "a bash that runs a skill script writes that skill before the run, the other skill stays unwritten",
    tools: [...SKILL_ROWS],
    script: [{ tool: "bash", input: { command: "python3 /workspace/.skills/fleet-ops/scripts/run.py" } }, { text: "done" }],
    attached: 1, written: FLEET_FILES, exact: true, after: { name: "bash", pathIncludes: "fleet-ops/scripts/run.py" },
  },
  {
    name: "a sandbox call that never names .skills starts the sandbox and writes no skill",
    tools: [...SKILL_ROWS],
    script: [{ tool: "bash", input: { command: "echo hi" } }, { text: "done" }],
    attached: 1, written: [], exact: true,
  },
  {
    name: "listing .skills (names no skill) writes every skill before the listing",
    tools: [...SKILL_ROWS],
    script: [{ tool: "bash", input: { command: "ls /workspace/.skills" } }, { text: "done" }],
    attached: 1, written: [...BOARD_FILES, ...FLEET_FILES], exact: true, after: { name: "bash", pathIncludes: "ls /workspace/.skills" },
  },
  {
    name: "the second read of the same skill does not write it again",
    tools: [...SKILL_ROWS],
    script: [
      { tool: "read", input: { path: "/workspace/.skills/board-ops/SKILL.md" } },
      { tool: "read", input: { path: "/workspace/.skills/board-ops/references/extra.md" } },
      { text: "done" },
    ],
    attached: 1, written: BOARD_FILES, exact: true,
  },
  {
    name: "hooks plugin: sandbox up front, every skill written up front, as before",
    tools: [...SKILL_ROWS, hooksRow(30)],
    script: [{ text: "done" }],
    attached: 1, written: [...BOARD_FILES, ...FLEET_FILES], exact: true,
  },
  {
    name: "hooks plugin declared with the singular type `hook` is a hooks plugin too",
    tools: [...SKILL_ROWS, hooksRow(30, "Hook")],
    script: [{ text: "done" }],
    attached: 1, written: [...BOARD_FILES, ...FLEET_FILES], exact: true,
  },
];

for (const row of rows) {
  test(row.name, async () => {
    world.script(row.script);
    const mcpBefore = pw.mcpCalls.length;
    const r = await run({ plugin_id: 5, plugin_tools: row.tools });
    assert.equal(r.attached, row.attached, "sandboxes started");
    const calls = r.made.flatMap((h) => h.calls);
    const writes = skillWrites(calls);
    for (const f of row.written) assert.ok(writes.some((w) => w.file === f), `${f} is written`);
    if (row.exact) {
      assert.deepEqual(
        [...new Set(writes.map((w) => w.file))].sort(),
        [...row.written].sort(),
        "no other skill file is written",
      );
      assert.equal(writes.length, new Set(writes.map((w) => w.file)).size, "no file is written twice");
    }
    if (row.after) {
      const idx = calls.findIndex((c) => c.name === row.after!.name && JSON.stringify(c.args).includes(row.after!.pathIncludes));
      assert.ok(idx >= 0, "the call ran");
      assert.ok(writes.every((w) => w.at < idx), "every skill file was on disk before the call that needs it");
    }
    if (row.script.some((t) => "tool" in t && t.tool === "mcp__board__ping")) {
      assert.equal(pw.mcpCalls.length, mcpBefore + 1, "the MCP tool ran in Brain");
    }
  });
}

test("hooks plugin: the hook scripts are staged and its SessionStart hook runs in the sandbox", async () => {
  world.script([{ text: "done" }]);
  const r = await run({ plugin_id: 5, plugin_tools: [...SKILL_ROWS, hooksRow(30)] });
  const calls = r.made.flatMap((h) => h.calls);
  assert.ok(calls.some((c) => c.name === "write" && String(c.args.path) === "/workspace/.claw/hooks/30/start.sh"), "script staged");
  assert.ok(calls.some((c) => c.name === "bash" && String(c.args.command).includes("/workspace/.claw/hooks/30/start.sh")), "hook ran");
});

test("progressive OFF: every plugin skill body is still inlined and no on-demand list is added", async () => {
  world.script([{ text: "done" }]);
  const r = await run({ plugin_id: 5, plugin_tools: [...SKILL_ROWS, mcpRow(17, pw.mcpUrl)] });
  assert.ok(r.prompt.includes("BOARD-BODY-MARKER") && r.prompt.includes("FLEET-BODY-MARKER"));
  assert.match(r.prompt, /=== SKILL: board-ops \(SKILL\.md\) ===/);
  assert.ok(!r.prompt.includes("load on demand"));
  assert.equal(r.attached, 0);
});

test("a request-local skill of the same name wins; the plugin's copy is never written for it", async () => {
  world.script([{ tool: "read", input: { path: "/workspace/.skills/board-ops/SKILL.md" } }, { text: "done" }]);
  const r = await run({
    plugin_id: 5, plugin_tools: [...SKILL_ROWS],
    skills: { "board-ops": { enabled: true, content: "LOCAL-BODY-MARKER", version: 1, files: [] } },
  });
  assert.ok(r.prompt.includes("LOCAL-BODY-MARKER") && !r.prompt.includes("BOARD-BODY-MARKER"));
  assert.deepEqual(skillWrites(r.made.flatMap((h) => h.calls)).filter((w) => w.file.startsWith(".skills/board-ops")), []);
});

test("a failed write of a plugin skill fails the call that needed it, names the skill, and is retried by repeating the call", async () => {
  // The first three writes (the three files of board-ops) are refused, later ones succeed.
  let refused = 0;
  const shape = (h: ReturnType<typeof fakeHands>) => {
    const real = h.callTool;
    h.callTool = async (name: string, args: Record<string, unknown>) => {
      const out = await real(name, args);
      if (name === "write" && refused < 3) { refused++; return `Error writing ${String(args.path)}: disk full`; }
      return out;
    };
  };
  const cat = { tool: "bash", input: { command: "cat /workspace/.skills/board-ops/SKILL.md" } } as const;
  world.script([cat, cat, { text: "done" }]);
  const r = await run({ plugin_id: 5, plugin_tools: [...SKILL_ROWS] }, shape);
  const calls = r.made.flatMap((h) => h.calls);
  const bashAt = calls.map((c, i) => ({ c, i })).filter(({ c }) => c.name === "bash").map(({ i }) => i);
  assert.equal(bashAt.length, 1, "the first call was not run; the repeat was");
  assert.ok(skillWrites(calls).filter((w) => w.at < bashAt[0]).length >= 6, "the repeat re-wrote the skill (3 refused + 3 written) before running");
  const second = world.llmBodies[1] ?? "";
  assert.ok(second.includes("Failed to write plugin skill 'board-ops' into the sandbox"), "the model is told which skill and that the call did not run");
  assert.ok(events.some((e) => e.status === "error" && e.actionId === "plugin_skill_2" && String(e.brief).includes("board-ops")), "a visible error event");
});
