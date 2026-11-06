// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ToolSchema } from "@claw/protocol";
import { isIP } from "node:net";
import { CITE_SOURCES_META } from "@claw/protocol";
import { redactSecrets } from "@claw/utils";
import pino from "pino";
import { Agent, fetch as undiciFetch } from "undici";
import { mcpToolFilter } from "./mcp-tool-filter.js";
import { isTransientFetchError, isTransientHttpStatus } from "../infra/transient-http.js";

const logger = pino({ name: "mcp-clients" });

/** A content block of a tool result or a resource read, as the server sent it. */
interface McpContentBlock {
  type?: string;
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
  name?: string;
  blob?: string;
  resource?: McpContentBlock;
}

function base64Bytes(b64: string): number {
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - padding);
}

/** A resource's contents (a `resources/read` entry, or the `resource` of an embedded block). */
function renderResourceContents(r: McpContentBlock): string {
  const uri = r.uri ?? "(no uri)";
  if (typeof r.text === "string") return `[resource ${uri}]\n${r.text}`;
  const size = typeof r.blob === "string" ? `, ${base64Bytes(r.blob)} bytes` : "";
  return `[resource ${uri} (${r.mimeType ?? "binary"}${size}): binary content, not shown]`;
}

/**
 * What the model reads of an MCP result: every block, in order. Text as it is;
 * anything else as one line that says what it was, so an image, an embedded
 * resource or a link is never turned into an empty answer. With no blocks at
 * all, the result's `structuredContent`, if any.
 */
export function renderMcpContent(blocks: unknown, structured?: unknown): string {
  const parts: string[] = [];
  for (const b of Array.isArray(blocks) ? (blocks as McpContentBlock[]) : []) {
    if (!b || typeof b !== "object") continue;
    switch (b.type) {
      case "text":
        if (b.text) parts.push(b.text);
        break;
      case "image":
      case "audio": {
        const size = typeof b.data === "string" ? `, ${base64Bytes(b.data)} bytes` : "";
        parts.push(`[${b.type} (${b.mimeType ?? "unknown type"}${size}): not shown, this result is passed on as text only]`);
        break;
      }
      case "resource":
        parts.push(b.resource && typeof b.resource === "object" ? renderResourceContents(b.resource) : "[resource: empty]");
        break;
      case "resource_link":
        parts.push(`[resource link ${b.uri ?? "(no uri)"}${b.name ? ` "${b.name}"` : ""}${b.mimeType ? ` (${b.mimeType})` : ""}]`);
        break;
      default:
        parts.push(`[${String(b.type ?? "unknown")} content: not shown]`);
    }
  }
  if (parts.length === 0 && structured !== undefined && structured !== null) return JSON.stringify(structured);
  return parts.join("\n");
}

/**
 * The two tools through which the model reaches a server's resources, offered
 * for a server that declares the `resources` capability under the server's own
 * prefix (`mcp__<server>__list_resources`), so a server's `requires_approval` /
 * `auto_approve` name them like any other of its tools. A server that has a tool
 * of the same name keeps its own.
 */
const LIST_RESOURCES = "list_resources";
const READ_RESOURCE = "read_resource";

function resourceToolSchemas(server: string): Array<{ name: string; description: string; input_schema: Record<string, unknown> }> {
  return [
    {
      name: LIST_RESOURCES,
      description: `[${server}] List the resources this server offers (uri, name, description, type). Pass the returned next_cursor to see more.`,
      input_schema: { type: "object", properties: { cursor: { type: "string", description: "next_cursor from the previous page" } } },
    },
    {
      name: READ_RESOURCE,
      description: `[${server}] Read one resource of this server by its uri.`,
      input_schema: { type: "object", properties: { uri: { type: "string" } }, required: ["uri"] },
    },
  ];
}

/**
 * Filled by a call with what the server answered beside its text: whether the result was the tool's own error, and the sources it
 * listed under its result's `_meta["claw/sources"]` (kept only for a server the run trusts for them: `tools/citations.ts`).
 */
export type McpCallOutcome = { isError: boolean; sources?: unknown[] };

/** `meta`: the request's `_meta`, which the server reads beside the arguments and the model never writes (`tools/citations.ts`). */
/** `signal`: the run's abort signal, so a run that has to stop (a lost or self-fenced lock) stops waiting on the call. */
type CallTool = (
  name: string, args: Record<string, unknown>, outcome?: McpCallOutcome, meta?: Record<string, unknown>, signal?: AbortSignal,
) => Promise<string>;

/** A connected server's tools, as a run calls them. */
export type McpToolCaller = { callTool: CallTool };

interface McpClientWrapper {
  callTool: CallTool;
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
/**
 * An MCP failure that says the server was briefly unreachable, not that the
 * call was wrong: the connection was refused or reset, or a proxy answered
 * 502/503/504 (the SDK's HTTP errors carry the status as a numeric `code`).
 * This is what an API pod swap looks like to a run that is mid-tool-call.
 */
export function isTransientMcpError(err: unknown): boolean {
  if (isTransientFetchError(err)) return true;
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "number" && isTransientHttpStatus(code);
}

/**
 * Waits before re-sending a call that is safe to repeat. The servers Claw runs
 * itself are stateless over streamable HTTP (no session survives a pod swap or
 * needs to), so a repeat is a new, complete request to whichever replica the
 * Service now routes to.
 */
export const MCP_TRANSIENT_DELAYS_MS: readonly number[] = [500, 1_500, 3_000];

async function retryTransientMcp<T>(
  what: string,
  name: string,
  call: () => Promise<T>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (err) {
      if (attempt >= MCP_TRANSIENT_DELAYS_MS.length || !isTransientMcpError(err)) throw err;
      logger.warn({ name, what, attempt: attempt + 1, err: String((err as Error)?.message ?? err) }, "mcp_client.transient_retry");
      await sleep(MCP_TRANSIENT_DELAYS_MS[attempt]!);
    }
  }
}

/** Test seam: the retry policy over a stand-in call, with the sleeps it would take. */
export const __mcpRetryForTest = retryTransientMcp;

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

  // Filled by listTools: the resource tools this server is offered (none for a
  // server without resources, or whose own tools have those names).
  const resourceTools = new Set<string>();
  // Filled by listTools: the tools the server itself declares read-only
  // (`annotations.readOnlyHint`). Only these, and the resource reads, are
  // re-sent after a transient failure. Anything else may have done its work
  // before the connection dropped, and sending it again could do it twice; it
  // fails to the model as before, which can see what happened and decide.
  const readOnlyTools = new Set<string>();

  return {
    async callTool(
      toolName: string, args: Record<string, unknown>, outcome?: McpCallOutcome, meta?: Record<string, unknown>,
      signal?: AbortSignal,
    ): Promise<string> {
      if (resourceTools.has(toolName)) {
        if (toolName === LIST_RESOURCES) {
          const cursor = typeof args.cursor === "string" && args.cursor ? args.cursor : undefined;
          const page = await retryTransientMcp(toolName, name, () => client.listResources(cursor ? { cursor } : {}));
          return JSON.stringify({
            resources: page.resources.map((r) => ({ uri: r.uri, name: r.name, description: r.description, mimeType: r.mimeType })),
            ...(page.nextCursor ? { next_cursor: page.nextCursor } : {}),
          });
        }
        if (typeof args.uri !== "string" || !args.uri) throw new Error("read_resource needs a uri");
        const uri = args.uri;
        const read = await retryTransientMcp(toolName, name, () => client.readResource({ uri }));
        return read.contents.map((c) => renderResourceContents(c as McpContentBlock)).join("\n");
      }
      const send = () => client.callTool(
        { name: toolName, arguments: args, ...(meta ? { _meta: meta } : {}) },
        undefined,
        signal ? { signal } : undefined,
      );
      const result = readOnlyTools.has(toolName) ? await retryTransientMcp(toolName, name, send) : await send();
      // The tool's own error bit (`isError`), which its text alone cannot carry: what it answered is a failure, not data it read.
      if (outcome && result.isError === true) outcome.isError = true;
      const sources = (result._meta as Record<string, unknown> | undefined)?.[CITE_SOURCES_META];
      if (outcome && Array.isArray(sources)) outcome.sources = sources;
      return renderMcpContent(result.content, result.structuredContent);
    },
    async listTools(): Promise<ToolSchema[]> {
      const result = await retryTransientMcp("tools/list", name, () => client.listTools());
      const own = new Set(result.tools.map((t) => t.name));
      readOnlyTools.clear();
      for (const t of result.tools) if (t.annotations?.readOnlyHint === true) readOnlyTools.add(t.name);
      const tools = result.tools.map((t) => ({
        name: t.name,
        description: t.description || `[${name}] ${t.name}`,
        input_schema: (t.inputSchema as Record<string, unknown>) || { type: "object", properties: {} },
      }));
      resourceTools.clear();
      if (client.getServerCapabilities()?.resources) {
        for (const t of resourceToolSchemas(name)) {
          if (own.has(t.name)) continue;
          resourceTools.add(t.name);
          tools.push(t);
        }
      }
      return tools.map((t) => ({ ...t, name: `mcp__${name}__${t.name}` }));
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
  clients: Map<string, McpToolCaller>;
  schemas: ToolSchema[];
  /** Servers that could not be connected or listed, with why; their tools are not offered. */
  failed: McpConnectFailure[];
  closeAll: () => Promise<void>;
}> {
  const clients = new Map<string, McpToolCaller>();
  const schemas: ToolSchema[] = [];
  const wrappers: McpClientWrapper[] = [];
  const failed: McpConnectFailure[] = [];

  for (const [name, spec] of Object.entries(servers)) {
    // `enabled_tools` / `disabled_tools` (mcp-tool-filter.ts): read before connecting, so a
    // field nobody can read keeps the server out of the run, said as unavailable.
    const filter = mcpToolFilter(spec);
    if (filter && "invalid" in filter) {
      logger.warn({ name, field: filter.invalid }, "mcp_client.tool_filter_invalid_server_skipped");
      failed.push({ name, reason: `its ${filter.invalid} setting cannot be read (expected a non-empty list of tool names)` });
      continue;
    }
    try {
      // Connecting is safe to repeat: it opens a client and lists tools, and a
      // server that was mid-swap when this run started is otherwise dropped
      // from the run for its whole life.
      const wrapper = await retryTransientMcp("connect", name, () => connectMcpServer(name, spec));
      wrappers.push(wrapper);
      const listed = await wrapper.listTools();
      const prefix = `mcp__${name}__`;
      const tools = filter ? listed.filter((t) => filter.allows(t.name.slice(prefix.length))) : listed;
      if (filter) {
        const own = new Set(listed.map((t) => t.name.slice(prefix.length)));
        const unknown = filter.exactNames.filter((n) => !own.has(n));
        // A name the server does not list is most likely a typo or a renamed tool: say it to the operator.
        if (unknown.length) logger.warn({ name, unknown }, "mcp_client.tool_filter_names_unknown");
      }
      clients.set(name, filter
        ? {
            callTool: (toolName, args, outcome, meta, signal) => filter.allows(toolName)
              ? wrapper.callTool(toolName, args, outcome, meta, signal)
              : Promise.reject(new Error(`Tool ${toolName} is not enabled on MCP server ${name}`)),
          }
        : wrapper);
      schemas.push(...tools);
      logger.info({ name, toolCount: tools.length, ...(filter ? { listedCount: listed.length } : {}) }, "mcp_client.tools_loaded");
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
