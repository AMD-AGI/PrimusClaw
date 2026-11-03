// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `SkillStore` and the router's `load_skill`: a listed skill is served to the
 * model from Brain's staged copy, never through a sandbox.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ToolSchema } from "@claw/protocol";

const { SkillStore, LOAD_SKILL_TOOL } = await import("../src/agent/skill-store.js");
const { ToolRouter } = await import("../src/tools/router.js");
const { parseToolAllowlist } = await import("../src/tools/allowlist.js");
import type { DefaultSkill } from "../src/agent/platform-defaults.js";

function stage(files: Record<string, string | Buffer>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-store-"));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}
const skill = (name: string, localDir: string, over: Partial<DefaultSkill> = {}): DefaultSkill =>
  ({ name, description: "d", toolId: 1, localDir, ...over });

test("SKILL.md comes with its body, the other files sorted, and where scripts run; a file comes bare", async () => {
  const dir = stage({ "SKILL.md": "BODY\n", "scripts/b.py": "b", "references/a.md": "REF\n" });
  const store = new SkillStore([skill("s1", dir)], "/workspace/.skills");
  const md = await store.load("s1");
  assert.ok(md.ok);
  assert.ok(md.text.startsWith("BODY\n"));
  assert.ok(md.text.indexOf("- references/a.md") < md.text.indexOf("- scripts/b.py"), "sorted");
  assert.ok(!md.text.includes("- SKILL.md"), "SKILL.md is not listed among the others");
  assert.ok(md.text.includes("/workspace/.skills/s1/"), "the sandbox path scripts run from");
  assert.deepEqual(await store.load("s1", "references/a.md"), { ok: true, text: "REF\n" });
  assert.deepEqual(await store.load("s1", ""), md, "an empty file means SKILL.md");
});

test("a skill with no other files says so; a long file list is capped and counted", async () => {
  const bare = new SkillStore([skill("bare", stage({ "SKILL.md": "X" }))]);
  const r = await bare.load("bare");
  assert.ok(r.ok && r.text.includes("no other files"));
  const files: Record<string, string> = { "SKILL.md": "X" };
  for (let i = 0; i < 103; i++) files[`references/f${String(i).padStart(3, "0")}.md`] = "x";
  const many = await new SkillStore([skill("many", stage(files))]).load("many");
  assert.ok(many.ok);
  assert.equal(many.text.split("\n- ").length - 1, 101, "100 listed plus the count line");
  assert.ok(many.text.includes("- (3 more)"));
});

test("an unknown skill names the ones there are; a missing file, a directory, an absolute or escaping path are refused", async () => {
  const outside = stage({ "secret.txt": "OUTSIDE" });
  const dir = stage({ "SKILL.md": "X", "references/a.md": "A" });
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(dir, "references/link.md"));
  fs.symlinkSync(outside, path.join(dir, "linkdir"));
  const store = new SkillStore([skill("s1", dir), skill("s2", stage({ "SKILL.md": "Y" }))]);
  const unknown = await store.load("nope");
  assert.ok(!unknown.ok && unknown.error.includes("'nope'") && unknown.error.includes("s1, s2"));
  for (const bad of ["references/none.md", "references", "../x", "references/../../x", "/etc/passwd", "a\\..\\b"]) {
    const r = await store.load("s1", bad);
    assert.ok(!r.ok, `${bad} is refused`);
  }
  const viaLink = await store.load("s1", "references/link.md");
  assert.ok(!viaLink.ok, "a symlink out of the skill's directory is not followed");
  const viaDir = await store.load("s1", "linkdir/secret.txt");
  assert.ok(!viaDir.ok, "nor is a symlinked directory");
  assert.ok(![unknown, viaLink, viaDir].some((r) => JSON.stringify(r).includes("OUTSIDE")));
});

test("a file that is not text is not served; the error says where it is in the sandbox", async () => {
  const dir = stage({ "SKILL.md": "X", "assets/logo.bin": Buffer.from([0xff, 0xfe, 0x00, 0x80]) });
  const r = await new SkillStore([skill("s1", dir)], "/w/.skills").load("s1", "assets/logo.bin");
  assert.ok(!r.ok && r.error.includes("/w/.skills/s1/assets/logo.bin"));
});

test("a staged copy that is gone is staged again; without a way to, the skill is unavailable, not a crash", async () => {
  const gone = path.join(os.tmpdir(), "skill-store-gone-" + process.pid);
  const fresh = stage({ "SKILL.md": "RESTAGED\n" });
  let restaged = 0;
  const s = skill("s1", gone, { restage: async () => { restaged++; return fresh; } });
  const store = new SkillStore([s]);
  const a = await store.load("s1");
  assert.ok(a.ok && a.text.startsWith("RESTAGED"));
  await store.load("s1");
  assert.equal(restaged, 1, "the new directory is kept");
  const b = await new SkillStore([skill("s2", gone)]).load("s2");
  assert.ok(!b.ok && b.error.includes("not available"));
});

function routerWith(store?: InstanceType<typeof SkillStore>) {
  let attached = 0;
  const hands = { async callToolFull() { throw new Error("a skill load reached the sandbox"); } };
  const router = new ToolRouter(null, new Map(), undefined, async () => { attached++; return hands as never; });
  if (store) router.skillStore = store;
  return { router, attached: () => attached };
}
const oneSkill = () => new SkillStore([skill("s1", stage({ "SKILL.md": "BODY\n" }))]);

test("router: load_skill is served from the store with no sandbox attached, counts the skill as read, and marks a refusal as an error", async () => {
  const { router, attached } = routerWith(oneSkill());
  const outcome = { isError: false };
  const text = await router.route("load_skill", { name: "s1" }, undefined, outcome);
  assert.ok(text.startsWith("BODY\n"));
  assert.equal(outcome.isError, false);
  assert.deepEqual([...router.skillsRead], ["s1"]);
  const refused = { isError: false };
  assert.match(await router.route("load_skill", { name: "zz" }, undefined, refused), /no skill named 'zz'/);
  assert.equal(refused.isError, true, "by_tool_ok is counted from this bit");
  assert.match(await router.route("load_skill", {}, undefined, { isError: false }), /no skill named ''/);
  assert.deepEqual([...router.skillsRead], ["s1"], "a refused load is not a read");
  const other = routerWith(new SkillStore([skill("s2", stage({ "SKILL.md": "X", "references/a.md": "A" }))]));
  await other.router.route("load_skill", { name: "s2", file: "references/a.md" });
  assert.deepEqual([...other.router.skillsRead], [], "a supporting file alone is not the skill being used, as with a read of one");
  assert.equal(attached(), 0);
});

test("router: the tool is offered only when a store is set; without one a call is an unknown tool", async () => {
  assert.ok(!routerWith().router.getToolSchemas().some((t) => t.name === LOAD_SKILL_TOOL));
  const { router } = routerWith(oneSkill());
  const t = router.getToolSchemas().find((x) => x.name === LOAD_SKILL_TOOL);
  assert.ok(t);
  assert.deepEqual((t.input_schema as { required: string[] }).required, ["name"]);
  await assert.rejects(routerWith().router.route("load_skill", { name: "s1" }), /Unknown tool: load_skill/);
});

test("router: children inherit the store; a tools_allowlist that omits the tool refuses it", async () => {
  const { router } = routerWith(oneSkill());
  const child = new ToolRouter(null);
  router.registerChild(child);
  assert.ok((await child.route("load_skill", { name: "s1" })).startsWith("BODY"));
  assert.ok(child.getToolSchemas().some((t) => t.name === LOAD_SKILL_TOOL));
  router.setToolAllowlist(parseToolAllowlist(["bash"]));
  const outcome = { isError: false };
  const refused = await router.route("load_skill", { name: "s1" }, undefined, outcome);
  assert.ok(!refused.includes("BODY") && outcome.isError, "the allowlist is the enforcement");
});

// --- who is offered the tool -------------------------------------------------

const tool = (name: string) => ({ name, description: name, input_schema: { type: "object", properties: {} } }) as unknown as ToolSchema;
type Session = import("../src/llm/provider.js").LlmSession;

/** A session that records the tool names it was offered and ends the turn. */
function offeredTo(into: string[][]): Session {
  return {
    async streamTurn(_m: unknown, tools: ToolSchema[]) {
      into.push(tools.map((t) => t.name));
      return {
        content: [{ type: "text", text: "done" }], stopReason: "end_turn",
        usage: { input_tokens: 0, output_tokens: 0, cache_create: 0, cache_read: 0 }, firstByteMs: 1,
      };
    },
    async complete() { return "summary"; },
  } as unknown as Session;
}

test("plan mode keeps load_skill: reading a skill is read-only, writing is not", async () => {
  const { agentLoop } = await import("../src/agent/agent-loop.js");
  const offered: string[][] = [];
  await agentLoop([{ role: "user", content: "plan it" }], [tool("load_skill"), tool("write"), tool("bash")], {
    model: "m", apiUrl: "http://localhost:0", apiKey: "k", maxTurns: 2, startInPlanMode: true,
    router: { route: async () => "ok", setHands: () => {} } as never,
    onEvent: async () => {}, sessionId: "s", userId: "u", llmSession: offeredTo(offered),
  } as never);
  assert.deepEqual(offered[0], ["load_skill"]);
});

test("sub-agents: the read-only and explore profiles are offered load_skill, a shell sub-agent is not", async () => {
  const { runSubagent } = await import("../src/agent/sub-agent.js");
  const { AnthropicProvider } = await import("../src/llm/anthropic-provider.js");
  const { OpenAiProvider } = await import("../src/llm/openai-provider.js");
  const orig = [AnthropicProvider.prototype.createSession, OpenAiProvider.prototype.createSession];
  const offered: string[][] = [];
  AnthropicProvider.prototype.createSession = (() => offeredTo(offered)) as never;
  OpenAiProvider.prototype.createSession = (() => offeredTo(offered)) as never;
  try {
    for (const type of ["readonly", "explore", "shell"] as const) {
      await runSubagent({
        description: "d", prompt: "p", subagentType: type,
        parentSchemas: [tool("load_skill"), tool("read"), tool("bash"), tool("write")],
        hands: {} as never, onEvent: async () => {}, model: "m", apiUrl: "http://localhost:0", apiKey: "k",
        maxTurns: 2, sessionId: "sub", depth: 1,
      });
    }
  } finally {
    AnthropicProvider.prototype.createSession = orig[0];
    OpenAiProvider.prototype.createSession = orig[1];
  }
  assert.deepEqual(offered.map((o) => o.includes("load_skill")), [true, true, false]);
  assert.ok(!offered.flat().includes("write"), "profiles still narrow as they did");
});
