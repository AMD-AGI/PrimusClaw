// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `ExecuteRequest.tools_allowlist`, one layer at a time: the parser, the schema
 * filter, `ToolRouter.route()` and the agent loop's own refusal. Each layer has
 * rows of its own because each is a guard the others do not make redundant: the
 * router is the choke point for every routed call, and the loop is the only
 * place that sees the calls it handles itself (`task`, `todo_write`) and the
 * ones a hook or an approver would otherwise be asked about.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { Message, ToolSchema } from "@claw/protocol";
import type { HandsClient } from "../src/clients/hands.js";
import type { LlmSession, LlmTurnResult, LlmContentBlock } from "../src/llm/provider.js";
import { filterToolSchemas, parseToolAllowlist, toolNotAllowedMessage } from "../src/tools/allowlist.js";
import { ToolRouter } from "../src/tools/router.js";
import { agentLoop, type LoopOptions } from "../src/agent/agent-loop.js";

// ── the parser ───────────────────────────────────────────────────────────────

interface ParseRow {
  name: string;
  raw: unknown;
  /** null: the run is unrestricted. */
  restricts: boolean;
  allowed?: string[];
  refused?: string[];
}

const parseRows: ParseRow[] = [
  { name: "no field", raw: undefined, restricts: false },
  { name: "null", raw: null, restricts: false },
  // The API stores [] on every task row that did not set one and forwards it.
  { name: "an empty list is no restriction", raw: [], restricts: false },
  {
    name: "exact names",
    raw: ["bash", "read"],
    restricts: true,
    allowed: ["bash", "read"],
    refused: ["write", "bash_output", "bash2", "Bash", " bash", "mcp__board__ping"],
  },
  {
    name: "a prefix pattern names a whole MCP server",
    raw: ["mcp__board__*"],
    restricts: true,
    allowed: ["mcp__board__ping", "mcp__board__a__b", "mcp__board__"],
    refused: ["mcp__boardx__ping", "mcp__board_ping", "mcp__other__ping", "bash", "mcp__board"],
  },
  {
    name: "exact and prefix together",
    raw: ["read", "mcp__assistant__*"],
    restricts: true,
    allowed: ["read", "mcp__assistant__say", "mcp__assistant__work_create"],
    refused: ["bash", "write", "task", "mcp__other__say"],
  },
  {
    name: "an exact MCP name is exact, not a prefix",
    raw: ["mcp__board__ping"],
    restricts: true,
    allowed: ["mcp__board__ping"],
    refused: ["mcp__board__pingpong", "mcp__board__"],
  },
  {
    name: "entries are trimmed and blanks dropped",
    raw: ["  bash  ", "", "   "],
    restricts: true,
    allowed: ["bash"],
    refused: ["read", ""],
  },
  {
    name: "a bare * is the prefix of everything",
    raw: ["*"],
    restricts: true,
    allowed: ["bash", "mcp__x__y", "anything"],
    refused: [],
  },
  {
    name: "a * that is not trailing is an ordinary character, so it names nothing and widens nothing",
    raw: ["mcp__*__ping", "ba*sh"],
    restricts: true,
    allowed: [],
    refused: ["mcp__board__ping", "mcp__other__ping", "bash", "basssh"],
  },
  {
    name: "entries that are not strings are dropped",
    raw: ["read", 5, null, { a: 1 }],
    restricts: true,
    allowed: ["read"],
    refused: ["bash", "5"],
  },
  {
    name: "a list with no usable entry allows nothing rather than everything",
    raw: [5, "", null],
    restricts: true,
    allowed: [],
    refused: ["bash", "read", "mcp__board__ping"],
  },
  {
    name: "a bare string is malformed and allows nothing",
    raw: "bash",
    restricts: true,
    allowed: [],
    refused: ["bash", "read"],
  },
  {
    name: "an object is malformed and allows nothing",
    raw: { bash: true },
    restricts: true,
    allowed: [],
    refused: ["bash"],
  },
];

for (const row of parseRows) {
  test(`parse: ${row.name}`, () => {
    const list = parseToolAllowlist(row.raw);
    if (!row.restricts) {
      assert.equal(list, null, "no restriction is null, not an allow-everything object");
      return;
    }
    assert.ok(list, "a restriction is an object");
    for (const name of row.allowed ?? []) assert.equal(list.allows(name), true, `allows ${JSON.stringify(name)}`);
    for (const name of row.refused ?? []) assert.equal(list.allows(name), false, `refuses ${JSON.stringify(name)}`);
  });
}

// ── the schema filter ────────────────────────────────────────────────────────

const schema = (name: string): ToolSchema =>
  ({ name, description: name, input_schema: { type: "object", properties: {} } }) as unknown as ToolSchema;

const OFFERED = ["bash", "read", "write", "task", "save_memory", "mcp__assistant__say", "mcp__assistant__work_create", "mcp__other__x"];

const filterRows: Array<{ name: string; raw: unknown; kept: string[] }> = [
  { name: "no field keeps every schema", raw: undefined, kept: OFFERED },
  { name: "an empty list keeps every schema", raw: [], kept: OFFERED },
  { name: "exact names", raw: ["read", "bash"], kept: ["bash", "read"] },
  { name: "a prefix pattern", raw: ["mcp__assistant__*"], kept: ["mcp__assistant__say", "mcp__assistant__work_create"] },
  { name: "exact and prefix", raw: ["read", "mcp__assistant__*"], kept: ["read", "mcp__assistant__say", "mcp__assistant__work_create"] },
  { name: "a name the run was never offered adds nothing", raw: ["web_search"], kept: [] },
  { name: "a malformed list keeps none", raw: "bash", kept: [] },
];

for (const row of filterRows) {
  test(`schemas: ${row.name}`, () => {
    const out = filterToolSchemas(OFFERED.map(schema), parseToolAllowlist(row.raw));
    assert.deepEqual(out.map((s) => s.name), row.kept);
  });
}

test("schemas: the router's own schemas and an MCP server's are filtered by the one list", () => {
  const router = new ToolRouter(null);
  const mcp = ["mcp__assistant__say", "mcp__other__x"].map(schema);
  const out = filterToolSchemas([...router.getToolSchemas(), ...mcp], parseToolAllowlist(["bash", "read", "mcp__assistant__*"]));
  assert.deepEqual(out.map((s) => s.name).sort(), ["bash", "mcp__assistant__say", "read"]);
});

// ── ToolRouter.route ─────────────────────────────────────────────────────────

function makeRouter(raw: unknown) {
  const handsCalls: string[] = [];
  const mcpCalls: string[] = [];
  const hands = {
    callTool: async (name: string) => { handsCalls.push(name); return "ran"; },
    callToolFull: async (name: string) => { handsCalls.push(name); return { text: "ran", isError: false }; },
  } as unknown as HandsClient;
  const router = new ToolRouter(hands, new Map([["board", {
    callTool: async (name: string) => { mcpCalls.push(name); return "pong"; },
  }]]));
  router.setToolAllowlist(parseToolAllowlist(raw));
  return { router, handsCalls, mcpCalls };
}

interface RouteRow {
  name: string;
  allowlist: unknown;
  call: string;
  input?: Record<string, unknown>;
  runs: boolean;
}

const routeRows: RouteRow[] = [
  { name: "no field: bash runs as before", allowlist: undefined, call: "bash", input: { command: "id" }, runs: true },
  { name: "no field: an MCP tool runs as before", allowlist: undefined, call: "mcp__board__ping", runs: true },
  { name: "an empty list: bash runs as before", allowlist: [], call: "bash", input: { command: "id" }, runs: true },
  { name: "exact: a listed tool runs", allowlist: ["read"], call: "read", input: { path: "a" }, runs: true },
  { name: "exact: bash is refused", allowlist: ["read"], call: "bash", input: { command: "id" }, runs: false },
  { name: "exact: write is refused", allowlist: ["read"], call: "write", input: { path: "a", contents: "x" }, runs: false },
  { name: "exact: bash does not imply bash_output", allowlist: ["bash"], call: "bash_output", input: { shell_id: "s" }, runs: false },
  { name: "prefix: a tool of the named server runs", allowlist: ["mcp__board__*"], call: "mcp__board__ping", runs: true },
  { name: "prefix: another server is refused, not 'unknown server'", allowlist: ["mcp__board__*"], call: "mcp__other__ping", runs: false },
  { name: "prefix: bash is refused", allowlist: ["mcp__board__*"], call: "bash", input: { command: "id" }, runs: false },
  { name: "prefix: write is refused", allowlist: ["mcp__board__*"], call: "write", input: { path: "a", contents: "x" }, runs: false },
  { name: "exact MCP name: that tool runs", allowlist: ["mcp__board__ping"], call: "mcp__board__ping", runs: true },
  { name: "exact MCP name: its sibling is refused", allowlist: ["mcp__board__ping"], call: "mcp__board__pong", runs: false },
  { name: "a malformed list refuses everything", allowlist: "bash", call: "bash", input: { command: "id" }, runs: false },
];

for (const row of routeRows) {
  test(`route: ${row.name}`, async () => {
    const { router, handsCalls, mcpCalls } = makeRouter(row.allowlist);
    const outcome = { isError: false };
    const out = await router.route(row.call, row.input ?? {}, undefined, outcome);
    const reached = [...handsCalls, ...mcpCalls];
    if (row.runs) {
      assert.deepEqual(reached, [row.call.startsWith("mcp__") ? "ping" : row.call], "the call went to its backend");
      assert.equal(outcome.isError, false);
      assert.doesNotMatch(out, /not available in this session/);
    } else {
      assert.deepEqual(reached, [], "nothing reached the sandbox or an MCP server");
      assert.equal(out, toolNotAllowedMessage(row.call), "the model is told, in words");
      assert.match(out, /^Error: the tool '.+' is not available in this session/);
      assert.equal(outcome.isError, true, "the refusal is an error, not a success");
    }
  });
}

test("route: save_memory and save_skill outside the list buffer nothing", async () => {
  const { router } = makeRouter(["mcp__board__*"]);
  const memory = await router.route("save_memory", { category: "preference", content: "tabs" });
  const skill = await router.route("save_skill", { skill_name: "x", content: "c", description: "d" });
  assert.equal(memory, toolNotAllowedMessage("save_memory"));
  assert.equal(skill, toolNotAllowedMessage("save_skill"));
  assert.equal(router.pendingMemories.length, 0);
  assert.equal(router.pendingSkills.length, 0);
});

test("route: a listed save_memory still saves", async () => {
  const { router } = makeRouter(["save_memory"]);
  const out = await router.route("save_memory", { category: "preference", content: "tabs" });
  assert.match(out, /Memory saved/);
  assert.equal(router.pendingMemories.length, 1);
});

test("route: a loop-handled tool outside the list gets the refusal; inside it, the old error", async () => {
  const restricted = makeRouter(["read"]).router;
  assert.equal(await restricted.route("todo_write", { todos: [] }), toolNotAllowedMessage("todo_write"));
  const open = makeRouter(undefined).router;
  await assert.rejects(open.route("todo_write", { todos: [] }), /must be handled by engine loop/);
  const listed = makeRouter(["todo_write"]).router;
  await assert.rejects(listed.route("todo_write", { todos: [] }), /must be handled by engine loop/);
});

test("route: setToolAllowlist(null) lifts the restriction", async () => {
  const { router, handsCalls } = makeRouter(["read"]);
  assert.equal(await router.route("bash", { command: "id" }), toolNotAllowedMessage("bash"));
  router.setToolAllowlist(null);
  assert.equal(await router.route("bash", { command: "id" }), "ran");
  assert.deepEqual(handsCalls, ["bash"]);
});

// ── the agent loop ───────────────────────────────────────────────────────────

function scriptedSession(turns: Array<{ content: LlmContentBlock[]; stopReason: string }>): LlmSession & {
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
        content: turn.content, stopReason: turn.stopReason,
        usage: { input_tokens: 0, output_tokens: 0, cache_create: 0, cache_read: 0 }, firstByteMs: 1,
      } as LlmTurnResult;
    },
    async complete() { return "summary"; },
  };
}

const toolUse = (id: string, name: string, input: Record<string, unknown> = {}): LlmContentBlock =>
  ({ type: "tool_use", id, name, input });
const text = (t: string): LlmContentBlock => ({ type: "text", text: t });

const LOOP_TOOLS = ["bash", "read", "write", "todo_write", "task"].map(schema);

type Ev = Record<string, unknown>;

/** A router that only records, so a call that reaches it is visible. */
function recordingRouter() {
  const calls: string[] = [];
  return {
    calls,
    route: async (name: string) => { calls.push(name); return "ok"; },
    setHands: () => {},
    classifyShell: async () => ({ shellClass: "finished", collectorLive: false }),
  } as unknown as ToolRouter & { calls: string[] };
}

function loopOpts(over: Partial<LoopOptions>): { opts: LoopOptions; events: Ev[] } {
  const events: Ev[] = [];
  const opts: LoopOptions = {
    model: "m", apiUrl: "http://localhost:0", apiKey: "k", maxTurns: 6,
    router: recordingRouter(),
    onEvent: async (e: unknown) => { events.push(e as Ev); },
    sessionId: "s", userId: "u",
    ...over,
  };
  return { opts, events };
}

const resultFor = (session: { calls: Array<{ messages: Message[] }> }, turn: number, id: string): string => {
  const block = session.calls[turn].messages
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .find((b: unknown) => (b as Ev)?.type === "tool_result" && (b as Ev).tool_use_id === id) as Ev | undefined;
  return String(block?.content);
};

test("loop: a call outside the list is refused before any hook, approver or router sees it", async () => {
  const session = scriptedSession([
    { content: [toolUse("t1", "bash", { command: "id" })], stopReason: "tool_use" },
    { content: [text("ok")], stopReason: "end_turn" },
  ]);
  const router = recordingRouter();
  const hookEvents: string[] = [];
  let asked = 0;
  const hooks = { has: () => true, run: async (event: string) => { hookEvents.push(event); return { block: false }; } };
  const hitl = { willAsk: () => true, beforeToolUse: async () => { asked++; return { action: "allow", input: {} }; } };
  const { opts, events } = loopOpts({
    llmSession: session, router,
    hooks: hooks as unknown as LoopOptions["hooks"],
    hitl: hitl as unknown as LoopOptions["hitl"],
    toolAllowlist: parseToolAllowlist(["read"]),
  });

  const result = await agentLoop([{ role: "user", content: "go" }], LOOP_TOOLS, opts);

  assert.deepEqual(router.calls, [], "never routed");
  assert.equal(hookEvents.includes("PreToolUse"), false, "no PreToolUse hook ran for it");
  assert.equal(asked, 0, "nobody was asked to approve it");
  assert.equal(resultFor(session, 1, "t1"), toolNotAllowedMessage("bash"), "the model is told");
  const errored = events.filter((e) => e.type === "toolUsed" && e.status === "error");
  assert.equal(errored.length, 1);
  assert.equal(errored[0].description, toolNotAllowedMessage("bash"));
  assert.deepEqual(result.toolStats, { total_calls: 1, error_calls: 1, by_tool: { bash: 1 }, by_tool_ok: {} });
});

test("loop: a listed call is routed as before", async () => {
  const session = scriptedSession([
    { content: [toolUse("t1", "read", { path: "a" })], stopReason: "tool_use" },
    { content: [text("ok")], stopReason: "end_turn" },
  ]);
  const router = recordingRouter();
  const { opts } = loopOpts({ llmSession: session, router, toolAllowlist: parseToolAllowlist(["read"]) });
  const result = await agentLoop([{ role: "user", content: "go" }], LOOP_TOOLS, opts);
  assert.deepEqual(router.calls, ["read"]);
  assert.equal(result.errorCount, 0);
  assert.equal(result.toolStats.by_tool_ok?.read, 1);
});

for (const [name, allowlist] of [["no field", undefined], ["null", null], ["an empty list", parseToolAllowlist([])]] as const) {
  test(`loop: ${name} is the loop it always was`, async () => {
    const session = scriptedSession([
      { content: [toolUse("t1", "bash", { command: "id" })], stopReason: "tool_use" },
      { content: [text("ok")], stopReason: "end_turn" },
    ]);
    const router = recordingRouter();
    const { opts } = loopOpts({ llmSession: session, router, toolAllowlist: allowlist });
    await agentLoop([{ role: "user", content: "go" }], LOOP_TOOLS, opts);
    assert.deepEqual(router.calls, ["bash"]);
  });
}

test("loop: todo_write is handled by the loop, so only the loop can turn it away", async () => {
  const todos = { todos: [{ id: "a", content: "first", status: "pending" }] };
  const turns = () => scriptedSession([
    { content: [toolUse("t1", "todo_write", todos)], stopReason: "tool_use" },
    { content: [text("ok")], stopReason: "end_turn" },
  ]);

  const refusedSession = turns();
  const refused = loopOpts({ llmSession: refusedSession, toolAllowlist: parseToolAllowlist(["read"]) });
  await agentLoop([{ role: "user", content: "go" }], LOOP_TOOLS, refused.opts);
  assert.equal(resultFor(refusedSession, 1, "t1"), toolNotAllowedMessage("todo_write"));
  assert.equal(refused.events.some((e) => e.type === "toolUsed" && e.status === "success"), false);

  const listedSession = turns();
  const listed = loopOpts({ llmSession: listedSession, toolAllowlist: parseToolAllowlist(["todo_write"]) });
  await agentLoop([{ role: "user", content: "go" }], LOOP_TOOLS, listed.opts);
  assert.match(resultFor(listedSession, 1, "t1"), /Todos have been modified successfully/);
});

test("loop: a task outside the list opens no sandbox and starts no sub-agent", async () => {
  const session = scriptedSession([
    { content: [toolUse("t1", "task", { description: "d", prompt: "p" })], stopReason: "tool_use" },
    { content: [text("ok")], stopReason: "end_turn" },
  ]);
  let attached = 0;
  const { opts, events } = loopOpts({
    llmSession: session,
    toolAllowlist: parseToolAllowlist(["read"]),
    attachHands: async () => { attached++; return {} as HandsClient; },
  });
  const result = await agentLoop([{ role: "user", content: "go" }], LOOP_TOOLS, opts);
  assert.equal(attached, 0, "the sandbox was never opened for it");
  assert.equal(session.calls.length, 2, "one model request per parent turn, none for a sub-agent");
  assert.equal(resultFor(session, 1, "t1"), toolNotAllowedMessage("task"));
  assert.equal(events.filter((e) => e.type === "subagentStart").length, 0);
  assert.deepEqual(result.toolStats, { total_calls: 1, error_calls: 1, by_tool: { task: 1 }, by_tool_ok: {} });
});
