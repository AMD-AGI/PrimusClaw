// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Minimal JSON-RPC client Brain uses to call Backend-side MCP tools
 * (task-design.md §8.2).
 *
 * The wire shape mirrors MCP's `tools/call` envelope so the API-side
 * registry can stay a drop-in replacement for a real MCP HTTP transport
 * later if we ever decide to multiplex everything through one SDK.
 *
 * Concerns split intentionally: this module only talks JSON-RPC. The
 * tool-router (`tools/router.ts`) decides *whether* a tool call should
 * be routed here based on `plugin_tools[*].config.scope`.
 */
import pino from "pino";

const logger = pino({ name: "backend-mcp-client" });

export interface BackendMcpCallResult {
  /** Concatenated `result.content[*].text` joined with `\n`. */
  text: string;
  /** Optional structured payload echoed by the server (e.g. parsed JSON). */
  structured?: unknown;
  /** When set, mode=script must treat this call as a `wait_external` signal. */
  wait_external?: boolean;
  /** Free-form error string when isError / wait_external is true. */
  error?: string;
  /** Mirrors MCP `result.isError`. */
  isError?: boolean;
  /**
   * Free-form metadata echoed back from the MCP handler. Tools can surface an
   * `external_id` (task-design.md §5.1) so the script-runner can park the task
   * under `metadata.derived.external_id`.
   */
  metadata?: Record<string, unknown>;
}

/**
 * One JSON-RPC call to `${endpoint}` with bearer auth. Throws on transport /
 * non-2xx / JSON-RPC error so that mode=script's `on_fail` policy can map
 * thrown errors to its `abort | continue | wait_external` semantics.
 */
export async function callBackendMcpTool(
  endpoint: string,
  token: string,
  name: string,
  args: Record<string, unknown>,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<BackendMcpCallResult> {
  if (!endpoint) throw new Error("backend_mcp_url is required");
  if (!token) throw new Error("backend_internal_token is required");

  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;
  const ctrl = new AbortController();
  const timeoutTimer = setTimeout(() => ctrl.abort(new Error("backend-mcp timeout")), timeoutMs);
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort(opts.signal.reason);
    else opts.signal.addEventListener("abort", () => ctrl.abort(opts.signal!.reason));
  }

  const body = {
    jsonrpc: "2.0",
    id: cryptoRandomId(),
    method: "tools/call",
    params: { name, arguments: args },
  };

  let resp: Response;
  try {
    resp = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timeoutTimer);
  }

  const text = await resp.text();
  if (!resp.ok) {
    logger.warn({ status: resp.status, name, body: text.slice(0, 300) }, "backend-mcp.http_error");
    throw new Error(`Backend MCP HTTP ${resp.status}: ${text.slice(0, 300)}`);
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`Backend MCP returned non-JSON: ${text.slice(0, 300)}`);
  }

  if (parsed.error) {
    const e = parsed.error as { code?: number; message?: string };
    throw new Error(`Backend MCP error ${e.code ?? "?"}: ${e.message ?? "unknown"}`);
  }

  const result = (parsed.result ?? {}) as {
    content?: Array<{ type?: string; text?: string }>;
    structured?: unknown;
    wait_external?: boolean;
    isError?: boolean;
    error?: string;
    metadata?: Record<string, unknown>;
  };
  const contents = Array.isArray(result.content) ? result.content : [];
  const textPart = contents
    .filter((c) => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("\n");

  return {
    text: textPart,
    structured: result.structured,
    wait_external: result.wait_external === true,
    isError: result.isError === true,
    error: result.error,
    metadata: result.metadata,
  };
}

function cryptoRandomId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `rpc-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}
