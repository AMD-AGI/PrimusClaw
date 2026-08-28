// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A row for the thing a chat turn is.
 *
 * A conversational run has, until now, had no persisted identity: no row, no
 * authoritative status, no deadline, no record of what it owns. Everything it
 * did was tracked by one column on the session -- `agent_status` -- which says
 * whether the session is busy and nothing about the run making it busy. A
 * surprising number of separate problems are that absence wearing different
 * hats. The sweeper cannot see a chat run that hung, because there is nothing
 * to see. The workspace collector cannot tell whose files these are, so it
 * infers ownership from paths and consequently dares not delete much. Nothing
 * can answer how many runs a tenant has in flight, or what happened during a
 * run that finished an hour ago.
 *
 * So chat turns start writing rows to the same table DAG nodes use. This is
 * the first half of that, and it mostly adds: concurrency is still gated by
 * `agent_status`, and the deadline backstop still leaves these rows alone (see
 * RUN_ROWS_SWEEPABLE), so there is room to compare the rows against the
 * sessions they shadow before anything depends on them being right.
 *
 * "Mostly", because the lease is not shadow. An expired lease is what tells the
 * sweeper a worker died, and the worker that later takes the delivery over
 * reads the row it closed and stands down -- so these rows are already load
 * bearing on the path this exists for, which is a run surviving the loss of the
 * pod running it.
 *
 * Every function here is best-effort and swallows its errors, reporting by
 * returning null. Callers that publish a turn must treat that null as a failed
 * dispatch -- a message with no row cannot be leased or reaped -- but the
 * refusal belongs there, not here. The systematic failure this leaves
 * uncovered -- the column not existing at all -- is caught at startup by the
 * schema guard instead.
 */
import { createHash, randomBytes } from "node:crypto";
import pino from "pino";
import type { RunLease } from "@claw/protocol";
import { db } from "../infra/db.js";
import { newTaskId } from "./ids.js";
import { insertTask } from "./db.js";
import { deadlineStampSql, RUN_BUDGET_DEFAULT_SEC } from "./run-budget.js";
import type { TaskStatus } from "./types.js";
import { recordRunUse, releaseRunUse } from "../workspace/store.js";
import { publishEvent } from "../events/store.js";

const logger = pino({ name: "chat-run" });

// Same default the DAG expander uses: the API talking to itself, which works
// out of the box in dev and should be set explicitly in production.
const INTERNAL_BACKEND_URL =
  process.env.INTERNAL_BACKEND_URL || `http://127.0.0.1:${process.env.API_PORT || "8200"}`;

/** How a chat run ended, in the vocabulary the row uses. */
export type ChatRunOutcome = "completed" | "failed" | "cancelled";

/**
 * The message id a queued turn is dispatched under.
 *
 * Derived from the queued row rather than the clock, because the drain that
 * sends it can run twice for one message: publishing is not the last thing the
 * completion handler does, and anything after it failing brings the handler
 * back on redelivery with the queued row still there. A fresh `claw-<now>` each
 * time made the replay a different turn to everything downstream, and nothing
 * downstream could tell.
 *
 * The row's id is the one thing about a queued message that does not change
 * between attempts, and it is gone as soon as the turn is really dispatched, so
 * it cannot collide with a later one. What recognises the replay is the stream:
 * the publish carries this id as its message id, and the duplicate window drops
 * the second copy before any worker sees it.
 *
 * That is the whole of the protection, and it has to be, because nothing
 * downstream would notice a second turn that got past it. The transcript is
 * written by turn index with no uniqueness on the message, so a turn that ran
 * twice is simply in the history twice -- read back to the user, and fed to the
 * model on every later turn.
 *
 * The run row is not deduplicated either: `claw_tasks` is keyed by its own id,
 * so a replay whose publish is dropped still opens one. It is left open, and
 * `closeChatRun` ends it along with the row the worker is really executing,
 * because it matches on this message id and closes every row that carries it.
 *
 * The reaper that closes a run whose worker died does not match that way. It
 * matches on an expired lease, and the spare row never had one -- nothing writes
 * `lease_expires_at` until a worker renews -- so it used to be left at
 * `preparing`, where it was enough to hold the conversation's gate shut until
 * the hourly session reaper. `closeUnclaimedDispatchSiblings` in the sweeper
 * closes it alongside the row it reaps, keyed on this id being the one thing the
 * two rows share.
 */
export function queuedMessageId(pendingRowId: number | string): string {
  return `claw-pending-${pendingRowId}`;
}

export interface OpenChatRunInput {
  sessionId: string;
  userId: string;
  /** The chat message id, which is how Brain refers to this run. */
  messageId: string;
  prompt: string;
  workspaceId?: string;
  /**
   * The workspace the caller has already bound this turn to, if it has.
   *
   * Passed in rather than resolved here so a turn is bound exactly once. The
   * caller has to know the id before it writes anything -- a turn that cannot be
   * bound is refused, and the refusal must leave nothing behind -- and resolving
   * it a second time here would let the reference and the writer claim land on a
   * different workspace than the one the gate was told about. Absent for callers
   * that still leave the lookup to this function.
   */
  filesWorkspaceId?: string;
  /**
   * Whether this run should be recorded as a user of the session's workspace.
   *
   * On by default, because a run that is about to execute has to hold a
   * reference for as long as it is writing those files. The caller that says no
   * is opening a row for a turn whose binding has just been established as
   * impossible: there is no workspace to reference, and asking for one here
   * would put a second round trip -- and a second `workspace.ensure_failed` --
   * against the database that has just refused the first.
   */
  recordWorkspaceUse?: boolean;
  pluginId?: number;
  sandboxImage?: string;
  /**
   * Secret-free execute spec written to `claw_tasks.input`. Present when the
   * doorbell path is on: claim hydrates the request from this rather than
   * from the JetStream payload.
   */
  spec?: Record<string, unknown>;
  /** Defaults to `preparing`, which is "the doorbell is going out now". */
  status?: "queued" | "preparing";
  /**
   * Whether to mint a lease token at insert. The doorbell path issues the
   * token at claim time instead, because nothing holds it between the two.
   */
  issueLease?: boolean;
}

/** What openChatRun hands back: the row's id, and how to keep it alive. */
export interface OpenChatRunResult {
  taskId: string;
  /** The workspace this run's files belong to, when one could be recorded. */
  workspaceId?: string;
  /**
   * Where the run renews its lease, and the token to do it with. Issued here
   * because this is where the row is created, and the token has to be a secret
   * the row can verify -- only its sha256 is stored.
   *
   * Absent when `issueLease` was false: the doorbell path mints the token at
   * claim time, and there is nothing to hand back at insert.
   */
  lease?: RunLease;
}

/**
 * Record that a chat turn is about to be dispatched.
 *
 * Written before the publish rather than after, so a process that dies between
 * the two leaves a record of a run that was attempted rather than no record at
 * all. Callers that go on to publish must treat a null return as a failed
 * dispatch: a message with no row has no lease and no deadline, and sits at
 * `running` until an operator notices. What closes a row that did open is
 * worth being exact about, because three different things can:
 *
 * - `closeChatRun`, from the `exec_complete` of a run that ended normally;
 * - `reapLostLeases`, once the lease this row hands the worker stops being
 *   renewed. Chat rows are not exempt from that one, and a worker that later
 *   takes the delivery over reads the terminal row and stands down;
 * - `teardownSession`, when the session the run belongs to is deleted.
 *
 * `reapStaleTasks`, the deadline backstop, is the one that still leaves these
 * rows alone unless `RUN_ROWS_SWEEPABLE` is set -- it is the only reaper that
 * publishes an interrupt, and an interrupt is keyed by session rather than by
 * run. With the flag on, the row is reachable through the never-claimed arm,
 * which matches on the `started_at` that `insertTask` stamps for a row opened
 * at `preparing`.
 *
 * The budget arm is the other half of that sentence, and it reaches the one
 * case the never-claimed arm cannot: a worker still heartbeating a stuck
 * engine, whose lease keeps `lease_expires_at` in the future. It matches on
 * `deadline_at`, so it applies exactly when `RUN_BUDGET_CHAT_SEC` is non-zero
 * -- 48 hours by default, `api.runBudgetChatSec` in the chart. Set that to zero
 * and no deadline is stamped, which leaves this case unreachable by either arm;
 * see the note on RUN_BUDGET_DEFAULT_SEC for what else a deadline buys.
 *
 * Opens directly at `preparing` because that is what the DAG dispatcher means by
 * it -- the execution message is going out now -- and there is no queue in front
 * of a chat turn to sit in.
 *
 * `message_id` goes in metadata rather than becoming the primary key: the id
 * is a millisecond timestamp, which is unique enough for a serialised
 * conversation and not unique enough to be a key.
 *
 * @returns the new row's id, or null if the row could not be written.
 */
export async function openChatRun(input: OpenChatRunInput): Promise<OpenChatRunResult | null> {
  const taskId = newTaskId();
  // Scoped to this run and to lease renewal alone. The chat path deliberately
  // does not get `callback_url`: those endpoints move rows between states, wake
  // the scheduler and open the backend tool surface, and these rows are still a
  // shadow record. A lease says only that a worker is alive, which is safe to
  // accept now.
  //
  // Withholding the address is not withholding the authorization, though, and
  // that is where the scope actually lives: all four internal task routes verify
  // against the hash written below, and their URLs differ from the lease one by a
  // path segment. `internalTaskAuth` accepts a row's token for the acting routes
  // only when the row has the `callback_url` that named them, which is what makes
  // the absence here a limit rather than a convention.
  const issueLease = input.issueLease !== false;
  const leaseToken = issueLease ? randomBytes(32).toString("hex") : null;
  const status = input.status ?? "preparing";
  try {
    await insertTask({
      task_id: taskId,
      session_id: input.sessionId,
      origin: "chat",
      workspace_id: input.workspaceId ?? null,
      plugin_id: input.pluginId ?? null,
      name: input.prompt.slice(0, 64) || "chat",
      prompt: input.prompt,
      input: input.spec,
      status,
      internal_token_hash: leaseToken
        ? createHash("sha256").update(leaseToken).digest("hex")
        : null,
      metadata: {
        message_id: input.messageId,
        user_id: input.userId,
        ...(input.sandboxImage ? { sandbox_image: input.sandboxImage } : {}),
        ...(input.spec ? { dispatch: "doorbell" } : {}),
      },
    });
    const workspaceId = input.recordWorkspaceUse === false
      ? undefined
      : await recordRunUse(input.sessionId, input.userId, taskId, input.filesWorkspaceId);
    return {
      taskId,
      workspaceId,
      ...(leaseToken ? {
        lease: {
          url: `${INTERNAL_BACKEND_URL}/v1/internal/tasks/${taskId}/lease`,
          token: leaseToken,
        },
      } : {}),
    };
  } catch (err) {
    logger.warn(
      { err, sessionId: input.sessionId, messageId: input.messageId },
      "chat_run.open_failed",
    );
    return null;
  }
}

/**
 * Move the session's open chat run to `running`.
 *
 * Identified by session rather than by run id because the event that triggers
 * this -- Brain reporting that it has a sandbox and is starting -- is a
 * session event and carries no run identifier. That is sound while a session
 * runs one turn at a time, which is precisely what `agent_status` guarantees
 * and what this table is not yet allowed to change.
 */
export async function markChatRunRunning(sessionId: string): Promise<void> {
  try {
    await db.query(
      `UPDATE claw_tasks
          SET status = 'running',
              ${deadlineStampSql(2, 3)}
        WHERE session_id = $1
          AND origin = 'chat'
          AND status = 'preparing'`,
      [sessionId, RUN_BUDGET_DEFAULT_SEC.chat, RUN_BUDGET_DEFAULT_SEC.dag_node],
    );
  } catch (err) {
    logger.warn({ err, sessionId }, "chat_run.mark_running_failed");
  }
}

/**
 * Close the chat run a completion event belongs to.
 *
 * Prefers the run whose recorded `message_id` matches. Events from a Brain
 * that predates this carry none; falling back to every open chat row on the
 * session would close a turn that is still running -- a session is not
 * actually one-turn-at-a-time across the queued-drain window or a forced
 * interrupt idle. The fallback therefore fires only when exactly one row is
 * open, which is the case the missing id was meant to cover.
 *
 * `error_message` is bounded here rather than trusted: it comes from a failure
 * path, and failure paths are where oversized strings come from.
 */
export async function closeChatRun(
  sessionId: string,
  messageId: string | undefined,
  outcome: ChatRunOutcome,
  failureReason?: string,
): Promise<void> {
  // Two lists, because this statement asks two different questions.
  //
  // `queued` belongs in what a *named* turn may close: a lease judged lost puts
  // a row back on the queue while its worker may still be finishing, and the
  // `exec_complete` that follows found nothing to close -- the row stayed
  // queued, kept its workspace reference and its slice of the admission count,
  // and two hours later the queue reaper archived a completed run as one that
  // never started.
  //
  // It does not belong in what an *unnamed* one may close. With no message id
  // the fallback below closes the row on the grounds that it is the only open
  // one, and a queued row is the one state where that inference is wrong: it
  // is a turn that has not run, and the event in hand belongs to a different
  // turn whose row is already terminal. Closing it as completed would drop a
  // user's message with no trace. A queued row still *counts* as another open
  // row, though, so its presence stops the fallback guessing at anything else.
  const openStatuses: TaskStatus[] = ["queued", "preparing", "running", "cancelling"];
  const guessableStatuses: TaskStatus[] = ["preparing", "running", "cancelling"];
  try {
    const r = await db.query(
      `UPDATE claw_tasks
          SET status = $3,
              failure_reason = $4,
              error_message = $5,
              completed_at = NOW()
        WHERE session_id = $1
          AND origin = 'chat'
          AND (
            (status = ANY($2) AND metadata->>'message_id' = $6)
            OR (
              $6::text IS NULL
              AND status = ANY($7)
              AND NOT EXISTS (
                SELECT 1 FROM claw_tasks other
                 WHERE other.session_id = $1
                   AND other.origin = 'chat'
                   AND other.status = ANY($2)
                   AND other.task_id <> claw_tasks.task_id
              )
            )
          )
        RETURNING task_id`,
      [
        sessionId,
        openStatuses,
        outcome,
        outcome === "completed" ? null : (failureReason ?? outcome),
        outcome === "completed" ? null : (failureReason ?? "").slice(0, 2000) || null,
        messageId ?? null,
        guessableStatuses,
      ],
    );
    if (!r.rowCount) {
      // Not an error on its own: a run swept, cancelled or already closed by a
      // duplicate event has nothing left to close. Logged because during the
      // shadow phase a run that ends without a row to close is exactly the
      // discrepancy worth knowing about.
      //
      // Except for one case, which is not a discrepancy at all and would
      // otherwise be the loudest source of this line: an abandoned queued
      // message closes its own row and then publishes the `exec_complete` that
      // ends the turn, so this statement is guaranteed to match nothing. Logged
      // a level down, because a line that fires by construction is what teaches
      // people to filter the ones that do not.
      const expected = failureReason === "workspace_bind_failed";
      logger[expected ? "debug" : "info"](
        { sessionId, messageId, outcome, failureReason },
        "chat_run.close_matched_nothing",
      );
      return;
    }
    // The run is over, so it is no longer a reason to keep the files and no
    // longer the workspace's writer. A run that failed still counts as having
    // changed it: it may have written half of what it meant to.
    for (const row of r.rows as Array<{ task_id: string }>) {
      await releaseRunUse(row.task_id);
    }
  } catch (err) {
    logger.warn({ err, sessionId, messageId, outcome }, "chat_run.close_failed");
  }
}

/**
 * Close a run that was persisted but will never execute.
 *
 * The row is written before the publish, so a publish that fails leaves one
 * describing a run nobody will ever execute. A doorbell opens at `queued`; a
 * fat message opens at `preparing`. The caller is already rolling the session
 * back to idle; this rolls back the other half.
 *
 * `failureReason` is what an operator filters on, so the one caller that is not
 * a failed publish says so instead: a queued turn abandoned because its workspace
 * could never be bound is the same event the DAG dispatcher records as
 * `workspace_bind_failed`, and reading it as a dispatch failure sends whoever
 * finds it looking at NATS.
 */
/**
 * @returns what this call actually established, which is three answers and
 *   not two. `closed` means the row is failed and nothing will execute it.
 *   `held` means a worker has it and is running the turn, so the caller must
 *   not roll back -- refusing a live turn deletes the user's message and then
 *   answers it. `unknown` means the statement itself failed and neither of
 *   those was established.
 *
 *   `unknown` used to be folded into `held`, on the grounds that a row nobody
 *   closed would be picked up by `reapExpiredQueuedRuns`. That is true only on
 *   the doorbell path: it selects `status = 'queued'` and
 *   `metadata->>'dispatch' = 'doorbell'`, and a fat row is `preparing` with
 *   neither. Nothing reaps that row -- `reapLostLeases` wants a non-null
 *   `lease_expires_at` and `insertTask` never writes one, `reapStaleTasks`
 *   skips chat unless RUN_ROWS_SWEEPABLE -- so folding the two together left
 *   the row occupying an admission slot fleet-wide *and* skipped the rollback
 *   that would at least have freed the session.
 */
/**
 * Why the close matched nothing, which is not one answer but two.
 *
 * A row a worker holds does not match, and neither does a row that is already
 * terminal -- including the one this very function closed a moment ago.
 * Reading both as `held` is how a second compensation on the same row reports
 * that a turn is running: `handOffAssembledRun` throws after a successful
 * close, the outer dispatch catch compensates again on the task id its own
 * `failRun` wrapper just remembered, and this returns `held` for a row it had
 * already failed. The caller then skips the rollback and answers `dispatched`,
 * so the user's message stays in the conversation with nothing coming.
 *
 * A terminal row is `closed`: nothing will execute it, which is exactly what
 * the caller needs to know and exactly what a first successful close means.
 */
async function verdictForUnmatchedRow(taskId: string): Promise<FailDispatchVerdict> {
  const r = await db.query(
    `SELECT status, lease_owner FROM claw_tasks WHERE task_id = $1`,
    [taskId],
  );
  const row = r.rows[0] as { status?: string; lease_owner?: string | null } | undefined;
  // Gone entirely: whatever closed it, nothing is going to run it.
  if (!row) return "closed";
  if (!OPEN_RUN_STATUS_SET.has(String(row.status))) {
    logger.info({ taskId, status: row.status }, "chat_run.fail_dispatch_already_terminal");
    return "closed";
  }
  if (row.lease_owner) {
    logger.info({ taskId }, "chat_run.fail_dispatch_skipped_held");
    return "held";
  }
  // Open, unheld, and yet the UPDATE matched nothing: something changed under
  // the statement. Nothing was established, so say so.
  logger.warn({ taskId, status: row.status }, "chat_run.fail_dispatch_unmatched");
  return "unknown";
}

/**
 * The states the settle below is willing to close from, as one list.
 *
 * Shared with the statement rather than restated beside it: the two had
 * already drifted once -- the SQL closed from three states and the check that
 * reads the outcome recognised four -- which quietly turned a `cancelling` row
 * into "a worker is running this".
 */
const OPEN_RUN_STATUSES = ["queued", "preparing", "running"] as const;
const OPEN_RUN_STATUS_SET = new Set<string>(OPEN_RUN_STATUSES);
const OPEN_RUN_STATUS_SQL = OPEN_RUN_STATUSES.map((s) => `'${s}'`).join(",");

/** What a compensation established about the row it was asked to close. */
export type FailDispatchVerdict = "closed" | "held" | "unknown";

export async function failChatRunDispatch(
  taskId: string | null,
  reason: string,
  failureReason = "dispatch_failed",
): Promise<FailDispatchVerdict> {
  if (!taskId) return "unknown";
  try {
    // Only while nobody holds it. This used to be an unguarded transition on
    // the grounds that a dispatch which failed had never executed -- true when
    // the row's only route to a worker was the message this function is
    // compensating for. The doorbell path added a second route that does not
    // wait for it: `peekNextQueued` matches the row the instant `insertTask`
    // commits, which is before the post-insert recheck and before the wakeup
    // is published, so claim-next can be running the turn by the time any of
    // those steps fails. Failing it then closes a live run and, worse, hands
    // its workspace back underneath it.
    //
    // A holder settles its own row: it has the lease, the generation and the
    // terminal event. Leaving it alone is the whole fix.
    const r = await db.query(
      `UPDATE claw_tasks
          SET status = 'failed',
              failure_reason = $2,
              error_message = $3,
              completed_at = NOW()
        WHERE task_id = $1
          AND status IN (${OPEN_RUN_STATUS_SQL})
          AND lease_owner IS NULL
        RETURNING task_id`,
      [taskId, failureReason, reason.slice(0, 2000)],
    );
    if (!r.rowCount) return await verdictForUnmatchedRow(taskId);
    // Reached only when the row was still unclaimed, so nothing ever executed
    // and the workspace is exactly as the run found it.
    await releaseRunUse(taskId, false);
    return "closed";
  } catch (err) {
    // TODO(admission): an `unknown` on the fat path leaves the row at
    // `preparing` with a null lease, and no reaper can see that state --
    // `reapLostLeases` wants a non-null `lease_expires_at` and `insertTask`
    // never writes one, `reapStaleTasks` skips chat unless RUN_ROWS_SWEEPABLE,
    // and every other chat reaper is scoped to doorbell rows. The row then
    // counts against the fleet-wide `OCCUPYING` total in `loadUsage`, which
    // has no per-user or per-session dimension, so it holds an admission slot
    // for the life of the deployment.
    //
    // Left as it is on purpose: with no ADMIT_* ceiling configured -- the
    // default, and what this deployment runs -- `decideAdmission` returns
    // `admit` before it counts anything, so the row costs nothing. Reaching
    // this line at all needs the publish and this statement to fail inside the
    // same narrow window, having just seen a successful insert.
    //
    // Fix it before turning any ADMIT_* ceiling on. The cheap-looking options
    // are both worse than the problem today: RUN_ROWS_SWEEPABLE lets
    // `reapStaleTasks` cover chat, but that reaper interrupts by session and
    // would cut a different live run on the same one; stamping
    // `lease_expires_at` at insert changes every chat row's semantics on the
    // hot path.
    logger.warn({ err, taskId }, "chat_run.fail_dispatch_failed");
    return "unknown";
  }
}

/**
 * Cancel doorbell rows that Stop can never reach over NATS.
 *
 * A queued turn has no worker listening on `interrupt.<sessionId>`. Preparing
 * without a holder is the same: dispatcher CAS or an unclaim in flight. A
 * leased preparing/running row is already in a Brain, so the NATS interrupt
 * still owns that half.
 *
 * All of which is true of a doorbell row and of nothing else, so the predicate
 * says so. The fat path opens at `preparing` and leaves `lease_owner` null
 * until the worker's first renewal -- the renewal endpoint is the only writer
 * of that column -- so for the whole of delivery, the workspace gate and the
 * lock wait, a live fat run is indistinguishable on status alone from a
 * doorbell nobody took. Cancelling one of those closes the row, releases the
 * workspace reference and idles the session while its JetStream message is
 * still on the stream and about to execute: the interrupt published beside
 * this call is core NATS, so if the worker has not subscribed yet it is simply
 * lost, and the run carries on with nothing recording it.
 */
export async function interruptUnstartedChatRuns(sessionId: string): Promise<number> {
  let rows: Array<{ task_id: string; message_id: string | null; user_id: string | null; prompt: string | null }>;
  try {
    const r = await db.query(
      `UPDATE claw_tasks
          SET status = 'cancelled',
              failure_reason = 'cancelled',
              error_message = 'interrupted before a worker claimed the run',
              completed_at = NOW()
        WHERE session_id = $1
          AND origin = 'chat'
          AND metadata->>'dispatch' = 'doorbell'
          AND (
            status = 'queued'
            OR (status = 'preparing' AND lease_owner IS NULL)
          )
        RETURNING task_id, prompt,
                  metadata->>'message_id' AS message_id,
                  COALESCE(metadata->>'user_id', input->>'user_id') AS user_id`,
      [sessionId],
    );
    rows = r.rows as typeof rows;
  } catch (err) {
    logger.warn({ err, sessionId }, "chat_run.interrupt_unstarted_failed");
    return 0;
  }
  if (!rows.length) return 0;
  for (const row of rows) {
    await releaseRunUse(row.task_id, false);
    await announceInterruptedUnstarted(sessionId, row);
  }
  // Anything non-terminal left on this session keeps the gate shut, whether or
  // not it carries a lease. `lease_owner IS NOT NULL` used to stand in for "a
  // Brain has this", which is the same mistake as the predicate above: it does
  // not see a fat row that is executing but has not renewed yet, and idling the
  // session under one lets the next message dispatch on top of a live run.
  const stillHeld = await db.query(
    `SELECT 1 FROM claw_tasks
      WHERE session_id = $1
        AND origin = 'chat'
        AND status IN ('queued','preparing','running','cancelling')
      LIMIT 1`,
    [sessionId],
  );
  if ((stillHeld.rowCount ?? 0) === 0) {
    await db.query(
      `UPDATE claw_sessions
          SET agent_status = 'idle', updated_at = NOW()
        WHERE session_id = $1 AND agent_status = 'running' AND deleted_at IS NULL`,
      [sessionId],
    );
  }
  return rows.length;
}

/**
 * Break a session gate that an interrupt did not manage to close.
 *
 * The last resort behind Stop: a turn whose `exec_complete` never arrives
 * leaves `agent_status` at `running` for good, and every later message parks
 * behind it. Called on a timer, so by the time it runs the interrupt has had
 * its chance and anything still here is stuck.
 *
 * Unless it is not. This was the one writer of the column with no idea what
 * the session still held, so thirty seconds after a stop it handed the
 * conversation back whether or not a Brain was mid-turn, and the next message
 * dispatched alongside the live run. A lease still in the future is the single
 * unambiguous sign of a holder -- a worker renews it continuously and nothing
 * else writes it -- so that, and only that, stays its hand. A lapsed lease, or
 * none at all, is exactly the stuck case this exists for.
 *
 * @returns whether the gate was actually released.
 */
export async function forceIdleAfterInterrupt(sessionId: string): Promise<boolean> {
  const r = await db.query(
    `UPDATE claw_sessions
        SET agent_status = 'idle', updated_at = NOW()
      WHERE session_id = $1
        AND agent_status = 'running'
        AND NOT EXISTS (
          SELECT 1 FROM claw_tasks t
           WHERE t.session_id = $1
             AND t.origin = 'chat'
             AND t.status IN ('preparing','running','cancelling')
             AND t.lease_expires_at > NOW()
        )`,
    [sessionId],
  );
  return (r.rowCount ?? 0) > 0;
}

async function announceInterruptedUnstarted(
  sessionId: string,
  row: { task_id: string; message_id: string | null; user_id: string | null; prompt: string | null },
): Promise<void> {
  const finalText = "Interrupted before the run started.";
  const of = (event: Record<string, unknown>): Record<string, unknown> => ({
    session_id: sessionId,
    message_id: row.message_id ?? undefined,
    ...event,
  });
  try {
    await publishEvent(sessionId, of({
      type: "AssistantMessage",
      data: { content: [{ type: "text", text: finalText }] },
    }));
    await publishEvent(sessionId, of({ type: "ResultMessage" }));
    await publishEvent(sessionId, of({
      type: "exec_complete",
      user_id: row.user_id || "default",
      prompt: row.prompt ?? "",
      final_text: finalText,
      failed: false,
      interrupted: true,
      error_count: 0,
      skills_used: {},
    }));
  } catch (err) {
    logger.warn({ err, sessionId, taskId: row.task_id }, "chat_run.interrupt_unstarted_announce_failed");
  }
}
