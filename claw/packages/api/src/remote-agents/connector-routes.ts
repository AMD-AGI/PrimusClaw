// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The routes a connector (the program on a user's machine) calls, as one table.
 *
 * Registration and authentication both read it, so "which routes does a
 * connector's access token reach" cannot drift from "which routes the connector
 * calls": a route added to the module is user-side until it is named here.
 */
export const CONNECTOR_SIDE_ROUTES = {
  register: { method: "POST", url: "/v1/remote-agents/connectors" },
  heartbeat: { method: "POST", url: "/v1/remote-agents/connectors/:cid/heartbeat" },
  events: { method: "POST", url: "/v1/remote-agents/connectors/:cid/events" },
  commands: { method: "GET", url: "/v1/remote-agents/connectors/:cid/commands" },
} as const;

/** `:param` matches one path segment, as the router does; anchored, so no prefix or suffix is a match. */
const matchers = Object.values(CONNECTOR_SIDE_ROUTES).map((r) => ({
  method: r.method as string,
  re: new RegExp(`^${r.url.replace(/:[A-Za-z0-9_]+/g, "[^/]+")}$`),
}));

/**
 * Whether `method` and `pathname` (no query string) name a connector-side route.
 * Exact method: a HEAD request, which the router also serves for a GET route, is
 * not one.
 */
export function isConnectorSideRoute(method: string, pathname: string): boolean {
  return matchers.some((m) => m.method === method && m.re.test(pathname));
}
