// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A real MCP server over Streamable HTTP that counts what the MCP pool tests ask about: how many connections were opened
 * (`initialize`), how many listings, how many initializes were in flight at once, and, for each tool call, the session it came
 * on and the credential it carried.
 *
 * `stateful`: each `initialize` gets a session of its own (`mcp-session-id`), as a server that keeps one per client does, and
 * `dropSessions()` forgets them all, as a restarted server would. Otherwise every request is served by a fresh server (the SDK's
 * stateless pattern). `initDelayMs` holds every `initialize` that long before it is answered.
 */
import http from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export interface CountingServer {
  url: string;
  /** Every request, refused ones included. */
  requests: number;
  /** GET requests: a standalone stream a client holds open. */
  gets: number;
  initializes: number;
  listings: number;
  maxInitInFlight: number;
  /** One per tool call: the session it arrived on ("" when stateless) and its Authorization header. */
  calls: Array<{ tool: string; session: string; auth: string }>;
  initDelayMs: number;
  /** Hold every `tools/list` this long. */
  listDelayMs: number;
  /** Answer every request 401 while set. */
  refuse: boolean;
  dropSessions(): void;
  close(): Promise<void>;
}

export async function startCountingServer(opts: { stateful?: boolean; initDelayMs?: number; tools?: string[] } = {}): Promise<CountingServer> {
  const tools = opts.tools ?? ["echo"];
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  let initInFlight = 0;
  const s: CountingServer = {
    url: "", requests: 0, gets: 0, initializes: 0, listings: 0, maxInitInFlight: 0, calls: [], initDelayMs: opts.initDelayMs ?? 0, listDelayMs: 0, refuse: false,
    dropSessions: () => { for (const t of sessions.values()) void t.close(); sessions.clear(); },
    close: async () => { s.dropSessions(); await new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections(); }); },
  };
  const build = () => {
    const mcp = new McpServer({ name: "counting", version: "1.0.0" });
    for (const name of tools) {
      mcp.tool(name, `the ${name} tool`, async (extra) => {
        const headers = (extra.requestInfo?.headers ?? {}) as Record<string, string | string[] | undefined>;
        s.calls.push({ tool: name, session: extra.sessionId ?? "", auth: String(headers.authorization ?? "") });
        return { content: [{ type: "text" as const, text: `ran ${name}` }] };
      });
    }
    return mcp;
  };
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    s.requests++;
    if (req.method === "GET") s.gets++;
    if (s.refuse) { res.writeHead(401, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "unauthorized" })); return; }
    const method = (body as { method?: string } | undefined)?.method;
    if (method === "tools/list") {
      s.listings++;
      if (s.listDelayMs) await new Promise((r) => setTimeout(r, s.listDelayMs));
    }
    if (method === "initialize") {
      s.initializes++;
      initInFlight++;
      s.maxInitInFlight = Math.max(s.maxInitInFlight, initInFlight);
      if (s.initDelayMs) await new Promise((r) => setTimeout(r, s.initDelayMs));
      initInFlight--;
    }
    if (!opts.stateful) {
      const mcp = build();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined as never });
      res.on("close", () => { void transport.close(); void mcp.close(); });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }
    const sid = req.headers["mcp-session-id"];
    if (typeof sid === "string") {
      const t = sessions.get(sid);
      if (!t) { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null })); return; }
      await t.handleRequest(req, res, body);
      return;
    }
    if (method !== "initialize") { res.writeHead(400); res.end(); return; }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => { sessions.set(id, transport); },
    });
    await build().connect(transport);
    await transport.handleRequest(req, res, body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  s.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  return s;
}
