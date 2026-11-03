// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ToolSchema } from "@claw/protocol";
import { isIP } from "node:net";
import { redactSecrets } from "@claw/utils";
import pino from "pino";
import { Agent, fetch as undiciFetch } from "undici";

const logger = pino({ name: "mcp-clients" });

interface McpClientWrapper {
  callTool: (name: string, args: Record<string, unknown>) => Promise<string>;
  listTools: () => Promise<ToolSchema[]>;
  close: () => Promise<void>;
}

/**
 * A fetch that connects only to the address the API vetted for this server.
 *
 * The API checks where a requester's own MCP server resolves and records the
 * answer on the spec as `pinned_address`; a name that resolved somewhere public
 * then, and somewhere inside the cluster now, would otherwise pass. The host
 * name still goes out as SNI and Host, so TLS is checked against it. (The
 * SDK follows a redirect only within the same origin, which this pins too.) Specs
 * without the field (the operator's, and those the API adds itself) connect
 * normally.
 */
export function pinnedFetch(pin: unknown): FetchLike | undefined {
  if (!pin || typeof pin !== "object") return undefined;
  const { address, family } = pin as { address?: unknown; family?: unknown };
  if (typeof address !== "string" || !isIP(address) || (family !== 4 && family !== 6)) {
    throw new Error("mcp_pinned_address_invalid");
  }
  const dispatcher = new Agent({
    connect: {
      lookup: (_host, opts, cb) => {
        if ((opts as { all?: boolean }).all) (cb as (e: null, a: Array<{ address: string; family: number }>) => void)(null, [{ address, family }]);
        else cb(null, address, family);
      },
    },
  });
  return (url, init) => undiciFetch(url, { ...(init as object), dispatcher }) as unknown as Promise<Response>;
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

  const fetch = pinnedFetch(spec.pinned_address);
  const tryConnect = async (kind: "sse" | "streamable-http") => {
    const c = makeClient();
    const opts = { requestInit: { headers }, ...(fetch ? { fetch } : {}) };
    const transport = kind === "sse"
      ? new SSEClientTransport(new URL(url), opts)
      : new StreamableHTTPClientTransport(new URL(url), opts);
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
      return mcpContentText(result.content);
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
 * The text of an MCP tool result.
 *
 * Only text reaches the model. A block of any other kind (an image, audio, a
 * resource) is named in a line rather than dropped, so a tool that answered
 * with a screenshot does not read as a tool that answered nothing.
 */
export function mcpContentText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return (content as Array<{ type?: string; text?: string; mimeType?: string }>)
    .map((c) => c?.type === "text"
      ? (c.text ?? "")
      : `[${c?.type ?? "unknown"} content omitted${c?.mimeType ? ` (${c.mimeType})` : ""}: this tool result can only be shown as text]`)
    .filter(Boolean)
    .join("\n");
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

export interface McpConnectFailure { name: string; reason: string }

const FAILURE_REASON_MAX_CHARS = 200;

/** A failure's message, short and without anything token-shaped, fit to show the model and the user. */
function connectFailureReason(err: unknown): string {
  const text = redactSecrets(String((err as Error)?.message ?? err).replace(/\s+/g, " ").trim()).text || "unknown error";
  return text.length > FAILURE_REASON_MAX_CHARS ? `${text.slice(0, FAILURE_REASON_MAX_CHARS)}...` : text;
}

/**
 * The line the model is given about servers that did not connect, or "" when all did.
 *
 * Without it a server that is down is indistinguishable from one that was never
 * configured: the model is simply not offered its tools, and tells the user it
 * has no way to do what they asked instead of saying the service is unreachable.
 */
export function mcpUnavailableNote(failed: readonly McpConnectFailure[]): string {
  if (!failed.length) return "";
  const list = failed.map((f) => `${f.name} (${f.reason})`).join("; ");
  return `[Unavailable this turn: MCP server(s) ${list}. Their tools are not offered. If the request needs one, tell the user that service is unreachable right now rather than that you lack the capability.]`;
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
  /** Servers that could not be connected or listed, with why; their tools are not offered. */
  failed: McpConnectFailure[];
  closeAll: () => Promise<void>;
}> {
  const clients = new Map<string, { callTool: (name: string, args: Record<string, unknown>) => Promise<string> }>();
  const schemas: ToolSchema[] = [];
  const wrappers: McpClientWrapper[] = [];
  const failed: McpConnectFailure[] = [];

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
      clients.delete(name);
      failed.push({ name, reason: connectFailureReason(err) });
    }
  }

  return {
    clients,
    schemas: sortToolSchemasByName(schemas),
    failed,
    async closeAll() {
      for (const w of wrappers) await w.close();
    },
  };
}
