// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { FastifyRequest } from "fastify";
import type { CallerAuth } from "../tasks/app-run.js";
import { isApiKey } from "./safe-client.js";

/**
 * The caller's own credential, the one the auth middleware actually accepted, to
 * be asked of SaFE on the caller's behalf. The middleware tries, in order: the
 * session cookie (`Token`), `Authorization: Bearer ak-...`, then `x-api-key`
 * (first value, `ak-...`). Forwarding the first thing that is present instead
 * would, for a gateway's own Bearer token beside the user's `x-api-key`, ask SaFE
 * with a credential that was never the caller's.
 *
 * It lives beside the middleware, not in a route module, because every route that
 * acts on SaFE as the caller needs exactly this and none of them should have to
 * import another route to get it.
 */
export function callerAuthOf(req: FastifyRequest): CallerAuth {
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
