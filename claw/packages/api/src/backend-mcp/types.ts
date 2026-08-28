// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Shared types for the Backend-side MCP layer (task-design.md §8.2).
 *
 * A Backend-side MCP tool runs *inside* the Backend process, never in a
 * sandbox. Brain calls these tools via `POST /v1/internal/tasks/<id>/backend-mcp`
 * (JSON-RPC 2.0). The wire shape mirrors the Hands MCP server so Brain's
 * tool-router can route by `tool.config.scope` and otherwise be agnostic.
 */
import type { Logger } from "pino";

/** MCP standard-result content shape. */
export interface McpContent {
  type: "text" | "image" | "resource";
  text?: string;
  /** Image / resource payload (base64) — present only for non-text content. */
  data?: string;
  /** Optional MIME hint for non-text content. */
  mimeType?: string;
}

/** Successful MCP tool call result. */
export interface McpResult {
  content: McpContent[];
  /**
   * Optional structured payload returned alongside the textual content. Brain
   * exposes this through `result.structured` so script-mode steps can use it
   * verbatim for `captures` without re-parsing JSON.
   */
  structured?: unknown;
  /**
   * Special signal used by `mode=script` steps with `on_fail="wait_external"`.
   * When set, the runner pauses the entire task in `waiting_external` and
   * ExternalResolver replays the script from step 0 after the prerequisite
   * resolves.
   */
  wait_external?: boolean;
  /** Free-form error explanation paired with `wait_external` / `isError`. */
  error?: string;
  /** Mirrors the MCP spec: when true, content is an error description. */
  isError?: boolean;
}

/**
 * Runtime context handed to every Backend MCP handler.
 *
 * Phase 1.2 ships a "best-effort" context (task/dag/session fields may be
 * empty when the call originates before Phase 2 schema lands). Phase 3
 * scheduler fully populates every field by reading `claw_tasks` first.
 */
export interface BackendMcpCtx {
  task_id: string;
  /** DB snapshot of the calling task; null when the row does not exist yet. */
  task: Record<string, unknown> | null;
  dag_root_task_id?: string;
  dag_node_id?: string;
  batch_id?: string;
  session_id: string;
  user_id: string;
  workspace_id: string;
  plugin_id?: number;

  /**
   * Phase 1 stub: every handler may still read/write the global `db.query` /
   * S3 surface as needed. The full path-scoped accessors land in Phase 5
   * when we wire KA-specific tools.
   */
  log: Logger;
  abortSignal: AbortSignal;
}

/**
 * Backend MCP tool handler signature. Returns either a structured `McpResult`
 * or throws -- the registry turns thrown errors into JSON-RPC errors.
 */
export type BackendMcpHandler = (
  args: Record<string, unknown>,
  ctx: BackendMcpCtx,
) => Promise<McpResult>;

/** Schema entry returned by `tools/list`. */
export interface BackendMcpToolDescriptor {
  name: string;
  description: string;
  /** JSON Schema for the call's `params.arguments`. Default `{}` accepts anything. */
  inputSchema: Record<string, unknown>;
}
