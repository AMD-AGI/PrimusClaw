// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A minimal Streamable-HTTP MCP server behind a stand-in for the sandbox
 * Router's port proxy, generic on purpose: the token header, the path and the
 * port are parameters, and the only method it knows is `initialize`.
 *
 * Like the Router, it refuses a request without `x-session-id`, and with
 * `routerAuth` it also refuses one whose `Authorization` is not the platform
 * key; it then drops `Authorization` before the "application" sees the request,
 * which checks the token header alone.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface StubSeen { method: string; url: string; headers: http.IncomingHttpHeaders; body: string }

export interface McpStub {
  /** `http://127.0.0.1:<port>`: the Router base. */
  base: string;
  seen: StubSeen[];
  close(): Promise<void>;
}

export interface McpStubOptions {
  tokenHeader: string;
  token: string;
  /** The path the application serves, after `/proxy/<port>`. */
  path: string;
  /** Require `Authorization: Bearer <platformKey>` at the Router. */
  routerAuth?: { platformKey: string };
  /** Answer something that is not an initialize result. */
  garbage?: boolean;
}

export async function startMcpStub(opts: McpStubOptions, port = 0): Promise<McpStub> {
  const seen: StubSeen[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: { ...req.headers }, body });
      const send = (status: number, payload: unknown, extra: Record<string, string> = {}) => {
        res.writeHead(status, { "content-type": "application/json", ...extra });
        res.end(JSON.stringify(payload));
      };
      if (!req.headers["x-session-id"]) return send(400, { error: "missing x-session-id" });
      if (opts.routerAuth && req.headers.authorization !== `Bearer ${opts.routerAuth.platformKey}`) return send(401, { error: "router auth" });
      if (!(req.url ?? "").includes("/invocations/proxy/") || !(req.url ?? "").endsWith(opts.path)) return send(404, { error: "no route" });
      // The Router strips Authorization; the application never sees it.
      const supplied = req.headers[opts.tokenHeader.toLowerCase()];
      if (req.method !== "POST") return send(405, { error: "method not allowed" });
      if (supplied !== opts.token) return send(401, { error: "bad token" });
      if (opts.garbage) return send(200, { not: "jsonrpc" });
      let rpc: any;
      try { rpc = JSON.parse(body); } catch { return send(400, { error: "bad json" }); }
      if (rpc.method !== "initialize") return send(200, { jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "method not found" } });
      send(200, {
        jsonrpc: "2.0", id: rpc.id,
        result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "stub", version: "0" } },
      }, { "mcp-session-id": "stub-session" });
    });
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const actual = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${actual}`,
    seen,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }),
  };
}
