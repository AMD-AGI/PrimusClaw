// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { ToolSchema } from "@claw/protocol";
import { isIP } from "node:net";
import { CITE_SOURCES_META } from "@claw/protocol";
import { redactSecrets } from "@claw/utils";
import pino from "pino";
import { Agent, fetch as undiciFetch } from "undici";
import { mcpToolFilter, type McpToolFilter } from "./mcp-tool-filter.js";
import { isTransientFetchError, isTransientHttpStatus } from "../infra/transient-http.js";
import { McpPoolEntry, type McpConnectionPool } from "./mcp-pool.js";

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
  /** Whether it may be kept open for a later turn (`mcp-pool.ts`). */
  persistent: boolean;
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
 * A Streamable HTTP client's fetch, minus the standalone GET stream the SDK opens after `initialize` for messages the server
 * sends on its own. Brain declares no client capabilities and handles no server notifications, so the stream carries nothing
 * it reads; and it is a request held open for as long as the connection lives, which a connection kept across turns
 * (`mcp-pool.ts`) would hold for every user on every server. The SDK reads a 405 as "this server offers no such stream". A GET
 * that resumes a request's own stream (`last-event-id`) still goes out.
 */
function withoutStandaloneSse(base: FetchLike | undefined): FetchLike {
  const send: FetchLike = base ?? ((url, init) => globalThis.fetch(url, init));
  return (url, init) => {
    if ((init?.method ?? "GET").toUpperCase() === "GET" && !new Headers(init?.headers).has("last-event-id")) {
      return Promise.resolve(new Response(null, { status: 405, statusText: "standalone stream not used" }));
    }
    return send(url, init);
  };
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

/** The SDK's answer to a request that got none within its timeout (`McpError`, code -32001). */
export function isMcpTimeout(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === ErrorCode.RequestTimeout;
}

/**
 * How long one call of a tool that may be repeated (`annotations.idempotentHint`) is waited for before it is sent again. Above every
 * `review_start` the live router made in three days (2026-11-05..07: p50 1.8 s, p99 10.5 s, slowest 19.6 s), below the SDK's 60 s,
 * which is what a lost answer used to cost: the router waited the whole minute and then knew nothing (2026-11-07 07:14Z).
 */
export const IDEMPOTENT_CALL_TIMEOUT_MS = 30_000;
/** Sends after the first, of a repeatable tool whose answer did not come in time: one, so two waits are the most a turn spends. */
export const IDEMPOTENT_TIMEOUT_RESENDS = 1;
/**
 * The one server whose `idempotentHint` Brain acts on: Claw's own assistant API, which the API itself writes into every assistant turn
 * under this name and path, replacing any server of that name a request carried (`role-profile.ts`). Another server's hint changes
 * nothing: its tools keep the SDK's wait and are sent once, since a tool of someone else's that takes 30-60 s by design would otherwise
 * time out and run twice.
 */
export const IDEMPOTENT_TRUSTED_SERVER = { name: "assistant", path: "/v1/internal/assistant-mcp" } as const;

export function trustsIdempotentHint(name: string, url: string): boolean {
  if (name !== IDEMPOTENT_TRUSTED_SERVER.name) return false;
  try {
    return new URL(url).pathname === IDEMPOTENT_TRUSTED_SERVER.path;
  } catch {
    return false;
  }
}

/** Read per call, so a test can shorten the wait. */
export const idempotentCallPolicy = { timeoutMs: IDEMPOTENT_CALL_TIMEOUT_MS, resends: IDEMPOTENT_TIMEOUT_RESENDS };

/**
 * A call the server says it may be sent again (`idempotentHint`: a repeat with the same arguments does nothing the first did not),
 * re-sent when its answer was lost as well as when the server was briefly gone: the repeat's answer is the first call's outcome
 * (`review_start`: the same handoff, or the review it already started). When no answer comes at all, the model is told in words
 * that the outcome is unknown and what it may do, not "Request timed out", which it read as "maybe nothing happened".
 */
async function retryIdempotentMcp<T>(
  what: string,
  name: string,
  call: () => Promise<T>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<T> {
  let resends = 0;
  for (;;) {
    try {
      return await retryTransientMcp(what, name, call, sleep);
    } catch (err) {
      if (!isMcpTimeout(err)) throw err;
      if (resends >= idempotentCallPolicy.resends) {
        throw new Error(
          `${what} gave no answer in ${Math.round((resends + 1) * idempotentCallPolicy.timeoutMs / 1000)}s (asked ${resends + 1} times): `
          + "whether it took effect is not known yet. Calling it again with the same arguments is safe (it never does twice what it did once) "
          + "and answers what happened; if you do not, tell the user in one sentence that their request is still being confirmed, not that it failed.",
        );
      }
      resends += 1;
      logger.warn({ name, what, resends }, "mcp_client.idempotent_resend_after_timeout");
    }
  }
}

/** Test seam: the repeatable tool's policy over a stand-in call. */
export const __mcpIdempotentRetryForTest = retryIdempotentMcp;

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
    const f = kind === "streamable-http" ? withoutStandaloneSse(fetch) : fetch;
    const opts = { requestInit: { headers }, ...(f ? { fetch: f } : {}) };
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
  // An SSE connection is a request held open for as long as the connection lives: it is the run's, not the pool's.
  const persistent = effectiveType === "streamable-http";

  // Filled by listTools: the resource tools this server is offered (none for a
  // server without resources, or whose own tools have those names).
  const resourceTools = new Set<string>();
  // Filled by listTools: the tools the server itself declares read-only
  // (`annotations.readOnlyHint`). Only these, and the resource reads, are
  // re-sent after a transient failure. Anything else may have done its work
  // before the connection dropped, and sending it again could do it twice; it
  // fails to the model as before, which can see what happened and decide.
  const readOnlyTools = new Set<string>();
  // Filled by listTools: the writes the server declares safe to repeat (`annotations.idempotentHint`), re-sent also when their
  // answer did not come in time (`retryIdempotentMcp`).
  const idempotentTools = new Set<string>();

  return {
    persistent,
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
      const repeatable = !readOnlyTools.has(toolName) && idempotentTools.has(toolName);
      const send = () => client.callTool(
        { name: toolName, arguments: args, ...(meta ? { _meta: meta } : {}) },
        undefined,
        signal || repeatable ? { ...(signal ? { signal } : {}), ...(repeatable ? { timeout: idempotentCallPolicy.timeoutMs } : {}) } : undefined,
      );
      const result = readOnlyTools.has(toolName) ? await retryTransientMcp(toolName, name, send)
        : repeatable ? await retryIdempotentMcp(toolName, name, send) : await send();
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
      idempotentTools.clear();
      for (const t of result.tools) {
        if (t.annotations?.readOnlyHint === true) readOnlyTools.add(t.name);
        else if (t.annotations?.idempotentHint === true && trustsIdempotentHint(name, url)) idempotentTools.add(t.name);
      }
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

/** A server left out of this turn because it was not ready within the turn's budget; it keeps connecting for the next one. */
export interface McpDeferred { name: string; reason: string }

export interface ConnectPlatformMcpOptions {
  /**
   * Keep the connections open after the run, for this user's next turn (`mcp-pool.ts`). Without a pool, or without a user (absent
   * or `default`), each server is opened for this run and closed by `closeAll`, as before.
   */
  pool?: McpConnectionPool;
  userId?: string;
  /**
   * Wait at most this long, for all servers together (they connect side by side), before the run goes on. A server not ready by
   * then is left out of this run (`deferred`) and logged; with a pool it keeps connecting in the background and the next turn
   * offers its tools. Absent or 0: wait for every server however long it takes.
   */
  budgetMs?: number;
  /**
   * Servers the run cannot work without (a review session's review tools): each is waited for up to `requiredBudgetMs` instead of
   * `budgetMs`, and is deferred only past that. The others still wait no longer than `budgetMs`.
   */
  required?: readonly string[];
  /** How long a `required` server is waited for; never less than `budgetMs`. Absent or 0: however long it takes. */
  requiredBudgetMs?: number;
}

const TIMED_OUT = Symbol("mcp_connect_budget");

/**
 * Connect to all MCP servers from resolved configs.
 * Returns a Map for ToolRouter and combined tool schemas for LLM.
 *
 * The servers are connected side by side, not one after another, so the run waits for the slowest server rather than for
 * the sum of them, and with `budgetMs` for no longer than that.
 *
 * `schemas` is sorted by name (see sortToolSchemasByName), across servers, so
 * neither a server's own listing order nor the order the servers were
 * configured in reaches the request.
 */
export async function connectPlatformMcp(
  servers: Record<string, Record<string, unknown>>,
  opts: ConnectPlatformMcpOptions = {},
): Promise<{
  clients: Map<string, McpToolCaller>;
  schemas: ToolSchema[];
  /** Servers that could not be connected or listed, with why; their tools are not offered. */
  failed: McpConnectFailure[];
  /** Servers still connecting when the budget ran out; their tools are not offered in this run. */
  deferred: McpDeferred[];
  /** Let go of this run's connections: pooled ones stay open for the next turn, the others are closed. */
  closeAll: () => Promise<void>;
}> {
  const started = Date.now();
  const clients = new Map<string, McpToolCaller>();
  const schemas: ToolSchema[] = [];
  const failed: McpConnectFailure[] = [];
  const deferred: McpDeferred[] = [];
  const releases: Array<() => void> = [];
  const reused: string[] = [];
  const pool = opts.pool && opts.userId && opts.userId !== "default" ? opts.pool : undefined;

  type Lease = { name: string; spec: Record<string, unknown>; filter: McpToolFilter | null; entry: McpPoolEntry; ready: Promise<void> };
  const leases: Lease[] = [];
  for (const [name, spec] of Object.entries(servers)) {
    // `enabled_tools` / `disabled_tools` (mcp-tool-filter.ts): read before connecting, so a
    // field nobody can read keeps the server out of the run, said as unavailable.
    const filter = mcpToolFilter(spec);
    if (filter && "invalid" in filter) {
      logger.warn({ name, field: filter.invalid }, "mcp_client.tool_filter_invalid_server_skipped");
      failed.push({ name, reason: `its ${filter.invalid} setting cannot be read (expected a non-empty list of tool names)` });
      continue;
    }
    // Connecting is safe to repeat: it opens a client and lists tools, and a
    // server that was mid-swap when this run started is otherwise dropped
    // from the run for its whole life.
    const open = () => retryTransientMcp("connect", name, () => connectMcpServer(name, spec));
    if (pool) {
      const lease = pool.acquire(opts.userId!, name, spec, open);
      if (lease.reused) reused.push(name);
      releases.push(() => pool.release(lease.entry));
      leases.push({ name, spec, filter: filter ?? null, entry: lease.entry, ready: lease.ready });
    } else {
      const entry = new McpPoolEntry(name, name, name, open);
      const ready = entry.connect();
      releases.push(() => entry.retire());
      leases.push({ name, spec, filter: filter ?? null, entry, ready });
    }
  }

  const timers: Array<ReturnType<typeof setTimeout>> = [];
  const deadlineOf = (ms: number): Promise<typeof TIMED_OUT> => (ms
    ? new Promise<typeof TIMED_OUT>((resolve) => { timers.push(setTimeout(() => resolve(TIMED_OUT), ms)); })
    : new Promise<never>(() => {}));
  const budget = opts.budgetMs && opts.budgetMs > 0 ? opts.budgetMs : 0;
  // A server the run cannot work without waits longer (or, with no budget for it, as long as it takes), never shorter than the rest.
  const requiredBudget = !budget ? 0 : opts.requiredBudgetMs && opts.requiredBudgetMs > 0 ? Math.max(opts.requiredBudgetMs, budget) : 0;
  const required = new Set(opts.required ?? []);
  const budgetOf = (name: string): number => (required.has(name) ? requiredBudget : budget);
  const deadline = deadlineOf(budget);
  const requiredDeadline = required.size && requiredBudget !== budget ? deadlineOf(requiredBudget) : deadline;
  const outcomes = await Promise.all(leases.map((l) => Promise.race([
    l.ready.then(() => null, (err: unknown) => ({ err })),
    required.has(l.name) ? requiredDeadline : deadline,
  ])));
  for (const t of timers) clearTimeout(t);

  leases.forEach((l, i) => {
    const { name, spec, filter, entry } = l;
    const outcome = outcomes[i];
    if (outcome === TIMED_OUT && !(entry.kind === "ready" && entry.verifiedAt > 0)) {
      // Not ready within the budget: this run goes on without it, and the connect goes on without the run.
      const waited = budgetOf(name);
      logger.warn({ name, url: spec.url, budgetMs: waited, required: required.has(name), pooled: !!pool }, "mcp_client.connect_deferred");
      deferred.push({ name, reason: `did not answer within ${waited} ms; its tools are offered again from the next turn` });
      l.ready.then(
        () => logger.info({ name, ms: Date.now() - started }, "mcp_client.deferred_connected"),
        (err: unknown) => logger.warn({ name, ms: Date.now() - started, err: connectFailureReason(err) }, "mcp_client.deferred_failed"),
      );
      return;
    }
    if (outcome && outcome !== TIMED_OUT) {
      // Log URL + type so operators can diagnose 4xx / DNS / TLS without
      // cross-referencing SaFE Tools API responses.
      logger.warn({ err: outcome.err, name, url: spec.url, type: spec.type || "http" }, "mcp_client.connect_failed");
      failed.push({ name, reason: connectFailureReason(outcome.err) });
      return;
    }
    // Ready, or (a health check still running past the budget) the tools it listed last time.
    const listed = entry.tools;
    const prefix = `mcp__${name}__`;
    const tools = filter ? listed.filter((t) => filter.allows(t.name.slice(prefix.length))) : listed;
    if (filter) {
      const own = new Set(listed.map((t) => t.name.slice(prefix.length)));
      const unknown = filter.exactNames.filter((n) => !own.has(n));
      // A name the server does not list is most likely a typo or a renamed tool: say it to the operator.
      if (unknown.length) logger.warn({ name, unknown }, "mcp_client.tool_filter_names_unknown");
    }
    const caller: McpToolCaller = {
      callTool: (toolName, args, outcome, meta, signal) => entry.callTool(toolName, args, outcome, meta, signal),
    };
    clients.set(name, filter
      ? {
          callTool: (toolName, args, outcome, meta, signal) => filter.allows(toolName)
            ? caller.callTool(toolName, args, outcome, meta, signal)
            : Promise.reject(new Error(`Tool ${toolName} is not enabled on MCP server ${name}`)),
        }
      : caller);
    schemas.push(...tools);
    logger.info({ name, toolCount: tools.length, ...(filter ? { listedCount: listed.length } : {}) }, "mcp_client.tools_loaded");
  });

  logger.info({
    ms: Date.now() - started,
    servers: Object.keys(servers).length,
    pooled: !!pool,
    reused,
    deferred: deferred.map((d) => d.name),
    failed: failed.map((f) => f.name),
  }, "mcp_client.connect_phase");

  let released = false;
  return {
    clients,
    schemas: sortToolSchemasByName(schemas),
    failed,
    deferred,
    async closeAll() {
      if (released) return;
      released = true;
      for (const release of releases) release();
    },
  };
}
