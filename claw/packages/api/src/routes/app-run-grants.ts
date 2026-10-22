// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * App-run grant API.
 *
 *   GET  /.well-known/jwks.json
 *   POST   /v1/internal/app-runs/:appRunId/grant
 *   GET    /v1/internal/app-runs/:appRunId/grant
 *   PATCH  /v1/internal/app-runs/:appRunId/grant
 *   DELETE /v1/internal/app-runs/:appRunId/grant
 *
 * The JWKS route publishes public keys. The grant routes use the cluster
 * internal token and return the role keys for injection.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { internalTokenAuth } from "../auth/middleware.js";
import { GrantClientError } from "../grants/client.js";
import { jwksDocument } from "../grants/attestation.js";
import { extendAppRunGrant, openAppRunGrant, readAppRunGrant, revokeAppRunGrant, type OpenAppRunInput } from "../grants/lifecycle.js";

/** Register the JWKS document and the app-run grant routes. */
export async function registerAppRunGrantRoutes(app: FastifyInstance): Promise<void> {
  app.get("/.well-known/jwks.json", async (_req, reply) => {
    try {
      return jwksDocument();
    } catch (err) {
      return reply.status(503).send({
        code: 503,
        reason: "grant_signing_unavailable",
        message: err instanceof Error ? err.message : "grant signing key is not configured",
      });
    }
  });

  const auth = { preHandler: internalTokenAuth };
  app.post("/v1/internal/app-runs/:appRunId/grant", auth, async (req, reply) => {
    try {
      const body = (req.body ?? {}) as Partial<OpenAppRunInput>;
      const opened = await openAppRunGrant(openInput(req, body));
      return reply.status(opened.reused ? 200 : 201).send(opened);
    } catch (err) {
      return sendGrantError(reply, err);
    }
  });
  app.get("/v1/internal/app-runs/:appRunId/grant", auth, async (req, reply) => {
    try {
      return await readAppRunGrant(appRunIdOf(req));
    } catch (err) {
      return sendGrantError(reply, err);
    }
  });
  app.patch("/v1/internal/app-runs/:appRunId/grant", auth, async (req, reply) => {
    try {
      const body = (req.body ?? {}) as { expiresAt?: string };
      const expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
      if (!expiresAt || Number.isNaN(expiresAt.getTime())) {
        return reply.status(400).send({ code: 400, reason: "invalid_grant", message: "expiresAt is required" });
      }
      return await extendAppRunGrant(appRunIdOf(req), expiresAt);
    } catch (err) {
      return sendGrantError(reply, err);
    }
  });
  app.delete("/v1/internal/app-runs/:appRunId/grant", auth, async (req, reply) => {
    try {
      await revokeAppRunGrant(appRunIdOf(req));
      return reply.status(204).send();
    } catch (err) {
      return sendGrantError(reply, err);
    }
  });
}

function openInput(req: FastifyRequest, body: Partial<OpenAppRunInput>): OpenAppRunInput {
  return {
    appRunId: appRunIdOf(req),
    userId: body.userId || "",
    userName: body.userName || "",
    workspaces: body.workspaces || [],
    platformKey: body.platformKey || "",
    sessionId: body.sessionId || "",
    demand: body.demand,
    limits: body.limits,
    templates: body.templates,
    kinds: body.kinds,
    startAt: body.startAt ? new Date(body.startAt) : undefined,
  };
}

function appRunIdOf(req: FastifyRequest): string {
  const params = req.params as { appRunId?: string };
  return params.appRunId || "";
}

function sendGrantError(reply: FastifyReply, err: unknown) {
  if (err instanceof GrantClientError) {
    return reply.status(err.status).send({ code: err.status, reason: err.reason, message: err.message });
  }
  const message = err instanceof Error ? err.message : "grant request failed";
  const reason = message.includes("signing key") ? "grant_signing_unavailable" : "grant_request_failed";
  const status = reason === "grant_signing_unavailable" ? 503 : 500;
  return reply.status(status).send({ code: status, reason, message });
}
