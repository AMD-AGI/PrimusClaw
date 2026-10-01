// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * How a request reaches Hands when it goes through the sandbox Router rather
 * than straight to the sandbox's cluster DNS name.
 *
 * Brain normally talks to Hands at `http://<id>.<ns>.svc.cluster.local:9100`,
 * which only resolves inside the cluster the sandbox runs in. When the sandbox
 * lives in another cluster, the one path in is that cluster's Router, whose
 * port proxy forwards `.../code-interpreters/<id>/invocations/proxy/9100/<p>`
 * to the pod. Two things about that proxy shape every request made through it:
 *
 * - it finds the session from the `x-session-id` header, and refuses a GET
 *   without one (a POST without one would ask it to create a sandbox);
 * - it strips `Authorization` before forwarding, so Hands never sees the
 *   bearer credential. On a routed URL the credential therefore also travels
 *   in {@link HANDS_TOKEN_HEADER}, which Hands accepts in its place.
 *
 * Both are derived from the URL alone, so every caller holding a Hands URL --
 * Brain's client, its health probes, the API's inventory probe -- builds the
 * same headers without knowing how the URL was chosen. A direct URL gets
 * neither extra header.
 */

/** Header carrying the Hands credential where `Authorization` does not survive. */
export const HANDS_TOKEN_HEADER = "X-Hands-Token";

const ROUTED_HANDS_PATH = /\/code-interpreters\/([^/?#]+)\/invocations\/proxy\/(\d+)(?:[/?#]|$)/;

function routedParts(url: string): { session: string; port: string } | null {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return null;
  }
  const m = ROUTED_HANDS_PATH.exec(path);
  if (!m) return null;
  try {
    return { session: decodeURIComponent(m[1]), port: m[2] };
  } catch {
    return null;
  }
}

/**
 * The Router session a Hands URL addresses, or null when the URL is not a
 * Router port-proxy URL (a direct one, or anything unparseable).
 */
export function routedHandsSessionId(url: string): string | null {
  return routedParts(url)?.session ?? null;
}

/**
 * The sandbox port a Router port-proxy URL forwards to, or null for any other
 * URL. For a routed URL the host's own port is the Router's, not Hands'.
 */
export function routedHandsPort(url: string): string | null {
  return routedParts(url)?.port ?? null;
}

/** Headers a Hands request needs to be routed at all; empty for a direct URL. */
export function handsRouteHeaders(url: string): Record<string, string> {
  const session = routedHandsSessionId(url);
  return session ? { "x-session-id": session } : {};
}

/**
 * The credential, and for a routed URL the routing headers and the credential
 * again in {@link HANDS_TOKEN_HEADER}. A direct URL gets exactly the one
 * `Authorization` header it always got, so nothing changes where the Router is
 * not in the path.
 */
export function handsCredentialHeaders(url: string, credential: string): Record<string, string> {
  const route = handsRouteHeaders(url);
  if (!route["x-session-id"]) return { Authorization: `Bearer ${credential}` };
  return {
    ...route,
    Authorization: `Bearer ${credential}`,
    [HANDS_TOKEN_HEADER]: credential,
  };
}
