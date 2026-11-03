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

const { SkillStore, LOAD_SKILL_TOOL, SKILL_PAGE_CHARS, LOAD_SKILL_RESULT_MAX_CHARS } = await import("../src/agent/skill-store.js");
const { truncateToolResult } = await import("../src/agent/agent-loop.js");
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
  const props = (t.input_schema as { properties: Record<string, { type: string }> }).properties;
  assert.deepEqual(Object.keys(props), ["name", "file", "offset"], "the model is offered the offset it is told to continue with");
  assert.equal(props.offset.type, "integer");
  assert.match(t.description, /offset/);
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

// --- paging: a long file comes in parts, none of them cut ---------------------

const lines = (n: number, width = 99) => Array.from({ length: n }, (_, i) => `${String(i).padStart(4, "0")} ${"x".repeat(width - 5)}\n`).join("");
/** What a part says about the file: the text before its continuation line or footer. */
const partText = (t: string) => t.split("\n\n[load_skill: chars ")[0].split("\n\n---\n[skill '")[0];
const nextOffset = (t: string) => { const m = t.match(/NOT the whole file[^\n]*"offset":(\d+)/); return m ? Number(m[1]) : null; };

/** Follow "offset" the way a model does; returns every result. */
async function readAll(store: InstanceType<typeof SkillStore>, name: string, file?: string): Promise<string[]> {
  const out: string[] = [];
  let offset: number | undefined;
  for (let i = 0; i < 50; i++) {
    const r = await store.load(name, file, offset);
    assert.ok(r.ok, r.ok ? "" : r.error);
    out.push(r.text);
    const n = nextOffset(r.text);
    if (n === null) return out;
    assert.ok(n > (offset ?? 0), "every part moves forward");
    offset = n;
  }
  throw new Error("did not end");
}

test("a SKILL.md up to a part long is one result with no continuation line; the footer is the same as before", async () => {
  const body = lines(Math.floor(SKILL_PAGE_CHARS / 100)); // just under a part
  const r = await new SkillStore([skill("s1", stage({ "SKILL.md": body, "references/a.md": "A" }))]).load("s1");
  assert.ok(r.ok);
  assert.ok(r.text.startsWith(body) && !r.text.includes("[load_skill: chars"));
  assert.ok(r.text.includes("- references/a.md") && r.text.includes("/workspace/.skills/s1/"));
});

test("a SKILL.md of 7829, 12399 and 17234 chars is served in whole, in parts that end at line breaks, the file list on the last one", async () => {
  for (const size of [7829, 12399, 17234, 45000]) {
    const body = lines(Math.ceil(size / 97), 96).slice(0, size - 1) + "\n"; // 97-char lines: a part's limit falls inside a line
    const results = await readAll(new SkillStore([skill("s1", stage({ "SKILL.md": body, "scripts/run.py": "x" }))]), "s1");
    assert.equal(results.map(partText).join(""), body, `${size}: the parts joined are the file`);
    assert.equal(results.length, Math.ceil(size / SKILL_PAGE_CHARS) , `${size}: ${results.length} parts`);
    results.forEach((t, i) => {
      assert.ok(partText(t).length <= SKILL_PAGE_CHARS, `${size}: part ${i} is within a part`);
      assert.ok(i === results.length - 1 || partText(t).endsWith("\n"), `${size}: part ${i} ends at a line break`);
      assert.equal(t.includes("- scripts/run.py"), i === results.length - 1, `${size}: only the last part has the file list`);
      assert.equal(truncateToolResult(t, LOAD_SKILL_TOOL), t, `${size}: part ${i} passes the loop's cap for load_skill unchanged`);
    });
  }
});

test("a part that is not the last names the next offset and the tool to call with it; the last says it is the end", async () => {
  const body = lines(400); // 40000 chars
  const results = await readAll(new SkillStore([skill("s1", stage({ "SKILL.md": body, "references/big.md": body }))]), "s1");
  assert.equal(results.length, 3);
  const next = results[0].match(/load_skill (\{[^}]*\})\./)![1];
  assert.deepEqual(JSON.parse(next), { name: "s1", offset: nextOffset(results[0]) });
  assert.ok(results[0].includes("chars 0-") && results[0].includes("of 40000"));
  assert.ok(results[2].includes("That is the end of the file."));
  // A reference file: no footer, and the next call names the file.
  const ref = await readAll(new SkillStore([skill("s1", stage({ "SKILL.md": "X", "references/big.md": body }))]), "s1", "references/big.md");
  assert.equal(ref.map(partText).join(""), body);
  assert.deepEqual(JSON.parse(ref[0].match(/load_skill (\{[^}]*\})\./)![1]), { name: "s1", file: "references/big.md", offset: nextOffset(ref[0]) });
  assert.ok(!ref.some((t) => t.includes("[skill 's1'")), "a reference file has no footer");
});

test("a file with no line break is cut at the limit; a cut never splits a surrogate pair", async () => {
  const flat = "y".repeat(SKILL_PAGE_CHARS * 2 + 5);
  const a = await readAll(new SkillStore([skill("s1", stage({ "SKILL.md": flat }))]), "s1");
  assert.deepEqual(a.map((t) => partText(t).length), [SKILL_PAGE_CHARS, SKILL_PAGE_CHARS, 5]);
  assert.equal(a.map(partText).join(""), flat);
  // 'a' puts every emoji's high surrogate at an odd index, so the limit falls between the halves.
  const emoji = "a" + "\u{1F600}".repeat(SKILL_PAGE_CHARS);
  const b = await readAll(new SkillStore([skill("s2", stage({ "SKILL.md": emoji }))]), "s2");
  assert.ok(b.length >= 2);
  for (const t of b) assert.ok(partText(t).isWellFormed(), "no lone surrogate at either end of a part");
  assert.equal(b.map(partText).join(""), emoji);
});

test("offset: a number or a digit string is taken; anything else, or one past the end, is refused with the length", async () => {
  const body = lines(300); // 30000
  const store = new SkillStore([skill("s1", stage({ "SKILL.md": body }))]);
  const at = async (o: unknown) => store.load("s1", undefined, o);
  const mid = await at(20000);
  assert.ok(mid.ok && mid.text.startsWith(body.slice(20000, 20010)));
  assert.deepEqual(await at("20000"), mid, "a model may send the number as a string");
  assert.deepEqual(await at(undefined), await store.load("s1"));
  const end = await at(30000);
  assert.ok(end.ok && end.text.includes("That is the end of the file."), "the very end is an empty last part, not an error");
  for (const bad of [-1, 1.5, 30001, "abc", "-5", "1e3", {}, [], true, NaN]) {
    const r = await at(bad);
    assert.ok(!r.ok && r.error.includes("30000"), `${JSON.stringify(bad)} is refused and the file's length is given`);
  }
});

test("the file list is bounded: 100 paths of at most 120 chars, longer ones and the rest counted; the whole result stays under the load_skill cap", async () => {
  const files: Record<string, string> = { "SKILL.md": lines(140).slice(0, SKILL_PAGE_CHARS + 50) }; // two parts, the second short
  for (let i = 0; i < 100; i++) files[`references/${String(i).padStart(3, "0")}-${"d".repeat(100)}.md`] = "x"; // 120-char paths
  for (let i = 0; i < 15; i++) files[`references/-${"e".repeat(150)}${i}.md`] = "x"; // too long to list; "-" sorts them first
  const results = await readAll(new SkillStore([skill("s1", stage(files))]), "s1");
  const last = results[results.length - 1];
  assert.equal(last.split("\n- ").length - 1, 101, "100 listed plus the count line");
  assert.ok(last.includes("- (15 more)"));
  assert.equal(last.match(/\n- references\/\d{3}-d{100}\.md/g)?.length, 100, "the 100 that fit are the ones listed");
  assert.ok(!last.includes("eeee"), "a path too long to list is not");
  assert.ok(last.includes("To run a script, use bash on its path under /workspace/.skills/s1/"), "the footer's last line is there");
  assert.ok(last.length <= LOAD_SKILL_RESULT_MAX_CHARS, `${last.length} <= ${LOAD_SKILL_RESULT_MAX_CHARS}`);
  assert.equal(truncateToolResult(last, LOAD_SKILL_TOOL), last, "the loop's cap leaves the whole list");
  assert.ok(truncateToolResult(last).length < last.length, "where the generic cap would have cut it");
});

// --- the loop's cap -----------------------------------------------------------

test("tool-result cap: others keep the generic cap and its advice; load_skill has its own bound and a notice that names load_skill, never a sandbox tool", () => {
  const big = "z".repeat(10000);
  const generic = truncateToolResult(big, "bash");
  assert.equal(generic, truncateToolResult(big), "without a name, or with another tool's, it is the generic cap");
  assert.ok(generic.length < 6200 && /head\/tail\/grep\/sed/.test(generic));
  assert.equal(truncateToolResult("short", "bash"), "short");
  assert.equal(truncateToolResult(big, LOAD_SKILL_TOOL), big, "10000 chars is under the load_skill bound");
  const over = "z".repeat(LOAD_SKILL_RESULT_MAX_CHARS + 5000);
  const cut = truncateToolResult(over, LOAD_SKILL_TOOL);
  assert.ok(cut.length < LOAD_SKILL_RESULT_MAX_CHARS, "the result is brought under its bound");
  assert.match(cut, /\d+ chars cut from this load_skill result/);
  assert.ok(cut.includes("calling load_skill again with name, file and the offset"), "the notice points at load_skill paging");
  assert.ok(!/head|tail|grep|sed|\bread\b|bash/.test(cut.replace(/z+/g, "")), "and at no other tool");
});

// --- sub-agent refusal wording -------------------------------------------------

/** One top-level run whose model dispatches a `task` that reads two skill files, then ends; returns the tool_result text it was given back. */
async function refusalSeenBy(offered: string[]): Promise<string> {
  const { agentLoop } = await import("../src/agent/agent-loop.js");
  const seen: string[] = [];
  let turn = 0;
  const session = {
    async streamTurn(messages: unknown) {
      seen.push(JSON.stringify(messages));
      const first = turn++ === 0;
      return {
        content: first
          ? [{ type: "tool_use", id: "t1", name: "task", input: { description: "read the skill", subagent_type: "explore", prompt: "read /workspace/.skills/a/SKILL.md and /workspace/.skills/a/references/b.md in parallel" } }]
          : [{ type: "text", text: "done" }],
        stopReason: first ? "tool_use" : "end_turn",
        usage: { input_tokens: 0, output_tokens: 0, cache_create: 0, cache_read: 0 }, firstByteMs: 1,
      };
    },
    async complete() { return "summary"; },
  } as unknown as Session;
  await agentLoop([{ role: "user", content: "go" }], offered.map(tool), {
    model: "m", apiUrl: "http://localhost:0", apiKey: "k", maxTurns: 3,
    router: { route: async () => { throw new Error("the refused task reached the router"); }, setHands: () => {} } as never,
    onEvent: async () => {}, sessionId: "s", userId: "u", llmSession: session,
  } as never);
  assert.equal(seen.length, 2);
  return JSON.parse(seen[1]).at(-1).content[0].content as string;
}

test("sub-agent skill-read refusal: with load_skill on offer it points at load_skill, not at read", async () => {
  const msg = await refusalSeenBy(["task", "load_skill", "read"]);
  assert.match(msg, /do not dispatch sub-agents to read skill files/);
  assert.match(msg, /Use the `load_skill` tool directly/);
  assert.ok(!/`read`/.test(msg), "a read of a skill path is a sandbox call: the model is not sent to it");
});

test("sub-agent skill-read refusal: where load_skill is not offered (skills live in the sandbox) the advice is still read", async () => {
  const msg = await refusalSeenBy(["task", "read"]);
  assert.match(msg, /Use the `read` tool directly/);
  assert.ok(!msg.includes("load_skill"));
});
