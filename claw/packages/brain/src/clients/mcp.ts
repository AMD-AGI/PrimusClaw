// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { ToolSchema } from "@claw/protocol";
import pino from "pino";

const logger = pino({ name: "mcp-clients" });

interface McpClientWrapper {
  callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
  listTools: () => Promise<ToolSchema[]>;
  close: () => Promise<void>;
}

/**
 * Connect to a remote MCP server and return a client wrapper.
 * Supports "http" (StreamableHTTP) and "sse" (SSE) transport types.
 *
 * Fallback: some SaFE-registered servers advertise type="http" but the
 * upstream only accepts SSE (returns 405 on POST). If the initial
 * StreamableHTTP connect fails with a 405-like error, retry once using SSE
 * before giving up.
 */
async function connectMcpServer(name: string, spec: Record<string, unknown>): Promise<McpClientWrapper> {
  const url = spec.url as string;
  const type = (spec.type as string) || "http";
  const token = (spec.token as string) || (spec.api_key as string) || "";
  if (!token) {
    logger.error({ name, url }, "auth_failed_missing_internal_token");
    throw new Error("auth_failed_missing_internal_token");
  }

  const requestTimeoutMs = 10 * 60 * 1000; // 10 min for long-running tools like benchmark
  const headers: Record<string, string> = {};
  headers.Authorization = `Bearer ${token}`;
  if (spec.headers && typeof spec.headers === "object") {
    Object.assign(headers, spec.headers);
  }

  const makeClient = () => new Client(
    { name: `brain-mcp-${name}`, version: "1.0.0" },
    { capabilities: {}, requestTimeoutMs } as any,
  );

  const tryConnect = async (kind: "sse" | "streamable-http") => {
    const c = makeClient();
    const transport = kind === "sse"
      ? new SSEClientTransport(new URL(url), { requestInit: { headers } })
      : new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } });
    await c.connect(transport);
    return c;
  };

  let client: Client;
  let effectiveType: string;
  if (type === "sse") {
    client = await tryConnect("sse");
    effectiveType = "sse";
  } else {
    try {
      client = await tryConnect("streamable-http");
      effectiveType = "streamable-http";
    } catch (err) {
      // 405 / "Method Not Allowed" → upstream only supports SSE GET. Retry.
      const msg = String((err as Error)?.message || err);
      const is405 = msg.includes("405") || /method\s+not\s+allowed/i.test(msg);
      if (!is405) {
        logger.warn({ name, url, type, err: msg }, "mcp_client.streamable_http_failed");
        throw err;
      }
      logger.warn({ name, url, err: msg }, "mcp_client.streamable_http_405_fallback_sse");
      client = await tryConnect("sse");
      effectiveType = "sse-fallback";
    }
  }

  logger.info({ name, url, type: effectiveType }, "mcp_client.connected");

  return {
    async callTool(toolName: string, args: Record<string, unknown>): Promise<string> {
      const result = await client.callTool({ name: toolName, arguments: args });
      const texts = (result.content as Array<{ type: string; text?: string }>)
        ?.filter((c) => c.type === "text" && c.text)
        .map((c) => c.text!)
        .join("\n");
      return texts || "";
    },
    async listTools(): Promise<ToolSchema[]> {
      const result = await client.listTools();
      return result.tools.map((t) => ({
        name: `mcp__${name}__${t.name}`,
        description: t.description || `[${name}] ${t.name}`,
        input_schema: (t.inputSchema as Record<string, unknown>) || { type: "object", properties: {} },
      }));
    },
    async close() {
      try { await client.close(); } catch { /* ignore */ }
    },
  };
}

/**
 * Put tool schemas in a fixed order: by name, code unit by code unit.
 *
 * The tool list is the first thing in the rendered prompt (tools, then system,
 * then messages), so a prompt-cache entry only survives while it is byte for
 * byte the same. A server may answer `tools/list` in a different order every
 * time -- one registered from a hash map does -- and the list is built once
 * per run, so the order is stable inside a turn and different on the next one:
 * the entry written by the last call of one turn can never be read by the
 * first call of the next, and the whole prefix is written again.
 *
 * Plain `<`, not `localeCompare`: the result must not depend on the ICU data
 * or the locale of the pod that happens to run the turn.
 */
export function sortToolSchemasByName<T extends { name: string }>(tools: readonly T[]): T[] {
  return [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Connect to all MCP servers from resolved configs.
 * Returns a Map for ToolRouter and combined tool schemas for LLM.
 *
 * `schemas` is sorted by name (see sortToolSchemasByName), across servers, so
 * neither a server's own listing order nor the order the servers were
 * configured in reaches the request.
 */
export async function connectPlatformMcp(
  servers: Record<string, Record<string, unknown>>,
): Promise<{
  clients: Map<string, { callTool: (name: string, args: Record<string, unknown>) => Promise<string> }>;
  schemas: ToolSchema[];
  closeAll: () => Promise<void>;
}> {
  const clients = new Map<string, { callTool: (name: string, args: Record<string, unknown>) => Promise<string> }>();
  const schemas: ToolSchema[] = [];
  const wrappers: McpClientWrapper[] = [];

  for (const [name, spec] of Object.entries(servers)) {
    try {
      const wrapper = await connectMcpServer(name, spec);
      wrappers.push(wrapper);
      clients.set(name, wrapper);
      const tools = await wrapper.listTools();
      schemas.push(...tools);
      logger.info({ name, toolCount: tools.length }, "mcp_client.tools_loaded");
    } catch (err) {
      // Log URL + type so operators can diagnose 4xx / DNS / TLS without
      // cross-referencing SaFE Tools API responses.
      logger.warn({ err, name, url: spec.url, type: spec.type || "http" }, "mcp_client.connect_failed");
    }
  }

  return {
    clients,
    schemas: sortToolSchemasByName(schemas),
    async closeAll() {
      for (const w of wrappers) await w.close();
    },
  };
}
