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
 * assistant) are added after this check and are not subject to it.
 */
import { MCP_SERVER_ALLOWED_HOSTS } from "../config.js";
import { guardWebhookUrl, parseAllowedHosts, type Resolver } from "../notifications/url-guard.js";

/** The reason a request's `mcp_servers` is refused, or null when every server may be used. */
export async function refuseRequestMcpServers(
  servers: unknown,
  resolve?: Resolver,
): Promise<string | null> {
  if (servers === undefined || servers === null) return null;
  if (typeof servers !== "object" || Array.isArray(servers)) return "mcp_servers must be a JSON object";
  const allowed = parseAllowedHosts(MCP_SERVER_ALLOWED_HOSTS);
  for (const [name, spec] of Object.entries(servers)) {
    const url = spec && typeof spec === "object" ? (spec as Record<string, unknown>).url : undefined;
    if (typeof url !== "string" || !url) return `mcp_servers.${name}.url must be an http(s) URL`;
    const guard = await guardWebhookUrl(url, allowed, resolve);
    if (!guard.ok) return `mcp_servers.${name}.url refused: ${guard.reason}`;
  }
  return null;
}
