// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Tools the model is offered do what they say, or are not offered.
 *
 *   H1 skill self-evolution off: the four skill-writing tools are not offered,
 *      and a call that arrives anyway is refused instead of told "saved"
 *   H2 exit_plan_mode is offered only to a run that is in plan mode
 *   H3 an MCP server that does not connect is reported, with a reason fit to show
 *   H4 an MCP result block that is not text is named, not dropped
 *   H5 a result too long for the conversation is kept whole in the sandbox and the
 *      cut points at it; a `read` page is cut at a line and told where to continue
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Message, ToolSchema } from "@claw/protocol";
import type { LlmSession, LlmTurnResult, LlmContentBlock } from "../src/llm/provider.js";
import { ToolRouter, SKILL_WRITE_TOOLS, SPILL_MAX_CHARS } from "../src/tools/router.js";
import { TOOL_RESULTS_DIR } from "../src/workspace/excludes.js";
import { agentLoop, truncateToolResult, type LoopOptions } from "../src/agent/agent-loop.js";
import { connectPlatformMcp, mcpContentText, mcpUnavailableNote } from "../src/clients/mcp.js";
import type { HandsClient } from "../src/clients/hands.js";

// ── H1 ──────────────────────────────────────────────────────────────────────

const SKILL_CALLS: Array<[string, Record<string, unknown>]> = [
  ["save_skill", { skill_name: "s", description: "d", content: "## Goal" }],
  ["add_skill_file", { skill_name: "s", file_path: "scripts/go.sh", content: "echo hi" }],
  ["update_skill_file", { skill_name: "s", file_path: "scripts/go.sh", content: "echo hi" }],
  ["remove_skill_file", { skill_name: "s", file_path: "scripts/go.sh" }],
];

test("H1 skill self-evolution off (the default): the skill tools are not offered", () => {
  const names = new ToolRouter(null).getToolSchemas().map((t) => t.name);
  for (const tool of SKILL_WRITE_TOOLS) assert.ok(!names.includes(tool), `${tool} is offered`);
  assert.ok(names.includes("save_memory"), "the other tools are untouched");
});

test("H1 skill self-evolution off: a call that arrives anyway is refused and buffers nothing", async () => {
  const router = new ToolRouter(null);
  for (const [name, input] of SKILL_CALLS) {
    const outcome = { isError: false };
    const out = await router.route(name, input, undefined, outcome);
    assert.match(out, /^Error: saving skills is turned off/, name);
    assert.equal(outcome.isError, true, `${name} counted as work done`);
  }
  assert.equal(router.pendingSkills.length, 0);
  assert.equal(router.pendingSkillFileMutations.length, 0);
});

test("H1 skill self-evolution on: the tools are offered, work, and a sub-agent's router inherits it", async () => {
  const router = new ToolRouter(null);
  router.skillEvolutionEnabled = true;
  const names = router.getToolSchemas().map((t) => t.name);
  for (const tool of SKILL_WRITE_TOOLS) assert.ok(names.includes(tool), `${tool} is not offered`);
  const out = await router.route("save_skill", SKILL_CALLS[0][1]);
  assert.match(out, /saved/);
  assert.equal(router.pendingSkills.length, 1);

  const child = new ToolRouter(null);
  router.registerChild(child);
  assert.equal(child.skillEvolutionEnabled, true);
});

// ── a scripted loop ────────────────────────────────────────────────────────

function scriptedSession(turns: Array<Partial<LlmTurnResult>>): LlmSession & {
  calls: Array<{ messages: Message[]; tools: ToolSchema[] }>;
} {
  const calls: Array<{ messages: Message[]; tools: ToolSchema[] }> = [];
  let i = 0;
  return {
    calls,
    async streamTurn(messages, tools) {
      calls.push({ messages: JSON.parse(JSON.stringify(messages)), tools: [...tools] });
      const turn = turns[i++];
      if (!turn) throw new Error(`scripted session exhausted after ${i - 1} turns`);
      return {
        content: turn.content ?? [],
        stopReason: turn.stopReason ?? "end_turn",
        usage: { input_tokens: 0, output_tokens: 0, cache_create: 0, cache_read: 0 },
        firstByteMs: 1,
      };
    },
    async complete() { return "summary"; },
  };
}

const toolUse = (id: string, name: string, input: Record<string, unknown> = {}): LlmContentBlock =>
  ({ type: "tool_use", id, name, input });
const text = (t: string): LlmContentBlock => ({ type: "text", text: t });

const TOOLS = ["read", "write", "bash", "exit_plan_mode"].map((name) => (
  { name, description: name, input_schema: { type: "object", properties: {} } }
)) as unknown as ToolSchema[];

function fakeRouter(
  result: (name: string) => string,
  spill: (id: string, text: string) => Promise<string | null>,
): ToolRouter & { spilled: Array<{ id: string; text: string }> } {
  const spilled: Array<{ id: string; text: string }> = [];
  return {
    spilled,
    route: async (name: string) => result(name),
    spillToolResult: async (id: string, t: string) => { spilled.push({ id, text: t }); return spill(id, t); },
    setHands: () => {},
  } as unknown as ToolRouter & { spilled: Array<{ id: string; text: string }> };
}

function opts(router: ToolRouter, llmSession: LlmSession, over: Partial<LoopOptions> = {}): LoopOptions {
  return {
    model: "m", apiUrl: "http://localhost:0", apiKey: "k", maxTurns: 5,
    router, llmSession, onEvent: async () => {}, sessionId: "s", userId: "u", ...over,
  };
}

/** The tool_result the model was given on the second turn. */
function resultSeen(session: { calls: Array<{ messages: Message[] }> }): string {
  const block = session.calls[1].messages
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .find((b: unknown) => (b as { type?: string }).type === "tool_result") as { content: string };
  return block.content;
}

// ── H2 ──────────────────────────────────────────────────────────────────────

test("H2 exit_plan_mode is not offered to a run that is not in plan mode", async () => {
  const session = scriptedSession([{ content: [text("hi")], stopReason: "end_turn" }]);
  await agentLoop([{ role: "user", content: "hi" }], TOOLS, opts(fakeRouter(() => "ok", async () => null), session));
  const offered = session.calls[0].tools.map((t) => t.name);
  assert.ok(!offered.includes("exit_plan_mode"), "a run outside plan mode was offered exit_plan_mode");
  assert.ok(offered.includes("write"));
});

test("H2 a run in plan mode is offered it, and not after leaving", async () => {
  const session = scriptedSession([
    { content: [toolUse("t1", "exit_plan_mode", { plan: "p" })], stopReason: "tool_use" },
    { content: [text("done")], stopReason: "end_turn" },
  ]);
  await agentLoop([{ role: "user", content: "plan" }], TOOLS,
    opts(fakeRouter(() => "ok", async () => null), session, { startInPlanMode: true }));
  assert.ok(session.calls[0].tools.some((t) => t.name === "exit_plan_mode"));
  assert.ok(!session.calls[1].tools.some((t) => t.name === "exit_plan_mode"));
});

// ── H5 ──────────────────────────────────────────────────────────────────────

const LONG = `${"x".repeat(5000)}MIDDLE${"y".repeat(5000)}`;

test("H5 a long result is kept whole in the sandbox and the cut names where", async () => {
  const session = scriptedSession([
    { content: [toolUse("toolu_01", "bash", { command: "make" })], stopReason: "tool_use" },
    { content: [text("done")], stopReason: "end_turn" },
  ]);
  const router = fakeRouter(() => LONG, async (id) => `/workspace/${TOOL_RESULTS_DIR}/${id}.txt`);
  await agentLoop([{ role: "user", content: "build" }], TOOLS, opts(router, session));
  assert.deepEqual(router.spilled, [{ id: "toolu_01", text: LONG }], "the whole result was not kept");
  const seen = resultSeen(session);
  assert.ok(seen.length < LONG.length, "the conversation got the whole result");
  assert.match(seen, new RegExp(`saved at /workspace/${TOOL_RESULTS_DIR}/toolu_01\\.txt`));
  assert.doesNotMatch(seen, /MIDDLE/);
});

test("H5 with nowhere to keep it, the cut says to re-run narrower, as before", async () => {
  const session = scriptedSession([
    { content: [toolUse("t1", "bash", { command: "make" })], stopReason: "tool_use" },
    { content: [text("done")], stopReason: "end_turn" },
  ]);
  await agentLoop([{ role: "user", content: "build" }], TOOLS, opts(fakeRouter(() => LONG, async () => null), session));
  const seen = resultSeen(session);
  assert.match(seen, /re-run the command with narrower scope/);
  assert.doesNotMatch(seen, /saved at/);
});

test("H5 a long read page is not kept again: it is cut at a line with the offset to continue", async () => {
  const page = Array.from({ length: 400 }, (_, i) => `${i + 1}|${"z".repeat(40)}`).join("\n");
  const session = scriptedSession([
    { content: [toolUse("t1", "read", { path: "big.log" })], stopReason: "tool_use" },
    { content: [text("done")], stopReason: "end_turn" },
  ]);
  const router = fakeRouter(() => page, async () => "/should/not/be/used");
  await agentLoop([{ role: "user", content: "read" }], TOOLS, opts(router, session));
  assert.equal(router.spilled.length, 0, "a read result was written to the sandbox again");
  const seen = resultSeen(session);
  const lastKept = Number(/(\d+)\|z+\n\n\[\.\.\. read result cut/.exec(seen)?.[1]);
  assert.ok(lastKept > 0 && lastKept < 400, seen.slice(-300));
  assert.match(seen, new RegExp(`continue with read offset=${lastKept + 1}\\b`));
});

test("H5 a result over the spill cap is said to be kept only in part", () => {
  const huge = "q".repeat(SPILL_MAX_CHARS + 10);
  const seen = truncateToolResult(huge, "bash", "/workspace/.tool-results/t.txt");
  assert.match(seen, new RegExp(`only the first ${SPILL_MAX_CHARS} of its ${huge.length} chars are saved`));
  assert.doesNotMatch(seen, /the whole result/);
});

test("H5 a read page whose first line alone is over the budget does not point past the cut", () => {
  const seen = truncateToolResult(`1|${"w".repeat(9000)}\n2|next`, "read");
  assert.match(seen, /line 1 alone is longer than this and was cut; see the rest of it with bash/);
  assert.doesNotMatch(seen, /\[\.\.\. [^\]]*; continue with read offset=2, and a smaller limit/);
});

test("H5 a short result is passed through untouched and nothing is written", () => {
  assert.equal(truncateToolResult("short", "bash", "/x"), "short");
});

test("H5 spillToolResult writes only into a sandbox the run already has", async () => {
  let opened = 0;
  const lazy = new ToolRouter(null, new Map(), {}, async () => { opened++; throw new Error("opened a sandbox"); });
  assert.equal(await lazy.spillToolResult("t1", LONG), null, "a run with no sandbox wrote one");
  assert.equal(opened, 0, "keeping a result opened a sandbox");

  const writes: Array<Record<string, unknown>> = [];
  const hands = {
    callTool: async (name: string, args: Record<string, unknown>) => { writes.push({ name, ...args }); return `Written to ${args.path}`; },
  } as unknown as HandsClient;
  const path = await new ToolRouter(hands).spillToolResult("toolu/../01", LONG);
  assert.equal(path, `/workspace/${TOOL_RESULTS_DIR}/toolu____01.txt`, "the id was not made a plain file name");
  assert.deepEqual(writes, [{ name: "write", path, contents: LONG }]);

  const failing = { callTool: async () => "Error writing x: ENOSPC" } as unknown as HandsClient;
  assert.equal(await new ToolRouter(failing).spillToolResult("t1", LONG), null, "a failed write was reported as kept");
});

// ── H3 / H4 ─────────────────────────────────────────────────────────────────

test("H3 a server that does not connect is reported with a reason, its tools absent", async () => {
  const token = "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB";
  const result = await connectPlatformMcp({
    down: { type: "http", url: "http://127.0.0.1:1/mcp", token },
  });
  try {
    assert.equal(result.schemas.length, 0);
    assert.equal(result.clients.has("down"), false);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].name, "down");
    assert.ok(result.failed[0].reason.length > 0 && result.failed[0].reason.length <= 203);
    assert.ok(!result.failed[0].reason.includes(token));
  } finally {
    await result.closeAll();
  }
  const note = mcpUnavailableNote(result.failed);
  assert.match(note, /MCP server\(s\) down \(/);
  assert.match(note, /unreachable right now rather than that you lack the capability/);
  assert.equal(mcpUnavailableNote([]), "");
});

test("H4 a non-text block is named, not dropped", () => {
  assert.equal(
    mcpContentText([
      { type: "text", text: "chart below" },
      { type: "image", data: "iVBORw0K", mimeType: "image/png" },
      { type: "resource", resource: { uri: "file:///a" } },
    ]),
    "chart below\n"
      + "[image content omitted (image/png): this tool result can only be shown as text]\n"
      + "[resource content omitted: this tool result can only be shown as text]",
  );
  assert.equal(mcpContentText(undefined), "");
});

test("gh_pr_get of the github_review server is cut only past its own bound; the same text from any other tool at the generic cap", async () => {
  const { GITHUB_REVIEW_READ_TOOL, GITHUB_REVIEW_READ_MAX_CHARS } = await import("../src/agent/agent-loop.js");
  const page = "d".repeat(23_000);
  // [tool, text, kept whole]
  const cases: Array<[string, string, boolean]> = [
    [GITHUB_REVIEW_READ_TOOL, page, true],
    [GITHUB_REVIEW_READ_TOOL, "d".repeat(GITHUB_REVIEW_READ_MAX_CHARS), true],
    [GITHUB_REVIEW_READ_TOOL, "d".repeat(GITHUB_REVIEW_READ_MAX_CHARS + 1), false],
    ["mcp__other__gh_pr_get", page, false],
    ["bash", page, false],
  ];
  for (const [tool, text, whole] of cases) assert.equal(truncateToolResult(text, tool) === text, whole, `${tool} ${text.length}`);
});
