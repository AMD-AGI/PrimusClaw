// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import pino from "pino";

const logger = pino({ name: "mcp-config" });
const ENV_PLACEHOLDER_RE = /<([A-Z_][A-Z0-9_]*)>/g;
export const ENV_PLACEHOLDER_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;
const VALID_TYPES = new Set(["sse", "stdio", "http"]);

/**
 * Recursively replace <NAME> placeholders.
 *
 * `overrides` are values the request itself carries (the requester's own
 * platform key as SAFE_API_KEY): every config may name those. Anything else is
 * a read of the Brain's environment, whose answer leaves as a header or inside a
 * URL to whatever server the config names. So only names on `envAllow` are read
 * from process.env, and only the operator's defaults file supplies an
 * `envAllow`; a config written by a requester or a tool author gets the empty
 * string for every other name.
 */
function replaceEnvPlaceholders(
  obj: unknown,
  overrides: Record<string, string>,
  envAllow: ReadonlySet<string>,
): unknown {
  if (typeof obj === "string") {
    return obj.replace(ENV_PLACEHOLDER_RE, (_, varName: string) => {
      const override = overrides[varName];
      if (override !== undefined) return override;
      if (envAllow.has(varName)) return process.env[varName] ?? "";
      logger.warn({ varName }, "mcp.placeholder_not_allowed");
      return "";
    });
  }
  if (Array.isArray(obj)) return obj.map((v) => replaceEnvPlaceholders(v, overrides, envAllow));
  if (obj && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = replaceEnvPlaceholders(v, overrides, envAllow);
    }
    return result;
  }
  return obj;
}

/** The literal host a spec's URL names, or null when it names none (no URL, or a placeholder in the host). */
function literalUrlHost(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase() || null;
  } catch {
    return null;
  }
}

/** The origin (scheme://host[:port]) a spec's http(s) URL names, or null when it names none. */
function literalUrlOrigin(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.origin : null;
  } catch {
    return null;
  }
}

/**
 * The origins of the servers that send `<name>`: those naming it in a field that goes out with every
 * request (the URL, the token, a header), at a URL with a literal host.
 */
export function originsSendingPlaceholder(
  servers: Record<string, Record<string, unknown>>,
  name: string,
): Set<string> {
  const origins = new Set<string>();
  for (const spec of Object.values(servers)) {
    if (!spec || typeof spec !== "object") continue;
    const sent = JSON.stringify([spec.url, spec.token, spec.api_key, spec.headers]);
    const origin = sent.includes(`<${name}>`) ? literalUrlOrigin(spec.url) : null;
    if (origin) origins.add(origin);
  }
  return origins;
}

/**
 * Normalize and validate MCP server configs.
 * @param servers - raw MCP server configs from tool_ids / request
 * @param overrides - values the request carries, for `<VAR>` placeholders in spec
 * @param envAllow - names that may be read from process.env; only the operator's defaults file has any
 * @param overrideHosts - when given, only a server whose URL names one of these host names, or one of
 *   these origins (`scheme://host[:port]`), gets `overrides` (the requester's platform key); any other
 *   server gets the empty string for them, as for an unlisted name
 */
export function normalizeMcpConfigs(
  servers: Record<string, Record<string, unknown>>,
  overrides: Record<string, string> = {},
  envAllow: ReadonlySet<string> = new Set(),
  overrideHosts?: ReadonlySet<string>,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};

  for (const [name, rawSpec] of Object.entries(servers)) {
    if (!rawSpec || typeof rawSpec !== "object") continue;
    if (!rawSpec.url && !rawSpec.command) continue;

    const host = overrideHosts ? literalUrlHost(rawSpec.url) : null;
    const origin = overrideHosts ? literalUrlOrigin(rawSpec.url) : null;
    const trusted = !overrideHosts
      || (host !== null && overrideHosts.has(host))
      || (origin !== null && overrideHosts.has(origin));
    if (!trusted) {
      const withheld = Object.keys(overrides).filter((k) => JSON.stringify(rawSpec).includes(`<${k}>`));
      // Visible here, not only as the server's later auth failure, so an operator can tell a host to list.
      if (withheld.length) logger.warn({ server: name, host, withheld }, "mcp.placeholder_withheld_untrusted_host");
    }
    const spec = replaceEnvPlaceholders({ ...rawSpec }, trusted ? overrides : {}, envAllow) as Record<string, unknown>;

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

