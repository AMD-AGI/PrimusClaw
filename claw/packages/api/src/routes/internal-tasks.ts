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
import { db, inTransaction, type Querier } from "../infra/db.js";

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
  [key: string]: unknown;
}

/**
 * Record which brain is running a task and which sandbox it provisioned.
 *
 * Both columns have existed since the table was created and nothing has ever
 * written to them, which leaves a running task anonymous: an operator with a
 * task id cannot say which pod's logs to read, and the sweeper cannot tell a
 * sandbox belonging to a live run apart from one whose run is long gone --
 * so it deletes neither, and abandoned sandboxes accumulate.
 *
 * Written unconditionally rather than only alongside a successful
 * `preparing -> running` transition, because a redelivered message runs on a
 * different pod with a different sandbox while the row is already `running`;
 * that is precisely the case where stale ownership misdirects a cleanup.
 * Terminal rows are excluded: attributing a sandbox to a finished run would
 * point cleanup at something that has already been torn down.
 *
 * Best-effort. This describes a run rather than driving it, and a failed
 * write must not turn into a rejected status update.
 */
async function recordRunOwnership(
  taskId: string,
  brainId: string | undefined,
  workloadId: string | undefined,
): Promise<void> {
  if (!brainId && !workloadId) return;
  try {
    await db.query(
      `UPDATE claw_tasks
          SET brain_id            = COALESCE($2, brain_id),
              sandbox_workload_id = COALESCE($3, sandbox_workload_id)
        WHERE task_id = $1
          AND status = ANY($4::text[])`,
      [taskId, brainId || null, workloadId || null, RENEWABLE_STATUSES],
    );
  } catch (err) {
    logger.warn(
      { taskId, err: (err as Error)?.message },
      "task.ownership_write_failed",
    );
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
  /** The worker's declaration that this POST is its acceptance of a delivery. */
  accept?: boolean;
  /** The generation the acceptance issued it, quoted on every later renewal. */
  run_claim?: number;
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
 * The `run_phase` object both statements below stamp on the row.
 *
 * Shared rather than built twice: a renewal and an acceptance report the same
 * thing about the same run, and two copies of the mapping is how they would
 * come to disagree about what a wait is.
 */
function runPhaseJson(body: RunLeaseBody): string {
  const phase = body.phase === "waiting" ? "waiting" : "executing";
  return JSON.stringify({
    phase,
    wait_reason: phase === "waiting" ? (body.wait_reason ?? null) : null,
    waited_ms: Math.max(Math.floor(Number(body.waited_ms) || 0), 0),
    waits: Math.max(Math.floor(Number(body.waits) || 0), 0),
    at: new Date().toISOString(),
  });
}

/**
 * The generation the caller quotes, or null when it carries none.
 *
 * @throws {LeaseBodyError} when the field is present but is not a generation.
 */
function runClaimFromBody(body: RunLeaseBody): number | null {
  if (body.run_claim === undefined || body.run_claim === null) return null;
  const parsed = Number(body.run_claim);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new LeaseBodyError("run_claim must be a non-negative integer");
  }
  return parsed;
}

/** A body this endpoint refuses at the boundary, named field and all. */
class LeaseBodyError extends Error {}

/** What either statement did to the row, or null when neither matched. */
interface LeaseGrant {
  status: string;
  /** The row's generation, present only where the statement returns one. */
  claimCount?: number;
}

function grantFrom(rows: unknown[]): LeaseGrant | null {
  const row = rows[0] as { status?: string; claim_count?: number | null } | undefined;
  if (!row?.status) return null;
  return typeof row.claim_count === "number"
    ? { status: row.status, claimCount: row.claim_count }
    : { status: row.status };
}

/**
 * Renew a lease this worker already holds, and record what the run is doing.
 *
 * The lease is the row's own answer to "is anything still running this?", and
 * the answer it replaces was inferred from whether a queue message remained
 * unacknowledged -- which cannot separate a worker that died from one that is
 * slow, and takes the redelivery budget to conclude either. Renewed every few
 * seconds, an expired lease means the worker is gone, within the TTL.
 *
 * The phase is the other half, and the more interesting one: a run holds its
 * slot whether it is calling the model or waiting on a command that has an
 * hour left, and nothing has ever measured which. Accumulated on the row so
 * the ratio can be read per run and across the fleet.
 *
 * This statement writes the expiry, the heartbeat and the phase and nothing
 * else -- never the owner, never the generation, never the receipt -- so a
 * redelivery landing on the pod already named in `lease_owner` can only ever
 * extend that lease. `brain_id` is a pod name rather than a per-claim
 * identity, so matching on it alone would let the previous attempt renew the
 * lease of the successor that took the row over from the same pod and carry on
 * running; the generation is what separates them, and a fenced row admits no
 * renewal that omits it.
 */
async function renewRunLease(
  taskId: string,
  body: RunLeaseBody,
  leaseSec: number,
  runClaim: number | null,
): Promise<LeaseGrant | null> {
  const r = await db.query(
    `UPDATE claw_tasks
        SET lease_expires_at = NOW() + ($3::int * INTERVAL '1 second'),
            heartbeat_at     = NOW(),
            metadata         = jsonb_set(
                                 COALESCE(metadata, '{}'::jsonb),
                                 '{run_phase}',
                                 $4::jsonb,
                                 true
                               )
      WHERE task_id = $1
        AND status = ANY($5::text[])
        AND lease_owner = $2
        AND lease_expires_at IS NOT NULL
        AND (
              COALESCE(claim_count, 0) = $6::int
           OR ($6::int IS NULL AND metadata->>'lease_fenced' IS DISTINCT FROM 'true')
        )
      RETURNING status, claim_count`,
    [taskId, body.brain_id, leaseSec, runPhaseJson(body), RENEWABLE_STATUSES, runClaim],
  );
  return grantFrom(r.rows);
}

/**
 * The rows whose first lease is an acceptance: a fat chat delivery, or a
 * legacy one from before the marker existed, which is the same thing.
 */
const FAT_TARGET_SQL = `origin = 'chat'
  AND (metadata->>'dispatch' = 'fat' OR metadata->>'dispatch' IS NULL)`;

/**
 * At most one row per `(session_id, message_id)` may ever carry holder
 * evidence. Holder evidence rather than a status list: a replayed queued
 * message opens a second row and both are `preparing` with null holder
 * columns, and a status test would refuse both.
 */
const SIBLING_HOLDER_SQL = `EXISTS (
  SELECT 1 FROM claw_tasks sibling
   WHERE sibling.session_id = claw_tasks.session_id
     AND sibling.origin = 'chat'
     AND sibling.task_id <> claw_tasks.task_id
     AND sibling.metadata->>'message_id' IS NOT NULL
     AND sibling.metadata->>'message_id' = claw_tasks.metadata->>'message_id'
     AND (
           sibling.lease_owner IS NOT NULL
        OR sibling.lease_expires_at IS NOT NULL
        OR COALESCE(sibling.claim_count, 0) > 0
     )
)`;

/**
 * Take a fat row's lease, which is how a worker accepts the delivery.
 *
 * `$5` is the acceptance discriminator, which the route binds true for a body
 * declaring `accept: true` and again for a flagless first lease whose renewal
 * matched nothing -- an old Brain, for which this endpoint supplies the
 * acceptance semantics. `$6` is the declaration itself, and only it proves the
 * caller will be fenced and will quote the generation this statement issues
 * it: the takeover arm demands it because a fresh redelivery holds the lease
 * URL and nothing else, so requiring a prior generation there would name a
 * value no admissible taker can hold.
 *
 * Two target shapes and no others: a pristine row, or a fully lapsed lease
 * whose holder was fenced. Owner with no expiry, expiry with no owner and a
 * generation with neither are states no writer here produces, so each is
 * undefined rather than takeable.
 */
async function acquireFatLease(
  q: Querier,
  taskId: string,
  body: RunLeaseBody,
  leaseSec: number,
  declaredAccept: boolean,
): Promise<LeaseGrant | null> {
  const r = await q(
    `UPDATE claw_tasks
        SET lease_owner      = $2,
            lease_expires_at = NOW() + ($3::int * INTERVAL '1 second'),
            heartbeat_at     = NOW(),
            claim_count      = COALESCE(claim_count, 0) + 1,
            metadata         = jsonb_set(
                                 CASE
                                   WHEN metadata->'dispatch_compensation'->>'version' = '1'
                                    AND metadata->'dispatch_compensation'->>'state' = 'armed'
                                   THEN COALESCE(metadata, '{}'::jsonb) - 'dispatch_compensation'
                                   ELSE COALESCE(metadata, '{}'::jsonb)
                                 END || jsonb_build_object('lease_fenced', $6::boolean),
                                 '{run_phase}',
                                 $4::jsonb,
                                 true
                               )
      WHERE task_id = $1
        AND $5::boolean
        AND ${FAT_TARGET_SQL}
        AND status = ANY($7::text[])
        AND (
              (lease_owner IS NULL AND lease_expires_at IS NULL
               AND COALESCE(claim_count, 0) = 0)
           OR (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL
               AND lease_expires_at < NOW()
               AND metadata->>'lease_fenced' = 'true' AND $6::boolean)
        )
        AND NOT ${SIBLING_HOLDER_SQL}
      RETURNING status, claim_count`,
    [
      taskId, body.brain_id, leaseSec, runPhaseJson(body), true, declaredAccept,
      ACQUIRABLE_STATUSES,
    ],
  );
  return grantFrom(r.rows);
}

/**
 * Everything outside the fat set: today's second predicate, unchanged, so a
 * doorbell row and a non-chat task renew and take over an expired lease
 * exactly as they do now, gaining neither a generation nor a disarmed receipt.
 */
async function acquireOrdinaryLease(
  taskId: string,
  body: RunLeaseBody,
  leaseSec: number,
): Promise<LeaseGrant | null> {
  const r = await db.query(
    `UPDATE claw_tasks
        SET lease_owner      = $2,
            lease_expires_at = NOW() + ($3::int * INTERVAL '1 second'),
            heartbeat_at     = NOW(),
            metadata         = jsonb_set(
                                 COALESCE(metadata, '{}'::jsonb),
                                 '{run_phase}',
                                 $4::jsonb,
                                 true
                               )
      WHERE task_id = $1
        AND status = ANY($5::text[])
        AND (
              lease_owner IS NULL
           OR lease_owner = $2
           OR lease_expires_at IS NULL
           OR lease_expires_at < NOW()
        )
      RETURNING status`,
    [taskId, body.brain_id, leaseSec, runPhaseJson(body), RENEWABLE_STATUSES],
  );
  return grantFrom(r.rows);
}

/** The immutable identity an acquisition needs before it can lock or choose. */
interface LeaseTarget {
  sessionId: string | null;
  messageId: string | null;
  fat: boolean;
}

async function readLeaseTarget(taskId: string): Promise<LeaseTarget | null> {
  const r = await db.query(
    `SELECT session_id,
            metadata->>'message_id' AS message_id,
            (${FAT_TARGET_SQL}) AS fat
       FROM claw_tasks WHERE task_id = $1`,
    [taskId],
  );
  const row = r.rows[0] as
    | { session_id?: string | null; message_id?: string | null; fat?: boolean | null }
    | undefined;
  if (!row) return null;
  return {
    sessionId: row.session_id ?? null,
    messageId: row.message_id ?? null,
    fat: row.fat === true,
  };
}

/**
 * Acquire a lease, taking the per-message lock a fat acquisition needs.
 *
 * READ COMMITTED reads the sibling test's rows from a snapshot and locks
 * nothing, so two acquisitions for one logical message can each miss the
 * other's uncommitted evidence and both succeed. The lock is taken in the
 * transaction that runs the UPDATE rather than as a conjunct inside it,
 * because a conjunct is evaluated per candidate row and the planner is free to
 * evaluate the sibling subquery first -- which is the read the lock exists to
 * order. A null `message_id` takes none: it names no logical message to be the
 * second holder of.
 */
async function acquireRunLease(
  taskId: string,
  body: RunLeaseBody,
  leaseSec: number,
  declaredAccept: boolean,
): Promise<LeaseGrant | null> {
  const target = await readLeaseTarget(taskId);
  if (!target) return null;
  if (!target.fat) return acquireOrdinaryLease(taskId, body, leaseSec);
  if (!target.messageId || !target.sessionId) {
    return acquireFatLease(db.query, taskId, body, leaseSec, declaredAccept);
  }
  return inTransaction(async (q) => {
    await q("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [
      target.sessionId, target.messageId,
    ]);
    return acquireFatLease(q, taskId, body, leaseSec, declaredAccept);
  });
}

/**
 * Answer one lease POST: renew what the caller holds, or let it accept.
 *
 * A body without `accept: true` tries renewal first and, while an owner is
 * established, that is the only statement it can match. A body declaring the
 * flag skips renewal outright, so a same-owner live redelivery under the flag
 * is refused rather than extending a lease it was not sent to extend.
 */
async function grantRunLease(
  taskId: string,
  body: RunLeaseBody,
  leaseSec: number,
  runClaim: number | null,
): Promise<LeaseGrant | null> {
  const declaredAccept = body.accept === true;
  if (!declaredAccept) {
    const renewed = await renewRunLease(taskId, body, leaseSec, runClaim);
    if (renewed) return renewed;
  }
  return acquireRunLease(taskId, body, leaseSec, declaredAccept);
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
 * The statuses a caller that holds nothing yet may be granted a lease from.
 * Narrower than the renewable set: an owner may renew through its own
 * cancellation, but a Brain arriving at a row the user has already stopped
 * must not start executing it.
 */
const ACQUIRABLE_STATUSES = ["preparing", "running"];

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
  row: RefusalRow | undefined,
  brainId: string | undefined,
  runClaim: number | null,
): LeaseRefusal {
  if (!row) return "missing";
  if (row.lease_live && row.lease_owner !== (brainId || null)) return "superseded";
  // A sibling row holding the same logical message is the other worker this
  // caller must not touch anything on, whatever this row's own status says.
  if (row.sibling_holds) return "superseded";
  // Every classification follows a refused acquisition -- an established
  // owner's renewal of its own `cancelling` row succeeds and never arrives
  // here -- so a row this caller may not acquire is over as far as it is
  // concerned, and a Brain that has not accepted has nothing to hand back.
  if (!ACQUIRABLE_STATUSES.includes(row.status)) return "terminal";
  // `brain_id` is a pod name, so a pod that took a row over from itself is
  // indistinguishable from its own previous attempt by owner alone: the
  // generation is the only thing that names the loser.
  if (row.lease_fenced && runClaim !== row.claim_count) return "superseded";
  return "unexplained";
}

interface RefusalRow {
  status: string;
  lease_owner: string | null;
  lease_live: boolean | null;
  sibling_holds?: boolean | null;
  lease_fenced?: boolean | null;
  claim_count?: number | null;
}

async function classifyLeaseRefusal(
  taskId: string,
  brainId: string | undefined,
  runClaim: number | null,
): Promise<LeaseRefusal> {
  try {
    const r = await db.query(
      `SELECT status, lease_owner, lease_expires_at > NOW() AS lease_live,
              claim_count,
              metadata->>'lease_fenced' = 'true' AS lease_fenced,
              ${SIBLING_HOLDER_SQL} AS sibling_holds
         FROM claw_tasks WHERE task_id = $1`,
      [taskId],
    );
    const row = r.rows[0] as RefusalRow | undefined;
    const refusal = classifyRow(row, brainId, runClaim);
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
function registerAgentDoneRoute(app: FastifyInstance): void {
  // Brain → Backend: task finished (success / failure / wait_external).
  app.post<{ Params: { taskId: string }; Body: AgentDoneBody }>(
    "/v1/internal/tasks/:taskId/agent_done",
    { preHandler: internalTaskAuth("dispatched") },
    async (req, _reply) => {
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

function registerTaskEventRoute(app: FastifyInstance): void {
  // Brain → Backend: streaming events (assistantTextDelta / toolUse / ...).
  app.post<{ Params: { taskId: string }; Body: TaskEventBody }>(
    "/v1/internal/tasks/:taskId/event",
    { preHandler: internalTaskAuth("dispatched") },
    async (req, _reply) => {
      const { taskId } = req.params;
      const body = req.body ?? {};
      logger.debug(
        { taskId, type: body.type ?? null },
        "task.event.received",
      );
      // Brain reports that the sandbox is up and the engine has started. The
      // dispatcher only ever got the row as far as `preparing`, so without
      // this the row stays there until it goes terminal and `running` is a
      // status nothing can be in.
      //
      // CAS on `preparing` alone, which makes a duplicate or late-arriving
      // signal a no-op: a row that has since been cancelled, swept, or
      // finished must not be dragged back into running.
      if (body.type === "statusUpdate" && body.agent_status === "running") {
        const moved = await transitionStatus(taskId, ["preparing"], "running");
        if (moved) logger.info({ taskId }, "task.running");
        await recordRunOwnership(taskId, body.brain_id, body.sandbox_workload_id);
      }
      // Otherwise accepted and logged, but not forwarded: this does not
      // publish to NATS `events.task.<task_id>`, so nothing fans the event out
      // to the session's SSE subscribers.
      return { ok: true };
    },
  );
}

function registerRunLeaseRoute(app: FastifyInstance): void {
  // Brain → Backend: this run is still alive, and here is what it is doing.
  //
  // Kept apart from the two endpoints above because it says something much
  // smaller than either: not that the run finished, not that its status
  // changed, only that a worker was still there a moment ago. Nothing here
  // moves a row between states or triggers scheduling, which is what makes it
  // safe to call every few seconds for every run in the fleet.
  app.post<{ Params: { taskId: string }; Body: RunLeaseBody }>(
    "/v1/internal/tasks/:taskId/lease",
    { preHandler: internalTaskAuth("lease") },
    async (req, reply) => {
      const { taskId } = req.params;
      const body = req.body ?? {};
      if (!body.brain_id) {
        return reply.status(400).send({ ok: false, error: "brain_id is required" });
      }
      let runClaim: number | null;
      try {
        runClaim = runClaimFromBody(body);
      } catch (err) {
        return reply.status(400).send({ ok: false, error: (err as Error).message });
      }
      const leaseSec = leaseSecondsFromBody(body);
      noteLeaseDisagreement(taskId, leaseSec);
      let grant: LeaseGrant | null;
      try {
        grant = await grantRunLease(taskId, body, leaseSec, runClaim);
      } catch (err) {
        logger.warn({ taskId, err: (err as Error)?.message }, "run.lease_write_failed");
        // Retryable rather than a 200 saying the row is in an unknown state: a
        // mid-run heartbeat may read a failure as transient, but an acceptance
        // must never read one as a lease it now holds.
        return reply.status(503).send({ ok: false, error: "lease unavailable" });
      }
      if (!grant) {
        // The row is terminal, gone, or held by another worker. Told rather
        // than silently accepted, so a worker can find out it is running
        // something nobody is waiting for -- and told which of the three it
        // was, because "two workers on one run" and "this run was cancelled"
        // ask the refused worker for opposite things. One must give its
        // sandbox and its delivery back; the other must leave both alone,
        // because they are the live worker's now.
        const reason = await classifyLeaseRefusal(taskId, body.brain_id, runClaim);
        return reply.status(409).send({ ok: false, error: "run is not active", reason });
      }
      return grant.claimCount === undefined
        ? { ok: true, status: grant.status }
        : { ok: true, status: grant.status, claim_count: grant.claimCount };
    },
  );
}

function registerBackendMcpRoute(app: FastifyInstance): void {
  // Brain → Backend: Backend-side MCP tool call (JSON-RPC 2.0).
  // Supports `initialize`, `tools/list`, `tools/call` per task-design §8.2.
  app.post<{ Params: { taskId: string }; Body: JsonRpcRequest }>(
    "/v1/internal/tasks/:taskId/backend-mcp",
    { preHandler: internalTaskAuth("dispatched") },
    async (req, _reply) => {
      const { taskId } = req.params;
      const body = (req.body ?? {}) as JsonRpcRequest;
      const response = await handleBackendMcpRequest(body, taskId, {
        buildContext: () => buildBackendMcpCtxStub(req, taskId),
        logger,
      });
      return response;
    },
  );
}

export async function registerInternalTaskRoutes(app: FastifyInstance): Promise<void> {
  registerAgentDoneRoute(app);
  registerTaskEventRoute(app);
  registerRunLeaseRoute(app);
  registerBackendMcpRoute(app);
}
