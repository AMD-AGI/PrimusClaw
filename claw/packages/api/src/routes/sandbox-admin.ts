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
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { authErrorPayload, getUser } from "../auth/middleware.js";
import { isAdmin } from "../auth/models.js";
import { SANDBOX_ADMIN_URL } from "../config.js";

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

async function listFromRouter(
  path: UpstreamPath,
  query: Record<string, unknown>,
  reply: FastifyReply,
): Promise<unknown> {
  const params = buildUpstreamQuery(path, query);
  if ("error" in params) return reply.status(400).send(authErrorPayload("bad_request", params.error));

  const url = `${SANDBOX_ADMIN_URL.replace(/\/+$/, "")}${path}?${params.toString()}`;
  let resp: Response;
  try {
    resp = await fetch(url, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  } catch {
    return reply.status(502).send(authErrorPayload("bad_gateway", "the agent sandbox router is unreachable"));
  }
  if (!resp.ok) {
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
      return listFromRouter(path, req.query, reply);
    });
  }
}
