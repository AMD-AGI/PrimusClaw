// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Backend MCP tool registry (task-design.md §8.2).
 *
 * The registry is a single process-global instance Brain talks to via the
 * `/v1/internal/tasks/<id>/backend-mcp` JSON-RPC endpoint. Tool implementations
 * register themselves at API boot via {@link backendMcpRegistry}; the registry
 * holds both the executable handler and an MCP-style descriptor so we can
 * answer `tools/list` without keeping a second list in sync.
 */
import type {
  BackendMcpCtx,
  BackendMcpHandler,
  BackendMcpToolDescriptor,
  McpResult,
} from "./types.js";

interface RegistryEntry {
  handler: BackendMcpHandler;
  descriptor: BackendMcpToolDescriptor;
}

export class BackendMcpRegistry {
  private readonly entries = new Map<string, RegistryEntry>();

  /**
   * Register a tool. Re-registering the same name replaces the previous
   * handler so plugin reloads / hot-swaps work cleanly.
   */
  register(descriptor: BackendMcpToolDescriptor, handler: BackendMcpHandler): void {
    this.entries.set(descriptor.name, { descriptor, handler });
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  list(filter?: (name: string) => boolean): BackendMcpToolDescriptor[] {
    const out: BackendMcpToolDescriptor[] = [];
    for (const [name, entry] of this.entries.entries()) {
      if (filter && !filter(name)) continue;
      out.push(entry.descriptor);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Dispatch a tool call. Unknown tools throw a JSON-RPC-friendly Error the
   * route handler maps to `code: -32601`.
   */
  async invoke(
    name: string,
    args: Record<string, unknown>,
    ctx: BackendMcpCtx,
  ): Promise<McpResult> {
    const entry = this.entries.get(name);
    if (!entry) {
      const err = new Error(`Backend MCP tool not found: ${name}`);
      (err as Error & { code?: number }).code = -32601;
      throw err;
    }
    return await entry.handler(args, ctx);
  }
}

/** Process-global registry. */
export const backendMcpRegistry = new BackendMcpRegistry();
