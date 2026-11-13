// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Sending a signed-out browser to sign in, instead of answering it with JSON.
 *
 * A delivery link (`GET /v1/sessions/:id/deliveries/:deliveryId`) is something a
 * person clicks: a client posts it in a chat, and the browser that opens it may
 * have no session with the platform yet. Answering that browser with the JSON
 * 401 every API client gets leaves the person on a page of JSON. When the
 * operator names a sign-in page (CLAW_BROWSER_SIGN_IN_URL), such a browser is
 * redirected there instead, with the link's own external path as the place to
 * come back to.
 *
 * Deliberately narrow, so nothing an API client sees changes:
 *   - only that one route, and only GET;
 *   - only when the request carries no credential at all (no Authorization, no
 *     x-api-key, no Token cookie, no `?token=` query parameter, which this route
 *     does not accept but a caller may have sent): a credential that was
 *     presented and refused keeps its JSON answer, and a browser holding a
 *     session the platform no longer accepts is not bounced between sign-in
 *     and here;
 *   - only for a browser navigation, i.e. an Accept header that names text/html;
 *   - off unless CLAW_BROWSER_SIGN_IN_URL is set.
 *
 * The setting is a prefix the encoded return path is appended to, e.g.
 * `/login?redirect=`. The return path is the path the browser used, with the
 * public path prefix the API is served under (from CLAW_PUBLIC_URL, else the
 * proxy's X-Forwarded-Prefix; see publicBaseUrl) put back in front, since the
 * ingress strips it before the API sees the request. It is always a path, never
 * a host: where it may lead is the sign-in page's decision, and it is relative.
 */
import type { FastifyRequest } from "fastify";
import { publicBaseUrl } from "../routes/a2a-agents.js";

/** The routes a signed-out browser is sent to sign in from. */
const SIGN_IN_REDIRECT_PATH_RE = /^\/v1\/sessions\/[^/]+\/deliveries\/[^/]+$/;

/** True when `pathname` is a route a signed-out browser may be redirected to sign in from. */
export function isSignInRedirectPath(pathname: string): boolean {
  return SIGN_IN_REDIRECT_PATH_RE.test(pathname);
}

/**
 * CLAW_BROWSER_SIGN_IN_URL, when it is usable: a same-origin path (`/login?redirect=`)
 * or an absolute http(s) URL. Anything else (empty, `//host`, another scheme) is
 * treated as unset, so a typo cannot turn a 401 into a redirect somewhere odd.
 */
export function browserSignInBase(env: Record<string, string | undefined> = process.env): string {
  const value = (env.CLAW_BROWSER_SIGN_IN_URL ?? "").trim();
  if (!value) return "";
  if (value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\")) return value;
  if (/^https?:\/\/[^/\\]/i.test(value)) return value;
  return "";
}

/** Whether an Accept header asks for HTML, as a browser's navigation does. */
export function acceptsHtml(accept: string | string[] | undefined): boolean {
  const joined = Array.isArray(accept) ? accept.join(",") : (accept ?? "");
  for (const entry of joined.split(",")) {
    const [type, ...params] = entry.split(";").map((part) => part.trim().toLowerCase());
    if (type !== "text/html") continue;
    const q = params.find((p) => p.startsWith("q="));
    if (q && Number(q.slice(2)) === 0) continue;
    return true;
  }
  return false;
}

/** The path part of the API's public base ("/claw-api"), or "" when it has none or none is known. */
function publicPathPrefix(headers: FastifyRequest["headers"], env: Record<string, string | undefined>): string {
  const base = publicBaseUrl(headers, env);
  if (!base) return "";
  let path: string;
  try {
    path = new URL(base).pathname;
  } catch {
    return "";
  }
  while (path.endsWith("/")) path = path.slice(0, -1);
  return path;
}

/**
 * Where to send this request to sign in, or null when it gets the usual answer.
 * `pathname` is the request path without its query, as the auth hook has it.
 */
export function browserSignInRedirect(
  req: Pick<FastifyRequest, "method" | "headers" | "cookies" | "query">,
  pathname: string,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const signIn = browserSignInBase(env);
  if (!signIn) return null;
  if (req.method !== "GET" || !isSignInRedirectPath(pathname)) return null;
  if (req.headers.authorization || req.headers["x-api-key"]) return null;
  const cookies = req.cookies as Record<string, string | undefined> | undefined;
  if (cookies?.Token) return null;
  const query = req.query as Record<string, unknown> | undefined;
  if (query && Object.hasOwn(query, "token")) return null;
  if (!acceptsHtml(req.headers.accept)) return null;
  return signIn + encodeURIComponent(publicPathPrefix(req.headers, env) + pathname);
}
