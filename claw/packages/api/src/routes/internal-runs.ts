// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Brain → API claim surface.
 *
 * Separate from the per-task callback routes: a worker claiming a run does
 * not yet hold that run's token. Auth is the cluster-wide internal token
 * only, so one run's lease cannot be used to take another.
 */

import {
  DOORBELL_SEMANTICS_MAX, RUN_FAIL_CLAIM_REASONS, RUN_UNCLAIM_REASONS,
  type RunUnclaimReason,
} from "@claw/protocol";
import { constantTimeEquals, PG_INT4_MAX } from "@claw/utils";
import { metrics } from "../infra/metrics.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import pino from "pino";

import { decodeRunTimeReport } from "@claw/protocol";
import {
  claimNextRun, claimRunById, failHeldClaim, heldClaimReasonFrom, releaseClaim,
  settleFinishedClaim,
  type ClaimedRun, type ClaimNextDiagnostics,
} from "../tasks/run-claim.js";
import type { RunSettlement } from "../tasks/run-time-ledger.js";

const logger = pino({ name: "internal-runs" });

async function clusterInternalAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
  const allowed = process.env.AUTH_INTERNAL_TOKEN || "";
  if (!token || !allowed || !constantTimeEquals(token, allowed)) {
    return reply.status(401).send({ ok: false, error: "internal auth required" }) as unknown as void;
  }
}

function fieldOf(body: unknown, field: string): unknown {
  return body && typeof body === "object"
    ? (body as Record<string, unknown>)[field]
    : undefined;
}

/**
 * The claim generation the caller believes it holds, when it reports one.
 *
 * Absence disables the fence, so a malformed value coerced to it would let a
 * stale release requeue a row somebody else is running. The upper bound is the
 * `claim_count` column's domain: a larger integer raises `22003` at the
 * statement, which the route would report as a server fault.
 */
function claimCountFrom(body: unknown): number | undefined | "invalid" {
  const raw = fieldOf(body, "claim_count");
  if (raw === undefined) return undefined;
  const usable = typeof raw === "number" && Number.isInteger(raw)
    && raw >= 0 && raw <= PG_INT4_MAX;
  return usable ? raw as number : "invalid";
}

const CLAIM_COUNT_INVALID = {
  ok: false,
  error: "claim_count_invalid",
  message: `claim_count must be an integer between 0 and ${PG_INT4_MAX}, or absent`,
} as const;

// Read by the poison guard: only `lock_contention` makes it report a busy
// workspace, so a misspelling fell through to absent names the wrong cause.
const RELEASE_REASONS = new Set<string>(RUN_UNCLAIM_REASONS);
function releaseReasonFrom(body: unknown): RunUnclaimReason | undefined | "invalid" {
  const raw = fieldOf(body, "reason");
  if (raw === undefined) return undefined;
  return typeof raw === "string" && RELEASE_REASONS.has(raw)
    ? raw as RunUnclaimReason
    : "invalid";
}

const RELEASE_REASON_INVALID = {
  ok: false,
  error: "reason_invalid",
  message: `reason must be one of ${RUN_UNCLAIM_REASONS.join(", ")}, or absent`,
} as const;

const FAIL_CLAIM_REASON_INVALID = {
  ok: false,
  error: "reason_invalid",
  message: `reason must be one of ${RUN_FAIL_CLAIM_REASONS.join(", ")}, or absent`,
} as const;

// Absence is a defined value, not a default: a client predating the field
// implements exactly version 1. A malformed value is refused instead.
function doorbellSemanticsFrom(body: unknown): number | "invalid" {
  const raw = fieldOf(body, "doorbell_semantics");
  if (raw === undefined) return 1;
  if (typeof raw !== "number" || !Number.isInteger(raw)) return "invalid";
  if (raw < 1 || raw > DOORBELL_SEMANTICS_MAX) return "invalid";
  return raw;
}

const SEMANTICS_INVALID = {
  ok: false,
  error: "doorbell_semantics_invalid",
  message:
    `doorbell_semantics must be an integer between 1 and ${DOORBELL_SEMANTICS_MAX}, or absent`,
} as const;

/**
 * The attempt's last word on its own time, when the holder sends one.
 *
 * Refused rather than partially accepted: a report that does not decode is a
 * caller this endpoint does not understand, and banking half of it would put
 * numbers in the ledger that no attempt produced.
 */
function settlementFrom(taskId: string, body: unknown): RunSettlement | undefined {
  const raw = body && typeof body === "object"
    ? (body as { run_time?: unknown }).run_time
    : undefined;
  if (raw === undefined) return undefined;
  const decoded = decodeRunTimeReport(raw);
  if (!decoded.ok) {
    logger.warn({ taskId, rejected: decoded.rejected }, "run.release.run_time_rejected");
    return undefined;
  }
  return { report: decoded.report, closeAttempt: true };
}

function releaseLeaseFrom(body: unknown): boolean {
  return body !== null && typeof body === "object"
    && (body as { release_lease?: unknown }).release_lease === true;
}

function brainIdFrom(body: unknown): string {
  const raw = fieldOf(body, "brain_id");
  return typeof raw === "string" && raw.trim() ? raw.trim() : "";
}

// Keyed by the union rather than by `string`, so a new refusal is a compile
// error here rather than an undefined lookup at the exit that reports it.
type ClaimRefusal = Extract<Awaited<ReturnType<typeof claimRunById>>, string>;

const CLAIM_REFUSALS: Record<ClaimRefusal, { status: number; error: string }> = {
  missing: { status: 404, error: "not_found" },
  busy: { status: 409, error: "busy" },
  // The same "come back later" class as busy: the row is untouched and nothing
  // is failed, the fleet simply has no executing headroom yet.
  deferred: { status: 409, error: "deferred" },
  unclaimable: { status: 422, error: "unclaimable" },
};

function registerClaimByIdRoute(app: FastifyInstance): void {
  app.post<{ Params: { taskId: string } }>(
    "/v1/internal/tasks/:taskId/claim",
    { preHandler: clusterInternalAuth },
    async (req, reply) => {
      const brainId = brainIdFrom(req.body);
      if (!brainId) return reply.status(400).send({ ok: false, error: "brain_id_required" });
      const semantics = doorbellSemanticsFrom(req.body);
      if (semantics === "invalid") return reply.status(400).send(SEMANTICS_INVALID);
      let claimed: Awaited<ReturnType<typeof claimRunById>>;
      try {
        claimed = await claimRunById(req.params.taskId, brainId, semantics);
      } catch (err) {
        metrics.onRunClaim("by_id", "error");
        throw err;
      }
      if (typeof claimed === "string") {
        metrics.onRunClaim("by_id", claimed);
        const refusal = CLAIM_REFUSALS[claimed];
        return reply.status(refusal.status).send({ ok: false, error: refusal.error });
      }
      // The reason the row was closed with, not a fixed string: a run that
      // spent its whole budget waiting for one workspace lock reads
      // differently from one that kept crashing, and the archive already
      // distinguishes them.
      if ("kind" in claimed) {
        metrics.onRunClaim("by_id", "exhausted");
        metrics.onRunClaimExhausted("by_id", claimed.reason);
        return reply.status(422).send({ ok: false, error: claimed.reason });
      }
      metrics.onRunClaim("by_id", "claimed");
      logger.info({ taskId: req.params.taskId, brainId }, "run.claim.http");
      // `claim_count` travels with the request so the holder can back off on
      // the row's own retry history; see ClaimedRun.claimCount.
      return { ok: true, request: claimed.request, claim_count: claimed.claimCount };
    },
  );
}

function registerUnclaimRoute(app: FastifyInstance): void {
  app.post<{ Params: { taskId: string } }>(
    "/v1/internal/tasks/:taskId/unclaim",
    { preHandler: clusterInternalAuth },
    async (req, reply) => {
      const brainId = brainIdFrom(req.body);
      if (!brainId) return reply.status(400).send({ ok: false, error: "brain_id_required" });
      const claimCount = claimCountFrom(req.body);
      if (claimCount === "invalid") return reply.status(400).send(CLAIM_COUNT_INVALID);
      const given = releaseReasonFrom(req.body);
      if (given === "invalid") return reply.status(400).send(RELEASE_REASON_INVALID);
      // Absence is the only way to reach the `unspecified` label; a body
      // carrying it as a reason was refused above.
      const reason = given ?? "unspecified";
      let released: boolean;
      try {
        released = await releaseClaim(
          req.params.taskId, brainId, claimCount, given,
          settlementFrom(req.params.taskId, req.body),
        );
      } catch (err) {
        metrics.onRunUnclaim(reason, "error");
        throw err;
      }
      metrics.onRunUnclaim(reason, released ? "accepted" : "not_holder");
      if (!released) return reply.status(409).send({ ok: false, error: "not_holder" });
      return { ok: true };
    },
  );
}

function registerFailClaimRoute(app: FastifyInstance): void {
  app.post<{ Params: { taskId: string } }>(
    "/v1/internal/tasks/:taskId/fail-claim",
    { preHandler: clusterInternalAuth },
    async (req, reply) => {
      const brainId = brainIdFrom(req.body);
      if (!brainId) return reply.status(400).send({ ok: false, error: "brain_id_required" });
      const claimCount = claimCountFrom(req.body);
      if (claimCount === "invalid") return reply.status(400).send(CLAIM_COUNT_INVALID);
      const reason = heldClaimReasonFrom(req.body);
      if (reason === "invalid") return reply.status(400).send(FAIL_CLAIM_REASON_INVALID);
      let failed: boolean;
      try {
        failed = await failHeldClaim(
          req.params.taskId, brainId, reason, claimCount,
          settlementFrom(req.params.taskId, req.body),
        );
      } catch (err) {
        metrics.onRunFailClaim(reason, "error");
        throw err;
      }
      metrics.onRunFailClaim(reason, failed ? "accepted" : "not_holder");
      if (!failed) return reply.status(409).send({ ok: false, error: "not_holder" });
      return { ok: true };
    },
  );
  app.post<{ Params: { taskId: string } }>(
    "/v1/internal/tasks/:taskId/settle-attempt",
    { preHandler: clusterInternalAuth },
    async (req, reply) => {
      const brainId = brainIdFrom(req.body);
      if (!brainId) return reply.status(400).send({ ok: false, error: "brain_id_required" });
      const claimCount = claimCountFrom(req.body);
      if (claimCount === "invalid") return reply.status(400).send(CLAIM_COUNT_INVALID);
      const settled = await settleFinishedClaim(
        req.params.taskId, brainId, claimCount,
        settlementFrom(req.params.taskId, req.body),
        releaseLeaseFrom(req.body),
      );
      if (!settled) return reply.status(409).send({ ok: false, error: "not_holder" });
      return { ok: true };
    },
  );
}

function registerClaimNextRoute(app: FastifyInstance): void {
  app.post(
    "/v1/internal/runs/claim-next",
    { preHandler: clusterInternalAuth },
    async (req, reply) => {
      const brainId = brainIdFrom(req.body);
      if (!brainId) return reply.status(400).send({ ok: false, error: "brain_id_required" });
      const semantics = doorbellSemanticsFrom(req.body);
      if (semantics === "invalid") return reply.status(400).send(SEMANTICS_INVALID);
      // The loop swallows its skips, so the counts come back on a plain struct
      // rather than through a metrics import in the claim core.
      const diag: ClaimNextDiagnostics = { skipped: [], outcome: "empty" };
      let claimed: ClaimedRun | null;
      try {
        claimed = await claimNextRun(brainId, semantics, diag);
      } catch (err) {
        metrics.onRunClaim("next", "error");
        throw err;
      }
      metrics.onRunClaim("next", diag.outcome);
      for (const skip of diag.skipped) {
        metrics.onRunClaimSkipped(skip.cause);
        if (skip.cause === "exhausted") metrics.onRunClaimExhausted("next", skip.exhaustion);
      }
      if (!claimed) return { ok: true, request: null };
      logger.info({ taskId: claimed.request.task_id, brainId }, "run.claim_next.http");
      return { ok: true, request: claimed.request, claim_count: claimed.claimCount };
    },
  );
}

export async function registerInternalRunRoutes(app: FastifyInstance): Promise<void> {
  registerClaimByIdRoute(app);
  registerUnclaimRoute(app);
  registerFailClaimRoute(app);
  registerClaimNextRoute(app);
}
