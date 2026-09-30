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
 *   bearer credential. The credential therefore also travels in
 *   {@link HANDS_TOKEN_HEADER}, which Hands accepts in its place.
 *
 * Both are derived from the URL alone, so every caller holding a Hands URL --
 * Brain's client, its health probes, the API's inventory probe -- builds the
 * same headers without knowing how the URL was chosen. A direct URL gets no
 * session header, and sending the credential twice to it is harmless.
 */

/** Header carrying the Hands credential where `Authorization` does not survive. */
export const HANDS_TOKEN_HEADER = "X-Hands-Token";

const ROUTED_HANDS_PATH = /\/code-interpreters\/([^/?#]+)\/invocations\/proxy\/\d+(?:[/?#]|$)/;

/**
 * The Router session a Hands URL addresses, or null when the URL is not a
 * Router port-proxy URL (a direct one, or anything unparseable).
 */
export function routedHandsSessionId(url: string): string | null {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return null;
  }
  const m = ROUTED_HANDS_PATH.exec(path);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

/** Headers a Hands request needs to be routed at all; empty for a direct URL. */
export function handsRouteHeaders(url: string): Record<string, string> {
  const session = routedHandsSessionId(url);
  return session ? { "x-session-id": session } : {};
}

/** Routing headers plus the credential, in both places Hands reads it from. */
export function handsCredentialHeaders(url: string, credential: string): Record<string, string> {
  return {
    ...handsRouteHeaders(url),
    Authorization: `Bearer ${credential}`,
    [HANDS_TOKEN_HEADER]: credential,
  };
}
