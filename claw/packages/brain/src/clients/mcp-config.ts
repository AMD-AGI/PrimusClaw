// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import pino from "pino";

const logger = pino({ name: "mcp-config" });
const ENV_PLACEHOLDER_RE = /<([A-Z_][A-Z0-9_]*)>/g;
const VALID_TYPES = new Set(["sse", "stdio", "http"]);

/**
 * Recursively replace <ENV_VAR> placeholders.
 * Checks overrides first (per-request values like platformKey),
 * then falls back to process.env.
 */
function replaceEnvPlaceholders(obj: unknown, overrides: Record<string, string> = {}): unknown {
  if (typeof obj === "string") {
    return obj.replace(ENV_PLACEHOLDER_RE, (_, varName: string) => overrides[varName] ?? process.env[varName] ?? "");
  }
  if (Array.isArray(obj)) return obj.map((v) => replaceEnvPlaceholders(v, overrides));
  if (obj && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = replaceEnvPlaceholders(v, overrides);
    }
    return result;
  }
  return obj;
}

/**
 * Normalize and validate MCP server configs.
 * @param servers - raw MCP server configs from tool_ids / request
 * @param overrides - per-request env overrides for `<VAR>` placeholders in spec
 */
export function normalizeMcpConfigs(
  servers: Record<string, Record<string, unknown>>,
  overrides: Record<string, string> = {},
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};

  for (const [name, rawSpec] of Object.entries(servers)) {
    if (!rawSpec || typeof rawSpec !== "object") continue;
    if (!rawSpec.url && !rawSpec.command) continue;

    const spec = replaceEnvPlaceholders({ ...rawSpec }, overrides) as Record<string, unknown>;

    if (!spec.type) {
      if (spec.url) {
        const url = String(spec.url).replace(/\/+$/, "");
        spec.type = url.endsWith("/sse") ? "sse" : "http";
      } else if (spec.command) {
        spec.type = "stdio";
      }
    }
    if (spec.type === "streamable-http") spec.type = "http";

    if (!VALID_TYPES.has(spec.type as string)) {
      logger.warn({ name, type: spec.type }, "mcp.skip_unsupported_type");
      continue;
    }
    out[name] = spec;
  }
  return out;
}
