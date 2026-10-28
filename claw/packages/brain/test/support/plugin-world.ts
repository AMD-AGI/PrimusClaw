// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Edges for engine-level plugin tests, next to platform-defaults-world.ts: an
 * S3-compatible object store holding the plugin's skills and hooks, and a real
 * MCP server (Streamable HTTP) whose tool Brain calls in-process. Env is set
 * before the test imports the engine, because config.ts reads it once.
 */
import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export interface PluginWorld {
  /** Put an object into the plugins bucket (replaces it: a changed body gets a new ETag, as a real store does). */
  put(key: string, body: string): void;
  /** What the object store was asked for since the last `resetCounts()`: listings, and object reads by key. */
  counts: { lists: number; gets: string[] };
  resetCounts(): void;
  /** Delete an object from the plugins bucket. */
  remove(key: string): void;
  /** While true, listings answer 500 (object reads still work). */
  failListings: boolean;
  /** While true, listings carry no ETag, as a store that does not report one. */
  omitEtags: boolean;
  /** Every MCP tool call the server answered, by tool name. */
  mcpCalls: string[];
  mcpUrl: string;
  close(): Promise<void>;
}

export async function startPluginWorld(): Promise<PluginWorld> {
  const objects = new Map<string, string>();
  const counts = { lists: 0, gets: [] as string[] };
  const state = { failListings: false, omitEtags: false };
  const etag = (body: string) => `"${createHash("md5").update(body).digest("hex")}"`;
  const s3 = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const rest = decodeURIComponent(url.pathname).replace(/^\/plugins\/?/, "");
    if (url.searchParams.get("list-type") === "2") {
      counts.lists++;
      if (state.failListings) { res.statusCode = 500; res.end(); return; }
      const prefix = url.searchParams.get("prefix") ?? "";
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix));
      res.setHeader("content-type", "application/xml");
      res.end(
        `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">`
        + `<Name>plugins</Name><KeyCount>${keys.length}</KeyCount><MaxKeys>1000</MaxKeys>`
        + `<IsTruncated>false</IsTruncated>${keys.map((k) => {
          const body = objects.get(k)!;
          const tag = state.omitEtags ? "" : `<ETag>${etag(body).replaceAll('"', "&quot;")}</ETag>`;
          return `<Contents><Key>${k}</Key>${tag}<Size>${Buffer.byteLength(body)}</Size></Contents>`;
        }).join("")}</ListBucketResult>`,
      );
      return;
    }
    const body = objects.get(rest);
    if (body === undefined) { res.statusCode = 404; res.end(); return; }
    counts.gets.push(rest);
    res.setHeader("content-type", "application/octet-stream");
    res.setHeader("etag", etag(body));
    res.end(body);
  });

  const mcpCalls: string[] = [];
  const mcp = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", async () => {
      // Stateless: one server + transport per request, the SDK's own pattern.
      const server = new McpServer({ name: "board", version: "1.0.0" });
      server.tool("ping", "answers pong", async () => {
        mcpCalls.push("ping");
        return { content: [{ type: "text" as const, text: "pong" }] };
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => { void transport.close(); void server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, raw ? JSON.parse(raw) : undefined);
    });
  });

  await Promise.all([
    new Promise<void>((r) => s3.listen(0, "127.0.0.1", r)),
    new Promise<void>((r) => mcp.listen(0, "127.0.0.1", r)),
  ]);
  process.env.S3_API_ENDPOINT = `http://127.0.0.1:${(s3.address() as AddressInfo).port}`;
  process.env.S3_ACCESS_KEY = "test";
  process.env.S3_SECRET_KEY = "test";
  process.env.S3_REGION = "us";

  return {
    put: (key, body) => { objects.set(key, body); },
    remove: (key) => { objects.delete(key); },
    counts,
    resetCounts: () => { counts.lists = 0; counts.gets.length = 0; },
    get failListings() { return state.failListings; },
    set failListings(v: boolean) { state.failListings = v; },
    get omitEtags() { return state.omitEtags; },
    set omitEtags(v: boolean) { state.omitEtags = v; },
    mcpCalls,
    mcpUrl: `http://127.0.0.1:${(mcp.address() as AddressInfo).port}/mcp`,
    close: async () => {
      await Promise.all([
        new Promise<void>((r) => s3.close(() => r())),
        new Promise<void>((r) => mcp.close(() => r())),
      ]);
    },
  };
}

/** A `plugin_tools` skill row whose files live under `skills/<name>/` in the bucket. */
export function skillRow(id: number, name: string) {
  return { id, type: "skill", name, config: { s3_key: `skills/${name}/`, is_prefix: true } };
}

export function mcpRow(id: number, url: string) {
  return { id, type: "mcp", name: "board", config: { mcpServers: { board: { type: "http", url, token: "t" } } } };
}

export function hooksRow(id: number, type = "hooks") {
  return { id, type, name: "guard", config: { s3_key: `hooks/h${id}` } };
}

let sessionSeq = 0;
/**
 * A session id no other test process shares. Brain stages a session's plugin
 * files under `<tmp>/claw-plugin-work/<session_id>` and removes that directory
 * when the run ends, so two test files (they run in parallel processes) using
 * the same id delete each other's files mid-download.
 */
export function uniqueSession(): string {
  return `plugin-test-${process.pid}-${++sessionSeq}`;
}
