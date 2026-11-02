// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { FastifyRequest } from "fastify";
import type { CallerAuth } from "../tasks/app-run.js";
import { IDENTITY_TOKEN_METHOD } from "./identity-token.js";
import { getUser } from "./middleware.js";
import { getAuthMethod } from "./request-credential.js";
import { isApiKey } from "./safe-client.js";

/**
 * The caller's own credential, the one the auth middleware actually accepted, to
 * be asked of SaFE on the caller's behalf. The middleware tries, in order: the
 * session cookie (`Token`), `Authorization: Bearer ak-...`, then `x-api-key`
 * (first value, `ak-...`). Forwarding the first thing that is present instead
 * would, for a gateway's own Bearer token beside the user's `x-api-key`, ask SaFE
 * with a credential that was never the caller's.
 *
 * A caller the middleware accepted by an identity provider's access token has no
 * credential of SaFE's own to forward, and the token is not one SaFE is asked to
 * accept on every route. What the middleware asked SaFE about it is the person's
 * platform key (`auth/identity-token.ts`), an `ak-` key like the ones above, so that
 * is what is presented. Without one (SaFE does not know the token, or this is not a
 * SaFE deployment) there is nothing to present, and nothing else on the request
 * stands in for it: the middleware did not accept those.
 *
 * It lives beside the middleware, not in a route module, because every route that
 * acts on SaFE as the caller needs exactly this and none of them should have to
 * import another route to get it.
 */
export function callerAuthOf(req: FastifyRequest): CallerAuth {
  if (getAuthMethod(req) === IDENTITY_TOKEN_METHOD) {
    const platformKey = getUser(req)?.platformKey;
    return platformKey ? { authorization: `Bearer ${platformKey}` } : {};
  }
  const cookies = req.cookies as Record<string, string> | undefined;
  if (cookies?.Token && typeof req.headers.cookie === "string") return { cookie: req.headers.cookie };
  const authorization = req.headers.authorization;
  if (typeof authorization === "string" && authorization.startsWith("Bearer ") && isApiKey(authorization.slice(7))) {
    return { authorization };
  }
  const header = req.headers["x-api-key"];
  const apiKey = Array.isArray(header) ? header[0] : header;
  if (typeof apiKey === "string" && isApiKey(apiKey)) return { authorization: `Bearer ${apiKey}` };
  return {};
}

/**
 * The `Authorization` value to send SaFE for a route that forwards the caller's credential to it as a header (the MCP tool
 * that lists models). It is derived from the credential the middleware actually accepted ({@link callerAuthOf}), never from
 * whatever `Authorization` header the request happens to carry: a request can carry a SaFE cookie that won authentication
 * and an identity provider's access token beside it, and that token is good for this API's audience, so SaFE is never
 * shown it. A caller authenticated by such a token is sent the person's platform key, and nothing without one.
 */
export function safeAuthorizationOf(req: FastifyRequest): string {
  return callerAuthOf(req).authorization ?? "";
}
