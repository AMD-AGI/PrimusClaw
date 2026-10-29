// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A Hands stand-in that speaks the real protocol (Streamable HTTP MCP, JSON replies,
 * a bearer token) and runs the `bash` tool for real, on this machine. What it does
 * not do is anything else Hands does; what it keeps is every command it was sent,
 * so a test can say what the API asked a sandbox to run.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { spawnSync } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

export interface HandsBashStub {
  /** `http://127.0.0.1:<port>/mcp`, the address a registry entry would hold. */
  url: string;
  token: string;
  /** Every command the `bash` tool was asked to run, with the timeout it was given. */
  commands: Array<{ command: string; timeout: number | undefined }>;
  /** Headers of every request that reached the server. */
  headers: http.IncomingHttpHeaders[];
  /** How many requests were refused for a missing or wrong token. */
  refused: number;
  close(): Promise<void>;
}

export async function startHandsBashStub(opts: { token: string; env: Record<string, string> }): Promise<HandsBashStub> {
  const stub: HandsBashStub = { url: "", token: opts.token, commands: [], headers: [], refused: 0, close: async () => {} };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      stub.headers.push({ ...req.headers });
      if ((req.headers.authorization ?? "") !== `Bearer ${opts.token}`) {
        stub.refused++;
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      if (req.method !== "POST") { res.writeHead(405).end(); return; }
      const mcp = new McpServer({ name: "hands", version: "1.0.0" });
      mcp.tool("bash", "run a command", { command: z.string(), timeout: z.number().optional() }, async (args: { command: string; timeout?: number }) => {
        stub.commands.push({ command: args.command, timeout: args.timeout });
        const r = spawnSync("bash", ["-c", args.command], { encoding: "utf8", env: opts.env, timeout: (args.timeout ?? 100) * 1000, maxBuffer: 64 * 1024 * 1024 });
        if (r.status === 0) return { content: [{ type: "text" as const, text: r.stdout }] };
        return { content: [{ type: "text" as const, text: `exit ${r.status}\nstdout: ${r.stdout}\nstderr: ${r.stderr}` }], isError: true };
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined as never, enableJsonResponse: true });
      await mcp.connect(transport);
      let body: unknown;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "null"); } catch { body = undefined; }
      await transport.handleRequest(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  stub.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  stub.close = () => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); });
  return stub;
}
