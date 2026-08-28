// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Brain → API claim surface.
 *
 * Separate from the per-task callback routes: a worker claiming a run does
 * not yet hold that run's token. Auth is the cluster-wide internal token
 * only, so one run's lease cannot be used to take another.
 */

import { constantTimeEquals } from "@claw/utils";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import pino from "pino";

import {
  claimNextRun, claimRunById, failHeldClaim, heldClaimReasonFrom, releaseClaim,
} from "../tasks/run-claim.js";

const logger = pino({ name: "internal-runs" });

async function clusterInternalAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
  const allowed = process.env.AUTH_INTERNAL_TOKEN || "";
  if (!token || !allowed || !constantTimeEquals(token, allowed)) {
    return reply.status(401).send({ ok: false, error: "internal auth required" }) as unknown as void;
  }
}

/** The claim generation the caller believes it holds, when it reports one. */
function claimCountFrom(body: unknown): number | undefined {
  const raw = body && typeof body === "object"
    ? (body as { claim_count?: unknown }).claim_count
    : undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}

/** Why the holder is giving the row back, when it says. Recorded for the poison guard. */
// "retry" is the honest default for a nak whose cause is not a lock -- a
// retryable model error, an undelivered agent_done, a shutdown checkpoint.
// Only "lock_contention" makes the poison guard report a busy workspace.
const RELEASE_REASONS = new Set(["lock_contention", "retry", "drain", "hydrate_failed"]);
function releaseReasonFrom(body: unknown): string | undefined {
  const raw = body && typeof body === "object"
    ? (body as { reason?: unknown }).reason
    : undefined;
  return typeof raw === "string" && RELEASE_REASONS.has(raw) ? raw : undefined;
}

function brainIdFrom(body: unknown): string {
  const raw = body && typeof body === "object" ? (body as { brain_id?: unknown }).brain_id : undefined;
  return typeof raw === "string" && raw.trim() ? raw.trim() : "";
}

export async function registerInternalRunRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { taskId: string } }>(
    "/v1/internal/tasks/:taskId/claim",
    { preHandler: clusterInternalAuth },
    async (req, reply) => {
      const brainId = brainIdFrom(req.body);
      if (!brainId) return reply.status(400).send({ ok: false, error: "brain_id_required" });
      const claimed = await claimRunById(req.params.taskId, brainId);
      if (claimed === "missing") return reply.status(404).send({ ok: false, error: "not_found" });
      if (claimed === "busy") return reply.status(409).send({ ok: false, error: "busy" });
      if (claimed === "unclaimable") return reply.status(422).send({ ok: false, error: "unclaimable" });
      // The reason the row was closed with, not a fixed string: a run that
      // spent its whole budget waiting for one workspace lock reads
      // differently from one that kept crashing, and the archive already
      // distinguishes them.
      if (typeof claimed !== "string" && "kind" in claimed) {
        return reply.status(422).send({ ok: false, error: claimed.reason });
      }
      logger.info({ taskId: req.params.taskId, brainId }, "run.claim.http");
      // `claim_count` travels with the request so the holder can back off on
      // the row's own retry history; see ClaimedRun.claimCount.
      return { ok: true, request: claimed.request, claim_count: claimed.claimCount };
    },
  );

  app.post<{ Params: { taskId: string } }>(
    "/v1/internal/tasks/:taskId/unclaim",
    { preHandler: clusterInternalAuth },
    async (req, reply) => {
      const brainId = brainIdFrom(req.body);
      if (!brainId) return reply.status(400).send({ ok: false, error: "brain_id_required" });
      const released = await releaseClaim(
        req.params.taskId, brainId, claimCountFrom(req.body), releaseReasonFrom(req.body),
      );
      if (!released) return reply.status(409).send({ ok: false, error: "not_holder" });
      return { ok: true };
    },
  );

  app.post<{ Params: { taskId: string } }>(
    "/v1/internal/tasks/:taskId/fail-claim",
    { preHandler: clusterInternalAuth },
    async (req, reply) => {
      const brainId = brainIdFrom(req.body);
      if (!brainId) return reply.status(400).send({ ok: false, error: "brain_id_required" });
      const failed = await failHeldClaim(
        req.params.taskId,
        brainId,
        heldClaimReasonFrom(req.body),
        claimCountFrom(req.body),
      );
      if (!failed) return reply.status(409).send({ ok: false, error: "not_holder" });
      return { ok: true };
    },
  );

  app.post(
    "/v1/internal/runs/claim-next",
    { preHandler: clusterInternalAuth },
    async (req, reply) => {
      const brainId = brainIdFrom(req.body);
      if (!brainId) return reply.status(400).send({ ok: false, error: "brain_id_required" });
      const claimed = await claimNextRun(brainId);
      if (!claimed) return { ok: true, request: null };
      logger.info({ taskId: claimed.request.task_id, brainId }, "run.claim_next.http");
      return { ok: true, request: claimed.request, claim_count: claimed.claimCount };
    },
  );
}
