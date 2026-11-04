// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `ExecuteRequest.tools_allowlist`, end to end through the real engine. Brain
 * used to ignore the field, so a session that was meant to hold only a few
 * tools (a router that may only call assistant tools) could still run bash and
 * write files. Here the model is offered a real MCP server and a recording
 * sandbox, the allowlist rides on the request, and the rows say what the model
 * was shown, what it was told when it called something outside the list anyway,
 * and what actually ran.
 *
 * Only the network edges are fake: the LLM, the object store, Hands. The MCP
 * server is a real one.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { startWorld, fakeHands, baseRequest, type Turn } from "./support/platform-defaults-world.js";
import { startPluginWorld, mcpRow, uniqueSession } from "./support/plugin-world.js";

const world = await startWorld();
const pw = await startPluginWorld();
const { AgentEngine } = await import("../src/agent/engine.js");
const { toolNotAllowedMessage } = await import("../src/tools/allowlist.js");
test.after(async () => { await world.close(); await pw.close(); });

const EVERYTHING = ["bash", "read", "write", "mcp__board__ping", "task"];

async function run(allowlist: unknown, turns: Turn[]) {
  world.script(turns);
  world.llmBodies.length = 0;
  const events: Array<Record<string, unknown>> = [];
  const hands = fakeHands();
  let attached = 0;
  const mcpBefore = pw.mcpCalls.length;
  const extras = { attachHands: async () => { attached++; return hands as never; } };
  await new AgentEngine().execute(
    baseRequest({
      session_id: uniqueSession(),
      plugin_id: 5,
      plugin_tools: [mcpRow(17, pw.mcpUrl)],
      ...(allowlist === undefined ? {} : { tools_allowlist: allowlist }),
    }),
    (async (e: unknown) => { events.push(e as Record<string, unknown>); }) as never,
    undefined, null as never, extras as never,
  );
  const bodies = world.llmBodies.map((b) => JSON.parse(b) as { tools?: Array<{ name: string }> });
  return {
    /** The tool names each model request carried, in request order. */
    offered: bodies.map((b) => (b.tools ?? []).map((t) => t.name).sort()),
    requests: bodies.length,
    /** What the model read after its first turn. */
    modelSaw: world.llmBodies[1] ?? "",
    handsCalls: hands.calls.map((c) => c.name),
    attached,
    mcpRan: pw.mcpCalls.length - mcpBefore,
    events,
  };
}

const ONE = (tool: string, input: Record<string, unknown> = {}): Turn[] => [{ tool, input }, { text: "done" }];

/** The refusal as it appears inside the JSON of the next request. */
const refusalIn = (modelSaw: string, tool: string) => modelSaw.includes(JSON.stringify(toolNotAllowedMessage(tool)).slice(1, -1));

test("no field: the model is offered everything and a bash call runs, as before", async () => {
  const r = await run(undefined, ONE("bash", { command: "echo hi" }));
  for (const name of EVERYTHING) assert.ok(r.offered[0].includes(name), `offered ${name}`);
  assert.deepEqual(r.handsCalls, ["bash"]);
  assert.equal(refusalIn(r.modelSaw, "bash"), false);
});

test("an empty list is no restriction: the same offer, and bash runs", async () => {
  const none = await run(undefined, ONE("bash", { command: "echo hi" }));
  const empty = await run([], ONE("bash", { command: "echo hi" }));
  assert.deepEqual(empty.offered[0], none.offered[0]);
  assert.deepEqual(empty.handsCalls, ["bash"]);
});

interface Row {
  name: string;
  allowlist: unknown;
  /** What the first request offers, exactly. */
  offered: string[];
  /** The tool the (scripted) model calls, whatever it was offered. */
  call: string;
  input?: Record<string, unknown>;
  /** The call ran, in the sandbox or on the MCP server. */
  runs: "hands" | "mcp" | false;
}

const rows: Row[] = [
  { name: "exact names: a listed tool runs", allowlist: ["read", "bash"], offered: ["bash", "read"], call: "read", input: { path: "a" }, runs: "hands" },
  { name: "exact names: write is offered nowhere and refused when called", allowlist: ["read"], offered: ["read"], call: "write", input: { path: "a", contents: "x" }, runs: false },
  { name: "exact names: bash is refused when called", allowlist: ["read"], offered: ["read"], call: "bash", input: { command: "id" }, runs: false },
  { name: "a prefix names the MCP server: only its tools are offered", allowlist: ["mcp__board__*"], offered: ["mcp__board__ping"], call: "mcp__board__ping", runs: "mcp" },
  { name: "a prefix: a model that calls bash anyway is refused", allowlist: ["mcp__board__*"], offered: ["mcp__board__ping"], call: "bash", input: { command: "id" }, runs: false },
  { name: "a prefix: a model that writes a file anyway is refused", allowlist: ["mcp__board__*"], offered: ["mcp__board__ping"], call: "write", input: { path: "a", contents: "x" }, runs: false },
  { name: "exact and prefix together", allowlist: ["read", "mcp__board__*"], offered: ["mcp__board__ping", "read"], call: "mcp__board__ping", runs: "mcp" },
  { name: "an MCP tool the list does not name is not called", allowlist: ["read"], offered: ["read"], call: "mcp__board__ping", runs: false },
  { name: "a loop-handled tool outside the list is refused", allowlist: ["read"], offered: ["read"], call: "todo_write", input: { todos: [{ id: "a", content: "c", status: "pending" }] }, runs: false },
  { name: "a malformed list offers and runs nothing", allowlist: "bash", offered: [], call: "bash", input: { command: "id" }, runs: false },
];

for (const row of rows) {
  test(row.name, async () => {
    const r = await run(row.allowlist, ONE(row.call, row.input));
    assert.deepEqual(r.offered[0], row.offered, "what the model was shown");
    assert.deepEqual(r.handsCalls, row.runs === "hands" ? [row.call] : [], "what reached the sandbox");
    assert.equal(r.mcpRan, row.runs === "mcp" ? 1 : 0, "what reached the MCP server");
    if (row.runs) {
      assert.equal(refusalIn(r.modelSaw, row.call), false);
    } else {
      assert.ok(refusalIn(r.modelSaw, row.call), "the model was told, in words, that the tool is not available");
      assert.equal(r.attached, 0, "no sandbox was opened for a call that was turned away");
    }
  });
}

test("a task outside the list starts no sub-agent and opens no sandbox", async () => {
  const r = await run(["read"], ONE("task", { description: "d", prompt: "p" }));
  assert.equal(r.requests, 2, "the parent's two turns and no sub-agent request");
  assert.equal(r.attached, 0);
  assert.ok(refusalIn(r.modelSaw, "task"));
  assert.equal(r.events.some((e) => e.type === "subagentStart"), false);
});

test("a sub-agent inherits the list: it is offered less than its parent and cannot call bash or todo_write", async () => {
  const r = await run(["task", "read"], [
    { tool: "task", input: { description: "d", prompt: "p" } },
    { tool: "bash", input: { command: "id" } },
    { tool: "todo_write", input: { todos: [{ id: "a", content: "c", status: "pending" }] } },
    { text: "sub done" },
    { text: "parent done" },
  ]);
  assert.deepEqual(r.offered[0], ["read", "task"], "the parent is offered the list");
  assert.deepEqual(r.offered[1], ["read"], "the sub-agent is offered the list minus what no sub-agent gets");
  assert.deepEqual(r.handsCalls, [], "bash never reached the sandbox, from either");
  assert.ok(refusalIn(world.llmBodies[2] ?? "", "bash"), "the sub-agent was told bash is not available");
  assert.ok(refusalIn(world.llmBodies[3] ?? "", "todo_write"), "and that the loop's own todo_write is not either");
  assert.equal(world.llmBodies[3].includes("Todos have been modified"), false, "it was not run");
});

test("the engine hands the router the parsed list, and nothing when the request has none", async () => {
  const { ToolRouter } = await import("../src/tools/router.js");
  const original = ToolRouter.prototype.setToolAllowlist;
  const seen: Array<readonly string[] | null> = [];
  ToolRouter.prototype.setToolAllowlist = function (list) {
    seen.push(list ? list.patterns : null);
    return original.call(this, list);
  };
  try {
    await run(["read", "mcp__board__*"], [{ text: "done" }]);
    await run(undefined, [{ text: "done" }]);
    await run([], [{ text: "done" }]);
  } finally {
    ToolRouter.prototype.setToolAllowlist = original;
  }
  assert.deepEqual(seen, [["read", "mcp__board__*"], null, null]);
});

test("a requested review (sandbox_profile review) is held to its fixed list whatever the request lists: no write, no plugin server, and a call outside it is refused", async () => {
  world.script(ONE("write", { file_path: "/workspace/x", content: "y" }));
  world.llmBodies.length = 0;
  const hands = fakeHands();
  const mcpBefore = pw.mcpCalls.length;
  await new AgentEngine().execute(
    baseRequest({
      session_id: uniqueSession(), plugin_id: 5, plugin_tools: [mcpRow(17, pw.mcpUrl)],
      tools_allowlist: ["*"], sandbox_profile: "review", memory_enabled: true,
    }),
    (async () => {}) as never, undefined, null as never, { attachHands: async () => hands as never } as never,
  );
  const offered = ((JSON.parse(world.llmBodies[0]!) as { tools?: Array<{ name: string }> }).tools ?? []).map((t) => t.name).sort();
  for (const name of ["bash", "read", "task"]) assert.ok(offered.includes(name), `offered ${name}`);
  for (const name of ["write", "edit", "mcp__board__ping", "save_memory", "deliver_file", "a2a_call", "web_fetch"]) {
    assert.equal(offered.includes(name), false, `not offered ${name}`);
  }
  assert.equal(hands.calls.some((c) => c.name === "write"), false, "the write was not run");
  assert.ok(refusalIn(world.llmBodies[1] ?? "", "write"), "the model was told it is not available");
  assert.equal(pw.mcpCalls.length, mcpBefore, "the plugin's server was not reached");
});
