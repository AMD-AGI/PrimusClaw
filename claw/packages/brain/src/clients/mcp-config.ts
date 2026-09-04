// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import pino from "pino";

const logger = pino({ name: "mcp-config" });
const ENV_PLACEHOLDER_RE = /<([A-Z_][A-Z0-9_]*)>/g;
const VALID_TYPES = new Set(["sse", "stdio", "http"]);

/**
 * Platform credentials a session's own mcp_servers config may never name.
 *
 * The config is user-supplied, and an expanded placeholder travels: as a token
 * it becomes `Authorization: Bearer <value>` to a server of the caller's
 * choosing, and inside a URL it is both sent and logged. These are the Brain's
 * own infrastructure credentials -- the checkpoint seal key, the user-env vault
 * master key, the NATS identity, the internal service token, object-store keys
 * -- and no MCP server has any business receiving one. Per-server credentials
 * (TAVILY_API_KEY and friends) are deliberately not here: naming those is the
 * feature.
 */
const DENIED_ENV_NAMES = new Set([
  "AUTH_INTERNAL_TOKEN",
  "BRAIN_CHECKPOINT_KEY",
  "NATS_CREDS", "NATS_NKEY", "NATS_PASSWORD", "NATS_SEED", "NATS_TOKEN", "NATS_USER",
  "S3_ACCESS_KEY", "S3_SECRET_KEY",
  "USER_ENV_ENCRYPTION_KEY",
]);
/** The same names by shape, so a key added later is denied without an edit here. */
const DENIED_ENV_SUFFIX_RE = /_(?:CHECKPOINT|ENCRYPTION|SEAL|SIGNING|PRIVATE)_KEY$/;

function envPlaceholderDenied(varName: string): boolean {
  return DENIED_ENV_NAMES.has(varName) || DENIED_ENV_SUFFIX_RE.test(varName);
}

/**
 * Recursively replace <ENV_VAR> placeholders.
 * Checks overrides first (per-request values like platformKey),
 * then falls back to process.env -- except for the platform credentials in
 * DENIED_ENV_NAMES, which never come from the environment. An override of the
 * same name is still honoured: that value came from the caller that built the
 * request, not from the session's config.
 */
function replaceEnvPlaceholders(obj: unknown, overrides: Record<string, string> = {}): unknown {
  if (typeof obj === "string") {
    return obj.replace(ENV_PLACEHOLDER_RE, (_, varName: string) => {
      const override = overrides[varName];
      if (override !== undefined) return override;
      if (envPlaceholderDenied(varName)) {
        logger.warn({ varName }, "mcp.denied_env_placeholder");
        return "";
      }
      return process.env[varName] ?? "";
    });
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

export const __test__ = { envPlaceholderDenied };
