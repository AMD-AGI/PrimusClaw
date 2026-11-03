// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Where an MCP server named in a request's `mcp_servers` may point.
 *
 * Brain connects to every server a turn carries, from inside the cluster and
 * with the requester's platform key in the Authorization header, so a server
 * the requester names is a URL the server fetches for them: the same checks as
 * a notification webhook (https, no private, loopback or link-local address
 * unless the operator allowed the host in MCP_SERVER_ALLOWED_HOSTS). Servers
 * the API adds to a turn itself (hosted applications, review tools, the
 * assistant) are added after this check and are not subject to it. The
 * address that passed is the one Brain connects to (`pinned_address`), so a
 * name that resolves differently later cannot move the connection.
 */
import { MCP_SERVER_ALLOWED_HOSTS } from "../config.js";
import { guardWebhookUrl, parseAllowedHosts, type Resolver } from "../notifications/url-guard.js";

type McpServers = Record<string, Record<string, unknown>>;

/**
 * The request's servers as Brain may use them, each with the address it was
 * vetted at as `pinned_address` (Brain connects only there; whatever the
 * request put in that field is replaced), or the reason they are refused.
 */
export async function vetRequestMcpServers(
  servers: unknown,
  resolve?: Resolver,
): Promise<{ ok: true; servers: McpServers | undefined } | { ok: false; error: string }> {
  if (servers === undefined || servers === null) return { ok: true, servers: undefined };
  if (typeof servers !== "object" || Array.isArray(servers)) return { ok: false, error: "mcp_servers must be a JSON object" };
  const allowed = parseAllowedHosts(MCP_SERVER_ALLOWED_HOSTS);
  const vetted: McpServers = {};
  for (const [name, spec] of Object.entries(servers)) {
    const url = spec && typeof spec === "object" ? (spec as Record<string, unknown>).url : undefined;
    if (typeof url !== "string" || !url) return { ok: false, error: `mcp_servers.${name}.url must be an http(s) URL` };
    const guard = await guardWebhookUrl(url, allowed, resolve);
    if (!guard.ok) return { ok: false, error: `mcp_servers.${name}.url refused: ${guard.reason}` };
    vetted[name] = { ...(spec as Record<string, unknown>), pinned_address: { address: guard.address, family: guard.family } };
  }
  return { ok: true, servers: vetted };
}
