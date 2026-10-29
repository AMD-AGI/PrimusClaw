// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The prompt cache across user turns, through the real engine.
 *
 * The cache can only read what is byte for byte the same, and the tool list is
 * the first thing in the rendered prompt. A tool server that answers
 * `tools/list` in a different order every time -- one registered from a hash
 * map does -- gives each run its own order: stable inside a turn, different on
 * the next, so the entry the last call of one turn wrote could never be read by
 * the first call of the next. Every turn wrote the whole prefix again.
 *
 * The stub server below rotates its tool list on every `tools/list`, which is
 * that behaviour without randomness. Only the network edges are fake (LLM and
 * MCP server); the history is shaped the way the API hands it to Brain: the
 * stored turns replayed, then the new prompt, with Brain wrapping the new
 * prompt on top.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { startWorld, baseRequest } from "./support/platform-defaults-world.js";

const TOOL_NAMES = ["delta", "alpha", "echo", "charlie", "bravo"];

/** A stateless Streamable-HTTP MCP server whose `tools/list` order changes on every call. */
async function startRotatingMcp() {
  let lists = 0;
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    const mcp = new Server({ name: "stub", version: "0" }, { capabilities: { tools: {} } });
    mcp.setRequestHandler(ListToolsRequestSchema, async () => {
      const shift = lists++ % TOOL_NAMES.length;
      const names = [...TOOL_NAMES.slice(shift), ...TOOL_NAMES.slice(0, shift)];
      return { tools: names.map((name) => ({ name, description: `the ${name} tool`, inputSchema: { type: "object", properties: {} } })) };
    });
    mcp.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text", text: "tool result" }] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { void transport.close(); void mcp.close(); });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
    lists: () => lists,
    close: () => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); }),
  };
}

const world = await startWorld();
const mcp = await startRotatingMcp();
const { AgentEngine } = await import("../src/agent/engine.js");
const { connectPlatformMcp, sortToolSchemasByName } = await import("../src/clients/mcp.js");

test.after(async () => { await world.close(); await mcp.close(); });

type Body = {
  tools?: Array<{ name: string }>;
  system?: Array<Record<string, unknown>> | string;
  messages: Array<{ role: string; content: string | Array<Record<string, unknown>> }>;
};

/**
 * The request flattened in render order -- tools, system, messages -- one entry
 * per block, with the cache marker taken off: the marker is where the prefix
 * ends, not part of what is hashed.
 */
function rendered(body: Body): { blocks: string[]; markers: number[] } {
  const blocks: string[] = [];
  const markers: number[] = [];
  for (const t of body.tools ?? []) blocks.push(`tool ${JSON.stringify(t)}`);
  const system = typeof body.system === "string" ? [{ type: "text", text: body.system }] : (body.system ?? []);
  const content = [
    ...system.map((b) => ["system", b] as const),
    ...body.messages.flatMap((m) =>
      (Array.isArray(m.content) ? m.content : [{ type: "text", text: m.content }]).map((b) => [m.role, b] as const)),
  ];
  for (const [role, block] of content) {
    const { cache_control, ...rest } = block as Record<string, unknown>;
    if (cache_control) markers.push(blocks.length);
    blocks.push(`${role} ${JSON.stringify(rest)}`);
  }
  return { blocks, markers };
}

function commonPrefixLength(a: string[], b: string[]): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

const mcpServers = { stub: { type: "http", url: mcp.url, token: "t" } };
const noSandbox = { attachHands: async () => { throw new Error("these turns need no sandbox"); } };

test("the stub reorders its tools on every listing, and connectPlatformMcp hands back one order regardless", async () => {
  // Raw listings straight off the wire: the premise the rest of this file rests on.
  const raw: string[][] = [];
  for (let i = 0; i < 2; i++) {
    const client = new Client({ name: "probe", version: "0" }, { capabilities: {} });
    await client.connect(new StreamableHTTPClientTransport(new URL(mcp.url)));
    raw.push((await client.listTools()).tools.map((t) => t.name));
    await client.close();
  }
  assert.notDeepEqual(raw[0], raw[1], "a stub that never reorders proves nothing");
  assert.deepEqual([...raw[0]].sort(), [...raw[1]].sort());

  // What Brain builds each run from such a server.
  const built: string[][] = [];
  for (let i = 0; i < 2; i++) {
    const c = await connectPlatformMcp({ stub: { type: "http", url: mcp.url, token: "t" } });
    built.push(c.schemas.map((s) => s.name));
    await c.closeAll();
  }
  assert.deepEqual(built[0], built[1]);
});

test("sortToolSchemasByName orders by code unit, leaves the input alone", () => {
  const input = [{ name: "mcp__b__x" }, { name: "mcp__a__z" }, { name: "mcp__B__x" }, { name: "mcp__a__y" }];
  const out = sortToolSchemasByName(input);
  assert.deepEqual(out.map((t) => t.name), ["mcp__B__x", "mcp__a__y", "mcp__a__z", "mcp__b__x"]);
  assert.deepEqual(input.map((t) => t.name), ["mcp__b__x", "mcp__a__z", "mcp__B__x", "mcp__a__y"]);
});

test("the first request of the next turn shares its prefix with the last request of the previous one, up to the first breakpoint", async () => {
  // Turn 1: the model calls a tool, then answers. Two requests in one run.
  world.llmBodies.length = 0;
  world.script([{ tool: "mcp__stub__alpha", input: {} }, { text: "first answer" }, { text: "second answer" }]);
  const prompt1 = "what does alpha say?";
  await new AgentEngine().execute(
    baseRequest({ mcp_servers: mcpServers, history: [{ role: "user", content: prompt1 }], prompt: prompt1 }),
    (async () => {}) as never, undefined, null, noSandbox as never,
  );
  assert.equal(world.llmBodies.length, 2, "turn 1 is a tool call and an answer");

  // Turn 2 as the API replays it: the stored user turn, the assistant turn with
  // its tool call, the tool result, then the new prompt.
  const prompt2 = "and what about bravo?";
  const history = [
    { role: "user", content: prompt1 },
    { role: "assistant", content: [
      { type: "text", text: "first answer" },
      { type: "tool_use", id: "tu0", name: "mcp__stub__alpha", input: {} },
    ] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "tu0", content: "tool result" }] },
    { role: "user", content: prompt2 },
  ];
  await new AgentEngine().execute(
    baseRequest({ mcp_servers: mcpServers, history, prompt: prompt2 }),
    (async () => {}) as never, undefined, null, noSandbox as never,
  );
  assert.equal(world.llmBodies.length, 3);

  const lastOfTurn1 = JSON.parse(world.llmBodies[1]) as Body;
  const firstOfTurn2 = JSON.parse(world.llmBodies[2]) as Body;
  const prev = rendered(lastOfTurn1);
  const next = rendered(firstOfTurn2);

  const toolCount = (firstOfTurn2.tools ?? []).filter((t) => t.name.startsWith("mcp__stub__")).length;
  assert.equal(toolCount, TOOL_NAMES.length, "every stub tool reached the request");
  assert.ok(next.markers.length > 0, "the request carries a breakpoint");

  // The first breakpoint is the anchor: it ends the stable prefix, tools included.
  const anchor = next.markers[0];
  assert.ok(anchor >= (firstOfTurn2.tools ?? []).length, "the anchor sits behind every tool definition");

  // The first block that differs must come after it, or the entry written at the
  // anchor can never be read back.
  const shared = commonPrefixLength(prev.blocks, next.blocks);
  assert.ok(
    shared > anchor,
    `first differing block is #${shared} (${(prev.blocks[shared] ?? "").slice(0, 70)} vs ${(next.blocks[shared] ?? "").slice(0, 70)}), `
      + `before the first breakpoint at #${anchor}`,
  );

  // Said directly as well: the same tools, in the same order, both times.
  const names = (b: Body) => (b.tools ?? []).map((t) => t.name);
  assert.deepEqual(names(firstOfTurn2), names(lastOfTurn1));
  const stubNames = names(firstOfTurn2).filter((n) => n.startsWith("mcp__stub__"));
  assert.deepEqual(stubNames, [...stubNames].sort());
});
