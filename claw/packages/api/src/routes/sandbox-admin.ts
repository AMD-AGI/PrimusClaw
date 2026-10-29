// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Read-only admin view of the Agent Sandbox control plane, for the console.
 *
 *   GET /v1/admin/sandbox/templates   templates of every user
 *   GET /v1/admin/sandbox/sessions    sandboxes of every user
 *
 * The Router lists everything for a caller it does not know: the deployments run
 * it without --enable-auth (Hands reaches sandboxes through it that way), so its
 * management API must not be reachable from a browser. These routes are the
 * browser's way in. The global preHandler authenticates the caller, the handler
 * requires an admin role, and the request that reaches the Router is built here
 * from a fixed set of query fields, with none of the caller's headers or cookies.
 *
 * A Router that does run with --enable-auth (SANDBOX_ROUTER_AUTH_ENABLED) answers
 * 401 to a request without credentials. Then the one header sent is
 * `Authorization: Bearer <the admin caller's SaFE key>`, built here from the
 * authenticated user and never copied from the request, so the Router resolves
 * the same admin role this handler checked. An admin with no such key is refused
 * with a clear error instead of being sent to a Router that would answer 401.
 */

/** Read per request, so a test can flip it; the environment sets it at boot. */
export const sandboxAdminSettings = { routerAuth: SANDBOX_ROUTER_AUTH_ENABLED };
import type { FastifyInstance, FastifyReply } from "fastify";
import { authErrorPayload, getUser } from "../auth/middleware.js";
import { isAdmin, type UserInfo } from "../auth/models.js";
import { SANDBOX_ADMIN_URL, SANDBOX_ROUTER_AUTH_ENABLED } from "../config.js";

const UPSTREAM_TIMEOUT_MS = 10_000;
const MAX_LIMIT = 1000;
const MAX_FILTER_LENGTH = 200;

/** The filters each Router list endpoint takes, besides paging and sorting. */
const FILTERS = {
  "/v1/templates": ["namespace", "userId", "userName", "name", "public"],
  "/v1/code-interpreter/sessions": ["namespace", "userId", "userName", "status", "sessionId", "sandboxName"],
} as const;

type UpstreamPath = keyof typeof FILTERS;

/** The query string the Router is sent, or the reason the caller's is refused. */
export function buildUpstreamQuery(
  path: UpstreamPath,
  query: Record<string, unknown>,
): URLSearchParams | { error: string } {
  const out = new URLSearchParams();
  for (const key of FILTERS[path]) {
    const v = query[key];
    if (v === undefined || v === "") continue;
    if (typeof v !== "string" || v.length > MAX_FILTER_LENGTH) return { error: `${key} is not valid` };
    out.set(key, v);
  }
  for (const key of ["offset", "limit"] as const) {
    const v = query[key];
    if (v === undefined || v === "") continue;
    const n = typeof v === "string" && /^\d{1,9}$/.test(v) ? Number(v) : NaN;
    if (!Number.isInteger(n) || n < (key === "limit" ? 1 : 0) || n > (key === "limit" ? MAX_LIMIT : 1e9)) {
      return { error: `${key} is not valid` };
    }
    out.set(key, String(n));
  }
  const sortBy = query.sortBy;
  if (sortBy !== undefined && sortBy !== "") {
    if (typeof sortBy !== "string" || !/^[A-Za-z]{1,32}$/.test(sortBy)) return { error: "sortBy is not valid" };
    out.set("sortBy", sortBy);
  }
  const order = query.order;
  if (order !== undefined && order !== "") {
    if (order !== "asc" && order !== "desc") return { error: "order is not valid" };
    out.set("order", order);
  }
  return out;
}

/**
 * What the Router said when it refused the filters the caller chose (400/422), or
 * null for any other failure, which is ours or the Router's and stays a 502.
 */
async function refusedFilters(resp: Response): Promise<string | null> {
  if (resp.status !== 400 && resp.status !== 422) return null;
  let reason = "";
  try {
    const body: unknown = await resp.json();
    const e = (body as { error?: unknown } | null)?.error;
    if (typeof e === "string") reason = e.slice(0, MAX_FILTER_LENGTH);
  } catch {
    // The status alone says the filters were refused.
  }
  return reason ? `the agent sandbox router refused the filters: ${reason}` : "the agent sandbox router refused the filters";
}

async function listFromRouter(
  path: UpstreamPath,
  query: Record<string, unknown>,
  user: UserInfo,
  reply: FastifyReply,
): Promise<unknown> {
  const params = buildUpstreamQuery(path, query);
  if ("error" in params) return reply.status(400).send(authErrorPayload("bad_request", params.error));

  const init: RequestInit = { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) };
  if (sandboxAdminSettings.routerAuth) {
    if (!user.platformKey) {
      return reply.status(503).send(authErrorPayload(
        "router_credentials_unavailable",
        "the agent sandbox router requires authentication and this session carries no SaFE API key to present to it",
      ));
    }
    init.headers = { Authorization: `Bearer ${user.platformKey}` };
  }

  const url = `${SANDBOX_ADMIN_URL.replace(/\/+$/, "")}${path}?${params.toString()}`;
  let resp: Response;
  try {
    resp = await fetch(url, init);
  } catch {
    return reply.status(502).send(authErrorPayload("bad_gateway", "the agent sandbox router is unreachable"));
  }
  if (!resp.ok) {
    const refused = await refusedFilters(resp);
    if (refused) return reply.status(400).send(authErrorPayload("bad_request", refused));
    return reply.status(502).send(authErrorPayload("bad_gateway", `the agent sandbox router answered ${resp.status}`));
  }
  let data: unknown;
  try {
    data = await resp.json();
  } catch {
    return reply.status(502).send(authErrorPayload("bad_gateway", "the agent sandbox router answered a body that is not JSON"));
  }
  return { ok: true, data };
}

export async function registerSandboxAdminRoutes(app: FastifyInstance): Promise<void> {
  for (const [route, path] of [
    ["/v1/admin/sandbox/templates", "/v1/templates"],
    ["/v1/admin/sandbox/sessions", "/v1/code-interpreter/sessions"],
  ] as const) {
    app.get<{ Querystring: Record<string, unknown> }>(route, async (req, reply) => {
      const user = getUser(req);
      if (!user) return reply.status(401).send(authErrorPayload("authentication_required", "authentication required"));
      if (!isAdmin(user)) return reply.status(403).send(authErrorPayload("forbidden", "an admin role is required"));
      return listFromRouter(path, req.query, user, reply);
    });
  }
}
