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
import type { ExecuteRequest, RunFailClaimReason, RunLease } from "@claw/protocol";
import pino from "pino";

import { RUN_LEASE_TTL_MS, TASK_POISON_DELIVERY_COUNT } from "../config.js";
import { loadUserEnvSnapshot } from "../crypto/user-env.js";
import { db, inTransaction, RUN_CLAIM_FENCE_SQL, type Querier } from "../infra/db.js";
import {
  anySoftCeilingSet, askFromRow, chargeAccepted, deferQueuedBySoftCeiling, envAdmitLimits,
  fillWithinCeiling, loadUsageWithRoots, runImmediately, softOverflow,
  withOwnedAdmissionLock, type AfterCommit,
} from "./admission.js";
import { metrics } from "../infra/metrics.js";
import { buildMessages } from "../sessions/context-builder.js";
import { publishEvent } from "../events/store.js";
import { releaseRunUse } from "../workspace/store.js";
import { applyTaskStatusTransition } from "./db.js";
import { parkHandsOfSettledSessions } from "./park-settled-hands.js";
import { requeueSojournSql } from "./run-budget.js";
import { RUN_CREDENTIALS_FIELD } from "./run-spec.js";
import { openRunCredentials, RunCredentialFault } from "./run-secrets.js";
import { settleRunTime, type RunSettlement } from "./run-time-ledger.js";
import type { ClawTaskRow } from "./types.js";

/**
 * Anything that can run a statement. The claim path takes one so a caller can
 * drive it inside a transaction of its own; substituting the `db` singleton
 * instead puts both transactions on one connection, which is no interleaving.
 */
export interface StatementSource {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
}

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

/**
 * Doorbell rows an incoming Brain at `version` could not run, in any
 * non-terminal state.
 *
 * Counting only the queued ones reads zero while such a run is executing, and
 * a draining pod puts its rows back exactly when the last compatible replica
 * goes away -- so a queued-only precondition clears a rollback that is unsafe.
 */
export async function countIncompatibleDoorbellRuns(version: number): Promise<number> {
  const r = await db.query(
    `SELECT COUNT(*)::int AS n FROM claw_tasks
      WHERE COALESCE(metadata->>'dispatch', '') = 'doorbell'
        AND status IN ('queued','preparing','running','cancelling')
        AND COALESCE((metadata->>'doorbell_semantics')::int, 1) > $1::int`,
    [version],
  );
  return Number((r.rows[0] as { n?: number } | undefined)?.n ?? 0);
}

/** A row `takeClaim` matched, carrying the prior state only that statement sees. */
type TakenRow = ClawTaskRow & { prior_status?: string; queued_since?: string | null };

/**
 * Read the soft-ceiling usage and take the row under one hold of the lock.
 *
 * Both must be in one transaction: two connections each holding a different
 * queued row contend for headroom rather than for a row, so no CAS refuses
 * them and both claim under a ceiling of one. A caller supplying its own
 * querier owns that transaction; without a soft ceiling there is no lock to
 * take. The queue exit rides `afterCommit` because a failed `COMMIT` leaves the
 * row at `queued` and an emitted metric cannot be taken back.
 */
async function takeUnderSoftCeiling(
  taskId: string,
  brainId: string,
  doorbellSemantics: number,
  q: StatementSource | undefined,
): Promise<TakenRow | "missing" | "busy" | "deferred"> {
  const gated = async (on: StatementSource, afterCommit: AfterCommit) => {
    if (await deferQueuedBySoftCeiling(taskId, on)) return "deferred" as const;
    const taken = await takeClaimOrBusy(taskId, brainId, doorbellSemantics, on);
    if (typeof taken !== "string" && taken.prior_status === "queued") {
      const since = taken.queued_since ?? null;
      afterCommit(() => metrics.observeQueueExit("chat", since, "claimed"));
    }
    return taken;
  };
  if (q) return await gated(q, runImmediately);
  if (!anySoftCeilingSet(envAdmitLimits())) return await gated(db, runImmediately);
  return await withOwnedAdmissionLock(gated);
}

export async function claimRunById(
  taskId: string,
  brainId: string,
  doorbellSemantics = 1,
  q?: StatementSource,
): Promise<ClaimedRun | "missing" | "busy" | "unclaimable" | "deferred" | ExhaustedClaim> {
  const taken = await takeUnderSoftCeiling(taskId, brainId, doorbellSemantics, q);
  if (taken === "missing" || taken === "busy" || taken === "deferred") return taken;
  return await finishClaim(taken, taskId, brainId);
}

async function finishClaim(
  taken: TakenRow,
  taskId: string,
  brainId: string,
): Promise<ClaimedRun | "busy" | "unclaimable" | ExhaustedClaim> {
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

/** A union, so the exhaustion reason is required exactly when the cause is `exhausted`. */
export type ClaimNextSkip =
  | { cause: "exhausted"; exhaustion: "lock_contention_exhausted" | "max_retries_exceeded" }
  | { cause: "raced" | "unclaimable" | "error" | "deferred" };

/** "No row" has three meanings, and collapsing them makes a stalled queue look idle. */
export interface ClaimNextDiagnostics {
  skipped: ClaimNextSkip[];
  outcome: "claimed" | "empty" | "all_skipped" | "retry_limit";
}

export async function claimNextRun(
  brainId: string,
  doorbellSemantics = 1,
  diag?: ClaimNextDiagnostics,
): Promise<ClaimedRun | null> {
  const skip: string[] = [];
  let failedAttempts = 0;
  while (failedAttempts < CLAIM_NEXT_ATTEMPTS) {
    let taskId: string;
    let taken: TakenRow | "missing" | "busy" | undefined;
    const softGated = anySoftCeilingSet(envAdmitLimits());
    if (softGated) {
      const selected = await takeNextWithinSoftCeiling(
        brainId, doorbellSemantics, skip, diag,
      );
      if (!selected) {
        if (diag) diag.outcome = diag.skipped.length || skip.length ? "all_skipped" : "empty";
        return null;
      }
      taskId = selected.taskId;
      taken = selected.taken;
    } else {
      const nextTaskId = await peekNextQueued(skip, doorbellSemantics);
      if (!nextTaskId) {
        if (diag) diag.outcome = skip.length ? "all_skipped" : "empty";
        return null;
      }
      taskId = nextTaskId;
    }
    // A hydrate failure that is not about credentials is rethrown by
    // claimRunById, and it used to leave through here: no catch on this loop
    // and none on the route, so the whole cycle answered 500. The row itself
    // is fine -- releaseClaim already put it back -- so the honest response is
    // to pass over it and offer the caller the next one. Since B1 the rebuild
    // reads the conversation, and nothing in buildMessages catches, so an
    // ordinary database blip reaches here.
    let claimed: Awaited<ReturnType<typeof claimRunById>>;
    try {
      claimed = softGated
        ? (typeof taken === "string" ? taken : await finishClaim(taken!, taskId, brainId))
        : await claimRunById(taskId, brainId, doorbellSemantics);
    } catch (err) {
      logger.warn({ err, taskId, brainId }, "run.claim_next.skipped_after_error");
      diag?.skipped.push({ cause: "error" });
      skip.push(taskId);
      failedAttempts++;
      continue;
    }
    if (typeof claimed !== "string" && !("kind" in claimed)) {
      if (diag) diag.outcome = "claimed";
      return claimed;
    }
    const cause = skipCauseOf(claimed);
    diag?.skipped.push(cause);
    skip.push(taskId);
    if (cause.cause !== "deferred") failedAttempts++;
  }
  if (diag) diag.outcome = "retry_limit";
  return null;
}

async function takeNextWithinSoftCeiling(
  brainId: string,
  doorbellSemantics: number,
  alreadySkipped: readonly string[],
  diag?: ClaimNextDiagnostics,
): Promise<{ taskId: string; taken: TakenRow | "missing" | "busy" } | null> {
  const limits = envAdmitLimits();
  return await withOwnedAdmissionLock(async (client, afterCommit) => {
    const { usage, roots } = await loadUsageWithRoots("executing", client);
    const accepted = await fillWithinCeiling<ClawTaskRow>({
      page: (skip) => peekNextQueuedRows(
        [...alreadySkipped, ...skip], doorbellSemantics, client,
      ),
      fits: (row) => {
        const ask = askFromRow(row, roots);
        if (softOverflow(usage, ask, limits)) {
          diag?.skipped.push({ cause: "deferred" });
          return false;
        }
        chargeAccepted(usage, ask, row.dag_root_task_id ?? row.task_id, roots);
        return true;
      },
      want: 1,
      idOf: (row) => row.task_id,
    });
    const row = accepted[0];
    if (!row) return null;
    const taken = await takeClaimOrBusy(row.task_id, brainId, doorbellSemantics, client);
    if (typeof taken !== "string" && taken.prior_status === "queued") {
      const since = taken.queued_since ?? null;
      afterCommit(() => metrics.observeQueueExit("chat", since, "claimed"));
    }
    return { taskId: row.task_id, taken };
  });
}

/**
 * `missing` and `busy` are both the queue moving under this pod, so they share
 * one value; only the others are properties of the candidate, and only those
 * can mean a queue that is stuck.
 */
function skipCauseOf(
  claimed: "missing" | "busy" | "unclaimable" | "deferred" | ExhaustedClaim,
): ClaimNextSkip {
  if (typeof claimed !== "string") {
    return { cause: "exhausted", exhaustion: claimed.reason };
  }
  if (claimed === "unclaimable" || claimed === "deferred") return { cause: claimed };
  return { cause: "raced" };
}

/**
 * A caller that implements less than the row requires is never offered it.
 * Filtered server-side: claiming and releasing instead would burn a
 * `claim_count` increment on every poll of every pod.
 */
const SEMANTICS_FITS_SQL =
  "COALESCE((metadata->>'doorbell_semantics')::int, 1) <= $SEM::int";

async function peekNextQueued(skip: string[], doorbellSemantics: number): Promise<string | null> {
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
        AND ${SEMANTICS_FITS_SQL.replace("$SEM", "$2")}
        AND NOT (task_id = ANY($1::text[]))
      ORDER BY
        priority DESC,
        COALESCE(queued_at, created_at) ASC,
        created_at ASC
      LIMIT 1`,
    [skip, doorbellSemantics],
  );
  return (r.rows[0] as { task_id?: string } | undefined)?.task_id ?? null;
}

async function peekNextQueuedRows(
  skip: string[],
  doorbellSemantics: number,
  q: StatementSource,
): Promise<ClawTaskRow[]> {
  const r = await q.query(
    `SELECT * FROM claw_tasks
      WHERE status = 'queued'
        AND origin = 'chat'
        AND executor = 'brain'
        AND metadata->>'dispatch' = 'doorbell'
        AND (lease_expires_at IS NULL OR lease_expires_at < NOW())
        AND (deadline_at IS NULL OR deadline_at > NOW())
        AND ${SEMANTICS_FITS_SQL.replace("$SEM", "$2")}
        AND NOT (task_id = ANY($1::text[]))
      ORDER BY
        priority DESC,
        COALESCE(queued_at, created_at) ASC,
        created_at ASC
      LIMIT 1`,
    [skip, doorbellSemantics],
  );
  return r.rows as ClawTaskRow[];
}

async function markUnclaimable(taskId: string): Promise<void> {
  const rows = await applyTaskStatusTransition("failed", {
    extra: {
      failure_reason: "unclaimable",
      error_message: "run spec could not be hydrated at claim time",
      lease_owner: null,
      lease_expires_at: null,
      heartbeat_at: null,
      internal_token_hash: null,
    },
    where: "task_id = $1 AND status IN ('queued','preparing')",
    params: [taskId],
  }).catch((err) => {
    logger.warn({ err, taskId }, "run.claim.mark_unclaimable_failed");
    return [] as ClawTaskRow[];
  });
  const row = rows[0];
  if (!row) return;
  await releaseRunUse(taskId, false);
  await announceClaimFailure(
    row,
    "unclaimable",
    "Task failed: this run could not be started. Please send a new message.",
  );
}

/**
 * Settle the run's time and move the row, as one transaction.
 *
 * Rolled back whole when the transition's own fence matches no row: committing
 * the merge while the release fails is how a superseded attempt's final report
 * lands in a ledger that now belongs to somebody else.
 */
async function settleAndTransition(
  taskId: string,
  settlement: RunSettlement | undefined,
  transition: (query: Querier) => Promise<ClawTaskRow[]>,
): Promise<boolean> {
  // Always a settlement, report or not: the attempt this boundary ends has a
  // record open, and leaving it open loses the only instant that says when it
  // stopped.
  const settled: RunSettlement = {
    ...settlement, closeAttempt: true, adoptUnrecordedAttempt: true,
  };
  try {
    return await inTransaction(async (query) => {
      // A report from an attempt the row has moved past is refused, and the
      // release beside it goes with it: whoever holds the row now is entitled
      // to it, and this caller is settling somebody else's run.
      const outcome = await settleRunTime(query, taskId, settled);
      // Only a superseded attempt voids the release. A row whose ledger cannot
      // be read is refused by the transition's own fence a moment later, and
      // failing here would replace that answer with a less informative one.
      if (!outcome.ok && outcome.reason === "stale_attempt") throw new StaleTransition();
      const rows = await transition(query);
      if (rows.length === 0) throw new StaleTransition();
      return true;
    });
  } catch (err) {
    if (err instanceof StaleTransition) return false;
    throw err;
  }
}

/** The transition's fence matched nothing, so its whole transaction is void. */
class StaleTransition extends Error {}

/**
 * End a holder's attempt without moving the row between states.
 *
 * Two boundaries reach here, and neither has a transition of its own. A claimed
 * chat run that succeeded carries no `callback_url`, so no `agent_done` arrives
 * and the completion event closes the row later knowing nothing about which
 * attempt ran it. A fat delivery that naks for a retry has no release endpoint
 * at all -- JetStream redelivers the same message -- so this is where its
 * coverage and its record are settled.
 *
 * The attempt token is cleared either way: the attempt is over, and a heartbeat
 * still in flight under it would otherwise renew a lease nobody is holding and
 * open a second record beside the one just closed. `releaseLease` expires the
 * lease and releases its owner so a redelivery can renew immediately. The
 * timestamp lets the reaper close the run if no replacement arrives.
 *
 * Fenced like a release, because a holder whose claim has since been taken is
 * settling somebody else's attempt.
 */
export async function settleFinishedClaim(
  taskId: string,
  brainId: string,
  claimCount?: number,
  settlement?: RunSettlement,
  releaseLease = false,
): Promise<boolean> {
  const settled: RunSettlement = { ...settlement, closeAttempt: true };
  try {
    return await inTransaction(async (query) => {
      const held = await query(
        `SELECT attempt_id FROM claw_tasks
          WHERE task_id = $1 AND lease_owner = $2
            AND ($3::int IS NULL OR claim_count = $3)
          FOR UPDATE`,
        [taskId, brainId, claimCount ?? null],
      );
      if (held.rowCount === 0) throw new StaleTransition();
      const outcome = await settleRunTime(query, taskId, settled);
      if (!outcome.ok) throw new StaleTransition();
      const closed = settlement?.report?.attemptId
        ?? (held.rows[0] as { attempt_id: string | null }).attempt_id;
      await query(
        `UPDATE claw_tasks
            SET attempt_id = NULL,
                heartbeat_at = NULL,
                settled_attempt_id = COALESCE($3, settled_attempt_id),
                lease_owner = CASE WHEN $2 THEN NULL ELSE lease_owner END,
                lease_expires_at = CASE WHEN $2 THEN clock_timestamp() ELSE lease_expires_at END
          WHERE task_id = $1`,
        [taskId, releaseLease, closed],
      );
      return true;
    });
  } catch (err) {
    if (err instanceof StaleTransition) return false;
    throw err;
  }
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
  settlement?: RunSettlement,
): Promise<boolean> {
  // `setSql` rather than `extra.metadata`: one statement may assign a column
  // once, and this assignment does two things -- carry the release reason and
  // restamp the sojourn marker, so a row going round the requeue loop three
  // times is measured as three waits rather than one that keeps growing.
  const released = await settleAndTransition(taskId, settlement, (query) =>
    applyTaskStatusTransition("queued", {
      extra: {
        lease_owner: null,
        lease_expires_at: null,
        heartbeat_at: null,
        internal_token_hash: null,
        // Cleared with the status, so a heartbeat racing this release cannot
        // find the row still holding the attempt it is reporting for.
        attempt_id: null,
        started_at: null,
      },
      setSql: [`metadata = ${requeueSojournSql(`CASE
                         WHEN $4::text IS NULL THEN COALESCE(metadata, '{}'::jsonb)
                         ELSE COALESCE(metadata, '{}'::jsonb)
                              || jsonb_build_object('last_release', $4::text)
                       END`)}`],
      where: `task_id = $1
        AND lease_owner = $2
        AND status IN ('queued','preparing','running')
        AND ($3::int IS NULL OR claim_count = $3)`,
      params: [taskId, brainId, claimCount ?? null, reason ?? null],
      query,
    }));
  if (released) metrics.onQueueEntered("requeue");
  return released;
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
export type HeldClaimFailureReason = RunFailClaimReason;

const HELD_CLAIM_MESSAGE: Record<HeldClaimFailureReason, string> = {
  session_deleted: "the session this run belonged to was deleted",
  claim_abandoned: "the holder settled the claimed run without completing it",
  workspace_unbound: "the run was not bound to a workspace, so it cannot be serialised",
};

const HELD_CLAIM_REASONS = new Set<string>(Object.keys(HELD_CLAIM_MESSAGE));

/**
 * Why the holder is closing the row, when it says so. Absence keeps the
 * historical default; a present-but-unrecognised value is refused, because the
 * three reasons ask opposite things and a fail is terminal.
 */
export function heldClaimReasonFrom(body: unknown): HeldClaimFailureReason | "invalid" {
  const raw = body && typeof body === "object" ? (body as { reason?: unknown }).reason : undefined;
  if (raw === undefined) return "session_deleted";
  return typeof raw === "string" && HELD_CLAIM_REASONS.has(raw)
    ? raw as HeldClaimFailureReason
    : "invalid";
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
  settlement?: RunSettlement,
): Promise<boolean> {
  const closed = await settleAndTransition(taskId, settlement, (query) =>
    applyTaskStatusTransition("failed", {
      extra: {
        failure_reason: reason,
        error_message: HELD_CLAIM_MESSAGE[reason],
        lease_owner: null,
        lease_expires_at: null,
        heartbeat_at: null,
        internal_token_hash: null,
        attempt_id: null,
      },
      where: `task_id = $1
        AND lease_owner = $2
        AND origin = 'chat'
        AND status IN ('queued','preparing','running')
        AND ($3::int IS NULL OR claim_count = $3)`,
      params: [taskId, brainId, claimCount ?? null],
      query,
    }));
  if (!closed) return false;
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
  doorbellSemantics: number,
  q: StatementSource,
): Promise<TakenRow | "missing" | "busy"> {
  const token = randomBytes(32).toString("hex");
  const hash = createHash("sha256").update(token).digest("hex");
  // Chat doorbells only: a DAG row whose lease lapsed is still the
  // scheduler's, and a fat chat row is still the JetStream message's.
  // The prior state, locked before the claim writes over it: this is the only
  // place that can still tell whether the claim was a queue exit, and an
  // UPDATE's RETURNING answers with what the row became.
  const before = await q.query(
    `SELECT status AS prior_status, metadata->>'queued_since' AS queued_since
       FROM claw_tasks WHERE task_id = $1 FOR UPDATE`,
    [taskId],
  );
  // Through the one writer of `status`, which stamps `started_at` and the
  // execution deadline for `preparing` itself, so the explicit stamps this
  // statement used to carry are its job now. `preparing` for a row already
  // there leaves the status alone and banks a zero segment, which is what the
  // old conditional expression said.
  const rows = await applyTaskStatusTransition("preparing", {
    extra: {
      lease_owner: brainId,
      internal_token_hash: hash,
      // Every claim, a contention-only one included, invalidates the previous
      // attempt's token, which closes the window the status guard leaves open
      // when a claim restores the row to preparing under the same pod name.
      attempt_id: null,
    },
    setSql: [
      "lease_expires_at = NOW() + ($2::int * INTERVAL '1 millisecond')",
      "heartbeat_at = NOW()",
      "claim_count = COALESCE(claim_count, 0) + 1",
    ],
    where: `task_id = $1
        AND origin = 'chat'
        AND metadata->>'dispatch' = 'doorbell'
        AND status = ANY($3::text[])
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
        AND ${SEMANTICS_FITS_SQL.replace("$SEM", "$4")}
        AND ${RUN_CLAIM_FENCE_SQL}`,
    params: [taskId, RUN_LEASE_TTL_MS, CLAIMABLE, doorbellSemantics],
    query: ((text, params) => q.query(text, params)) as Querier,
  });
  if (rows.length === 0) {
    const exists = await q.query(
      `SELECT status, lease_expires_at FROM claw_tasks WHERE task_id = $1`, [taskId],
    );
    if ((exists.rowCount ?? 0) === 0) return "missing";
    return "busy";
  }
  const prior = before.rows[0] as { prior_status?: string; queued_since?: string } | undefined;
  const row = { ...rows[0], ...(prior ?? {}) } as TakenRow;
  (row as ClawTaskRow & { _lease_token: string })._lease_token = token;
  return row;
}

/**
 * The sibling `NOT EXISTS` is a pre-check, not the guarantee: under READ
 * COMMITTED both siblings of one turn can see the other still `queued`, so the
 * unique index refuses the second, as a violation rather than a zero-row CAS.
 */
async function takeClaimOrBusy(
  taskId: string,
  brainId: string,
  doorbellSemantics: number,
  q: StatementSource,
): Promise<TakenRow | "missing" | "busy"> {
  try {
    return await takeClaim(taskId, brainId, doorbellSemantics, q);
  } catch (err) {
    if ((err as { code?: string })?.code !== UNIQUE_VIOLATION) throw err;
    logger.info({ taskId, brainId }, "run.claim.lost_to_sibling");
    return "busy";
  }
}

/** Postgres class 23505: the turn's uniqueness invariant refused this writer. */
const UNIQUE_VIOLATION = "23505";

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

async function failExhaustedClaim(row: ClawTaskRow, settlement?: RunSettlement): Promise<boolean> {
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
    closed = await settleAndTransition(row.task_id, settlement, (query) =>
      applyTaskStatusTransition("failed", {
        extra: {
          failure_reason: failureReason,
          error_message: message,
          lease_owner: null,
          lease_expires_at: null,
          heartbeat_at: null,
          internal_token_hash: null,
          attempt_id: null,
        },
        where: "task_id = $1 AND status IN ('queued','preparing','running')",
        params: [row.task_id],
        query,
      }));
  } catch (err) {
    logger.warn({ err, taskId: row.task_id }, "run.claim.mark_exhausted_failed");
    return false;
  }
  if (!closed) {
    logger.warn({ taskId: row.task_id }, "run.claim.mark_exhausted_noop");
    return false;
  }
  await releaseRunUse(row.task_id, false);
  // And the sandbox, if this session has nothing else running. A run claimed to
  // exhaustion is a run no worker ever finished, so nothing ever reached the
  // line in Brain that puts `hands.<sid>` back in the idle pool -- and an
  // unparked handle is not one the idle sweep ignores, it is one every replica
  // pings once a tick, keeping the platform's lastActivity fresh and its GC
  // away until the workload's own absolute deadline.
  //
  // Here as well as in the sweeper's gate release because this path is not a
  // sweep and does not go through it: it closes the row itself and announces
  // its own failure. Naming the three reapers and stopping there is how the
  // guard came to sit on three of the four routes into this state.
  await parkHandsOfSettledSessions([row.session_id]);
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
    task_id: row.task_id,
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
