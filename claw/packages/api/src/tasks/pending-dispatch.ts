// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Putting a queued turn onto the queue.
 *
 * A turn that arrived while the session was busy is parked in
 * `claw_pending_messages` and replayed when the running turn finishes. Replay
 * used to be a plain publish, which made it the one dispatch path with no row
 * behind it: its worker could die and nothing reclaimed the run, because no
 * row said anyone had ever owned it. It gets the same row, lease and workspace
 * binding as the immediate path now, and the order in which it gets them is
 * the point of this module.
 *
 * The order, and what each step is protecting against:
 *
 *   1. Bind the workspace, refusing if it cannot. A run whose files are not
 *      named falls back to the session gate key, and two runs over one
 *      directory then delete each other's work. First, because a refusal must
 *      leave nothing behind -- and because the refusal is not always temporary,
 *      so a row opened before it is a row opened once per retry, for ever.
 *   2. Open the row. Before the publish, so a process that dies between the
 *      two leaves something the sweeper can close rather than a run that was
 *      never recorded.
 *   3. Publish, and treat a publish that merely might have failed as one that
 *      might have succeeded. Only a refusal the server sent back tears the row
 *      down; a timeout leaves it, because the message may be on the stream.
 *   4. Only then delete the queue row. The other order loses the message
 *      outright when the publish throws.
 *
 * Lifted out of the event-consumer handler it grew up in, where it was
 * unreachable from a test: the surrounding function needs a live NATS
 * connection, a marketplace, an LLM and a skill store before it gets this far.
 */

import { taskSubject, type ExecuteRequest } from "@claw/protocol";
import pino from "pino";

import { envInt, RUN_DOORBELL_DISPATCH } from "../config.js";
import { db } from "../infra/db.js";
import { publishEvent } from "../events/store.js";
import { js, sc, publishCertainlyFailed } from "../infra/nats.js";
import { openChatRun, failChatRunDispatch } from "./chat-run.js";
import { decideAdmission } from "./admission.js";
import { handOffAssembledRun } from "./run-dispatch.js";
import { injectLiveUserEnv } from "./run-claim.js";
import { ensureSessionWorkspace, requireWorkspaceBinding } from "../workspace/store.js";

const logger = pino({ name: "pending-dispatch" });

/**
 * How many times a queued message may be refused a workspace before it is
 * abandoned.
 *
 * Derived from the retry it bounds rather than chosen: the failure arrives back
 * here through the event consumer, which naks for ten seconds, so six attempts
 * is the minute the DAG path already allows itself for the same refusal (see
 * BIND_RETRY_WINDOW_MS in tasks/dispatcher.ts). Long enough for a failover or a lock
 * held by a migration, and short of an outage -- past which retrying is not
 * patience, it is a queued message reopening a run row every ten seconds and
 * re-running the completion handler's memory insert and profile call with it.
 *
 * A count rather than a window because the row carries no usable clock: a queued
 * message waits behind the turn in front of it, for hours if that turn takes
 * hours, so anything measured from `created_at` would be exhausted before the
 * first attempt.
 *
 * The floor is two attempts, because the value is compared against the count
 * this attempt has just been added to: at one, `attempts < BIND_MAX_ATTEMPTS`
 * is false the first time it is asked, so a single database hiccup takes the
 * abandon branch and drops a message that one retry would have delivered --
 * exactly what the floor is there to exclude.
 */
const BIND_MAX_ATTEMPTS = envInt("PENDING_DISPATCH_BIND_MAX_ATTEMPTS", 6, { min: 2 });

/**
 * The ceiling for the paths the counter above does not reach.
 *
 * Two of them: a queue row whose counting statement failed, and one past the
 * bound whose run row could not be opened. Both answer "retry", both are right
 * to, and neither consults `bind_attempts` -- so what bounds them is nothing at
 * all. Above them sits a `nak(10_000)` with no delivery ceiling, and every
 * redelivery re-runs the completion handler from the top: the completed turn's
 * record, the explicit memory write, the user-profile update and the summary
 * and memory extraction that call an LLM, and the evolution job. That is the
 * loop the counter exists to stop, running for as long as the stream holds the
 * event.
 *
 * Twice the ordinary bound, so a message really is given the retries it is owed
 * before either path gives up, and expressed against it so raising one raises
 * both.
 */
const BIND_MAX_UNCOUNTED_ATTEMPTS = 2 * BIND_MAX_ATTEMPTS;

/**
 * Attempts this process has made for a queue row it could not count.
 *
 * In memory because the durable counter is what failed; there is nowhere else
 * to put it that the failure does not also reach. That makes it a weaker bound
 * than `bind_attempts` -- a restart forgets, and a redelivery may be picked up
 * by another replica -- but a weak ceiling on this path is the difference
 * between "eventually gives up" and "never does", and the case it bounds is a
 * database that is answering some statements and not others.
 *
 * Keyed by the queue row, and dropped as soon as the row's fate is decided, so
 * this holds an entry per message currently failing to be counted rather than
 * per message ever dispatched.
 */
const uncountedAttempts = new Map<string, number>();

function countUncountedAttempt(pendingId: unknown): number {
  const key = String(pendingId);
  const attempts = (uncountedAttempts.get(key) ?? 0) + 1;
  uncountedAttempts.set(key, attempts);
  return attempts;
}

/** Forget a row that is settled, or whose durable counter is answering again. */
function forgetUncountedAttempts(pendingId: unknown): void {
  uncountedAttempts.delete(String(pendingId));
}

export interface PendingDispatchInput {
  sessionId: string;
  /** `claw_pending_messages.id` of the row being replayed. */
  pendingId: unknown;
  userId: string;
  messageId: string;
  prompt: string;
  workspaceId?: string;
  pluginId?: number;
  sandboxImage?: string;
  /**
   * The execute request, already assembled by the caller. Mutated here to
   * carry the lease and the workspace binding, matching what the immediate
   * path sends.
   */
  task: Record<string, unknown>;
}

export interface PendingDispatchResult {
  /**
   * The run row this dispatch opened, or null when the message was abandoned.
   * An insert that failed throws instead of returning here: publishing without
   * a row is how sessions sat at `running` with nothing to reap.
   */
  runId: string | null;
}

/**
 * Seam over the collaborators, in one object so a test can replace them.
 *
 * Same shape as `interruptPublisher` in tasks/sweeper.ts and for the same reason:
 * `js` and `sc` are live bindings on a frozen module namespace, and the two
 * chat-run helpers reach a database this path has no other need of.
 */
export const pendingDispatchPorts = {
  openChatRun,
  failChatRunDispatch,
  doorbellDispatch: RUN_DOORBELL_DISPATCH,
  admit: decideAdmission,
  requireWorkspaceBinding,
  async bindWorkspace(sessionId: string, userId: string): Promise<string | undefined> {
    return (await ensureSessionWorkspace(sessionId, userId))?.workspace_id;
  },
  async publish(subject: string, payload: string, msgId: string): Promise<void> {
    await js.publish(subject, sc.encode(payload), { msgID: msgId });
  },
  publishSessionEvent: publishEvent,
};

/**
 * Count this attempt against the queue row's own counter.
 *
 * @returns how many attempts this message has now had, `"row_gone"` when
 *          another drain has already taken the row, or `"uncounted"` when the
 *          statement itself failed.
 */
async function countBindAttempt(
  input: PendingDispatchInput,
): Promise<number | "row_gone" | "uncounted"> {
  try {
    const counted = await db.query(
      `UPDATE claw_pending_messages SET bind_attempts = bind_attempts + 1
        WHERE id = $1
        RETURNING bind_attempts`,
      [input.pendingId],
    );
    const attempts = (counted.rows[0] as { bind_attempts?: number } | undefined)?.bind_attempts;
    return attempts ?? "row_gone";
  } catch (err) {
    // Answered rather than raised, and answered as "keep retrying". This runs
    // inside the handler for a completion event the consumer naks every ten
    // seconds with no delivery ceiling, so an exception escaping here is the
    // permanent loop the counter exists to stop.
    //
    // Not for a missing column, which the startup schema guard now refuses to
    // boot without (see REQUIRED_SCHEMA in infra/schema-guard.ts): a deployment that
    // reaches this line has the column. What is left is the transient kind --
    // a connection dropped mid-statement, a lock wait, a statement timeout --
    // where one failed count is not evidence about the message and the next
    // delivery may well succeed. Bounded rather than trusted, though: see
    // BIND_MAX_UNCOUNTED_ATTEMPTS for what stops "retriable" from meaning
    // "for ever".
    logger.warn(
      { err, sessionId: input.sessionId, pendingId: input.pendingId },
      "pending.bind_attempt_count_failed",
    );
    return "uncounted";
  }
}

/**
 * Tell the session that this turn was refused, and end it the way turns end.
 *
 * Three events, because one serves neither audience. `exec_complete` is
 * filtered out of the SSE stream (see routes/events.ts), so on its own it
 * closes the turn with nothing for the user to see; the pair in front of it is
 * what Brain publishes when a run dies before its loop starts, and it is what
 * renders as the reply.
 *
 * `exec_complete` is the one that has to be there, for two reasons that have
 * nothing to do with the client. It writes the turn -- a queued message's user
 * turn is only recorded when that turn completes, so without this the message
 * the user sent leaves no trace in anything they can read. And it is what moves
 * the queue: draining is driven by the completion handler, one row per event,
 * so a turn that ends without one leaves everything queued behind it waiting
 * for the next message the user happens to send.
 *
 * Three and not the four Brain sends from the same place: it publishes a
 * `statusUpdate` with `agentStatus: "failed"` between the pair and the
 * completion, and that one is about a sandbox, which this refusal never got as
 * far as starting. Leaving it out changes nothing on the server -- the API's
 * own consumer acts on the `running` form of that event alone, and the
 * session's status is written from `exec_complete` either way -- and the
 * frontend lives in another repository, so what it makes of the difference
 * cannot be checked from here.
 *
 * The text is the refusal in the user's terms rather than the internal reason,
 * which goes on the run row and into the log where an operator will look for it.
 */
export async function publishRefusedTurn(
  input: PendingDispatchInput,
  failureReason = "workspace_bind_failed",
): Promise<void> {
  const finalText = failureReason === "workspace_bind_failed"
    ? "This message was not started: its workspace could not be prepared. "
      + "Nothing ran, and it can be sent again."
    : "This message was not started: the cluster refused it. "
      + "Nothing ran, and it can be sent again.";
  const of = (event: Record<string, unknown>): Record<string, unknown> => ({
    session_id: input.sessionId,
    message_id: input.messageId,
    ...event,
  });
  await pendingDispatchPorts.publishSessionEvent(input.sessionId, of({
    type: "AssistantMessage",
    data: { content: [{ type: "text", text: finalText }] },
  }));
  await pendingDispatchPorts.publishSessionEvent(input.sessionId, of({ type: "ResultMessage" }));
  await pendingDispatchPorts.publishSessionEvent(input.sessionId, of({
    type: "exec_complete",
    user_id: input.userId,
    prompt: input.prompt,
    final_text: finalText,
    failed: true,
    failure_reason: failureReason,
    error_count: 0,
    skills_used: {},
  }));
}

async function refusePendingAdmission(
  input: PendingDispatchInput,
  reason: string,
): Promise<void> {
  logger.error(
    { sessionId: input.sessionId, pendingId: input.pendingId, err: reason },
    "pending.admission_rejected",
  );
  await publishRefusedTurn(input, reason);
  forgetUncountedAttempts(input.pendingId);
  try {
    await db.query("DELETE FROM claw_pending_messages WHERE id = $1", [input.pendingId]);
  } catch (err) {
    logger.warn(
      { err, sessionId: input.sessionId, pendingId: input.pendingId },
      "pending.admission_rejected_delete_failed",
    );
  }
}

/**
 * Give up on a queued message, leaving the traces a turn that ran leaves.
 *
 * `workspace_bind_failed` on the run row is the same reason the DAG path
 * records for the same refusal, in the same table an operator already queries
 * for what ran. The queue row goes at the same time: left in place it would be
 * picked up again by the next completion event on that session, ahead of
 * anything the user has sent since.
 *
 * @returns whether the message is settled. False leaves it queued for the next
 *          redelivery to try again, which is the only safe answer when the run
 *          row could not be opened: that row is the whole record of the refusal,
 *          and an unhealthy database -- the usual reason a binding is refused in
 *          the first place -- is exactly the state in which it fails to open.
 *          Deleting the queue row anyway would drop the user's message with
 *          nothing anywhere saying it had existed. True also covers a queue row
 *          that could not be deleted, for the reason given at that delete: the
 *          refusal is recorded by then, and asking for the message again is what
 *          would make one stuck delete into a growing number of them.
 */
async function abandonPendingMessage(
  input: PendingDispatchInput,
  reason: string,
  attempts: number,
  counter: "bind_attempts" | "process" = "bind_attempts",
): Promise<boolean> {
  // `counter` says which of the two ceilings this count came from, because the
  // number alone reads as the queue row's and the process-local tally means
  // something different: a smaller sample, and a counter that was failing.
  logger.error(
    { sessionId: input.sessionId, pendingId: input.pendingId, attempts, counter, err: reason },
    "pending.workspace_bind_abandoned",
  );
  const run = await pendingDispatchPorts.openChatRun({
    sessionId: input.sessionId,
    userId: input.userId,
    messageId: input.messageId,
    prompt: input.prompt,
    workspaceId: input.workspaceId,
    // No reference to take: the binding being given up on here is the step that
    // would have named a workspace to record one against, and asking again
    // costs another round trip against the database that just refused it.
    recordWorkspaceUse: false,
    pluginId: input.pluginId,
    sandboxImage: input.sandboxImage,
  });
  if (run) {
    await pendingDispatchPorts.failChatRunDispatch(run.taskId, reason, "workspace_bind_failed");
  } else if (attempts < BIND_MAX_UNCOUNTED_ATTEMPTS) {
    logger.error(
      { sessionId: input.sessionId, pendingId: input.pendingId, attempts },
      "pending.abandon_deferred_no_run_row",
    );
    return false;
  } else {
    // Past the second ceiling, waiting for a row that is not being written is
    // no longer patience. The refusal ends the turn on the strength of this log
    // line and the session events below instead: less than a run row an
    // operator can query, and far less than a completion handler re-running its
    // LLM calls every ten seconds until the stream drops the event.
    logger.error(
      { sessionId: input.sessionId, pendingId: input.pendingId, attempts, err: reason },
      "pending.abandoned_without_run_row",
    );
  }
  // The events go before the queue delete, not after. `publishRefusedTurn`
  // throws when NATS is unavailable or its third publish fails, and the other
  // order leaves the queue row already deleted and the run row already terminal
  // with no `exec_complete` behind them: the turn is never written, so the
  // message the user sent leaves no trace anywhere they can read, and the
  // redelivery finds no row to try again with. This order costs a repeated
  // refusal at worst -- the completion the events publish brings the drain back
  // to this session and it may find the row still here -- and a repeat is
  // cheap: the user turn is inserted `ON CONFLICT DO NOTHING` on the message
  // id, the run row is already terminal, and nothing executes either way.
  //
  // A publish that throws does cost something: the redelivery comes back here
  // and opens a second run row for the same message, one per attempt for as
  // long as the event bus is down. Bounded by the event's own retention, and
  // the alternative is the message itself being the thing that goes missing.
  await publishRefusedTurn(input);
  // Settled here, whatever the delete below does: the turn is written and the
  // run row is terminal, so nothing more is owed to this attempt. A tally kept
  // past that point has the next drain of this session abandon the row on
  // attempts nobody is still making.
  forgetUncountedAttempts(input.pendingId);
  try {
    await db.query("DELETE FROM claw_pending_messages WHERE id = $1", [input.pendingId]);
  } catch (err) {
    // Recorded rather than raised, because raising here multiplies. A nak brings
    // this message back to this same row, and the `exec_complete` just published
    // brings a drain of the session to it as well -- two successors per round,
    // for as long as the delete keeps failing. Left in place, the row is instead
    // picked up by one drain and refused again, which is the single repeat the
    // ordering above already accepts.
    logger.error(
      { err: String(err), sessionId: input.sessionId, pendingId: input.pendingId },
      "pending.abandon_delete_failed",
    );
  }
  return true;
}

/**
 * Stop replaying a message whose workspace is never going to be bound.
 *
 * `ensureSessionWorkspace` answers null for every reason there is, so the
 * refusal that repairs itself in a second and the one that never will look
 * identical from here. Retrying is right for the first and unbounded for the
 * second: each attempt used to open a run row before finding out, so a condition
 * that outlasts the day turned one queued message into thousands of rows.
 *
 * Every path out of here is bounded, which is the property worth stating: the
 * queue row's own counter bounds the ordinary refusal, and
 * BIND_MAX_UNCOUNTED_ATTEMPTS bounds the two that cannot consult it.
 *
 * @returns whether the caller should stop rather than raise for another attempt.
 */
async function bindRefusalIsFinal(
  input: PendingDispatchInput,
  reason: string,
): Promise<boolean> {
  const attempts = await countBindAttempt(input);
  if (attempts === "row_gone") {
    // Nothing left to replay and nothing to count: another drain of this
    // session took the row. Not an error, and not worth a retry that would
    // find the same absence ten seconds later.
    forgetUncountedAttempts(input.pendingId);
    logger.warn({ sessionId: input.sessionId, pendingId: input.pendingId }, "pending.row_vanished");
    return true;
  }
  // A count that failed falls back to this process's own tally, because the
  // alternative is no bound: the retry it asks for is a redelivery nobody
  // limits, and the handler it lands in re-runs every completion step from the
  // top. Held to a looser ceiling than a counted message, since the failure
  // being counted is the counter's rather than the message's.
  if (attempts === "uncounted") {
    const local = countUncountedAttempt(input.pendingId);
    if (local < BIND_MAX_UNCOUNTED_ATTEMPTS) {
      logger.warn(
        { sessionId: input.sessionId, pendingId: input.pendingId, uncounted: local, err: reason },
        "pending.workspace_bind_retrying",
      );
      return false;
    }
    return abandonPendingMessage(input, reason, local, "process");
  }
  // The durable counter is answering again, so this process's tally is stale
  // and would otherwise abandon a message on attempts nobody is still making.
  forgetUncountedAttempts(input.pendingId);
  if (attempts < BIND_MAX_ATTEMPTS) {
    logger.warn(
      { sessionId: input.sessionId, pendingId: input.pendingId, attempts, err: reason },
      "pending.workspace_bind_retrying",
    );
    return false;
  }
  return abandonPendingMessage(input, reason, attempts);
}

export async function dispatchPendingMessage(
  input: PendingDispatchInput,
): Promise<PendingDispatchResult> {
  const { sessionId, task } = input;
  const subject = taskSubject();

  // Bound before the row is opened, and bound once. A refusal here leaves
  // nothing behind -- no row, no reference -- which is what lets the retry above
  // be a retry rather than an accumulation.
  let filesWorkspaceId: string;
  try {
    filesWorkspaceId = pendingDispatchPorts.requireWorkspaceBinding(
      await pendingDispatchPorts.bindWorkspace(sessionId, input.userId),
      { sessionId },
    );
  } catch (err) {
    const reason = String((err as Error)?.message ?? err);
    if (await bindRefusalIsFinal(input, reason)) return { runId: null };
    throw err; // bubble up so the outer event-consumer nak'd retry can rerun
  }

  task.files_workspace_id = filesWorkspaceId;
  task.files_workspace_required = true;

  if (pendingDispatchPorts.doorbellDispatch) {
    return finishPendingDoorbell(input, task);
  }

  if (!task.user_env || typeof task.user_env !== "object" || !Object.keys(task.user_env).length) {
    await injectLiveUserEnv(task as unknown as ExecuteRequest);
  }

  const run = await pendingDispatchPorts.openChatRun({
    sessionId,
    userId: input.userId,
    messageId: input.messageId,
    prompt: input.prompt,
    workspaceId: input.workspaceId,
    filesWorkspaceId,
    pluginId: input.pluginId,
    sandboxImage: input.sandboxImage,
  });
  // Same rule as the immediate path: a turn with no row has no lease, no
  // deadline, and nothing a sweeper can close. Publishing it anyway is how
  // sessions sat at `running` with no worker and no error. Retry instead --
  // the queue row is still here, and a transient insert failure is exactly
  // what the outer nak is for.
  if (!run) {
    logger.error({ sessionId, pendingId: input.pendingId }, "pending.open_failed");
    throw new Error("chat_run.open_failed");
  }
  task.run_lease = run.lease;
  task.files_workspace_id = filesWorkspaceId;
  task.files_workspace_required = true;

  let publishAttempted = false;
  try {
    // Serialised first, and the flag set only once there is something to send.
    // A payload that will not serialise never reaches the connection, so
    // counting it as a publish that may have landed leaves the row open for a
    // redelivery that will find no message on the stream and nothing to
    // resolve it with.
    const payload = JSON.stringify(task);
    // Published under the queued row's id, so a drain that reaches this line
    // twice puts one task on the stream rather than two.
    publishAttempted = true;
    await pendingDispatchPorts.publish(subject, payload, input.messageId);
  } catch (err) {
    // `certain` says whether the run row was torn down, which is the difference
    // between "this turn has not started" and "this turn may be running
    // already" when someone reads this line afterwards. The one step above the
    // publish is certain by construction: a payload that would not serialise
    // never reached the stream, and leaving its row open would leave one nobody
    // closes.
    const certain = !publishAttempted || publishCertainlyFailed(err);
    logger.error(
      { err, sessionId, pendingId: input.pendingId, certain },
      "pending.publish_failed",
    );
    // Only when the publish certainly did not land. A timed-out publish may be
    // on the stream already, and the retry republishes under the same id, so
    // the stream drops the retry's copy and the first one runs -- against this
    // row. Failing it here would have that worker refused on its first
    // heartbeat, and the turn would be lost rather than merely repeated.
    //
    // Leaving it open costs a spare row when the publish really had failed, and
    // not for long: the replay's row carries the same message id, so the close
    // that ends the turn ends both.
    if (certain) {
      await pendingDispatchPorts.failChatRunDispatch(
        run.taskId,
        String((err as Error)?.message ?? err),
      );
    }
    throw err; // bubble up so the outer event-consumer nak'd retry can rerun
  }

  await db.query("DELETE FROM claw_pending_messages WHERE id = $1", [input.pendingId]);
  // The row is gone, so any tally kept for it while the counter was failing is
  // about a message that has now been dispatched.
  forgetUncountedAttempts(input.pendingId);
  await db.query(
    "UPDATE claw_sessions SET agent_status = 'running' WHERE session_id = $1 AND deleted_at IS NULL",
    [sessionId],
  );
  logger.info({ sessionId }, "pending.dispatched");
  return { runId: run.taskId };
}

async function finishPendingDoorbell(
  input: PendingDispatchInput,
  task: Record<string, unknown>,
): Promise<PendingDispatchResult> {
  const result = await handOffAssembledRun({
    task,
    sessionId: input.sessionId,
    userId: input.userId,
    messageId: input.messageId,
    prompt: input.prompt,
    workspaceId: input.workspaceId,
    filesWorkspaceId: typeof task.files_workspace_id === "string" ? task.files_workspace_id : undefined,
    pluginId: input.pluginId,
    sandboxImage: input.sandboxImage,
    publish: (subject, payload, msgId) =>
      pendingDispatchPorts.publish(subject, payload, msgId ?? input.messageId),
    openRun: pendingDispatchPorts.openChatRun,
    failRun: pendingDispatchPorts.failChatRunDispatch,
    admit: pendingDispatchPorts.admit,
  });
  if (result.kind === "open_failed") {
    logger.error({ sessionId: input.sessionId, pendingId: input.pendingId }, "pending.open_failed");
    throw new Error("chat_run.open_failed");
  }
  if (result.kind === "rejected") {
    await refusePendingAdmission(input, result.reason);
    return { runId: null };
  }
  await db.query("DELETE FROM claw_pending_messages WHERE id = $1", [input.pendingId]);
  forgetUncountedAttempts(input.pendingId);
  await db.query(
    "UPDATE claw_sessions SET agent_status = 'running' WHERE session_id = $1 AND deleted_at IS NULL",
    [input.sessionId],
  );
  logger.info(
    { sessionId: input.sessionId, kind: result.kind, runId: result.taskId },
    "pending.dispatched",
  );
  return { runId: result.taskId };
}
