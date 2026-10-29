// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `GET /v1/me` -- who the caller is and where they can run a sandbox.
 *
 * One document so a page learns its identity, its roles and the workspace to
 * start a chat in with a single request to this API, instead of calling the
 * platform's cluster, workspace and user endpoints itself:
 *
 *   {
 *     "userId": "...", "name"?: "...", "email"?: "...", "roles": ["..."],
 *     "sandbox": { "available": true, "defaultWorkspaceId"?: "...", "gpuProduct"?: "..." },
 *     "workspaces": [ { "id", "name", "scopes": [], "gpuProduct"?, "flavorId"?,
 *                       "clusterId"?, "isDefault"?, "admin": false } ]
 *   }
 *
 * Source: SaFE, asked with the caller's own credential (callerAuthOf) -- the
 * session cookie or `ak-` key the auth middleware accepted -- so the answer is
 * what SaFE itself would tell this user, and nobody else's:
 *   GET /api/v1/workspaces        the workspaces the caller may see
 *   GET /api/v1/clusters          cluster phases
 *   GET /api/v1/users/self        `managedWorkspaces`, which decides `admin`
 * `self` is SaFE's own name for "whoever this credential belongs to", so no
 * identifier from the request (or from this API's idea of the user) reaches a URL.
 *
 * Rules, each one the web client's existing behaviour so that switching to this
 * route changes nothing a user sees:
 *   - `sandbox.available` -- at least one cluster is Ready AND at least one
 *     workspace carries the `Sandbox` scope.
 *   - `sandbox.defaultWorkspaceId` -- the first Sandbox-scoped workspace in the
 *     order SaFE lists them (by name). The client's "current workspace" is only
 *     ever the first workspace it was given, so this is that rule without a
 *     client-side memory. `gpuProduct` is that workspace's.
 *   - `workspaces[].admin` -- the caller manages that workspace. System-wide admin
 *     roles are reported in `roles`; they do not turn every `admin` on.
 *
 * All three reads must succeed. `admin` and `available` are decisions, and a
 * missing read cannot be rendered as "no": answering `admin: false` because the
 * user lookup failed would demote a workspace admin to a plain user on the
 * strength of an outage. A failed read is a failure.
 *
 * Without SaFE to ask -- kubernetes/BYOK mode, or the development auth bypass --
 * there are no workspaces and no cluster: identity and roles are answered from the
 * authenticated user, `workspaces` is empty and `sandbox.available` is false.
 *
 * Failures, `{ error, reason }`, never a 500 for a dependency:
 *   401 authentication_required   no credential this route can forward to SaFE
 *   401 session_rejected          SaFE answered 401: it no longer accepts the caller's
 *                                 credential (a session that lapsed inside the auth
 *                                 middleware's cache window). Signing in again helps.
 *   502 safe_forbidden            SaFE answered 403: the credential is good but this
 *                                 account may not read one of the three documents.
 *                                 Not a 401: signing in again changes nothing, and a
 *                                 client that answers 401 with the login would loop.
 *   503 safe_not_configured       SAFE_API_URL is unset
 *   503 safe_unreachable          DNS / TLS / reset / timeout
 *   502 safe_error                any other non-2xx
 *   502 safe_bad_response         2xx, but not the document expected
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import pino from "pino";
import { callerAuthOf } from "../auth/caller-auth.js";
import { devAuthBypassEnabled, getUser } from "../auth/middleware.js";
import type { UserInfo } from "../auth/models.js";
import { SAFE_API_URL, isKubernetesMode } from "../config.js";
import { UpstreamError, getUpstreamJson } from "../shared/upstream.js";

const logger = pino({ name: "me-route" });

export interface MeWorkspace {
  id: string;
  name: string;
  scopes: string[];
  gpuProduct?: string;
  flavorId?: string;
  clusterId?: string;
  isDefault?: boolean;
  admin: boolean;
}

export interface Me {
  userId: string;
  name?: string;
  email?: string;
  roles: string[];
  sandbox: { available: boolean; defaultWorkspaceId?: string; gpuProduct?: string };
  workspaces: MeWorkspace[];
}

const SANDBOX_SCOPE = "Sandbox";
const READY_PHASE = "Ready";

const asObject = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const nonEmpty = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/** `body.items` as an array of objects, or null when the document is not a list. */
function itemsOf(body: unknown): Record<string, unknown>[] | null {
  const items = asObject(body)?.items;
  // A list endpoint with nothing to list may answer `null` (an unset Go slice).
  if (items === null || items === undefined) return asObject(body) ? [] : null;
  if (!Array.isArray(items)) return null;
  return items.flatMap((i) => { const o = asObject(i); return o ? [o] : []; });
}

/** The ids in the user record's `managedWorkspaces`, or null when it is neither absent nor a list. */
function managedIdsOf(body: unknown): Set<string> | null {
  const record = asObject(body);
  if (!record) return null;
  const managed = record.managedWorkspaces;
  if (managed === null || managed === undefined) return new Set();
  if (!Array.isArray(managed)) return null;
  const ids = new Set<string>();
  for (const m of managed) {
    const id = nonEmpty(asObject(m)?.id);
    if (id) ids.add(id);
  }
  return ids;
}

/**
 * The document, from the three SaFE answers. Null when any of them is not the
 * shape SaFE documents: the caller turns that into a 502 rather than guessing.
 */
export function buildMe(
  user: Pick<UserInfo, "userId" | "userName" | "roles" | "email">,
  workspacesBody: unknown,
  clustersBody: unknown,
  userBody: unknown,
): Me | null {
  const workspaceItems = itemsOf(workspacesBody);
  const clusterItems = itemsOf(clustersBody);
  const managed = managedIdsOf(userBody);
  if (!workspaceItems || !clusterItems || !managed) return null;

  const workspaces: MeWorkspace[] = [];
  for (const w of workspaceItems) {
    const id = nonEmpty(w.workspaceId);
    if (!id) continue;
    const ws: MeWorkspace = {
      id,
      name: nonEmpty(w.workspaceName) ?? id,
      scopes: Array.isArray(w.scopes) ? w.scopes.filter((s): s is string => typeof s === "string") : [],
      admin: managed.has(id),
    };
    const gpuProduct = nonEmpty(w.gpuProduct);
    if (gpuProduct) ws.gpuProduct = gpuProduct;
    const flavorId = nonEmpty(w.flavorId);
    if (flavorId) ws.flavorId = flavorId;
    const clusterId = nonEmpty(w.clusterId);
    if (clusterId) ws.clusterId = clusterId;
    if (typeof w.isDefault === "boolean") ws.isDefault = w.isDefault;
    workspaces.push(ws);
  }

  const anyReadyCluster = clusterItems.some((c) => c.phase === READY_PHASE);
  const defaultSandbox = workspaces.find((w) => w.scopes.includes(SANDBOX_SCOPE));
  const sandbox: Me["sandbox"] = { available: anyReadyCluster && defaultSandbox !== undefined };
  if (defaultSandbox) {
    sandbox.defaultWorkspaceId = defaultSandbox.id;
    if (defaultSandbox.gpuProduct) sandbox.gpuProduct = defaultSandbox.gpuProduct;
  }
  return { ...identityOf(user), sandbox, workspaces };
}

/**
 * Who the caller is, from the authenticated identity (what SaFE's verification
 * reported, or the synthetic one in BYOK / dev modes). `name` and `email` are left
 * out when the account has none, not sent empty.
 */
function identityOf(user: Pick<UserInfo, "userId" | "userName" | "roles" | "email">): Pick<Me, "userId" | "name" | "email" | "roles"> {
  const identity: Pick<Me, "userId" | "name" | "email" | "roles"> = { userId: user.userId, roles: [...user.roles] };
  if (user.userName) identity.name = user.userName;
  if (user.email) identity.email = user.email;
  return identity;
}

function refuse(reply: FastifyReply, status: number, error: string, reason: string): FastifyReply {
  return reply.status(status).send({ error, reason });
}

export async function registerMeRoutes(app: FastifyInstance): Promise<void> {
  app.get("/v1/me", async (req, reply) => {
    // Per-caller data: nothing in between may serve it to someone else.
    reply.header("cache-control", "no-store");
    const user = getUser(req);
    if (!user) return refuse(reply, 401, "authentication_required", "authentication is required");

    // Nothing to ask: the identity is all there is, and saying so beats a failure.
    if (isKubernetesMode() || devAuthBypassEnabled()) {
      return reply.send({ ...identityOf(user), sandbox: { available: false }, workspaces: [] } satisfies Me);
    }
    if (!SAFE_API_URL) return refuse(reply, 503, "safe_not_configured", "SAFE_API_URL is not configured");

    const auth = callerAuthOf(req);
    const headers: Record<string, string> = {};
    if (auth.authorization) headers.authorization = auth.authorization;
    if (auth.cookie) headers.cookie = auth.cookie;
    if (!headers.authorization && !headers.cookie) {
      return refuse(reply, 401, "authentication_required", "no credential that can be presented to SaFE was sent");
    }

    let bodies: [unknown, unknown, unknown];
    try {
      bodies = await Promise.all([
        getUpstreamJson(`${SAFE_API_URL}/api/v1/workspaces`, headers),
        getUpstreamJson(`${SAFE_API_URL}/api/v1/clusters`, headers),
        getUpstreamJson(`${SAFE_API_URL}/api/v1/users/self`, headers),
      ]);
    } catch (err) {
      if (!(err instanceof UpstreamError)) throw err;
      const f = err.failure;
      logger.warn({ kind: f.kind, status: "status" in f ? f.status : null, detail: "detail" in f ? f.detail : null }, "me.upstream_failed");
      if (f.kind === "unreachable") return refuse(reply, 503, "safe_unreachable", "SaFE did not answer");
      if (f.kind === "rejected") {
        // Only a 401 says the credential is no good. SaFE uses 403 for an authorization
        // denial on a credential it accepted, so a 403 must not send the user to the login.
        if (f.status === 401) return refuse(reply, 401, "session_rejected", "SaFE no longer accepts this session; sign in again");
        return refuse(reply, 502, "safe_forbidden", "SaFE does not allow this account to read what this document needs");
      }
      if (f.kind === "http") return refuse(reply, 502, "safe_error", `SaFE answered HTTP ${f.status}`);
      return refuse(reply, 502, "safe_bad_response", "SaFE answered with a document this API cannot read");
    }

    const me = buildMe(user, ...bodies);
    if (!me) return refuse(reply, 502, "safe_bad_response", "SaFE answered with a document this API cannot read");
    return reply.send(me);
  });
}
