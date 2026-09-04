// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Sweeper (task-design.md §9.4 R-3).
 *
 * Periodic background reconciler that fixes drift between PostgreSQL,
 * DagHandleMap (NATS KV), and SaFE workloads:
 *
 *   - Back-stop runs past their `deadline_at` (or, for rows predating that
 *     column, past `BRAIN_TASK_TIMEOUT_SEC`), marking them terminal and
 *     interrupting whatever is still executing them.
 *   - Release sessions stuck at `agent_status = 'running'`.
 *   - Tear handle KV entries whose DAG root is already terminal.
 *   - Hands KV entries whose backing workload is unreachable get a
 *     warning log; we leave the actual teardown to ensureSandbox's
 *     existing destroyHands path so we don't race Brain rebuilds.
 *   - Finish session deletions whose cleanup did not complete in the request
 *     that asked for them (see sessions/cleanup-sweep.ts).
 */
import { db } from "../infra/db.js";
import { backfillPlatformFacts, drainPendingPlatformFacts } from "./platform-backfill.js";
import { publishEvent } from "../events/store.js";
import pino from "pino";
import { interruptSubject } from "@claw/protocol";
import { envBool, envInt, LEASE_LOST_GRACE_SEC, TASK_SWEEPER_TICK_MS } from "../config.js";
import { nc } from "../infra/nats.js";
import { LEADER_LOCK_IDS, withLeaderLock } from "../infra/leader-lock.js";
import { runCleanupSweep } from "../sessions/cleanup-sweep.js";
import { stopAllHandlesForDag } from "./sandbox-stopper.js";
import { handleMap } from "./sandbox-stopper.js";
import { RUN_BUDGET_BACKSTOP_GRACE_SEC, RUN_QUEUE_MAX_SEC, RUN_REQUEUE_RESET_SQL } from "./run-budget.js";
import {
  releaseRefsOfDeletedSessions, releaseRefsOfFinishedRuns, releaseRefsOfIdleSessions, releaseRunUse,
} from "../workspace/store.js";

const logger = pino({ name: "task-sweeper" });

// Every one of these is a "how long before this counts as dead" window, so
// zero is not a shorter window -- it reaps everything the first time it runs.
const BRAIN_TASK_TIMEOUT_SEC = envInt("BRAIN_TASK_TIMEOUT_SEC", 60 * 60, { min: 1 });
const WAIT_EXTERNAL_DEFAULT_SEC = envInt("WAIT_EXTERNAL_DEFAULT_SEC", 30 * 60, { min: 1 });
// How long a session may sit at agent_status='running' with no sign of life.
// Defaults to the task timeout so the two agree unless deliberately split: both
// answer the same question, one for a claw_tasks row and one for a session.
const SESSION_STUCK_TIMEOUT_SEC = envInt(
  "SESSION_STUCK_TIMEOUT_SEC",
  BRAIN_TASK_TIMEOUT_SEC,
  { min: 1 },
);
/**
 * Whether the deadline backstop is allowed to act on chat runs.
 *
 * Narrower than it sounds, and deliberately: it gates `reapStaleTasks` and
 * nothing else. What makes that reaper different is not that it writes to the
 * row but that it publishes an interrupt, and an interrupt is keyed by session
 * rather than by run. A session outlives any one turn, so a shadow row left
 * open by a bug and reaped an hour later would abort whatever the user happened
 * to be running at that moment -- a failure worse than the wrong row that
 * caused it. Off until chat rows have been shown to close reliably.
 *
 * `reapLostLeases` is not behind it. An expired lease is direct evidence rather
 * than an inference from a timeout, it publishes no interrupt, and the row it
 * closes is read by the worker that eventually takes the delivery over, so
 * leaving chat rows out would leave exactly the runs this table exists to make
 * durable un-reaped.
 */
const RUN_ROWS_SWEEPABLE = envBool("RUN_ROWS_SWEEPABLE", false);

/** Injection seam for the terminal events a reap has to announce. */
export const sweeperPorts = {
  publishSessionEvent: publishEvent,
};

let stopped = false;
let timer: NodeJS.Timeout | null = null;

/**
 * Backstop for runs that outlived their budget and did not stop themselves.
 *
 * This used to be the only enforcement there was, and it enforced nothing: the
 * statement wrote `failed / brain_timeout` onto the row and stopped there. The
 * Brain process running the task never heard about it, so it carried on calling
 * the model and holding its sandbox while the UI showed the run as failed — and
 * for DAG rows, `reapOrphanHandles` then destroyed that sandbox within a tick,
 * leaving the still-running process to fail on its next tool call with an error
 * that mentioned neither a timeout nor a budget.
 *
 * Two things changed. Rows are judged against their own `deadline_at`, so a run
 * that declared a longer budget gets it and one that declared none still falls
 * back to the old global constant. And every row reaped here is followed by an
 * interrupt on the channel Brain already listens to, the same one the stop
 * button uses, so a process that is still alive ends the way a cancelled run
 * ends instead of being lied about.
 *
 * The grace period is what makes this a backstop rather than a competitor: the
 * run gets its own chance to notice the deadline and report a reason first.
 *
 * The second arm is for rows no worker ever claimed. A lease is written by the
 * worker executing the run, so a row the API moved to `preparing` and nothing
 * ever picked up -- the fleet was down, or the message aged out of the stream
 * -- has no lease for `reapLostLeases` to expire and a deadline that is hours
 * away, which for a graph node means a day of a row claiming to be preparing
 * and a DAG stalled behind it. Judging those by the old global timeout is the
 * behaviour they had before there was a budget, and it is the right one: the
 * question they pose is liveness, not how long the run may take. A row being
 * executed by a worker too old to take a lease is judged the same way, which is
 * also what it had before.
 */
export async function reapStaleTasks(): Promise<number> {
  const r = await db.query(
    `UPDATE claw_tasks
     SET status = CASE WHEN status = 'cancelling' THEN 'cancelled' ELSE 'failed' END,
         failure_reason = CASE
                            WHEN status = 'cancelling' THEN 'cancelled'
                            WHEN deadline_at IS NOT NULL
                                 AND deadline_at < NOW() - ($3::int * INTERVAL '1 second')
                              THEN 'run_budget_exhausted'
                            ELSE 'brain_timeout'
                          END,
         error_message = CASE
                           -- The same branch in the same position as the one
                           -- above. Without it a run the user stopped is
                           -- archived as cancelled, beside an error message
                           -- saying its budget ran out.
                           WHEN status = 'cancelling'
                             THEN 'the run was cancelled; it never confirmed the stop, and the sweeper closed the row'
                           WHEN deadline_at IS NOT NULL
                                AND deadline_at < NOW() - ($3::int * INTERVAL '1 second')
                             THEN 'run budget exhausted at ' || deadline_at
                                  || '; the run did not report a terminal state within the grace period'
                           ELSE $2
                         END,
         completed_at = NOW()
     WHERE status IN ('preparing','running','cancelling')
       AND ($4::boolean OR origin IS DISTINCT FROM 'chat')
       -- The virtual DAG root is inserted at 'running' and never dispatched to
       -- a worker, so no lease and no liveness of its own: reapStuckDagRoots
       -- judges it against its children instead. Excluded explicitly because
       -- what exempts it today is only that nothing stamps its started_at --
       -- an accident of the insert path, and one that would close a healthy
       -- graph an hour in the moment anything did.
       AND executor IS DISTINCT FROM 'dag'
       AND (
         (deadline_at IS NOT NULL
            AND deadline_at < NOW() - ($3::int * INTERVAL '1 second'))
         OR
         -- The never-claimed arm. A healthy task or DAG node renews its lease
         -- immediately, so a NULL lease after this long means no worker ever
         -- accepted the run (or one too old to speak the lease protocol did).
         -- Its execution budget is independent: a deadline hours away must not
         -- turn a missing worker into a run that claims to be alive for hours.
         (lease_expires_at IS NULL
            AND started_at IS NOT NULL
            AND started_at < NOW() - ($1::int * INTERVAL '1 second'))
       )
     RETURNING task_id, session_id, dag_root_task_id, deadline_at, sandbox_workload_id`,
    [
      BRAIN_TASK_TIMEOUT_SEC,
      `no agent_done after ${BRAIN_TASK_TIMEOUT_SEC}s`,
      RUN_BUDGET_BACKSTOP_GRACE_SEC,
      RUN_ROWS_SWEEPABLE,
    ],
  );
  if (!r.rowCount) return 0;

  const rows = r.rows as Array<{
    task_id: string;
    session_id: string;
    dag_root_task_id: string | null;
    deadline_at: string | null;
    sandbox_workload_id: string | null;
  }>;
  logger.warn(
    {
      reaped: r.rowCount,
      graceSec: RUN_BUDGET_BACKSTOP_GRACE_SEC,
      legacyTimeoutSec: BRAIN_TASK_TIMEOUT_SEC,
      ids: rows.map((row) => row.task_id),
    },
    "sweeper.reaped_stale_tasks",
  );
  await interruptReapedRuns(rows);
  // These are the runs that stopped reporting. Some of them stopped because the
  // node under them was reclaimed, and this is the last moment their pods can
  // still say so. Best-effort and after the interrupt: the close has already
  // happened and must stand regardless.
  await backfillPlatformFacts(rows).catch((err) => {
    logger.warn({ err }, "sweeper.platform_backfill_failed");
    return 0;
  });
  return r.rowCount;
}

/**
 * Tell whatever is still running these tasks to stop.
 *
 * Addressed the way every other interrupt is: the DAG root for graph nodes,
 * the session for everything else (see cancelTask, which derives it the same
 * way). Not the key Brain gates the run on, which is its own business and has
 * already been something else once. Deduplicated because a whole DAG can time
 * out at once and every node of it shares one address.
 *
 * Best effort by construction. Core NATS is at-most-once and the process may
 * already be gone, which is the usual reason a row got here; the row is already
 * terminal either way, and this only closes the gap where it is not.
 */
async function interruptReapedRuns(
  rows: Array<{ session_id: string; dag_root_task_id: string | null }>,
): Promise<void> {
  const keys = new Set(
    rows.map((row) => row.dag_root_task_id ?? row.session_id).filter(Boolean),
  );
  if (!interruptPublisher.available()) {
    // The sweeper's own tick can outlive a NATS reconnect, and a missing
    // connection must not undo the row updates already committed above.
    logger.warn({ keys: [...keys] }, "sweeper.interrupt_skipped_no_nats");
    return;
  }
  for (const key of keys) {
    try {
      interruptPublisher.publish(interruptSubject(key));
    } catch (e) {
      // Keep going: one unreachable run must not strand the rest of the batch.
      logger.warn({ key, err: (e as Error).message }, "sweeper.interrupt_publish_failed");
    }
  }
  try {
    await interruptPublisher.flush();
  } catch (e) {
    logger.warn({ err: (e as Error).message }, "sweeper.interrupt_flush_failed");
  }
}

/**
 * Seam over the NATS connection.
 *
 * `nc` is a live binding on a module namespace, which is frozen, so a test
 * cannot substitute it. A plain object can be, and the indirection costs one
 * call on a path that runs at most once a minute.
 */
export const interruptPublisher = {
  available(): boolean { return !!nc; },
  publish(subject: string): void { nc.publish(subject); },
  async flush(): Promise<void> { await nc.flush(); },
};

/** Reap stuck `__dag_root__` rows.
 *
 *  `reapStaleTasks` above filters on `started_at IS NOT NULL`, which
 *  intentionally never matches dag_root rows — the root is a logical
 *  aggregate that Brain never marks as started; its state is reduced
 *  from its children. The downside is that when *children* fail (e.g.
 *  Hands workload poll timeout in `hydrate_benchmark`, brain_timeout in
 *  `pre_task`) but the scheduler doesn't propagate the failure back
 *  to the root, the root sits in `running` forever, pinning brain pods
 *  during rolling upgrades and polluting the leaderboard / runs UI.
 *
 *  This reaper closes the gap: any dag_root that's been running /
 *  preparing for longer than BRAIN_TASK_TIMEOUT_SEC AND has at least
 *  one terminally-failed child gets forced to `failed` with reason
 *  `dag_root_stuck`. Still-pending children of those roots are
 *  cascade-closed to `failed` (deps_failed) so the dispatcher /
 *  scheduler / brain don't keep polling them.
 *
 *  Idempotent (only matches non-terminal rows); audit-friendly
 *  (dedicated failure_reason + error_message keeps reaped rows
 *  greppable forever after).
 */
export async function reapStuckDagRoots(): Promise<number> {
  const reaped = await db.query(
    `UPDATE claw_tasks parent
        SET status         = 'failed',
            failure_reason = 'dag_root_stuck',
            error_message  = 'reaper: child(ren) failed but dag_root still running',
            completed_at   = NOW()
      WHERE parent.dag_node_id = '__dag_root__'
        AND parent.status IN ('running','preparing')
        AND parent.created_at < NOW() - ($1::int * INTERVAL '1 second')
        AND EXISTS (
          SELECT 1 FROM claw_tasks child
           WHERE child.dag_root_task_id = parent.task_id
             AND child.dag_node_id <> '__dag_root__'
             AND child.status = 'failed'
        )
      RETURNING task_id`,
    [BRAIN_TASK_TIMEOUT_SEC],
  );
  if (!reaped.rowCount) return 0;
  const ids = reaped.rows.map((r) => (r as { task_id: string }).task_id);
  const cascade = await db.query(
    `UPDATE claw_tasks child
        SET status         = 'failed',
            failure_reason = 'deps_failed',
            error_message  = 'cascaded from dag_root_stuck reap',
            completed_at   = NOW()
      WHERE child.dag_root_task_id = ANY($1::text[])
        AND child.dag_node_id <> '__dag_root__'
        AND child.status NOT IN ('failed','completed','cancelled')
      RETURNING task_id`,
    [ids],
  );
  logger.warn(
    { reapedRoots: reaped.rowCount, cascadedChildren: cascade.rowCount ?? 0, ids },
    "sweeper.reaped_dag_roots",
  );
  return reaped.rowCount;
}

/**
 * Close runs whose worker stopped renewing their lease.
 *
 * The question this answers -- is anything still executing this run? -- used to
 * be answered by inference: a queue message still unacknowledged meant probably
 * yes, and running out of redelivery attempts meant probably no, hours later. Neither separates a worker that died from one that is slow, which
 * is why the backstop above waits out a whole timeout before touching anything.
 * A lease answers it directly, and an expired one is not ambiguous: the worker
 * would have renewed it seconds ago if it were there.
 *
 * Unlike the deadline backstop this publishes no interrupt. There is by
 * definition nothing listening -- that is what the expired lease means -- and
 * the interrupt is keyed by session, which outlives any one run: publishing it
 * would risk aborting whatever the user is running now over a run that ended
 * long ago. Closing the row is the entire job.
 *
 * Only rows that ever had a lease are eligible. Current chat, task, and DAG
 * dispatches all issue one; rows dispatched before that protocol, workers too
 * old to renew, and messages nobody claimed keep a NULL lease and reach the
 * never-claimed timeout above instead.
 *
 * The one exception is deliberate and follows the reap rather than widening
 * it: a chat row that
 * shares its message id with a row reaped here was opened by the same dispatch
 * and never claimed by anybody, and closing it is what lets the session's gate
 * be released -- see closeUnclaimedDispatchSiblings.
 *
 * The grace this waits out is the load-bearing part, and it is derived rather
 * than picked -- see LEASE_LOST_GRACE_SEC in config and the derivation it comes
 * from in @claw/protocol/run-lease. What it has to outlast is not the queue's
 * ack_wait but the takeover that ack_wait leads to: the redelivered copy still
 * has to acquire `lock.<key>`, which the dead worker holds for the registry
 * bucket's TTL, so the resume can land minutes after the redelivery. Reaping
 * first does not merely report early -- the worker that finally gets the lock
 * reads the terminal row and stands down, turning a pod death that would have
 * cost a resume from checkpoint into a lost turn.
 *
 * A row at `cancelling` is archived as cancelled rather than as a worker the
 * fleet lost, the same three branches the deadline backstop carries. This path
 * reaches such a row sooner -- minutes rather than a whole timeout -- so a stop
 * whose worker died before confirming it arrives here first. The trade is that
 * a run which had already crashed when the user pressed stop is recorded as
 * their cancellation and the worker loss goes uncounted; that way round is the
 * cheaper mistake, since the user's intent is the thing the archive is read
 * for, and the loss is still in this function's own log line either way.
 *
 * The branches are written out here rather than as SQL comments inside the
 * statement, because a `--` comment inside a template literal survives only as
 * long as nobody collapses the string onto one line.
 */
export async function requeueLostDoorbellLeases(): Promise<number> {
  const r = await db.query(
    `UPDATE claw_tasks
        SET status = 'queued',
            lease_owner = NULL,
            lease_expires_at = NULL,
            heartbeat_at = NULL,
            internal_token_hash = NULL,
            ${RUN_REQUEUE_RESET_SQL}
      WHERE status IN ('preparing','running')
        AND origin = 'chat'
        AND metadata->>'dispatch' = 'doorbell'
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at < NOW() - ($1::int * INTERVAL '1 second')
        AND (deadline_at IS NULL OR deadline_at > NOW())
      RETURNING task_id, session_id`,
    [LEASE_LOST_GRACE_SEC],
  );
  if (!r.rowCount) return 0;
  logger.warn(
    { requeued: r.rowCount, graceSec: LEASE_LOST_GRACE_SEC, rows: r.rows },
    "sweeper.requeued_lost_doorbell_leases",
  );
  return r.rowCount;
}

/**
 * What a queue timeout has to say, and to whom.
 *
 * Closing the row and opening the gate is the database's half. The client
 * subscribed to the session is the other one: it has had a `UserMessage` on
 * screen since dispatch and is waiting for the turn to end. Nothing here used
 * to end it, so the turn simply stopped -- no assistant reply, no result, no
 * `exec_complete` -- and the stream stayed open on a question nobody answered.
 *
 * The same three events every other terminal path publishes, in the same
 * order, so a reader that already handles `announceClaimFailure` needs no new
 * case. `exec_complete` carries `failed: true`, which the durable consumer
 * turns into `agent_status = 'failed'` and a `closeChatRun` -- both harmless
 * here, since the row is already terminal and `failed` leaves the gate open.
 *
 * Two wordings, because a queued row is not always a run that never started.
 * `requeueLostDoorbellLeases` returns a row that lost its worker to `queued`,
 * and that row may have executed for an hour before the pod died -- telling
 * its user "nothing ran, send it again" would be a claim this function cannot
 * make. `claim_count` is what separates them: it is incremented by `takeClaim`
 * and never reset, so a non-zero count means somebody held this run.
 */
export async function reapExpiredQueuedRuns(): Promise<number> {
  const r = await db.query(
    `UPDATE claw_tasks
        SET status = 'failed',
            failure_reason = 'queue_timeout',
            error_message = 'queued past RUN_QUEUE_MAX_SEC without a worker claiming the run',
            completed_at = NOW()
      WHERE status = 'queued'
        AND origin = 'chat'
        AND metadata->>'dispatch' = 'doorbell'
        AND queued_at IS NOT NULL
        AND queued_at < NOW() - ($1::int * INTERVAL '1 second')
      RETURNING task_id, session_id, prompt, claim_count,
                metadata->>'message_id' AS message_id,
                COALESCE(metadata->>'user_id', input->>'user_id') AS user_id`,
    [RUN_QUEUE_MAX_SEC],
  );
  if (!r.rowCount) return 0;
  // Ids, not rows: the RETURNING above carries `prompt` so the announcement
  // can quote the turn, and this sink has no redaction.
  logger.warn({ reaped: r.rowCount, ids: idsOf(r.rows) }, "sweeper.reaped_expired_queue");
  for (const row of r.rows as ExpiredQueuedRow[]) {
    // Hand the workspace reference back here, as the doorbell reaper and the
    // Stop path both do. Leaving it to releaseRefsOfFinishedRuns works, but
    // that fallback defaults `changed` to true, so a run that never started --
    // this one is queued, claim_count 0 -- would bump the workspace version as
    // if it had written something.
    await releaseRunUse(row.task_id, false);
    await announceQueueTimeout(row);
  }
  const ids = r.rows.map((row) => (row as { session_id: string }).session_id);
  await releaseSessionsOfLostRuns(ids);
  return r.rowCount;
}

/** What a reap may log. The rows themselves carry the user's prompt. */
function idsOf(rows: unknown[]): Array<{ task_id: string; session_id: string }> {
  return rows.map((r) => ({
    task_id: (r as { task_id: string }).task_id,
    session_id: (r as { session_id: string }).session_id,
  }));
}

interface ExpiredQueuedRow {
  task_id: string;
  session_id: string;
  prompt: string | null;
  claim_count: number | null;
  message_id: string | null;
  user_id: string | null;
}

async function announceQueueTimeout(row: ExpiredQueuedRow): Promise<void> {
  const everHeld = Number(row.claim_count ?? 0) > 0;
  const finalText = everHeld
    ? "This run lost its worker and no replacement claimed it before the queue "
      + "wait ran out. It may have partly run; check the session before resending."
    : "This run waited for a worker longer than the queue allows. Nothing ran, "
      + "and it can be sent again.";
  await announceRunFailure(row, "queue_timeout", finalText);
}

/** The terminal three events, for a reaper that closed a row out from under a turn. */
// The subset announceRunFailure actually reads. Narrowed from ExpiredQueuedRow
// so reapLostLeases' rows (which have no claim_count) satisfy it too.
type AnnounceableRow = Pick<
  ExpiredQueuedRow,
  "task_id" | "session_id" | "message_id" | "user_id" | "prompt"
>;

async function announceRunFailure(
  row: AnnounceableRow,
  failureReason: string,
  finalText: string,
): Promise<void> {
  const of = (event: Record<string, unknown>): Record<string, unknown> => ({
    session_id: row.session_id,
    message_id: row.message_id ?? undefined,
    ...event,
  });
  try {
    await sweeperPorts.publishSessionEvent(row.session_id, of({
      type: "AssistantMessage",
      data: { content: [{ type: "text", text: finalText }] },
    }));
    await sweeperPorts.publishSessionEvent(row.session_id, of({ type: "ResultMessage" }));
    await sweeperPorts.publishSessionEvent(row.session_id, of({
      type: "exec_complete",
      user_id: row.user_id ?? "default",
      prompt: row.prompt ?? "",
      final_text: finalText,
      failed: true,
      failure_reason: failureReason,
      error_count: 0,
      skills_used: {},
    }));
  } catch (err) {
    // The row is already closed and the gate release still runs; a stream that
    // missed its terminal event is worth a line, not a failed tick.
    logger.warn({ err, taskId: row.task_id, failureReason }, "sweeper.run_failure_announce_failed");
  }
}

/**
 * Close a doorbell run that outlived its budget, because nothing else will.
 *
 * Every other reaper declines this row on purpose, and together the declines
 * leave a gap. `requeueLostDoorbellLeases` admits a row whose `deadline_at` is
 * NULL or still ahead, so it stops handing the row back only once a budget it
 * was given has been spent -- correctly, since another claim would only spend a
 * budget that is gone. `reapLostLeases` leaves doorbell `preparing`/`running`
 * rows to that requeue pass. `reapStaleTasks` skips chat rows unless
 * `RUN_ROWS_SWEEPABLE`. So a run whose lease lapsed after its deadline passed
 * stays non-terminal for ever.
 *
 * All of which is conditional on a budget existing. `RUN_BUDGET_CHAT_SEC`
 * defaults to 48 hours, so the ordinary row does reach here -- but a deployment
 * that sets it to `RUN_BUDGET_OFF` leaves `deadline_at` NULL, and then this
 * reaper's `deadline_at IS NOT NULL` predicate never matches and the function
 * is inert. Such a row keeps being requeued instead, on the NULL arm above, and
 * what ends it is the ceiling `claim_count` carries: twenty-two claims, then a
 * row archived as retries-exhausted, with nothing recorded about why.
 *
 * Not `reapExpiredQueuedRuns`, which is the tempting second backstop and is not
 * one. It judges the wait from `queued_at`, and `RUN_REQUEUE_RESET_SQL` stamps
 * `queued_at = NOW()` on every requeue, so a row going round that loop never
 * accumulates `RUN_QUEUE_MAX_SEC` of queue time and this reaper never matches
 * it. Turning the budget off does not hand the backstop to the queue ceiling;
 * it leaves exactly one, counted in claims rather than in time.
 *
 * Which is not merely untidy. The row keeps its slice of the admission count,
 * so a tenant's ceiling erodes one abandoned turn at a time, and it keeps the
 * workspace reference that stops the collector reclaiming those files. The
 * session gate is the one thing it does not hold, because `reapStuckSessions`
 * judges occupancy on `queued` or a live lease -- but the gate was only ever
 * half of what this row is holding.
 *
 * The grace matches the deadline backstop's, so a run that is about to report
 * its own timeout is given the same chance to do it first.
 */
export async function reapExpiredDoorbellRuns(): Promise<number> {
  const r = await db.query(
    `UPDATE claw_tasks
        SET status = 'failed',
            failure_reason = 'run_budget_exhausted',
            error_message = 'run budget exhausted at ' || deadline_at
                            || '; the lease lapsed after the deadline, so no worker could take it again',
            completed_at = NOW(),
            lease_owner = NULL,
            lease_expires_at = NULL,
            heartbeat_at = NULL,
            internal_token_hash = NULL
      WHERE origin = 'chat'
        AND metadata->>'dispatch' = 'doorbell'
        AND status IN ('queued','preparing','running')
        AND deadline_at IS NOT NULL
        AND deadline_at < NOW() - ($1::int * INTERVAL '1 second')
        AND (lease_expires_at IS NULL OR lease_expires_at < NOW())
      RETURNING task_id, session_id, prompt, claim_count,
                metadata->>'message_id' AS message_id,
                COALESCE(metadata->>'user_id', input->>'user_id') AS user_id`,
    [RUN_BUDGET_BACKSTOP_GRACE_SEC],
  );
  if (!r.rowCount) return 0;
  logger.warn({ reaped: r.rowCount, ids: idsOf(r.rows) }, "sweeper.reaped_expired_doorbell_runs");
  for (const row of r.rows as ExpiredQueuedRow[]) {
    // Both halves of what the row was holding, in the order the queue reaper
    // uses: tell the turn's reader it is over, then let go of the files.
    await announceRunFailure(
      row,
      "run_budget_exhausted",
      "This run used its whole time budget and its worker went away before it "
      + "reported a result. It can be sent again.",
    );
    await releaseRunUse(row.task_id, false);
  }
  await releaseSessionsOfLostRuns(
    r.rows.map((row) => (row as { session_id: string }).session_id),
  );
  return r.rowCount;
}

export async function reapLostLeases(): Promise<number> {
  const r = await db.query(
    `UPDATE claw_tasks
        SET status         = CASE WHEN status = 'cancelling' THEN 'cancelled' ELSE 'failed' END,
            failure_reason = CASE WHEN status = 'cancelling' THEN 'cancelled' ELSE 'worker_lost' END,
            error_message  = CASE
                               WHEN status = 'cancelling'
                                 THEN 'the run was cancelled; its worker went away before confirming the stop, '
                                      || 'and the sweeper closed the row'
                               ELSE 'the lease on this run expired at ' || lease_expires_at
                                    || '; no worker has renewed it since'
                             END,
            completed_at   = NOW()
      WHERE status IN ('preparing','running','cancelling')
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at < NOW() - ($1::int * INTERVAL '1 second')
        -- COALESCE, not a bare comparison: a fat chat row has no dispatch
        -- key, so metadata->>'dispatch' = 'doorbell' is NULL, the whole
        -- conjunction is NULL, and NOT NULL is NULL -- which is not TRUE, so
        -- the row is dropped from the pass. This exclusion was written to hand
        -- live doorbell rows to requeueLostDoorbellLeases; without the COALESCE
        -- it also, silently, stopped this reaper from ever closing a fat chat
        -- row whose worker died. Nothing else closes one: reapStaleTasks skips
        -- chat unless RUN_ROWS_SWEEPABLE (default off), and every other chat
        -- reaper is scoped to doorbell rows.
        AND NOT (
          origin = 'chat'
          AND COALESCE(metadata->>'dispatch', '') = 'doorbell'
          AND status IN ('preparing','running')
        )
      RETURNING task_id, session_id, origin, lease_owner,
                metadata->>'message_id' AS message_id,
                sandbox_workload_id,
                failure_reason,
                prompt,
                COALESCE(metadata->>'user_id', input->>'user_id') AS user_id`,
    [LEASE_LOST_GRACE_SEC],
  );
  if (!r.rowCount) return 0;
  const rows = r.rows as Array<{
    task_id: string;
    session_id: string;
    origin: string;
    lease_owner: string | null;
    message_id: string | null;
    sandbox_workload_id: string | null;
    failure_reason: string;
    prompt: string | null;
    user_id: string | null;
  }>;
  logger.warn(
    {
      reaped: r.rowCount,
      graceSec: LEASE_LOST_GRACE_SEC,
      // prompt is intentionally dropped: it is user input, and RETURNING now
      // carries it for the announce below. Everything else is diagnostic.
      rows: rows.map(({ prompt: _prompt, ...rest }) => rest),
    },
    "sweeper.reaped_lost_leases",
  );
  const chatRows = rows.filter((row) => row.origin === "chat");
  // Before the announce, because the announce is a publish and the consumer at
  // the other end of it closes rows by message id. `closeChatRun` updates every
  // open chat row carrying the reaped row's `metadata->>'message_id'`, which is
  // exactly the set this statement exists to close -- and it stamps them with
  // the event's own `worker_lost`. Publishing first is therefore a race the
  // spare row can lose: it is archived as a worker that was lost, on the one
  // row in the pair no worker ever held, and the statement below then finds
  // nothing left to correct. Closing first leaves the consumer nothing to
  // match, whichever of the two gets there first.
  //
  // Caught rather than awaited into the caller, because the ordering must not
  // buy back the failure it was reordered away from. The row above is already
  // terminal and this reaper's WHERE clause only ever selects
  // `preparing`/`running`/`cancelling`, so no later sweep can select it again:
  // anything that throws between closing the row and publishing loses that
  // turn's exec_complete permanently. A spare row left open is a smaller
  // failure than a turn the session forgets, and `reapStuckSessions` is still
  // the backstop for it, so this one is logged and stepped over.
  try {
    await closeUnclaimedDispatchSiblings(chatRows);
  } catch (err) {
    logger.error({ err, ids: idsOf(chatRows) }, "sweeper.close_dispatch_siblings_failed");
  }
  // A reaped chat run must still record its turn. recordCompletionTurns -- the
  // sole writer of claw_conversation_turns -- runs only on exec_complete, and
  // this reaper published none, so a later message rebuilt history from an empty
  // table and the session forgot the work. Mirror reapExpiredDoorbellRuns and
  // announce the terminal trio. worker_lost only: announceRunFailure emits
  // failed:true with no interrupted flag, so announcing the cancelled branch
  // would mislabel a user-cancelled turn as a failure.
  //
  // Ahead of the gate release below, and that order is a durability argument
  // rather than tidiness for the same reason the try/catch above is: the gate
  // release is a database call that can throw, it is not a precondition of the
  // announce, and a throw in it must not be able to take the turn with it.
  //
  // It also keeps the conversation shut until the turn is at least on its way.
  // releaseSessionsOfLostRuns is what makes the session able to accept another
  // message, and a message admitted before this exec_complete is even published
  // reaches buildMessages with nothing coming. What that order cannot promise
  // is that the turn has been *recorded* by then: publishSessionEvent waits for
  // JetStream to ack the message, not for the consumer to run
  // recordCompletionTurns, so the gate can still open ahead of the write. That
  // window is the same one reapExpiredDoorbellRuns and reapExpiredQueuedRuns
  // have -- both announce and then release in one pass, with no primitive here
  // that can wait on the consumer -- and closing it is a cross-service change
  // rather than an ordering one.
  for (const row of chatRows) {
    if (row.failure_reason !== "worker_lost") continue;
    await announceRunFailure(
      row,
      "worker_lost",
      "This run lost its worker and no replacement renewed its lease before the "
        + "sweeper closed it. Its sandbox may still be finishing work; check the "
        + "session before resending.",
    );
  }
  // After the sibling close, whose rows are non-terminal until it runs and each
  // of which is enough on its own to make this release match nothing.
  await releaseSessionsOfLostRuns(chatRows.map((row) => row.session_id));
  // A worker and its sandbox commonly disappear together on node loss. The
  // expired lease closes the row; this read records the platform's reason while
  // the workload detail still exists. Best-effort because liveness cleanup must
  // not depend on the platform API being available.
  await backfillPlatformFacts(rows).catch((err) => {
    logger.warn({ err }, "sweeper.lost_lease_platform_backfill_failed");
    return 0;
  });
  return r.rowCount;
}

/**
 * Close the rows a retried dispatch left behind for the run just reaped.
 *
 * The queued-message drain opens the run row before it publishes and deletes the
 * queue row after, so a throw in between naks the `exec_complete` and runs the
 * whole handler again with the queue row still there. The republish carries the
 * queue row's id, so the stream recognises it as the message it already has and
 * drops it -- which is what keeps the turn from running twice. `openChatRun` has
 * run a second time by then, though, so two rows carry one
 * `metadata->>'message_id'` and only the first is the row a worker ever holds a
 * lease for.
 *
 * `closeChatRun` ends both, because it matches on the message id. The reap above
 * matches on an expired lease instead, so when the worker dies it closes the
 * leased row and leaves the spare at `preparing`: chat rows are exempt from the
 * deadline backstop unless RUN_ROWS_SWEEPABLE is set, and one non-terminal row
 * is enough to defeat the predicate that releases the conversation's gate. The
 * session then stayed gated until reapStuckSessions came past an hour later,
 * with every message sent in the meantime parked -- which is exactly the wait
 * releaseSessionsOfLostRuns was added to remove.
 *
 * Scoped as narrowly as the evidence is. A chat row with no lease is not
 * abandoned on that account -- it is what every run looks like in the seconds
 * before its worker's first renewal -- so only rows sharing the reaped row's
 * session and message id qualify. The reason says what they were rather than
 * borrowing `worker_lost`, which would claim a worker had held them.
 *
 * Where that argument ends: "the spare row never executes" holds only while the
 * stream still recognises the republish as a duplicate, and that is the task
 * stream's duplicate window, which is set to the same span as the retention and
 * therefore sized in hours by the redelivery budget rather than fixed (see
 * `resolveTaskStreamMaxAgeNs`). A replay that lands past it is a second publish,
 * so it is a second run that really does execute, and its row is at `preparing`
 * with `lease_expires_at IS NULL` until its worker's first renewal. A reap of
 * the first row landing inside those seconds closes a live run: the worker
 * carries on until its next renewal is refused, and the turn is archived as a
 * row nobody ever claimed.
 *
 * Stated rather than closed. Getting there needs one `exec_complete` to fail and
 * replay for the whole width of that window -- it naks in ten seconds, so some
 * hundreds of consecutive failures -- while the database and the stream stay
 * well enough for the retried drain to keep opening a row and publishing.
 * Closing it means telling the two rows apart by something other than the
 * absence of a lease: their `created_at` against the reaped row's, or a mark the
 * drain leaves on the row it replayed. That is a schema question rather than a
 * predicate one.
 */
async function closeUnclaimedDispatchSiblings(
  rows: Array<{ session_id: string; message_id: string | null }>,
): Promise<void> {
  const sessionIds: string[] = [];
  const messageIds: string[] = [];
  for (const row of rows) {
    // A row with no recorded message id has no sibling that can be identified,
    // and matching on NULL would pair it with every other such row.
    if (!row.message_id) continue;
    sessionIds.push(row.session_id);
    messageIds.push(row.message_id);
  }
  if (!sessionIds.length) return;
  const r = await db.query(
    `UPDATE claw_tasks t
        SET status         = 'failed',
            failure_reason = 'dispatch_retried',
            error_message  = 'a retried dispatch opened this row a second time; the turn ran '
                             || 'under the row that held the lease, and no worker ever claimed this one',
            completed_at   = NOW()
       FROM unnest($1::text[], $2::text[]) AS sibling(session_id, message_id)
      WHERE t.session_id = sibling.session_id
        AND t.metadata->>'message_id' = sibling.message_id
        AND t.origin = 'chat'
        -- A doorbell spare actually sits at queued. The rest of this list is
        -- the world before the doorbell, when every row a dispatch opened went
        -- straight to preparing; a retried doorbell dispatch opens its second
        -- row at queued with no lease, so none of the three matched and the
        -- spare survived the pass written to close it. It then holds the
        -- session gate shut -- closeChatRun counts queued as occupying -- and,
        -- worse, still satisfies peekNextQueued, so the row whose whole
        -- description is "no worker ever claimed this one" gets claimed and
        -- runs the turn a second time.
        -- (No backticks: this statement is a template literal.)
        AND t.status IN ('queued','preparing','running','cancelling')
        AND t.lease_expires_at IS NULL
        -- Never claimed, which is what this row's own error message says about
        -- it. Without this, adding queued above would also catch a row
        -- requeueLostDoorbellLeases had just put back: that pass runs one step
        -- earlier in the same tick and leaves the row queued with no lease, so
        -- a turn deliberately handed back for another attempt would be closed
        -- as a duplicate instead. A requeue resets queued_at and started_at
        -- and deliberately not claim_count, so the counter still separates the
        -- two: a spare no worker ever took is 0, a requeued row is at least 1.
        AND COALESCE(t.claim_count, 0) = 0
      RETURNING t.task_id`,
    [sessionIds, messageIds],
  );
  if (!r.rowCount) return;
  logger.warn(
    { closed: r.rowCount, ids: r.rows.map((row) => (row as { task_id: string }).task_id) },
    "sweeper.closed_unclaimed_dispatch_siblings",
  );
}

/**
 * How many messages are parked behind each of these sessions' gates.
 *
 * For the log line beside a gate release, and nothing decides anything on it,
 * so a failure here is swallowed rather than raised: the tick is a serial chain
 * and every reaper after the caller would otherwise be skipped because a count
 * could not be read.
 */
async function countPendingBySession(
  sessionIds: string[],
): Promise<Array<{ session_id: string; n: number }>> {
  const r = await db.query(
    `SELECT session_id, COUNT(*)::int AS n
       FROM claw_pending_messages
      WHERE session_id = ANY($1::text[])
      GROUP BY session_id`,
    [sessionIds],
  ).catch((e: unknown) => {
    logger.warn({ err: (e as Error)?.message }, "sweeper.pending_count_failed");
    return { rows: [] };
  });
  return r.rows as Array<{ session_id: string; n: number }>;
}

/**
 * Let the conversation move again once its run has been given up on.
 *
 * Closing the row answers "did that run finish"; `claw_sessions.agent_status`
 * answers "may this session accept another message", and nothing here used to
 * touch it. So a pod death left the row reaped in minutes and the conversation
 * gated until `reapStuckSessions` came past an hour later -- with every message
 * the user sent in between parked in `claw_pending_messages` rather than
 * refused, so from the outside the session had simply stopped answering.
 *
 * The gate is only released for a session with nothing else executing. A
 * session outlives any one turn, so the run being reaped here is not
 * necessarily the run holding the gate: the user may already have started
 * another, and freeing the gate under it would let a second message dispatch
 * into a conversation that is mid-reply. Anything still non-terminal keeps the
 * gate shut and leaves the session to the reaper that judges it directly.
 *
 * What this does not itself do is answer the messages that piled up while the
 * gate was shut. Draining them is `handleComplete`'s job -- it takes the oldest
 * one per completion event -- and this function publishes nothing. For the
 * caller that matters most it is no longer true that no such event exists:
 * `reapLostLeases` now announces the terminal trio for a `worker_lost` chat row
 * just before calling this, so that turn does reach `handleComplete`, which
 * records it and drains a message behind it. What the announce does not
 * guarantee is when. A publish is acked by JetStream, not by the consumer, so
 * the drain -- and the `recordCompletionTurns` write in front of it -- happens
 * on the consumer's own clock, which may well be after this release has opened
 * the gate. Whichever order they land in, the release is what lets a message
 * move at all.
 *
 * The rows with no announce keep the old shape whole -- a `cancelled` reap,
 * which is deliberately not announced as a failure, and any row whose publish
 * threw and was swallowed. Their pending messages still wait for the user's
 * next message, dispatch behind it, and arrive out of order. They are counted
 * in the log below so that wait stays visible.
 */
async function releaseSessionsOfLostRuns(sessionIds: string[]): Promise<void> {
  if (!sessionIds.length) return;
  const r = await db.query(
    `UPDATE claw_sessions s
        SET agent_status = 'idle',
            updated_at = NOW()
      WHERE s.session_id = ANY($1::text[])
        AND s.agent_status = 'running'
        AND s.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM claw_tasks t
           WHERE t.session_id = s.session_id
             AND t.status IN ('queued','preparing','running','cancelling')
        )
      RETURNING session_id`,
    [sessionIds],
  );
  if (!r.rowCount) return;
  const ids = r.rows.map((row) => (row as { session_id: string }).session_id);
  logger.warn(
    { released: r.rowCount, ids, orphanedPending: await countPendingBySession(ids) },
    "sweeper.released_sessions_of_lost_runs",
  );
}

/** Fail `waiting_external` rows past their per-node timeout. */
export async function reapWaitExternal(): Promise<number> {
  const r = await db.query(
    `UPDATE claw_tasks
     SET status = 'failed', failure_reason = 'external_timeout',
         error_message = 'wait_external did not resolve in time',
         completed_at = NOW()
     WHERE status = 'waiting_external'
       AND COALESCE(
             (metadata->'derived'->>'wait_external_timeout_sec')::int,
             $1
           ) > 0
       AND completed_at IS NULL
       AND queued_at IS NOT NULL
       AND queued_at < NOW() - (
         COALESCE(
           (metadata->'derived'->>'wait_external_timeout_sec')::int,
           $1
         ) * INTERVAL '1 second'
       )
     RETURNING task_id`,
    [WAIT_EXTERNAL_DEFAULT_SEC],
  );
  return r.rowCount ?? 0;
}

/**
 * Release sessions stuck at `agent_status = 'running'`.
 *
 * That column is the gate on the whole conversation: POST /messages flips it to
 * running before dispatch and back on `exec_complete`, and while it reads
 * running every further message is parked in `claw_pending_messages` instead of
 * dispatched. Nothing else expired it, so any run that ended without its
 * terminal event — a pod OOM-killed, a node lost, an ack budget exhausted —
 * left the session permanently unable to accept another message. There was no
 * user-facing way out and no error to look for; the session simply stopped
 * responding.
 *
 * Liveness is judged by the session's own event stream rather than by
 * `updated_at`, which many unrelated writes touch. A live run emits events
 * continuously, so "running, and silent for the whole window" is the
 * conservative reading: a healthy long run keeps its status, and a dead one is
 * released. Both conditions have to hold, so a row written recently for another
 * reason is left alone for one more cycle.
 *
 * A doorbell chat row can sit at `queued` with no session events at all — the
 * wakeup was acked, or admission never rang — so silence is not a verdict
 * while that row still occupies the session.
 *
 * Occupying is the word doing the work, and it is narrower than non-terminal.
 * Two row states earn the reprieve: `queued`, which `reapExpiredQueuedRuns`
 * closes at `RUN_QUEUE_MAX_SEC` and which opens the gate itself on the way
 * out, and a lease that has not expired, which says a Brain is holding the run
 * right now. Everything else that is merely non-terminal has to stay
 * releasable, because for two row shapes nothing else will ever close it:
 *
 *   - a fat row at `preparing`, whose `lease_owner` and `lease_expires_at`
 *     stay null until the worker's first renewal. Chat rows are exempt from
 *     `reapStaleTasks` unless `RUN_ROWS_SWEEPABLE`, and `reapLostLeases` wants
 *     a lease that was actually written, so one that never reached a worker is
 *     invisible to both;
 *   - a doorbell row at `preparing`/`running` whose lease lapsed after its
 *     deadline passed. `requeueLostDoorbellLeases` declines it on
 *     `deadline_at > NOW()`, `reapLostLeases` leaves doorbell preparing/running
 *     to that requeue pass, and `reapStaleTasks` skips chat.
 *
 * Suppressing on non-terminal alone therefore does not delay the release, it
 * removes it: `agent_status` stays `running` for good and every later message
 * parks in `claw_pending_messages` behind it, which is the exact failure this
 * reaper exists to end.
 *
 * Queued messages are reported rather than replayed. Draining them is
 * `handleComplete`'s job and reaching it from here needs that path extracted
 * first; releasing the gate at least lets the next message dispatch instead of
 * joining them.
 */
export async function reapStuckSessions(): Promise<number> {
  const r = await db.query(
    `UPDATE claw_sessions s
        SET agent_status = 'idle',
            updated_at = NOW()
      WHERE s.agent_status = 'running'
        AND s.deleted_at IS NULL
        AND s.updated_at < NOW() - ($1::int * INTERVAL '1 second')
        AND NOT EXISTS (
          SELECT 1 FROM claw_session_events e
           WHERE e.session_id = s.session_id
             AND e.created_at > NOW() - ($1::int * INTERVAL '1 second')
        )
        AND NOT EXISTS (
          SELECT 1 FROM claw_tasks t
           WHERE t.session_id = s.session_id
             AND t.origin = 'chat'
             AND t.status IN ('queued','preparing','running','cancelling')
             AND (t.status = 'queued' OR t.lease_expires_at > NOW())
        )
      RETURNING session_id`,
    [SESSION_STUCK_TIMEOUT_SEC],
  );
  if (!r.rowCount) return 0;
  const ids = r.rows.map((row) => (row as { session_id: string }).session_id);
  logger.warn(
    {
      released: r.rowCount,
      timeoutSec: SESSION_STUCK_TIMEOUT_SEC,
      ids,
      orphanedPending: await countPendingBySession(ids),
    },
    "sweeper.released_stuck_sessions",
  );
  return r.rowCount;
}

/** Reconcile DagHandleMap: drop entries for terminal DAG roots. */
export async function reapOrphanHandles(): Promise<number> {
  const all = await handleMap().listAll();
  let dropped = 0;
  for (const [dagRoot] of all) {
    const r = await db.query(
      `SELECT status FROM claw_tasks WHERE task_id = $1 AND dag_node_id = '__dag_root__'`,
      [dagRoot],
    );
    const status = r.rows[0]?.status ?? "missing";
    if (status === "completed" || status === "failed" || status === "cancelled" || status === "missing") {
      // We pass the dag root's session id when known; falling back to ""
      // is safe because safeStopWorkload reads the platform key from the
      // session and skips when absent.
      const sess = await db.query(`SELECT session_id FROM claw_tasks WHERE task_id = $1`, [dagRoot]);
      const sessionId = sess.rows[0]?.session_id ?? "";
      await stopAllHandlesForDag(dagRoot, sessionId);
      dropped++;
    }
  }
  return dropped;
}

/** Delete expired idempotency-cache rows so the table/index don't grow
 *  unbounded. Reads already filter on `expires_at > NOW()`, so these rows are
 *  dead — removing them changes no request behavior, only reclaims space. */
export async function reapExpiredIdempotency(): Promise<number> {
  const r = await db.query("DELETE FROM claw_idempotency_keys WHERE expires_at < NOW()");
  return r.rowCount ?? 0;
}

/**
 * Run one sweep so that a throw cannot take the rest of the tick with it.
 *
 * The tick is a serial chain. A statement timeout on a log-only count used
 * to skip every reaper scheduled after it. Leadership containment covered
 * two of the sites; the rest still shared one catch.
 */
async function runContained(event: string, work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch (e) {
    logger.error({ err: (e as Error)?.message ?? e }, event);
  }
}

export async function sweeperTick(): Promise<void> {
  await runContained("sweeper.stale_tasks_failed", reapStaleTasks);
  // Run AFTER reapStaleTasks so children freshly marked as
  // `brain_timeout` show up to reapStuckDagRoots in the same tick.
  await runContained("sweeper.stuck_dag_roots_failed", reapStuckDagRoots);
  // Ahead of the wait-external and session scans, and after the deadline
  // backstop, so a run that is both past its budget and abandoned is closed
  // with the reason that explains it rather than the one that noticed second.
  await runContained("sweeper.requeued_doorbell_leases_failed", requeueLostDoorbellLeases);
  await runContained("sweeper.lost_leases_failed", reapLostLeases);
  await runContained("sweeper.expired_queue_failed", reapExpiredQueuedRuns);
  // After the requeue pass: a row inside its deadline belongs to that pass,
  // and only what it declines is this one's.
  await runContained("sweeper.expired_doorbell_failed", reapExpiredDoorbellRuns);
  await runContained("sweeper.wait_external_failed", reapWaitExternal);
  await runContained("sweeper.stuck_sessions_failed", reapStuckSessions);
  // Retry platform reads deferred by a per-sweep cap or a transient failure,
  // even when this tick found no newly stale rows. Before this lived after
  // reapStaleTasks' early return, so a quiet next tick left the backlog forever.
  // Run before orphan cleanup can destroy the last workload detail available.
  await runContained("sweeper.platform_backfill_drain_failed", drainPendingPlatformFacts);
  // The one scan here whose action is not idempotent: it reads a handle,
  // decides the DAG behind it is over, and destroys a sandbox. Two replicas
  // reaching that conclusion together destroy it twice, and the second one is
  // deciding against a world that no longer exists -- which is how a sandbox
  // Brain has just rebuilt gets torn down under it.
  //
  // Contained rather than left to a tick-wide catch, because this is the
  // only sweep that needs a connection from the lock pool and it sits in
  // the middle of the tick. An exhausted or unreachable lock pool would
  // otherwise take the whole remainder with it.
  await withLeaderLock(LEADER_LOCK_IDS.orphanHandles, "orphan_handles", reapOrphanHandles)
    .catch((e) => {
      logger.error({ err: (e as Error)?.message ?? e }, "sweeper.orphan_handles_failed");
    });
  // Finish the session deletions the request that asked for them could not.
  // A leader for the same reason as the sweep above -- it reads a row, decides
  // the deletion is unfinished, and then walks S3 and writes to KV -- and
  // contained for the same reason too: this is the one part of the tick that
  // reaches four stores, and none of the sweeps after it need any of them.
  await withLeaderLock(LEADER_LOCK_IDS.sessionCleanup, "session_cleanup", runCleanupSweep)
    .catch((e) => {
      logger.error({ err: (e as Error)?.message ?? e }, "sweeper.session_cleanup_failed");
    });
  // After every reaper that can close a row, so a run this tick just ended
  // lets go of its workspace in the same tick rather than the next one. Also
  // a read-decide-act scan, and needs no leader for it: releasing a reference
  // that is already released does nothing, so two replicas agreeing is free.
  await runContained("sweeper.release_finished_refs_failed", releaseRefsOfFinishedRuns);
  // Both after the run sweep, so a session whose last run just closed is
  // judged on the state it ends the tick in rather than on the one it started
  // it in. The first reclaims what a failed teardown left behind and is on by
  // default; the second starts the countdown on the files of sessions that
  // still exist and is a no-op unless WORKSPACE_IDLE_RELEASE_DAYS is set.
  await runContained("sweeper.release_deleted_refs_failed", releaseRefsOfDeletedSessions);
  await runContained("sweeper.release_idle_refs_failed", releaseRefsOfIdleSessions);
  // Maintenance: prune expired idempotency rows last so a failure here can't
  // skip the task reapers above.
  await runContained("sweeper.idempotency_prune_failed", reapExpiredIdempotency);
}

export function startSweeper(): void {
  if (timer) return;
  stopped = false;
  const loop = async () => {
    if (stopped) return;
    try {
      await sweeperTick();
    } catch (e) {
      logger.error({ err: (e as Error)?.message ?? e }, "sweeper.tick_failed");
    }
    if (!stopped) timer = setTimeout(loop, TASK_SWEEPER_TICK_MS);
  };
  void loop();
  logger.info({ tickMs: TASK_SWEEPER_TICK_MS }, "sweeper.started");
}

export function stopSweeper(): void {
  stopped = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
