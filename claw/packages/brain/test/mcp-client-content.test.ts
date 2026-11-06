// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the model reads of an MCP server, through the real client (`connectPlatformMcp`) against real MCP
 * servers over Streamable HTTP: every content block of a tool result, not only its text, and a server's
 * resources through `list_resources` / `read_resource`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { connectPlatformMcp, renderMcpContent } from "../src/clients/mcp.js";

const PNG = Buffer.from("not really a png, twelve+").toString("base64");

function buildServer(opts: { resources: boolean; ownReadResource?: boolean }): McpServer {
  const mcp = new McpServer({ name: "fixture", version: "1.0.0" });
  mcp.tool("mixed", "every kind of block", async () => ({
    content: [
      { type: "text", text: "before" },
      { type: "image", data: PNG, mimeType: "image/png" },
      { type: "resource", resource: { uri: "file:///notes.md", mimeType: "text/markdown", text: "# notes body" } },
      { type: "resource", resource: { uri: "file:///blob.bin", mimeType: "application/octet-stream", blob: PNG } },
      { type: "resource_link", uri: "file:///big.log", name: "big.log", mimeType: "text/plain" },
      { type: "text", text: "after" },
    ],
  }) as never);
  mcp.tool("only_image", "an image and nothing else", async () => ({
    content: [{ type: "image", data: PNG, mimeType: "image/png" }],
  }) as never);
  if (opts.ownReadResource) {
    mcp.tool("read_resource", "the server's own tool of that name", async () => ({ content: [{ type: "text", text: "own tool" }] }));
  }
  if (opts.resources) {
    mcp.resource("readme", "file:///readme.md", { description: "the readme", mimeType: "text/markdown" }, async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: "# readme body" }],
    }));
  }
  return mcp;
}

async function serve(opts: { resources: boolean; ownReadResource?: boolean }): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    const mcp = buildServer(opts);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined as never });
    res.on("close", () => { void transport.close(); void mcp.close(); });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/mcp`, close: () => new Promise((r) => server.close(() => r())) };
}

test("a tool result keeps every block: text in order, the rest as a line that says what it was", async () => {
  const s = await serve({ resources: false });
  const mcp = await connectPlatformMcp({ fx: { type: "http", url: s.url, token: "t" } });
  try {
    const out = await mcp.clients.get("fx")!.callTool("mixed", {});
    const lines = out.split("\n");
    assert.equal(lines[0], "before");
    assert.match(lines[1], /^\[image \(image\/png, 25 bytes\): not shown/);
    assert.equal(lines[2], "[resource file:///notes.md]");
    assert.equal(lines[3], "# notes body");
    assert.match(lines[4], /^\[resource file:\/\/\/blob\.bin \(application\/octet-stream, 25 bytes\): binary content, not shown\]$/);
    assert.equal(lines[5], '[resource link file:///big.log "big.log" (text/plain)]');
    assert.equal(lines[6], "after");
    const only = await mcp.clients.get("fx")!.callTool("only_image", {});
    assert.notEqual(only, "", "a result with no text block is not an empty answer");
    assert.match(only, /^\[image \(image\/png/);
  } finally {
    await mcp.closeAll();
    await s.close();
  }
});

test("a server with resources is offered list_resources and read_resource under its own prefix, and they reach it", async () => {
  const s = await serve({ resources: true });
  const mcp = await connectPlatformMcp({ fx: { type: "http", url: s.url, token: "t" } });
  try {
    const names = mcp.schemas.map((t) => t.name);
    assert.ok(names.includes("mcp__fx__list_resources"));
    assert.ok(names.includes("mcp__fx__read_resource"));
    const listed = JSON.parse(await mcp.clients.get("fx")!.callTool("list_resources", {}));
    assert.deepEqual(listed.resources, [{ uri: "file:///readme.md", name: "readme", description: "the readme", mimeType: "text/markdown" }]);
    const read = await mcp.clients.get("fx")!.callTool("read_resource", { uri: "file:///readme.md" });
    assert.equal(read, "[resource file:///readme.md]\n# readme body");
    await assert.rejects(mcp.clients.get("fx")!.callTool("read_resource", {}), /needs a uri/);
  } finally {
    await mcp.closeAll();
    await s.close();
  }
});

test("no resources capability, no resource tools; a server's own tool of the same name stays its own", async () => {
  const plain = await serve({ resources: false });
  const own = await serve({ resources: true, ownReadResource: true });
  const mcp = await connectPlatformMcp({
    plain: { type: "http", url: plain.url, token: "t" },
    own: { type: "http", url: own.url, token: "t" },
  });
  try {
    const names = mcp.schemas.map((t) => t.name);
    assert.ok(!names.includes("mcp__plain__list_resources") && !names.includes("mcp__plain__read_resource"));
    assert.equal(names.filter((n) => n === "mcp__own__read_resource").length, 1, "offered once");
    assert.ok(names.includes("mcp__own__list_resources"));
    assert.equal(await mcp.clients.get("own")!.callTool("read_resource", { uri: "file:///readme.md" }), "own tool");
  } finally {
    await mcp.closeAll();
    await plain.close();
    await own.close();
  }
});

test("renderMcpContent: structuredContent only when there are no blocks; unknown block types are named", () => {
  assert.equal(renderMcpContent([], { a: 1 }), '{"a":1}');
  assert.equal(renderMcpContent([{ type: "text", text: "x" }], { a: 1 }), "x");
  assert.equal(renderMcpContent([{ type: "video" }]), "[video content: not shown]");
  assert.equal(renderMcpContent(undefined), "");
});
