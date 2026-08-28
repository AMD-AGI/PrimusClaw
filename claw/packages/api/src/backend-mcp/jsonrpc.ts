// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * JSON-RPC 2.0 adapter for Brain → Backend MCP calls (task-design.md §8.2).
 *
 * We only implement the three methods Brain ever calls:
 *
 *   - `initialize`      handshake; returns server capabilities
 *   - `tools/list`      enumerate registered Backend tools
 *   - `tools/call`      invoke one by name with the given arguments
 *
 * Any other method returns `-32601 method not found`. Errors thrown inside
 * a handler become `-32000` errors with the original message.
 */
import type { Logger } from "pino";
import { backendMcpRegistry } from "./registry.js";
import type { BackendMcpCtx, McpResult } from "./types.js";

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: string | number | null;
  result: unknown;
}

export interface JsonRpcError {
  jsonrpc: "2.0";
  id: string | number | null;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

const PROTOCOL_VERSION = "2024-11-05";

function jsonRpcError(id: string | number | null, code: number, message: string, data?: unknown): JsonRpcError {
  return { jsonrpc: "2.0", id, error: data === undefined ? { code, message } : { code, message, data } };
}

function jsonRpcResult(id: string | number | null, result: unknown): JsonRpcSuccess {
  return { jsonrpc: "2.0", id, result };
}

interface HandleOpts {
  /**
   * Caller-supplied factory for the per-call MCP context. Phase 1.2 ships
   * a stub from `routes/internal-tasks.ts`; Phase 3 scheduler wires the
   * real one that reads `claw_tasks` first.
   */
  buildContext: (params: { taskId: string }) => Promise<BackendMcpCtx>;
  logger: Logger;
}

/**
 * Entry point used by the Fastify route. Validates JSON-RPC framing and
 * dispatches to one of the three supported methods.
 */
export async function handleBackendMcpRequest(
  body: JsonRpcRequest,
  taskId: string,
  opts: HandleOpts,
): Promise<JsonRpcResponse> {
  const id = (body?.id ?? null) as string | number | null;
  if (body?.jsonrpc !== "2.0") {
    return jsonRpcError(id, -32600, "expected jsonrpc='2.0'");
  }
  const method = body?.method ?? "";
  const params = (body?.params ?? {}) as Record<string, unknown>;
  const log = opts.logger;

  if (method === "initialize") {
    return jsonRpcResult(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "primus-claw-backend-mcp", version: "1.0.0" },
    });
  }

  if (method === "tools/list") {
    const tools = backendMcpRegistry.list().map((d) => ({
      name: d.name,
      description: d.description,
      inputSchema: d.inputSchema,
    }));
    return jsonRpcResult(id, { tools });
  }

  if (method === "tools/call") {
    const name = String(params.name ?? "").trim();
    if (!name) return jsonRpcError(id, -32602, "params.name is required");
    if (!backendMcpRegistry.has(name)) {
      return jsonRpcError(id, -32601, `Backend MCP tool not found: ${name}`);
    }
    const args = (params.arguments && typeof params.arguments === "object")
      ? (params.arguments as Record<string, unknown>)
      : {};
    let ctx: BackendMcpCtx;
    try {
      ctx = await opts.buildContext({ taskId });
    } catch (ctxErr) {
      const msg = ctxErr instanceof Error ? ctxErr.message : String(ctxErr);
      log.error({ taskId, name, err: msg }, "backend-mcp.context_failed");
      return jsonRpcError(id, -32000, `failed to build context: ${msg}`);
    }
    let result: McpResult;
    try {
      result = await backendMcpRegistry.invoke(name, args, ctx);
    } catch (callErr) {
      const code = (callErr as Error & { code?: number }).code ?? -32000;
      const msg = callErr instanceof Error ? callErr.message : String(callErr);
      log.warn({ taskId, name, err: msg }, "backend-mcp.invoke_failed");
      return jsonRpcError(id, code, msg);
    }
    return jsonRpcResult(id, result);
  }

  return jsonRpcError(id, -32601, `method not found: ${method}`);
}
