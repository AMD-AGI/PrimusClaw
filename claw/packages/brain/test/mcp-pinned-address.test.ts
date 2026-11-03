// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A request's own MCP server reaches Brain with the address the API vetted it at (`pinned_address`), and Brain
 * connects only there, against a real MCP server: the host name is not looked up again (a `.invalid` name that
 * resolves nowhere still connects), it still goes out as the Host header, and a redirect, which would leave the
 * pinned address, is refused. A spec without the field connects as before.
 */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { startPluginWorld } from "./support/plugin-world.js";
import { connectPlatformMcp } from "../src/clients/mcp.js";

const pw = await startPluginWorld();
const port = new URL(pw.mcpUrl).port;
const redirector = http.createServer((_req, res) => { res.writeHead(307, { location: pw.mcpUrl }); res.end(); });
await new Promise<void>((r) => redirector.listen(0, "127.0.0.1", r));
const redirectPort = (redirector.address() as AddressInfo).port;
test.after(async () => { await pw.close(); await new Promise<void>((r) => redirector.close(() => r())); });

const PIN = { address: "127.0.0.1", family: 4 };
const rows: Array<{ name: string; spec: Record<string, unknown>; tools: string[]; host?: string }> = [
  { name: "a pinned name is not resolved again", spec: { url: `http://vetted-host.invalid:${port}/mcp`, pinned_address: PIN }, tools: ["ping"], host: `vetted-host.invalid:${port}` },
  { name: "the same name unpinned does not connect", spec: { url: `http://vetted-host.invalid:${port}/mcp` }, tools: [] },
  { name: "a pinned server's redirect is not followed", spec: { url: `http://vetted-host.invalid:${redirectPort}/mcp`, pinned_address: PIN }, tools: [] },
  { name: "a malformed pin does not connect", spec: { url: `http://vetted-host.invalid:${port}/mcp`, pinned_address: { address: "vetted-host.invalid", family: 4 } }, tools: [] },
  { name: "an unpinned spec connects as before", spec: { url: pw.mcpUrl }, tools: ["ping"] },
];

for (const row of rows) {
  test(row.name, async () => {
    pw.mcpHeaders.length = 0;
    const r = await connectPlatformMcp({ s: { type: "http", token: "t", ...row.spec } });
    try {
      assert.deepEqual(r.schemas.map((t) => t.name.replace(/^mcp__s__/, "")), row.tools);
      if (row.host) assert.equal(pw.mcpHeaders[0]?.host, row.host, "the vetted name is still the Host");
    } finally {
      await r.closeAll();
    }
  });
}
