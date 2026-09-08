// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Internal task lifecycle endpoints (Brain → Backend; see task-design.md §11.2
 * for the agent_done / event protocol and §8.2 for backend-mcp JSON-RPC).
 *
 * Current status:
 *   - `agent_done` applies the final task outcome via `applyAgentDone`.
 *   - `backend-mcp` is fully handled by `handleBackendMcpRequest` (JSON-RPC
 *     2.0: `initialize`, `tools/list`, `tools/call`).
 *   - `event` is still a stub: it accepts and logs the payload but does not
 *     yet persist/forward it (see the handler below).
 *
 * Authentication: every request must carry `Authorization: Bearer <token>`.
 * We check it against the per-task `claw_tasks.internal_token_hash` first;
 * if that does not match (or the task has no hash yet), we fall back to the
 * legacy `AUTH_INTERNAL_TOKEN` env (the same one Brain-API admin endpoints use).
 * The row's own token is scoped: `lease` accepts it from any row, the three
 * acting routes only from a row that was dispatched with a `callback_url`. See
 * `internalTaskAuth`.
 */
import { createHash } from "node:crypto";
import { constantTimeEquals } from "@claw/utils";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import pino from "pino";
import { handleBackendMcpRequest, type JsonRpcRequest } from "../backend-mcp/index.js";
import type { BackendMcpCtx } from "../backend-mcp/index.js";
import { applyAgentDone, type AgentDonePayload } from "../tasks/lifecycle.js";
import { getTask, transitionStatus } from "../tasks/db.js";
import { effectiveRunLeaseTtlMs, MAX_RUN_LEASE_TTL_MS } from "@claw/protocol";
import { RUN_LEASE_TTL_MS } from "../config.js";
import { db } from "../infra/db.js";
import { decodeRunTimeReport } from "@claw/protocol";
import { bankQueuedTime, mergeRenewal, openAttemptRecordFor } from "../tasks/run-time-ledger.js";

const logger = pino({ name: "internal-tasks" });

/**
 * What a route asks of the row's own token, beyond it being the right token.
 *
 * `lease` is every row: saying "I am still here" is what the lease endpoint is
 * for, and a run that cannot say it is reaped. `dispatched` is the three routes
 * that act -- they move rows between states, wake the scheduler, and resolve a
 * session's `user_id` / `workspace_id` to open the backend tool surface -- and
 * they are only for a run that was dispatched to use them.
 */
type TokenScope = "lease" | "dispatched";

/**
 * Per-task auth (task-design.md §11.2). Accepts either:
 *
 *   1. The per-task token whose sha256 equals
 *      `claw_tasks.internal_token_hash` — canonical path used by the
 *      Brain dispatcher → Brain → Backend round-trip.
 *   2. The cluster-wide `AUTH_INTERNAL_TOKEN` env — fallback for admin /
 *      seed scripts that do not have a task context.
 *
 * All four routes under `/v1/internal/tasks/:taskId/` verify against that one
 * column, so a token accepted for any of them was, until this scope existed,
 * accepted for all of them. `openChatRun` issues a token for lease renewal and
 * withholds `callback_url` on the grounds that the endpoints it names must not
 * be reachable by a shadow row -- but withholding the address is not
 * withholding the authorization, and the URLs are derivable from the task id the
 * worker already has.
 *
 * The distinguishing fact is on the row rather than in a new column: a run meant
 * to use the acting endpoints was dispatched with the `callback_url` that names
 * them, and a chat run deliberately has none. So the row's token opens those
 * three only for a row that carries one. The env fallback is unchanged: it
 * belongs to an operator rather than to a run, and carries no task scope to
 * exceed.
 */
function internalTaskAuth(scope: TokenScope) {
  return async function verifyInternalToken(
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
    if (!token) {
      return reply.status(401).send({ ok: false, error: "internal auth required" }) as any;
    }
    // Path 1: per-task token (preferred).
    const params = (req.params as { taskId?: string } | undefined) ?? {};
    if (params.taskId) {
      try {
        const row = await db.query(
          `SELECT internal_token_hash, callback_url FROM claw_tasks WHERE task_id = $1`,
          [params.taskId],
        );
        const found = row.rows[0] as
          | { internal_token_hash?: string | null; callback_url?: string | null }
          | undefined;
        const hash = found?.internal_token_hash;
        if (hash) {
          const presented = createHash("sha256").update(token).digest("hex");
          if (constantTimeEquals(presented, hash)) {
            if (scope === "lease" || found?.callback_url) return;
            // Reported rather than answered with a bare 401, because this one is
            // not a stale or forged token: it is the row's own, presented to an
            // endpoint the row was never dispatched to use.
            logger.warn(
              { taskId: params.taskId, route: req.url },
              "task.internal_token_out_of_scope",
            );
          }
        }
      } catch { /* fall through to env check */ }
    }
    // Path 2: AUTH_INTERNAL_TOKEN env fallback.
    const allowed = process.env.AUTH_INTERNAL_TOKEN || "";
    if (allowed && constantTimeEquals(token, allowed)) return;
    return reply.status(401).send({ ok: false, error: "internal auth required" }) as any;
  };
}

type AgentDoneBody = AgentDonePayload;

interface TaskEventBody {
  task_id?: string;
  type?: string;
  /** Present on `type: "statusUpdate"`; see the run-started handling below. */
  agent_status?: string;
  /** Which brain picked the run up. Only sent with the run-started signal. */
  brain_id?: string;
  /** The Hands workload provisioned for it, likewise. */
  sandbox_workload_id?: string;
  /** This attempt, so the row can allocate it a generation. */
  attempt_id?: string;
  claim_count?: number;
  delivery_seq?: number;
  delivery_count?: number;
  [key: string]: unknown;
}

/** Best-effort attribution of an active run to its executing brain and sandbox. */
async function recordRunOwnership(taskId: string, body: TaskEventBody): Promise<void> {
  if (!(await writeRunOwnership(taskId, body))) return;
  await bankQueuedTime(taskId).catch(() => { /* best-effort, like the write */ });
  if (body.attempt_id) await openAttemptRecordFor(taskId, body.attempt_id);
}

/** @returns whether the row was in a state that still accepts this attempt. */
async function writeRunOwnership(taskId: string, body: TaskEventBody): Promise<boolean> {
  const brainId = body.brain_id;
  const workloadId = body.sandbox_workload_id;
  const attemptId = body.attempt_id;
  if (!brainId && !workloadId && !attemptId) return false;
  try {
    const r = await db.query(
      `UPDATE claw_tasks
          SET brain_id            = COALESCE($2, brain_id),
              sandbox_workload_id = COALESCE($3, sandbox_workload_id),
              attempt_id          = COALESCE($5, attempt_id),
              attempt_generation  = CASE
                                      WHEN $5::text IS NOT NULL
                                       AND attempt_id IS DISTINCT FROM $5
                                      THEN attempt_generation + 1
                                      ELSE attempt_generation
                                    END,
              delivery_seq        = $6::bigint,
              delivery_count      = $7::bigint
        WHERE task_id = $1
          AND status = ANY($4::text[])
          -- Doorbell delivery pairs stay at (0, 0); each claim advances claim_count.
          AND claim_count = $8::int
          AND (delivery_seq, delivery_count) <= ($6::bigint, $7::bigint)
          AND ($5::text IS NULL OR $5 IS DISTINCT FROM settled_attempt_id)`,
      [
        taskId, brainId || null, workloadId || null, RENEWABLE_STATUSES,
        attemptId ?? null, body.delivery_seq ?? 0, body.delivery_count ?? 0,
        body.claim_count ?? 0,
      ],
    );
    return (r.rowCount ?? 0) > 0;
  } catch (err) {
    logger.warn(
      { taskId, err: (err as Error)?.message },
      "task.ownership_write_failed",
    );
    return false;
  }
}

interface RunLeaseBody {
  brain_id?: string;
  /** How long the row should treat this renewal as valid. Bounded below. */
  lease_seconds?: number;
  /** "executing" or "waiting"; anything else is read as executing. */
  phase?: string;
  wait_reason?: string;
  /** Cumulative milliseconds this run has spent waiting, as the worker sees it. */
  waited_ms?: number;
  waits?: number;
  /** The attempt token (§8). Fail-closed: an omitted field is not a zero. */
  attempt_id?: string;
  claim_count?: number;
  delivery_seq?: number;
  delivery_count?: number;
  /** This attempt's running per-state totals, absent on an identity-only tick. */
  run_time?: unknown;
}

/** The attempt token, or the field that was missing from it. */
type AttemptToken =
  | { ok: true; attemptId: string; claimCount: number; deliverySeq: number; deliveryCount: number }
  | { ok: false; missing: string };

function attemptTokenOf(body: RunLeaseBody): AttemptToken {
  if (typeof body.attempt_id !== "string" || !body.attempt_id) {
    return { ok: false, missing: "attempt_id" };
  }
  for (const field of ["claim_count", "delivery_seq", "delivery_count"] as const) {
    const value = body[field];
    if (typeof value !== "number" || !Number.isFinite(value)) return { ok: false, missing: field };
  }
  return {
    ok: true,
    attemptId: body.attempt_id,
    claimCount: body.claim_count as number,
    deliverySeq: body.delivery_seq as number,
    deliveryCount: body.delivery_count as number,
  };
}

function isLegacyRunLease(body: RunLeaseBody): boolean {
  return typeof body.brain_id === "string" && body.brain_id.trim().length > 0
    && ["attempt_id", "claim_count", "delivery_seq", "delivery_count", "run_time"]
      .every((field) => !Object.hasOwn(body, field));
}

/**
 * Widest lease a worker may ask for. A long one delays noticing a dead pod.
 *
 * Shared with the timing model rather than kept here: the reaper's grace is
 * derived from the lease it is judging, so a cap only this endpoint knew about
 * would have the reaper waiting out a lease no row ever carries.
 */
const MAX_LEASE_SEC = MAX_RUN_LEASE_TTL_MS / 1000;

/**
 * How long this renewal should last.
 *
 * Missing, zero, or unparseable used to collapse to 1 second via
 * `Math.max(..., 1)`, which made the fence expire immediately: any other
 * worker could claim the row while this one was still running. Fall back to
 * the TTL the reaper is judging, then cap so a worker cannot buy more than
 * that reaper will wait.
 */
function leaseSecondsFromBody(body: RunLeaseBody): number {
  const parsed = Math.floor(Number(body.lease_seconds));
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return Math.min(effectiveRunLeaseTtlMs(RUN_LEASE_TTL_MS) / 1000, MAX_LEASE_SEC);
  }
  return Math.min(parsed, MAX_LEASE_SEC);
}

/**
 * Report a fleet whose lease is shorter than the reaper was configured for.
 *
 * The reaper's grace is derived from `RUN_LEASE_TTL_MS`, and both deployments
 * normally read that from the same secret -- but nothing makes them, and a
 * shorter lease on the worker side is the direction that hurts: the verdict
 * arrives that much earlier, which is how a run still waiting for a dead
 * worker's lock gets closed before it can be taken over. The renewal itself
 * carries what the worker believes, so the disagreement is observable here
 * rather than only in the environment nobody re-reads.
 *
 * One line per distinct value: renewals arrive every few seconds per run.
 */
const reportedLeaseSeconds = new Set<number>();
function noteLeaseDisagreement(taskId: string, requestedSec: number): void {
  // Against what the reaper actually derived from, which is the capped value:
  // comparing with the raw setting stays silent about the fleet asking for more
  // than a row can hold, and warns about a difference that is only the cap.
  if (requestedSec * 1000 >= effectiveRunLeaseTtlMs(RUN_LEASE_TTL_MS)) return;
  if (reportedLeaseSeconds.has(requestedSec)) return;
  reportedLeaseSeconds.add(requestedSec);
  logger.warn(
    { taskId, workerLeaseSec: requestedSec, reaperAssumesLeaseMs: RUN_LEASE_TTL_MS },
    "run.lease_shorter_than_reaper_assumes (RUN_LEASE_TTL_MS differs between "
    + "brain and api; the reap grace was derived from api's value)",
  );
}

/**
 * `unavailable` is not a status: the fence never ran, so nothing may be banked,
 * while the caller is still told it is live.
 */
type RenewalOutcome =
  | { kind: "accepted"; status: string }
  | { kind: "refused" }
  | { kind: "unavailable" };

function runPhasePatch(body: RunLeaseBody): string {
  const phase = body.phase === "waiting" ? "waiting" : "executing";
  return JSON.stringify({
    phase,
    wait_reason: phase === "waiting" ? (body.wait_reason ?? null) : null,
    waited_ms: Math.max(Math.floor(Number(body.waited_ms) || 0), 0),
    waits: Math.max(Math.floor(Number(body.waits) || 0), 0),
    at: new Date().toISOString(),
  });
}

/** Renew the lease and return whether its attempt fence was applied. */
async function renewRunLease(
  taskId: string,
  body: RunLeaseBody,
  token: Extract<AttemptToken, { ok: true }>,
): Promise<RenewalOutcome> {
  const leaseSec = leaseSecondsFromBody(body);
  noteLeaseDisagreement(taskId, leaseSec);
  try {
    const r = await db.query(
      `UPDATE claw_tasks
          SET lease_owner      = COALESCE($2, lease_owner),
              lease_expires_at = NOW() + ($3::int * INTERVAL '1 second'),
              heartbeat_at     = NOW(),
              metadata         = jsonb_set(
                                   COALESCE(metadata, '{}'::jsonb),
                                   '{run_phase}',
                                   COALESCE(metadata->'run_phase', '{}'::jsonb) || $4::jsonb,
                                   true
                                 ),
              attempt_id         = $6,
              attempt_generation = CASE WHEN attempt_id IS DISTINCT FROM $6
                                        THEN attempt_generation + 1
                                        ELSE attempt_generation END,
              delivery_seq       = CASE WHEN (delivery_seq, delivery_count)
                                             < ($8::bigint, $9::bigint)
                                        THEN $8::bigint ELSE delivery_seq END,
              delivery_count     = CASE WHEN (delivery_seq, delivery_count)
                                             < ($8::bigint, $9::bigint)
                                        THEN $9::bigint ELSE delivery_count END
        WHERE task_id = $1
          AND status = ANY($5::text[])
          AND (
                lease_owner IS NULL
             OR lease_owner = $2
             OR lease_expires_at IS NULL
             OR lease_expires_at < NOW()
          )
          AND claim_count = $7
          AND (delivery_seq, delivery_count) <= ($8::bigint, $9::bigint)
          -- A settled attempt's token is spent. Clearing attempt_id is what stops
          -- a late heartbeat renewing under it, but a cleared column reads just
          -- like a run no attempt ever opened, which is the adoption arm's
          -- legitimate target -- so the id itself is remembered. (No backticks:
          -- this statement is a template literal.)
          AND $6 IS DISTINCT FROM settled_attempt_id
          AND (
                attempt_id = $6
             OR attempt_id IS NULL
             OR ((delivery_seq, delivery_count) < ($8::bigint, $9::bigint)
                 AND (lease_expires_at IS NULL OR lease_expires_at < NOW()))
          )
        RETURNING status`,
      [
        taskId,
        body.brain_id || null,
        leaseSec,
        runPhasePatch(body),
        RENEWABLE_STATUSES,
        token.attemptId,
        token.claimCount,
        token.deliverySeq,
        token.deliveryCount,
      ],
    );
    const status = (r.rows[0] as { status?: string } | undefined)?.status;
    return status ? { kind: "accepted", status } : { kind: "refused" };
  } catch (err) {
    logger.warn({ taskId, err: (err as Error)?.message }, "run.lease_renew_failed");
    return { kind: "unavailable" };
  }
}

async function renewLegacyRunLease(
  taskId: string, body: RunLeaseBody, authorization: string | undefined,
): Promise<RenewalOutcome> {
  const bearer = authorization?.replace(/^Bearer\s+/i, "") ?? "";
  const tokenHash = createHash("sha256").update(bearer).digest("hex");
  const leaseSec = leaseSecondsFromBody(body);
  noteLeaseDisagreement(taskId, leaseSec);
  try {
    const r = await db.query(
      `UPDATE claw_tasks
          SET lease_owner = $2,
              lease_expires_at = NOW() + ($3::int * INTERVAL '1 second'),
              heartbeat_at = NOW(),
              metadata = jsonb_set(
                COALESCE(metadata, '{}'::jsonb), '{run_phase}',
                COALESCE(metadata->'run_phase', '{}'::jsonb) || $4::jsonb, true)
        WHERE task_id = $1
          AND status = ANY($5::text[])
          -- Claim rotation can race authentication; fence the bearer again here.
          AND internal_token_hash = $6
          -- Generation never clears, so entering the attempt protocol closes this bridge.
          AND attempt_generation = 0
          AND attempt_id IS NULL
          AND settled_attempt_id IS NULL
          AND (delivery_seq, delivery_count) = (0, 0)
          AND (
            lease_owner = $2
            OR (COALESCE(metadata->>'dispatch', '') <> 'doorbell'
                AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at < NOW()))
          )
        RETURNING status`,
      [taskId, body.brain_id, leaseSec, runPhasePatch(body), RENEWABLE_STATUSES, tokenHash],
    );
    const status = (r.rows[0] as { status?: string } | undefined)?.status;
    return status ? { kind: "accepted", status } : { kind: "refused" };
  } catch (err) {
    logger.warn({ taskId, err: (err as Error)?.message }, "run.legacy_lease_renew_failed");
    return { kind: "unavailable" };
  }
}

/**
 * Bank what this renewal covered, against the attempt the row still holds.
 *
 * Two fences, because the UPDATE above commits on its own and a release or
 * takeover can land between it and this read: the nested report must present
 * the token the row accepted, and the row must still hold that attempt.
 */
async function mergeRenewalCoverage(
  taskId: string,
  body: RunLeaseBody,
  token: Extract<AttemptToken, { ok: true }>,
): Promise<void> {
  const decoded = body.run_time === undefined ? null : decodeRunTimeReport(body.run_time);
  if (decoded && !decoded.ok) {
    logger.warn({ taskId, rejected: decoded.rejected }, "run_lease.run_time_rejected");
    return;
  }
  const report = decoded?.report;
  if (report && !sameAttemptToken(report, token)) {
    logger.warn(
      { taskId, tokenAttemptId: token.attemptId, reportAttemptId: report.attemptId },
      "run_lease.run_time_token_mismatch",
    );
    return;
  }
  // Contained for the same reason the renewal's own UPDATE is: a run that is
  // otherwise fine must not be told to stand down because its accounting could
  // not be written.
  const outcome = await mergeRenewal(taskId, token.attemptId, report)
    .catch((err) => {
      logger.warn({ taskId, err: (err as Error)?.message }, "run_lease.run_time_merge_failed");
      return "unavailable" as const;
    });
  if (outcome === "stale") {
    logger.warn({ taskId, attemptId: token.attemptId }, "run_lease.run_time_superseded");
  }
}

/** Whether a nested report speaks for the attempt the lease body presented. */
function sameAttemptToken(
  report: { attemptId: string; claimCount: number; deliverySeq: number; deliveryCount: number },
  token: Extract<AttemptToken, { ok: true }>,
): boolean {
  return report.attemptId === token.attemptId
    && report.claimCount === token.claimCount
    && report.deliverySeq === token.deliverySeq
    && report.deliveryCount === token.deliveryCount;
}

/**
 * Why a renewal was refused, once the refusal has already been decided.
 *
 * Told to the caller as well as the log, because the two answers ask opposite
 * things of it. `superseded` means another worker holds this run: the sandbox,
 * the workspace and the delivery all belong to that worker, and the refused
 * caller must touch none of them. Anything else means nobody holds it, and the
 * caller is the only one who can hand back what it is still holding.
 *
 * `unexplained` when the lookup itself failed, which is deliberately the same
 * answer as `superseded` to a caller: standing down costs a resume, and giving
 * a live worker's sandbox and message away costs the turn.
 */
type LeaseRefusal = "superseded" | "terminal" | "missing" | "unexplained";

/**
 * The statuses a live run can be in. Shared by both UPDATEs above and by the
 * classification below rather than repeated, because the answer the caller
 * acts on is only sound while all three agree on what "still running" means.
 */
const RENEWABLE_STATUSES = ["preparing", "running", "cancelling"];

/**
 * Which of the three refusals this row is.
 *
 * Ordered by how much damage the wrong answer does, which is not symmetric.
 * `superseded` tells the caller to let go of everything quietly, because what
 * it is holding belongs to the worker that took over. `terminal` tells it to
 * stop the sandbox and throw its delivery away -- and the sandbox is shared per
 * session, so a caller told that about a run someone else is driving takes the
 * live worker's sandbox and its message with it.
 *
 * So a live lease in someone else's name is answered first, whatever the status
 * says. Terminal rows keep their lease -- nothing clears `lease_owner` on the
 * way to a terminal state -- so a cancelled row carries a live one for the rest
 * of its TTL, and a worker whose pod stalled long enough to be taken over asks
 * about it in exactly that window.
 *
 * Only then the status, because the lease alone gets one case wrong: the
 * renewal refuses a live, running row only when another worker's lease is
 * unexpired, so if that lease lapses between the two statements the lease reads
 * free while the row is plainly alive. Reading that as `terminal` is the same
 * damage arrived at from the other side. A renewable row with no live rival is
 * neither refusal -- the state moved between two statements -- and
 * `unexplained` costs the caller a resume rather than the turn.
 */
function classifyRow(
  row: { status: string; lease_owner: string | null; lease_live: boolean | null } | undefined,
  brainId: string | undefined,
): LeaseRefusal {
  if (!row) return "missing";
  if (row.lease_live && row.lease_owner !== (brainId || null)) return "superseded";
  if (!RENEWABLE_STATUSES.includes(row.status)) return "terminal";
  return "unexplained";
}

async function classifyLeaseRefusal(
  taskId: string,
  brainId: string | undefined,
): Promise<LeaseRefusal> {
  try {
    const r = await db.query(
      `SELECT status, lease_owner, lease_expires_at > NOW() AS lease_live
         FROM claw_tasks WHERE task_id = $1`,
      [taskId],
    );
    const row = r.rows[0] as
      | { status: string; lease_owner: string | null; lease_live: boolean | null }
      | undefined;
    const refusal = classifyRow(row, brainId);
    logger.warn(
      {
        taskId,
        caller: brainId ?? null,
        status: row?.status ?? "missing",
        leaseOwner: row?.lease_owner ?? null,
        refusal,
      },
      "run.lease_renew_refused",
    );
    return refusal;
  } catch (err) {
    logger.warn({ taskId, err: (err as Error)?.message }, "run.lease_refusal_unexplained");
    return "unexplained";
  }
}

/**
 * Build a {@link BackendMcpCtx} for a JSON-RPC call.
 *
 * Looks up the task via `getTask` and, when it has a `session_id`, the
 * session row too, to fill `user_id` / `workspace_id` (request headers are
 * only used as a fallback for whichever of the two the session lookup
 * doesn't provide). `task`, `dag_root_task_id`, and `dag_node_id` come
 * straight from the task row.
 */
async function buildBackendMcpCtxStub(
  req: FastifyRequest,
  taskId: string,
): Promise<BackendMcpCtx> {
  const task = await getTask(taskId).catch(() => null);
  // Resolve user_id / workspace_id from the task's session so the backend
  // MCP handler does not have to trust caller-provided headers.
  let userId = (req.headers["x-user-id"] as string | undefined) ?? "";
  let workspaceId = (req.headers["x-workspace-id"] as string | undefined) ?? "";
  if (task?.session_id) {
    try {
      const r = await db.query(
        `SELECT user_id, config FROM claw_sessions WHERE session_id = $1`,
        [task.session_id],
      );
      if ((r.rowCount ?? 0) > 0) {
        const row = r.rows[0] as { user_id: string | null; config: Record<string, unknown> | null };
        if (!userId) userId = row.user_id ?? "";
        const cfg = (row.config ?? {}) as Record<string, unknown>;
        if (!workspaceId && typeof cfg.workspace_id === "string") workspaceId = cfg.workspace_id;
      }
    } catch { /* best-effort */ }
  }
  return {
    task_id: taskId,
    task: task ? (task as unknown as Record<string, unknown>) : null,
    session_id: task?.session_id ?? ((req.headers["x-session-id"] as string | undefined) ?? ""),
    user_id: userId,
    workspace_id: workspaceId,
    plugin_id: task?.plugin_id ?? undefined,
    dag_root_task_id: task?.dag_root_task_id ?? undefined,
    dag_node_id: task?.dag_node_id ?? undefined,
    log: logger,
    abortSignal: new AbortController().signal,
  };
}

/**
 * Register the three Brain → Backend lifecycle endpoints.
 *
 * Mount path: `/v1/internal/tasks/:taskId/{agent_done,event,backend-mcp}`.
 */
export async function registerInternalTaskRoutes(app: FastifyInstance): Promise<void> {
  registerAgentDoneRoute(app);
  registerEventRoute(app);
  registerLeaseRoute(app);
  registerBackendMcpRoute(app);
}

/** Brain → Backend: task finished (success / failure / wait_external). */
function registerAgentDoneRoute(app: FastifyInstance): void {
  app.post<{ Params: { taskId: string }; Body: AgentDoneBody }>(
    "/v1/internal/tasks/:taskId/agent_done",
    { preHandler: internalTaskAuth("dispatched") },
    async (req) => {
      const { taskId } = req.params;
      const body = req.body ?? {};
      logger.info(
        {
          taskId,
          abortReason: body.abort_reason ?? null,
          turns: body.turns ?? null,
          captures: body.captures ? Object.keys(body.captures) : [],
          artifacts: body.artifacts?.length ?? 0,
        },
        "task.agent_done.received",
      );
      await applyAgentDone(taskId, body);
      return { ok: true };
    },
  );
}

/** Brain → Backend: streaming events (assistantTextDelta / toolUse / ...). */
function registerEventRoute(app: FastifyInstance): void {
  app.post<{ Params: { taskId: string }; Body: TaskEventBody }>(
    "/v1/internal/tasks/:taskId/event",
    { preHandler: internalTaskAuth("dispatched") },
    async (req) => {
      const { taskId } = req.params;
      const body = req.body ?? {};
      logger.debug({ taskId, type: body.type ?? null }, "task.event.received");
      // CAS on `preparing` alone, which makes a duplicate or late-arriving
      // signal a no-op: a row that has since been cancelled, swept, or
      // finished must not be dragged back into running.
      if (body.type === "statusUpdate" && body.agent_status === "running") {
        const moved = await transitionStatus(taskId, ["preparing"], "running");
        if (moved) logger.info({ taskId }, "task.running");
        await recordRunOwnership(taskId, body);
      }
      // Otherwise accepted and logged, but not forwarded: this does not
      // publish to NATS `events.task.<task_id>`, so nothing fans the event out
      // to the session's SSE subscribers.
      return { ok: true };
    },
  );
}

/**
 * Brain → Backend: this run is still alive, and here is what it is doing.
 *
 * Kept apart from the two endpoints above because it says something much
 * smaller than either: not that the run finished, not that its status changed,
 * only that a worker was still there a moment ago. Nothing here moves a row
 * between states or triggers scheduling, which is what makes it safe to call
 * every few seconds for every run in the fleet.
 */
function registerLeaseRoute(app: FastifyInstance): void {
  app.post<{ Params: { taskId: string }; Body: RunLeaseBody }>(
    "/v1/internal/tasks/:taskId/lease",
    { preHandler: internalTaskAuth("lease") },
    async (req, reply) => {
      const { taskId } = req.params;
      const body = req.body ?? {};
      const token = attemptTokenOf(body);
      if (!token.ok && !isLegacyRunLease(body)) {
        // A partial modern token must never fall back to the legacy bridge.
        logger.warn({ taskId, missing: token.missing }, "run_lease.missing_attempt_token");
        return reply.status(400).send({
          ok: false, error: `attempt token incomplete: ${token.missing} is required`,
        });
      }
      const outcome = token.ok
        ? await renewRunLease(taskId, body, token)
        : await renewLegacyRunLease(taskId, body, req.headers.authorization);
      if (outcome.kind === "accepted") {
        if (token.ok) await mergeRenewalCoverage(taskId, body, token);
        return { ok: true, status: outcome.status };
      }
      // Nothing was banked: the fence never matched, so the coverage this body
      // carries belongs to a ledger this caller may no longer write.
      if (outcome.kind === "unavailable") return { ok: true, status: "unknown" };
      // Told which of the three refusals it was, because "two workers on one
      // run" and "this run was cancelled" ask the refused worker for opposite
      // things: one must give its sandbox and its delivery back, the other
      // must leave both alone, because they are the live worker's now.
      const reason = await classifyLeaseRefusal(taskId, body.brain_id);
      return reply.status(409).send({ ok: false, error: "run is not active", reason });
    },
  );
}

/**
 * Brain → Backend: Backend-side MCP tool call (JSON-RPC 2.0).
 * Supports `initialize`, `tools/list`, `tools/call` per task-design §8.2.
 */
function registerBackendMcpRoute(app: FastifyInstance): void {
  app.post<{ Params: { taskId: string }; Body: JsonRpcRequest }>(
    "/v1/internal/tasks/:taskId/backend-mcp",
    { preHandler: internalTaskAuth("dispatched") },
    async (req) => {
      const { taskId } = req.params;
      const body = (req.body ?? {}) as JsonRpcRequest;
      return handleBackendMcpRequest(body, taskId, {
        buildContext: () => buildBackendMcpCtxStub(req, taskId),
        logger,
      });
    },
  );
}
