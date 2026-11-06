// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `enabled_tools` / `disabled_tools` on an MCP server spec (`src/clients/mcp-tool-filter.ts`), through the
 * real client (`connectPlatformMcp`) against a real MCP server over Streamable HTTP:
 *
 *   T1  no field: every tool the server lists is offered, as before
 *   T2  enabled_tools offers only the names and prefixes it lists, and a call to any other tool is refused
 *       before it reaches the server
 *   T3  disabled_tools removes tools, and wins over enabled_tools; a bare `*` is every tool
 *   T4  a field that cannot be read keeps the server out of the run, reported as unavailable with the reason
 *   T5  camelCase spellings are read, and when both spellings are present a tool must pass both
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { connectPlatformMcp, mcpUnavailableNote } from "../src/clients/mcp.js";
import { mcpToolFilter } from "../src/clients/mcp-tool-filter.js";

const TOOLS = ["get_status", "get_pods", "apply_delete", "apply_scale", "whoami"];

async function serve(): Promise<{ url: string; calls: string[]; close: () => Promise<void> }> {
  const calls: string[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    const mcp = new McpServer({ name: "fixture", version: "1.0.0" });
    for (const name of TOOLS) {
      mcp.tool(name, `the ${name} tool`, async () => {
        calls.push(name);
        return { content: [{ type: "text", text: `ran ${name}` }] };
      });
    }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined as never });
    res.on("close", () => { void transport.close(); void mcp.close(); });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/mcp`, calls, close: () => new Promise((r) => server.close(() => r())) };
}

/** The bare tool names a spec offers, and the result to close. */
async function offered(extra: Record<string, unknown>, url: string) {
  const mcp = await connectPlatformMcp({ ops: { type: "http", url, token: "t", ...extra } });
  return { mcp, names: mcp.schemas.map((s) => s.name.replace(/^mcp__ops__/, "")) };
}

test("T1 no field: every tool the server lists is offered", async () => {
  const s = await serve();
  const { mcp, names } = await offered({}, s.url);
  try {
    assert.deepEqual(names, [...TOOLS].sort());
    assert.equal(await mcp.clients.get("ops")!.callTool("apply_delete", {}), "ran apply_delete");
  } finally { await mcp.closeAll(); await s.close(); }
});

test("T2 enabled_tools offers only what it lists, and refuses a call to anything else", async () => {
  const s = await serve();
  const { mcp, names } = await offered({ enabled_tools: ["get_*", "whoami", "no_such_tool"] }, s.url);
  try {
    assert.deepEqual(names, ["get_pods", "get_status", "whoami"]);
    assert.deepEqual(mcp.failed, []);
    assert.equal(await mcp.clients.get("ops")!.callTool("get_pods", {}), "ran get_pods");
    await assert.rejects(mcp.clients.get("ops")!.callTool("apply_delete", {}), /apply_delete is not enabled on MCP server ops/);
    assert.deepEqual(s.calls, ["get_pods"], "the refused call never reached the server");
  } finally { await mcp.closeAll(); await s.close(); }
});

test("T3 disabled_tools removes tools and wins over enabled_tools; a bare * is every tool", async () => {
  const s = await serve();
  try {
    const a = await offered({ disabled_tools: ["apply_*"] }, s.url);
    assert.deepEqual(a.names, ["get_pods", "get_status", "whoami"]);
    await assert.rejects(a.mcp.clients.get("ops")!.callTool("apply_scale", {}), /not enabled/);
    await a.mcp.closeAll();

    const b = await offered({ enabled_tools: ["*"], disabled_tools: ["apply_delete", "whoami"] }, s.url);
    assert.deepEqual(b.names, ["apply_scale", "get_pods", "get_status"]);
    await b.mcp.closeAll();
    assert.deepEqual(s.calls, []);
  } finally { await s.close(); }
});

test("T4 a field that cannot be read keeps the server out, reported as unavailable", async () => {
  const s = await serve();
  try {
    for (const [field, value] of [
      ["enabled_tools", "get_status"], ["enabled_tools", []], ["disabled_tools", ["apply_delete", ""]],
      ["disabled_tools", null], ["enabledTools", [42]],
    ] as const) {
      const { mcp, names } = await offered({ [field]: value }, s.url);
      try {
        assert.deepEqual(names, [], `${field}=${JSON.stringify(value)} offered tools`);
        assert.equal(mcp.clients.has("ops"), false);
        assert.equal(mcp.failed.length, 1);
        assert.equal(mcp.failed[0]!.name, "ops");
        assert.match(mcp.failed[0]!.reason, new RegExp(`${field} setting cannot be read`));
        assert.match(mcpUnavailableNote(mcp.failed), /MCP server\(s\) ops \(its .* setting cannot be read/);
      } finally { await mcp.closeAll(); }
    }
  } finally { await s.close(); }
});

test("T5 camelCase spellings are read, and both spellings must pass", () => {
  const camel = mcpToolFilter({ enabledTools: ["get_*"] });
  assert.ok(camel && !("invalid" in camel));
  assert.equal(camel.allows("get_pods"), true);
  assert.equal(camel.allows("whoami"), false);

  const both = mcpToolFilter({ enabled_tools: ["get_*", "whoami"], enabledTools: ["get_status", "whoami"], disabledTools: ["whoami"] });
  assert.ok(both && !("invalid" in both));
  assert.deepEqual(TOOLS.filter((t) => both.allows(t)), ["get_status"]);

  assert.equal(mcpToolFilter({ url: "x" }), null, "no field is no filter");
  assert.equal(mcpToolFilter(undefined), null);
});
