// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Give a worker the execute request a doorbell named.
 *
 * The row holds a secret-free spec plus a sealed credential blob. Claim is
 * the only moment the blob is opened, the user-env vault is read, and a
 * lease token is issued. Two workers cannot both succeed: the UPDATE is a
 * CAS on an expired-or-absent lease.
 */

import { createHash, randomBytes } from "node:crypto";
import type { ExecuteRequest, RunLease } from "@claw/protocol";
import pino from "pino";

import { RUN_LEASE_TTL_MS, TASK_POISON_DELIVERY_COUNT } from "../config.js";
import { loadUserEnvSnapshot } from "../crypto/user-env.js";
import { db } from "../infra/db.js";
import { buildMessages } from "../sessions/context-builder.js";
import { publishEvent } from "../events/store.js";
import { releaseRunUse } from "../workspace/store.js";
import { deadlineStampSql, RUN_BUDGET_DEFAULT_SEC, RUN_REQUEUE_RESET_SQL } from "./run-budget.js";
import { RUN_CREDENTIALS_FIELD } from "./run-spec.js";
import { openRunCredentials, RunCredentialFault } from "./run-secrets.js";
import type { ClawTaskRow } from "./types.js";

const logger = pino({ name: "run-claim" });

export const runClaimPorts = {
  publishSessionEvent: publishEvent,
  buildHistory: buildMessages,
};

const INTERNAL_BACKEND_URL =
  process.env.INTERNAL_BACKEND_URL || `http://127.0.0.1:${process.env.API_PORT || "8200"}`;

const CLAIMABLE = ["queued", "preparing"] as const;

/** A row the poison guard closed, and what it recorded as the cause. */
export interface ExhaustedClaim {
  kind: "exhausted";
  reason: "lock_contention_exhausted" | "max_retries_exceeded";
}

/**
 * Why a row ran out of claims, from the last holder's own account.
 *
 * Shared by the row, the user-facing announcement and the HTTP answer. Those
 * used to disagree: the archive said the workspace had been busy while the 422
 * said only that retries ran out.
 */
export function exhaustionReasonOf(
  row: ClawTaskRow,
): "lock_contention_exhausted" | "max_retries_exceeded" {
  return row.metadata?.last_release === "lock_contention"
    ? "lock_contention_exhausted"
    : "max_retries_exceeded";
}

export interface ClaimedRun {
  request: ExecuteRequest;
  lease: RunLease;
  /**
   * How many times this row has been claimed, this claim included.
   *
   * Reported to the holder because it is the only durable record of how often
   * a run has been handed out and given back, and the holder needs it to back
   * off like the fat path does. A claimed doorbell has no JetStream delivery
   * count to grow -- the wakeup was acked at claim time -- so without this the
   * contention retry restarts at the first delay every cycle while the count
   * this number reports keeps climbing toward the poison ceiling.
   */
  claimCount: number;
}

export async function claimRunById(
  taskId: string,
  brainId: string,
): Promise<ClaimedRun | "missing" | "busy" | "unclaimable" | ExhaustedClaim> {
  const taken = await takeClaim(taskId, brainId);
  if (taken === "missing" || taken === "busy") return taken;
  if (claimCountOf(taken) >= TASK_POISON_DELIVERY_COUNT) {
    const closed = await failExhaustedClaim(taken);
    if (!closed) {
      await releaseClaim(taken.task_id, brainId, claimCountOf(taken)).catch(() => {});
      return "busy";
    }
    return { kind: "exhausted", reason: exhaustionReasonOf(taken) };
  }
  try {
    const claimed = await assembleClaim(taken, brainId);
    await injectLiveUserEnv(claimed.request);
    return claimed;
  } catch (err) {
    logger.error({ err, taskId, brainId }, "run.claim.hydrate_failed");
    // Any failure to open the spec is terminal for this row, not transient.
    // Only an absent blob used to be treated that way, so a blob that was
    // present but unreadable -- truncated, or written under a master key this
    // replica no longer has -- fell through to the release below and came
    // straight back through claim-next, failing identically each time until
    // `claim_count` ran out. Twenty-two claims of a 500, then a row archived
    // as retries-exhausted, for a fault no retry could have fixed.
    if (isCredentialFault(err)) {
      await markUnclaimable(taskId);
      return "unclaimable";
    }
    await releaseClaim(taskId, brainId, claimCountOf(taken)).catch(() => {});
    throw err;
  }
}

const CLAIM_NEXT_ATTEMPTS = 8;

export async function claimNextRun(brainId: string): Promise<ClaimedRun | null> {
  const skip: string[] = [];
  for (let i = 0; i < CLAIM_NEXT_ATTEMPTS; i++) {
    const taskId = await peekNextQueued(skip);
    if (!taskId) return null;
    // A hydrate failure that is not about credentials is rethrown by
    // claimRunById, and it used to leave through here: no catch on this loop
    // and none on the route, so the whole cycle answered 500. The row itself
    // is fine -- releaseClaim already put it back -- so the honest response is
    // to pass over it and offer the caller the next one. Since B1 the rebuild
    // reads the conversation, and nothing in buildMessages catches, so an
    // ordinary database blip reaches here.
    let claimed: Awaited<ReturnType<typeof claimRunById>>;
    try {
      claimed = await claimRunById(taskId, brainId);
    } catch (err) {
      logger.warn({ err, taskId, brainId }, "run.claim_next.skipped_after_error");
      skip.push(taskId);
      continue;
    }
    if (typeof claimed === "string" || "kind" in claimed) {
      skip.push(taskId);
      continue;
    }
    return claimed;
  }
  return null;
}

async function peekNextQueued(skip: string[]): Promise<string | null> {
  const r = await db.query(
    `SELECT task_id FROM claw_tasks
      WHERE status = 'queued'
        AND origin = 'chat'
        AND executor = 'brain'
        AND metadata->>'dispatch' = 'doorbell'
        AND (lease_expires_at IS NULL OR lease_expires_at < NOW())
        -- Same refusal requeueLostDoorbellLeases makes, for the same reason: a
        -- run whose budget is already spent has nothing to spend. A requeue
        -- resets queued_at and deliberately not deadline_at, so after one the
        -- queue-timeout reaper waits another RUN_QUEUE_MAX_SEC before it looks
        -- at the row while its deadline may already be behind it. Handing it
        -- out in that window boots a workspace and a sandbox only to abort on
        -- run_budget_exhausted -- and the claim installs a fresh lease, which
        -- takes the row out of reapExpiredDoorbellRuns' reach on the way past.
        AND (deadline_at IS NULL OR deadline_at > NOW())
        AND NOT (task_id = ANY($1::text[]))
      ORDER BY
        priority DESC,
        COALESCE(queued_at, created_at) ASC,
        created_at ASC
      LIMIT 1`,
    [skip],
  );
  return (r.rows[0] as { task_id?: string } | undefined)?.task_id ?? null;
}

async function markUnclaimable(taskId: string): Promise<void> {
  const r = await db.query(
    `UPDATE claw_tasks
        SET status = 'failed',
            failure_reason = 'unclaimable',
            error_message = 'run spec could not be hydrated at claim time',
            completed_at = NOW(),
            lease_owner = NULL,
            lease_expires_at = NULL,
            heartbeat_at = NULL,
            internal_token_hash = NULL
      WHERE task_id = $1
        AND status IN ('queued','preparing')
      RETURNING *`,
    [taskId],
  ).catch((err) => {
    logger.warn({ err, taskId }, "run.claim.mark_unclaimable_failed");
    return { rows: [], rowCount: 0 };
  });
  const row = r.rows[0] as ClawTaskRow | undefined;
  if (!row) return;
  await releaseRunUse(taskId, false);
  await announceClaimFailure(
    row,
    "unclaimable",
    "Task failed: this run could not be started. Please send a new message.",
  );
}

/**
 * Hand a claimed row back, if this caller still holds the claim it took.
 *
 * `claimCount` is the generation, and without it this statement is unsafe.
 * `lease_owner` alone cannot say *which* claim is being released: `BRAIN_ID`
 * is the pod name, so it is the same string across every claim that pod ever
 * takes on the row. A release that arrives late therefore matches a claim it
 * knows nothing about.
 *
 * Late is the normal case, not an exotic one. Lock contention defers the retry
 * by `lockContentionNakMs`, which climbs to five minutes, while the lease is
 * forty-five seconds and nothing renews it for a run that never started. So
 * the lease lapses mid-wait, `requeueLostDoorbellLeases` puts the row back,
 * claim-next hands it to a replica -- one time in N, the same pod -- and that
 * replica starts executing. When the original timer finally fires, matching on
 * owner alone would yank a running row back onto the queue, where a third
 * claim would start a second agent loop for one turn, with nothing logged
 * anywhere to say so.
 *
 * `claim_count` is incremented by every `takeClaim`, so comparing it pins the
 * release to the exact claim that asked for it. A stale release matches
 * nothing and returns false, which is the right answer: whoever holds the row
 * now is entitled to it.
 *
 * The parameter is optional so a worker too old to report its generation keeps
 * the previous behaviour rather than being unable to release at all.
 */
export async function releaseClaim(
  taskId: string,
  brainId: string,
  claimCount?: number,
  reason?: string,
): Promise<boolean> {
  const r = await db.query(
    `UPDATE claw_tasks
        SET status = 'queued',
            lease_owner = NULL,
            lease_expires_at = NULL,
            heartbeat_at = NULL,
            internal_token_hash = NULL,
            metadata = CASE
                         WHEN $4::text IS NULL THEN metadata
                         ELSE metadata || jsonb_build_object('last_release', $4::text)
                       END,
            ${RUN_REQUEUE_RESET_SQL}
      WHERE task_id = $1
        AND lease_owner = $2
        AND status IN ('queued','preparing','running')
        AND ($3::int IS NULL OR claim_count = $3)
      RETURNING task_id`,
    [taskId, brainId, claimCount ?? null, reason ?? null],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Why the holder is ending a claim instead of putting the row back.
 *
 * `session_deleted` is the tombstone loop: unclaiming would let the next idle
 * replica take the same row, see the same mark, and unclaim again.
 * `claim_abandoned` is a doorbell `term()`: the JetStream wakeup is already
 * acked, so terminate means fail the row, not "the session was deleted".
 * `workspace_unbound` is a claimed run the gate cannot serialise: there is no
 * `callback_url` on a chat row, so `agent_done` would leave it preparing.
 */
export type HeldClaimFailureReason =
  | "session_deleted"
  | "claim_abandoned"
  | "workspace_unbound";

const HELD_CLAIM_MESSAGE: Record<HeldClaimFailureReason, string> = {
  session_deleted: "the session this run belonged to was deleted",
  claim_abandoned: "the holder settled the claimed run without completing it",
  workspace_unbound: "the run was not bound to a workspace, so it cannot be serialised",
};

const HELD_CLAIM_REASONS = new Set<string>(Object.keys(HELD_CLAIM_MESSAGE));

export function heldClaimReasonFrom(body: unknown): HeldClaimFailureReason {
  const raw = body && typeof body === "object" ? (body as { reason?: unknown }).reason : undefined;
  return typeof raw === "string" && HELD_CLAIM_REASONS.has(raw)
    ? raw as HeldClaimFailureReason
    : "session_deleted";
}

/**
 * Close a claimed row for good. Generation-guarded for the same reason
 * {@link releaseClaim} is, and more sharply: a stale release only requeues,
 * while a stale fail is terminal for a run somebody else is executing.
 */
export async function failHeldClaim(
  taskId: string,
  brainId: string,
  reason: HeldClaimFailureReason = "session_deleted",
  claimCount?: number,
): Promise<boolean> {
  const r = await db.query(
    `UPDATE claw_tasks
        SET status = 'failed',
            failure_reason = $3,
            error_message = $4,
            completed_at = NOW(),
            lease_owner = NULL,
            lease_expires_at = NULL,
            heartbeat_at = NULL,
            internal_token_hash = NULL
      WHERE task_id = $1
        AND lease_owner = $2
        AND origin = 'chat'
        AND status IN ('queued','preparing','running')
        AND ($5::int IS NULL OR claim_count = $5)
      RETURNING task_id`,
    [taskId, brainId, reason, HELD_CLAIM_MESSAGE[reason], claimCount ?? null],
  );
  if ((r.rowCount ?? 0) === 0) return false;
  await releaseRunUse(taskId, false);
  return true;
}

/**
 * Take a row, if it is free and no sibling is already running this turn.
 *
 * The sibling clause is what replaces a guarantee the doorbell path lost. A
 * dispatch retried after the row was written but before its queue entry was
 * deleted opens a second row carrying the same `metadata->>'message_id'`. On
 * the fat path that was harmless: the republish went out under the same
 * message id, the stream's duplicate window dropped it, and the spare row sat
 * at `preparing` with nothing to execute it -- which is the assumption
 * `closeUnclaimedDispatchSiblings` is built on.
 *
 * Claim-next never consults the stream. It selects on row state alone, so the
 * spare is exactly as claimable as the original, and the turn ran twice: two
 * agent loops, two answers to one message, two bills. Refusing the claim while
 * a sibling of the same message id is executing puts the spare back where the
 * fat path left it, and `closeChatRun` -- which matches by message id and now
 * counts `queued` as open -- closes it when the real run finishes.
 *
 * Rows with no message id are exempt: matching NULL to NULL would pair every
 * such row with every other.
 */
async function takeClaim(
  taskId: string,
  brainId: string,
): Promise<ClawTaskRow | "missing" | "busy"> {
  const token = randomBytes(32).toString("hex");
  const hash = createHash("sha256").update(token).digest("hex");
  // Chat doorbells only: a DAG row whose lease lapsed is still the
  // scheduler's, and a fat chat row is still the JetStream message's.
  const r = await db.query(
    `UPDATE claw_tasks
        SET lease_owner = $2,
            lease_expires_at = NOW() + ($3::int * INTERVAL '1 millisecond'),
            heartbeat_at = NOW(),
            internal_token_hash = $4,
            status = CASE WHEN status = 'queued' THEN 'preparing' ELSE status END,
            started_at = COALESCE(started_at, NOW()),
            ${deadlineStampSql(6, 7)},
            claim_count = COALESCE(claim_count, 0) + 1
      WHERE task_id = $1
        AND origin = 'chat'
        AND metadata->>'dispatch' = 'doorbell'
        AND status = ANY($5::text[])
        AND (lease_expires_at IS NULL OR lease_expires_at < NOW())
        AND NOT EXISTS (
          SELECT 1 FROM claw_tasks sibling
           WHERE sibling.session_id = claw_tasks.session_id
             AND sibling.origin = 'chat'
             AND sibling.task_id <> claw_tasks.task_id
             AND sibling.metadata->>'message_id' IS NOT NULL
             AND sibling.metadata->>'message_id' = claw_tasks.metadata->>'message_id'
             AND sibling.status IN ('preparing','running','cancelling')
        )
      RETURNING *`,
    [taskId, brainId, RUN_LEASE_TTL_MS, hash, CLAIMABLE, RUN_BUDGET_DEFAULT_SEC.chat, RUN_BUDGET_DEFAULT_SEC.dag_node],
  );
  if ((r.rowCount ?? 0) === 0) {
    const exists = await db.query(`SELECT status, lease_expires_at FROM claw_tasks WHERE task_id = $1`, [taskId]);
    if ((exists.rowCount ?? 0) === 0) return "missing";
    return "busy";
  }
  const row = r.rows[0] as ClawTaskRow;
  (row as ClawTaskRow & { _lease_token: string })._lease_token = token;
  return row;
}

async function assembleClaim(row: ClawTaskRow, brainId: string): Promise<ClaimedRun> {
  const token = (row as ClawTaskRow & { _lease_token?: string })._lease_token;
  if (!token) throw new Error("claim assembled without a lease token");
  const request = await hydrateExecuteRequest(row, token);
  logger.info(
    { taskId: row.task_id, sessionId: row.session_id, brainId, status: row.status },
    "run.claimed",
  );
  return {
    request,
    lease: {
      url: `${INTERNAL_BACKEND_URL}/v1/internal/tasks/${row.task_id}/lease`,
      token,
    },
    claimCount: claimCountOf(row),
  };
}

/**
 * Rebuild the execute request from the row.
 *
 * `history` is not on the row -- see RUN_SPEC_REBUILT_KEYS -- so it is
 * assembled here from `claw_conversation_turns`, the table that owns the
 * conversation and that a session deletion actually clears. One indexed
 * read per claim, and no LLM call: `buildMessages` only walks the turns and
 * the system parts.
 *
 * Rebuilding cannot drift from what the sender would have assembled. Turns are
 * written by `recordCompletionTurns` when a turn ends, and a row can only be
 * sitting here unclaimed while its session's gate reads `running`, which is
 * exactly the state that parks every later message instead of letting it
 * complete. So no turn lands between the send and the claim.
 */
async function hydrateExecuteRequest(row: ClawTaskRow, leaseToken: string): Promise<ExecuteRequest> {
  const spec = { ...(row.input ?? {}) } as Record<string, unknown>;
  const blob = spec[RUN_CREDENTIALS_FIELD];
  delete spec[RUN_CREDENTIALS_FIELD];
  if (typeof blob !== "string" || !blob) {
    throw new Error("run.claim.missing_credentials");
  }
  const creds = openRunCredentials(blob);
  const request = spec as unknown as ExecuteRequest;
  request.task_id = row.task_id;
  request.session_id = row.session_id;
  request.llm_api_key = creds.llm_api_key;
  request.platform_key = creds.platform_key;
  if (creds.session_env) request.session_env = creds.session_env;
  if (creds.mcp_servers !== undefined) {
    (request as unknown as Record<string, unknown>).mcp_servers = creds.mcp_servers;
  }
  // The column and the spec are written from the same string, but the spec is
  // kept as a fallback: an empty prompt here would not fail, it would quietly
  // send the model a turn with nothing in it.
  const turnPrompt = row.prompt
    ?? (typeof request.prompt === "string" ? request.prompt : "");
  request.history = await runClaimPorts.buildHistory(
    row.session_id,
    turnPrompt,
    typeof row.input?.user_id === "string" ? row.input.user_id : "default",
  );
  request.deadline_at = row.deadline_at ?? request.deadline_at;
  request.run_lease = {
    url: `${INTERNAL_BACKEND_URL}/v1/internal/tasks/${row.task_id}/lease`,
    token: leaseToken,
  };
  return request;
}

/**
 * Read the user's env vault now, at claim time.
 *
 * Worth stating because it differs from the fat path, which snapshots the
 * vault when the message is accepted and carries that snapshot on the
 * request. Here the row deliberately does not hold it -- every API replica can
 * read the vault, so persisting a copy would be exposure without benefit --
 * and the consequence is that a run claimed later sees the vault as it is
 * then, not as it was when the user pressed send. For an admitted run that gap
 * is milliseconds; for one that waited behind a soft limit it can be hours,
 * and an env var edited in between takes effect on a turn already sent.
 *
 * `session_env` is not this: it arrives on the request, has no vault, and is
 * sealed onto the row, so it keeps send-time values.
 */
export async function injectLiveUserEnv(request: ExecuteRequest): Promise<void> {
  const userId = request.user_id;
  if (!userId) return;
  const snapshot = await loadUserEnvSnapshot(db, userId, logger);
  if (Object.keys(snapshot).length) request.user_env = snapshot;
}

/**
 * Whether a hydrate failure is about the row's sealed credentials.
 *
 * Both shapes are permanent: the field is absent, or it is present and will
 * not open. The second is reported as {@link RunCredentialFault} rather than
 * inferred from message text, because the text comes from three layers and a
 * hand-kept list of substrings had already fallen behind the thrower.
 */
function isCredentialFault(err: unknown): boolean {
  if (err instanceof RunCredentialFault) return true;
  return (err instanceof Error ? err.message : String(err)).includes("missing_credentials");
}

function claimCountOf(row: ClawTaskRow): number {
  const raw = (row as ClawTaskRow & { claim_count?: unknown }).claim_count;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? n : 0;
}

async function failExhaustedClaim(row: ClawTaskRow): Promise<boolean> {
  let closed = false;
  // Why it ran out, when the last holder said. The brain has a
  // `lock_contention_exhausted` verdict of its own, but on the doorbell path
  // this guard fires first and used to flatten every cause into
  // `max_retries_exceeded` -- so a run that spent its whole claim budget
  // waiting for one workspace lock read the same as one that was crashing.
  const lastRelease = typeof row.metadata?.last_release === "string"
    ? row.metadata.last_release
    : null;
  const contention = lastRelease === "lock_contention";
  const failureReason = contention ? "lock_contention_exhausted" : "max_retries_exceeded";
  const message = contention
    ? "the workspace this run needs stayed busy for its whole claim budget"
    : "claimed too many times without a terminal result";
  try {
    const r = await db.query(
      `UPDATE claw_tasks
          SET status = 'failed',
              failure_reason = $2,
              error_message = $3,
              completed_at = NOW(),
              lease_owner = NULL,
              lease_expires_at = NULL,
              heartbeat_at = NULL,
              internal_token_hash = NULL
        WHERE task_id = $1
          AND status IN ('queued','preparing','running')
        RETURNING task_id`,
      [row.task_id, failureReason, message],
    );
    closed = (r.rowCount ?? 0) > 0;
  } catch (err) {
    logger.warn({ err, taskId: row.task_id }, "run.claim.mark_exhausted_failed");
    return false;
  }
  if (!closed) {
    logger.warn({ taskId: row.task_id }, "run.claim.mark_exhausted_noop");
    return false;
  }
  await releaseRunUse(row.task_id, false);
  await announceClaimFailure(
    row,
    failureReason,
    contention
      ? "Task failed: the workspace stayed busy for this run's whole retry budget. "
        + "Please send a new message once the other run finishes."
      : "Task failed: exceeded maximum retry attempts. Please send a new message.",
  );
  return true;
}

async function announceClaimFailure(
  row: ClawTaskRow,
  failureReason: string,
  finalText: string,
): Promise<void> {
  const messageId = typeof row.metadata?.message_id === "string" ? row.metadata.message_id : undefined;
  const userId = typeof row.input?.user_id === "string" && row.input.user_id
    ? row.input.user_id
    : "default";
  const of = (event: Record<string, unknown>): Record<string, unknown> => ({
    session_id: row.session_id,
    message_id: messageId,
    ...event,
  });
  try {
    await runClaimPorts.publishSessionEvent(row.session_id, of({
      type: "AssistantMessage",
      data: { content: [{ type: "text", text: finalText }] },
    }));
    await runClaimPorts.publishSessionEvent(row.session_id, of({ type: "ResultMessage" }));
    await runClaimPorts.publishSessionEvent(row.session_id, of({
      type: "exec_complete",
      user_id: userId,
      prompt: row.prompt ?? "",
      final_text: finalText,
      failed: true,
      failure_reason: failureReason,
      error_count: 0,
      skills_used: {},
    }));
  } catch (err) {
    logger.warn({ err, taskId: row.task_id, failureReason }, "run.claim.failure_announce_failed");
  }
}
