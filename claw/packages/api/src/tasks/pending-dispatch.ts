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

import { doorbellDedupId, taskSubject, type ExecuteRequest } from "@claw/protocol";
import pino from "pino";

import { envInt } from "../config.js";
import { beginDoorbellDispatch } from "./doorbell-gate.js";
import { db } from "../infra/db.js";
import { completionAlreadyPublished, publishEvent } from "../events/store.js";
import { js, sc, publishCertainlyFailed } from "../infra/nats.js";
import {
  failChatRunDispatch, noteRefusedPublish, openChatRun, recordDispatchSeq, recordPublishState,
  SWEEPABLE_RUN_STATUSES, takeSessionGate, takeSessionGateIfUnowned,
  releaseSessionGateForTurn,
} from "./chat-run.js";
import type { PoolClient } from "pg";
import { decideAdmission } from "./admission.js";
import { withOwnedAdmissionLock } from "./admission.js";
import { newTaskId } from "./ids.js";
import { admissionAskFor, handOffAssembledRun, publishRunMessage } from "./run-dispatch.js";
import { stripRunSecrets } from "./run-spec.js";
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
  doorbellDispatch: beginDoorbellDispatch,
  admit: decideAdmission,
  requireWorkspaceBinding,
  async bindWorkspace(sessionId: string, userId: string): Promise<string | undefined> {
    return (await ensureSessionWorkspace(sessionId, userId))?.workspace_id;
  },
  async publish(subject: string, payload: string, msgId: string): Promise<number> {
    return (await js.publish(subject, sc.encode(payload), { msgID: msgId })).seq;
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
  /**
   * The row this refusal terminalized, when it opened one. Supplied rather
   * than inferred: without it a message-scoped terminal event can be read as
   * belonging to a sibling row that carries holder evidence.
   */
  taskId?: string,
): Promise<void> {
  const finalText = failureReason === "workspace_bind_failed"
    ? "This message was not started: its workspace could not be prepared. "
      + "Nothing ran, and it can be sent again."
    : "This message was not started: the cluster refused it. "
      + "Nothing ran, and it can be sent again.";
  const of = (event: Record<string, unknown>): Record<string, unknown> => ({
    session_id: input.sessionId,
    message_id: input.messageId,
    ...(taskId ? { task_id: taskId } : {}),
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

/**
 * Refuse a queued turn the fleet has no room for -- unless the turn is no
 * longer this drain's to refuse.
 *
 * The refusal ends a turn by publishing an `exec_complete` for this session and
 * message id, and that event is absorbed by whichever run the consumer decides
 * it belongs to. With no run named it is `closeUnnamedChatRun` that decides,
 * and that function matches on `(session_id, message_id)` alone: it fails the
 * run it finds. So a refusal published while a run for this message is open is
 * not a refusal at all -- it is a terminal event aimed at somebody else's live
 * turn.
 *
 * That is reachable from both branches, and it is reachable without anything
 * going wrong. Two drains of one queue row both read `absent` for the id they
 * share -- the selection that found the row takes no lock -- and one of them
 * goes on to open, publish and delete. The other resumes, reaches admission,
 * and with a hard ceiling in force it is the *first* one's now-open run that
 * puts the fleet over the limit. Its refusal then fails the turn that was
 * dispatched successfully, and the user's answer never arrives. The reservation
 * protects the INSERT from that drain; it did not protect this earlier exit.
 *
 * So the handoff is read once more, here, and the refusal is withdrawn when the
 * reservation names a run that owns the turn. It is the same question
 * `preparePendingHandoff` asks and the same function that answers it, because
 * it is the same question: the reserved id is the only identity this turn can
 * be dispatched under, so a live row under it is the whole of "somebody else
 * has this".
 *
 * Read here rather than inside the admission lock, which is the other place it
 * could go. The lock would make the read atomic against concurrent opens, but
 * the act it has to protect is the publish, and the publish happens after the
 * lock is released -- so the window would be the lock release rather than this
 * statement, which is longer, not shorter. The doorbell branch, which has the
 * identical hole, never enters that lock at all. What remains either way is the
 * gap between this read and the publish below; closing that would mean deleting
 * the queue row before publishing, and the ordering note on that delete says
 * why this path will not do that.
 *
 * The events name the reserved id, for the reason `publishRefusedTurn`'s own
 * parameter gives: a message-scoped terminal event with no row on it is one any
 * sibling row can be read as the subject of. Naming an id that no row exists
 * under makes the consumer classify the completion `foreign` and close nothing,
 * which is exactly right -- there is nothing to close -- while the turn, the
 * gate and the queue drain it also carries all still happen.
 */
async function refusePendingAdmission(
  input: PendingDispatchInput,
  reason: string,
  handoffId: string,
): Promise<PendingDispatchResult> {
  const recorded = await recordedHandoffState(handoffId);
  if (recorded === "open" || recorded === "unsettled") {
    logger.warn(
      { sessionId: input.sessionId, pendingId: input.pendingId, taskId: handoffId, recorded,
        err: reason },
      "pending.admission_refusal_withdrawn",
    );
    // `open` is a hand-off that happened: settled the way every other drain
    // settles one. `unsettled` is a run under this id whose delivery nothing
    // has established, and the refusal is withheld for the same reason the
    // drain withholds everything else there -- a completion published over it
    // would close a row that may be about to execute.
    return recorded === "open"
      ? await settleHandedOffTurn(input, handoffId, "open")
      : deliveryUnsettled(input, handoffId);
  }
  logger.error(
    { sessionId: input.sessionId, pendingId: input.pendingId, err: reason },
    "pending.admission_rejected",
  );
  // Named before the refusal is published, or the completion below releases
  // nothing and the drain stops here: the next parked message waits for an
  // event that is never coming. Pre-existing on the doorbell branch that shares
  // this function, and reachable from the fat branch too now that it admits.
  //
  // Taking a gate is a promise that something will hand it back, and the only
  // thing that can hand this one back is the completion published below. So it
  // is taken exactly when that completion will be processed, and given back
  // whenever it will not:
  //
  //  - Not taken at all when this message already has a completion published
  //    for it. A second refusal of the same message publishes an event the
  //    consumer discards -- a gate taken under it would have no releaser left.
  //    That is the state a swallowed delete below leads to: the first
  //    refusal's completion reopens the session, and the drain finds the row
  //    still queued and refuses again.
  //
  //    Existence, not `completionAlreadyProcessed`. That one requires
  //    `processed_at`, which the consumer writes only after `handleComplete`
  //    returns -- and the drain that reaches this second refusal runs inside
  //    `handleComplete`. The first completion is therefore mid-flight with a
  //    NULL `processed_at` at exactly this moment, and the processed-only test
  //    answers "no" for the completion that is about to discard ours.
  //  - Given back when the publish throws, which leaves the message queued with
  //    no completion coming at all.
  const releasable = !await completionAlreadyPublished(input.sessionId, input.messageId);
  const took = releasable
    && await takeSessionGateIfUnowned(input.sessionId, input.messageId);
  try {
    await publishRefusedTurn(input, reason, handoffId);
  } catch (err) {
    if (took) await releaseSessionGateForTurn(input.sessionId, input.messageId);
    throw err;
  }
  forgetUncountedAttempts(input.pendingId);
  try {
    await db.query("DELETE FROM claw_pending_messages WHERE id = $1", [input.pendingId]);
  } catch (err) {
    logger.warn(
      { err, sessionId: input.sessionId, pendingId: input.pendingId },
      "pending.admission_rejected_delete_failed",
    );
  }
  return { runId: null };
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
    // Fat-shaped, though nothing will be dispatched: an undispatched refusal
    // record that must stay eligible for fat reconciliation if its immediate
    // compensation returns an unknown outcome.
    dispatch: "fat",
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
  await publishRefusedTurn(input, "workspace_bind_failed", run?.taskId);
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

  const handoff = await preparePendingHandoff(input);
  if (handoff.kind === "settled") return handoff.result;

  const doorbellToken = pendingDispatchPorts.doorbellDispatch();
  if (doorbellToken) {
    // The token is released when this dispatch stops being able to publish a
    // doorbell, on every path out -- the publish resolving, the publish
    // throwing and its compensation returning, or any early return between.
    try {
      return await finishPendingDoorbell(input, task, handoff.taskId);
    } finally {
      doorbellToken.release();
    }
  }

  if (!task.user_env || typeof task.user_env !== "object" || !Object.keys(task.user_env).length) {
    await injectLiveUserEnv(task as unknown as ExecuteRequest);
  }

  // Admitted here for the reason the immediate path is: this branch is the
  // fallback `beginDoorbellDispatch` declines into, which includes a revoked
  // capability floor and a KV watch that merely died, and it used to open and
  // publish without consulting any ceiling at all. A pending message is the
  // worse half of that asymmetry -- the queue exists because the session was
  // busy, so these are precisely the turns a full fleet should be metering.
  //
  // Decided and inserted under one lock, as `handOffUncounted` requires:
  // creation order and commit order must be the same order, or two creates
  // that each cleared the check are both admitted against one slot.
  const fatAsk = await admissionAskFor({
    task, sessionId, userId: input.userId, messageId: input.messageId, prompt: input.prompt,
    publish: async () => undefined,
  } as Parameters<typeof admissionAskFor>[0]);
  const fatOpen = await withOwnedAdmissionLock(async (client: PoolClient) => {
    const admission = await pendingDispatchPorts.admit(fatAsk, client);
    if (admission.kind === "reject") return { admission } as const;
    return {
      admission,
      run: await pendingDispatchPorts.openChatRun({
        dispatch: "fat",
        // Opened under the id the queue row reserved, the same one the doorbell
        // branch above hands to `handOffAssembledRun`. This branch used to give
        // the reservation back and let `openChatRun` mint its own, which left
        // the queue row naming nobody from here until the DELETE below: a drain
        // that resumed inside that span read `absent` from
        // `recordedHandoffState`, minted a third id and opened a second run for
        // one user turn. `idx_tasks_chat_turn_unique` refuses that insert only
        // while the first row is still open, so a turn that has already
        // finished is one no index stops from being run again, and what is left
        // is the task stream's duplicate window -- a deadline rather than an
        // invariant, 161 minutes on the default delivery budget against a chat
        // run allowed 48 hours. Two agent loops, two answers to one message.
        //
        // Nothing is lost by no longer handing the reservation back first:
        // standing down for a row another drain has taken is
        // `preparePendingHandoff`'s answer above, read from the reservation
        // itself rather than from a second statement, and the reserved id is
        // the better stand-down evidence of the two.
        taskId: handoff.taskId,
        sessionId,
        userId: input.userId,
        messageId: input.messageId,
        prompt: input.prompt,
        workspaceId: input.workspaceId,
        filesWorkspaceId,
        pluginId: input.pluginId,
        sandboxImage: input.sandboxImage,
        // Secret-free: nothing rehydrates a fat row from `input`. What does
        // read it is admission's GPU aggregate, over `input->'topology'`, and
        // with no spec a fat GPU run counts zero nodes against every later
        // decision for its whole life.
        spec: { ...stripRunSecrets(task), dispatch: "fat" },
        client,
      }),
    } as const;
  });
  if (fatOpen.admission.kind === "reject") {
    // Under the reserved id, like every other decision this branch makes about
    // the turn. The refusal reads it once more before it publishes: see
    // `refusePendingAdmission` for what a refusal published over a live run for
    // this message does to that run.
    return await refusePendingAdmission(input, fatOpen.admission.reason, handoff.taskId);
  }
  // Deliberately not deferred, and logged rather than queued silently: a
  // deferral means leaving the row at `queued` for a claimer, and no claimer
  // takes a fat row -- `peekNextQueued` and `reapExpiredQueuedRuns` both
  // filter `metadata->>'dispatch' = 'doorbell'`. It would be run by nobody and
  // reaped by nobody. The hard ceiling above still refuses, so the fleet limit
  // holds; only the smoothing threshold is out of this path's reach.
  if (fatOpen.admission.kind === "queue") {
    logger.warn(
      { sessionId, pendingId: input.pendingId, position: fatOpen.admission.position },
      "pending.fat_soft_admission_not_deferred",
    );
  }
  const run = fatOpen.run;
  // Same rule as the immediate path: a turn with no row has no lease, no
  // deadline, and nothing a sweeper can close. Publishing it anyway is how
  // sessions sat at `running` with no worker and no error. Retry instead --
  // the queue row is still here, and a transient insert failure is exactly
  // what the outer nak is for.
  if (!run) {
    logger.error({ sessionId, pendingId: input.pendingId }, "pending.open_failed");
    throw new Error("chat_run.open_failed");
  }
  task.task_id = run.taskId;
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
    // A gate, not a note: an unrecorded `attempted` leaves a row denying a
    // message already on the stream, so a throw here must stop the publish.
    await recordPublishState(run.taskId, "attempted");
    // Published under the queued row's id, so a drain that reaches this line
    // twice puts one task on the stream rather than two.
    publishAttempted = true;
    const seq = await publishRunMessage(() => pendingDispatchPorts.publish(
      subject, payload, doorbellDedupId(sessionId, input.messageId),
    ));
    await recordDispatchSeq(run.taskId, seq);
  } catch (err) {
    // `certain` says whether the run row was torn down, which is the difference
    // between "this turn has not started" and "this turn may be running
    // already" when someone reads this line afterwards. Every step above the
    // publish is certain by construction: neither a payload that would not
    // serialise nor a receipt that would not commit ever reached the stream.
    const certain = !publishAttempted || publishCertainlyFailed(err);
    if (certain) await noteRefusedPublish(run.taskId);
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
        undefined,
        { statuses: SWEEPABLE_RUN_STATUSES },
      );
    }
    throw err; // bubble up so the outer event-consumer nak'd retry can rerun
  }

  await db.query("DELETE FROM claw_pending_messages WHERE id = $1", [input.pendingId]);
  // The row is gone, so any tally kept for it while the counter was failing is
  // about a message that has now been dispatched.
  forgetUncountedAttempts(input.pendingId);
  await takeSessionGate(sessionId, input.messageId);
  logger.info({ sessionId }, "pending.dispatched");
  return { runId: run.taskId };
}

/**
 * The run id this queued message is handed off under, decided once.
 *
 * Compare-and-set rather than a plain write, so concurrent drains of one queue
 * row converge on the same id instead of each minting its own. This statement
 * is the only serialisation point they share: the selection that found the row
 * takes no lock, so a second drainer can resume after the first has published
 * and deleted it.
 *
 * @returns null when no queue row matched, which means the message was handed
 *   off and its row deleted while this drainer was assembling. Answering with
 *   the fresh candidate instead let that drainer publish a second turn under an
 *   identity nothing had recorded.
 */
async function reserveDispatchTaskId(pendingId: unknown): Promise<string | null> {
  const candidate = newTaskId();
  const r = await db.query(
    `UPDATE claw_pending_messages
        SET dispatch_task_id = COALESCE(dispatch_task_id, $2)
      WHERE id = $1
      RETURNING dispatch_task_id`,
    [pendingId, candidate],
  );
  return (r.rows[0] as { dispatch_task_id?: string } | undefined)?.dispatch_task_id ?? null;
}

/**
 * What the run this queue row already opened did with the turn.
 *
 * One place, answering one question, because the reservation this reads is kept
 * for the whole of both branches now and every later drain decides the
 * message's fate from it. The question is not "what happened to this run" but
 * "is this turn still owed", and there are exactly three answers:
 *
 *   1. somebody owns this turn, or somebody did -- "open", and "consumed" once
 *      it is over. Stop replaying the message; the queue row may go.
 *   2. nobody owns it and nobody is coming for it -- "retryable". Open another
 *      row and send it.
 *   3. neither is established yet -- "unsettled". Decide nothing, and above all
 *      do not throw the message away.
 *
 * Three facts decide all three, and they are deliberately the ones that no
 * reaper, no failure path and no later pass can rewrite:
 *
 *   TERMINALITY. `status` says whether anything can still act on this row. The
 *   four open statuses mean a dispatcher, a claimer or a worker may still move
 *   it; the three terminal ones mean none of them will, because every gate a
 *   worker passes through -- the lease route, the claim route, `closeChatRun`'s
 *   status list -- refuses a row that is already settled. Terminal is therefore
 *   the only state in which "nobody is coming" is a fact rather than a guess,
 *   and it is what the C4 round established: nothing rotates the reservation
 *   off a row that is still open, because a live dispatcher one statement short
 *   of its publish is indistinguishable from a dead one, and rotating the id
 *   out from under the live one loses the turn's identity for good.
 *
 *   REACH. Whether a worker ever had this run: `lease_owner`, `lease_expires_at`
 *   or a non-zero `claim_count`. These are written only by a Brain taking the
 *   row -- `acquireFatLease` and `takeClaim` -- and nothing anywhere puts them
 *   back, so they outlive the run, the reaper that closed it and the
 *   compensation that finalised it. They are the same trio `reapOrphanedFatRuns`
 *   trusts for the same judgement, for the same reason.
 *
 *   ANSWER. Whether this turn already got one somewhere other than this row.
 *   Reach is about this row only, and a turn can be served, or ended and said
 *   to be ended, without this row ever being the thing that did it. Two paths
 *   do exactly that, and both leave a terminal row with no lease and no claim
 *   on it -- the shape reach alone reads as "nothing ran, send it again":
 *
 *     - `closeDuplicateDispatchSiblings` fails an unheld duplicate *because* a
 *       SIBLING row carried the same message to the end. It runs from
 *       `closeChatRun`, so by the time it writes, the row that answered the
 *       turn is terminal -- and therefore no longer holding
 *       `idx_tasks_chat_turn_unique` against a replacement. Retrying here is
 *       not a raise and a nak; it opens a real second doorbell row, and a
 *       doorbell row is executed by claim-next whatever the stream does with
 *       the wakeup. One message, two answers.
 *     - `reapExpiredQueuedRuns` closes a row that waited out `RUN_QUEUE_MAX_SEC`
 *       and then ANNOUNCES the turn's end -- AssistantMessage, ResultMessage
 *       and an `exec_complete` carrying `failed: true`. The turn is over and
 *       the user has been told so in words ("Nothing ran, and it can be sent
 *       again"); sending it again on their behalf answers a message the
 *       session has already closed.
 *
 *   The two are read from the two places that durably remember an answer. A
 *   SIBLING is a row in this same table for this row's session and message id
 *   that a worker reached or that reached `completed`/`cancelled` -- the same
 *   TERMINALITY and REACH questions asked of a different row, so no new kind of
 *   evidence and no recursion. An ANNOUNCEMENT is an `exec_complete` recorded
 *   against this row's message id in `claw_session_events`, which is the same
 *   fact `completionAlreadyPublished` reads a few hundred lines above and for
 *   the same reason; it is asked here as part of this row's read so that it is
 *   the ROW's message id being asked about rather than the drain's, and so the
 *   whole classification stays one round trip. If that predicate changes there,
 *   this copy has to follow.
 *
 *   Neither is the reaper's name in another costume, which is the trap the
 *   revision below was written to avoid. `duplicate_dispatch_row` and
 *   `queue_timeout` are strings a particular writer chose; a sibling row and a
 *   recorded completion are facts about the TURN, they are written by the paths
 *   that actually settled it rather than by the path that noticed, and any
 *   future reaper that settles a turn the same two ways is recognised without
 *   being named here.
 *
 * So: a terminal row a worker reached is a turn that was served, however it
 * ended, and a terminal row no worker ever reached is a turn that was not --
 * unless something outside the row already answered it. The
 * `failure_reason` is not consulted at all, and that is the point of this
 * revision. It used to be, and the string turned out to name the reaper rather
 * than the situation: with `RUN_ROWS_SWEEPABLE` on, `sweeperTick` runs
 * `reapStaleTasks` before `reapOrphanedFatRuns`, so a fat drain that died
 * between its insert and its publish has its never-held row closed
 * `brain_timeout` by the first and never reaches the second, which would have
 * written `dispatch_unconfirmed`. One physical situation, two strings, and a
 * classifier reading the string called the same stranded turn retryable in one
 * ordering and consumed -- the message deleted, the turn never run -- in the
 * other. The receipt is no better a witness: `finalizeDispatchCompensations`
 * adopts an armed receipt into a terminal one and the `publish` field does not
 * survive it, so the evidence would be erased by a pass that runs in the same
 * tick as the reap.
 *
 * `completed` and `cancelled` are answered by status alone, ahead of reach.
 * A completed row has a result, whoever wrote it. A cancelled row is a turn
 * somebody stopped -- `SETTLED_REASON_SQL` marks that
 * `cancelled_before_dispatch_confirmed` precisely so it is not resurrected --
 * and a stopped turn is not a turn still owed however little of it ran.
 *
 * On an OPEN row terminality says nothing yet, so the question becomes whether
 * anyone is on their way, and there the two branches differ. A doorbell row
 * *is* the work: it opens at `queued`, `peekNextQueued` takes it, and the turn
 * runs whatever becomes of the drain that opened it -- "claim-next never needed
 * the wakeup". Every open doorbell row is (1). A fat row is inert without its
 * message -- no claimer takes one -- so an open fat row is worth only what
 * became of its publish, and `dispatch_seq` is the one thing that settles that
 * from a snapshot: the publish returned a sequence, the message is on the
 * stream under this row's id, the turn is genuinely handed off. An open fat row
 * a worker has already reached is the same answer by a stronger route.
 *
 * Every other open fat row is (3). The receipt's certainties are deliberately
 * not consulted here either: `not_attempted` is the shape of a drain that died
 * before its publish *and* of a drain that is alive and one statement short of
 * it, since `withOwnedAdmissionLock` commits the row and `recordPublishState`
 * arms it a moment later. Those two want opposite answers, so this function
 * gives neither and waits for terminality to tell them apart.
 *
 * What waiting costs is that a genuinely stranded row is retried after the
 * reaper rather than on the next drain. That wait buys the C2a property for
 * free -- an ambiguous publish keeps its message -- and it costs no dispatch
 * that could have happened anyway: while the stranded row is still open
 * `idx_tasks_chat_turn_unique` refuses its replacement, so the eager answer
 * bought nothing but a raise, a nak, and a queue row pointing at nothing.
 *
 * Retrying a terminal unreached-and-unanswered row cannot execute a turn twice,
 * which is the property all of this exists to hold. If a message for the old id
 * is still on the stream, the Brain that eventually takes it reads a terminal
 * row and is refused before it starts; and inside the stream's duplicate window
 * the replacement publish is dropped as the duplicate it is. Neither floor
 * holds for a turn some other row already answered, which is what the ANSWER
 * fact is for: the sibling's message was consumed by the sibling, so the
 * duplicate window has nothing to collapse the replacement against, and the
 * replacement's own row is a doorbell row that claim-next executes without ever
 * consulting the stream.
 *
 * The reverse mistake still has no floor at all: a turn classified consumed is a
 * message deleted with nothing anywhere that remembers it was asked for. So the
 * ANSWER fact is only ever allowed to narrow `retryable`, and only on evidence
 * that is positively present. Absent evidence -- a completion the durable
 * consumer has not written yet, a sibling in a state this cannot read as an
 * answer -- leaves the row retryable, which is the reading that keeps the turn.
 *
 * The fat set is written positively, as `NO_DELIVERY_IN_FLIGHT_SQL` writes it,
 * so a dispatch value this deployment does not know stays outside the inert arm
 * and is read as the run that owns the turn.
 */
async function recordedHandoffState(
  taskId: string,
): Promise<"absent" | "open" | "unsettled" | "retryable" | "consumed"> {
  // One statement, so the three facts describe one instant of the row rather
  // than three. The two ANSWER arms are correlated subqueries rather than SQL
  // comments and joins for the reason the sweeper's own note gives: a `--`
  // comment inside a template literal lasts only until somebody collapses the
  // string, and a message id that is NULL matches nothing on either arm anyway,
  // so a row naming no turn is answered by terminality and reach alone.
  const r = await db.query(
    `SELECT handoff.status,
            handoff.metadata->>'dispatch' = 'fat' AS fat,
            (handoff.lease_owner IS NOT NULL
             OR handoff.lease_expires_at IS NOT NULL
             OR COALESCE(handoff.claim_count, 0) > 0) AS reached,
            (handoff.metadata->>'dispatch_seq') IS NOT NULL AS delivered,
            EXISTS (
              SELECT 1 FROM claw_tasks sibling
               WHERE sibling.session_id = handoff.session_id
                 AND sibling.origin = 'chat'
                 AND sibling.metadata->>'message_id' = handoff.metadata->>'message_id'
                 AND sibling.task_id <> handoff.task_id
                 AND (sibling.status IN ('completed', 'cancelled')
                      OR sibling.lease_owner IS NOT NULL
                      OR sibling.lease_expires_at IS NOT NULL
                      OR COALESCE(sibling.claim_count, 0) > 0)
            ) AS answered_by_sibling,
            EXISTS (
              SELECT 1 FROM claw_session_events ended
               WHERE ended.session_id = handoff.session_id
                 AND ended.event = 'exec_complete'
                 AND ended.data->>'message_id' = handoff.metadata->>'message_id'
                 AND ended.deleted_at IS NULL
            ) AS announced
       FROM claw_tasks handoff WHERE handoff.task_id = $1`,
    [taskId],
  );
  const row = r.rows[0] as {
    status?: string; fat?: boolean | null; reached?: boolean | null; delivered?: boolean | null;
    answered_by_sibling?: boolean | null; announced?: boolean | null;
  } | undefined;
  if (!row) return "absent";
  const status = String(row.status);
  const reached = row.reached === true;
  if (["queued", "preparing", "running", "cancelling"].includes(status)) {
    const inert = row.fat === true && !reached && row.delivered !== true;
    return inert ? "unsettled" : "open";
  }
  if (status === "completed" || status === "cancelled") return "consumed";
  if (status === "failed") {
    const answered = row.answered_by_sibling === true || row.announced === true;
    // Reach first, then the answer elsewhere, and `retryable` only when neither
    // is there. Both arms are read on a row that is already terminal, so
    // neither can be the transient shape of something still in progress.
    return reached || answered ? "consumed" : "retryable";
  }
  // A status neither set names belongs to a contract this deployment does not
  // have. Answering it would be guessing on behalf of a newer writer, so this
  // decides nothing and keeps the message, which is the one answer that cannot
  // lose a turn.
  logger.warn({ taskId, status }, "pending.handoff_status_unknown");
  return "unsettled";
}

async function clearReservedDispatchTaskId(
  pendingId: unknown,
  taskId: string,
): Promise<boolean> {
  const r = await db.query(
    `UPDATE claw_pending_messages
        SET dispatch_task_id = NULL
      WHERE id = $1 AND dispatch_task_id = $2
      RETURNING id`,
    [pendingId, taskId],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Stand down: the queue row this drain was assembling is already gone.
 *
 * Whoever deleted it published the turn, so there is nothing left to hand off
 * and nothing to compensate -- the one thing this drainer must not do is open a
 * run of its own.
 */
function handedOffElsewhere(input: PendingDispatchInput): PendingDispatchResult {
  forgetUncountedAttempts(input.pendingId);
  logger.info(
    { sessionId: input.sessionId, pendingId: input.pendingId },
    "pending.handoff_row_gone",
  );
  return { runId: null };
}

/**
 * Stand down keeping the message: whether its turn was handed off is not known.
 *
 * The other stand-down above ends a queue row because somebody else certainly
 * published it. This one ends only *this* attempt, and the row it leaves behind
 * is the point of it: an open fat run names this message and nothing says the
 * message reached the stream, so deleting it would bet the user's turn on the
 * reading that cannot be recovered from. The bet the other way costs a replay
 * that `doorbellDedupId` collapses on the stream.
 *
 * Two shapes arrive here and they are deliberately not separated. One is the
 * publish that timed out: it may be on the stream and it may have reached
 * nothing. The other is the row whose receipt still denies any publish, which
 * is a drain that died before sending *or* a drain that is alive and about to
 * send -- see `recordedHandoffState` for why this branch may not guess between
 * those, and what it would cost the turn if it guessed wrong. Both are answered
 * the same way because the safe act is the same act: keep the message, rotate
 * nothing, and let the reconciliation below say which it was.
 *
 * Nothing is republished from here, because a second publish is the one act
 * that could turn one ambiguous delivery into two real ones. What resolves it
 * is the same reconciliation every other unsettled fat row waits for:
 * `reapOrphanedFatRuns` closes the row once the durable says no delivery is in
 * flight for it, `finalizeDispatchCompensations` hands the session's gate back,
 * and `drainOrphanedPendingMessages` -- which looks for exactly this residue, a
 * queue row on an idle session with no open chat run -- brings the message back
 * here to be classified "retryable" and sent. If the message was on the stream
 * after all, its run reaches a terminal state instead and the next drain reads
 * "consumed" and clears the row.
 *
 * The session gate is deliberately left where the completion that triggered
 * this drain put it. Shutting it would name a turn this branch has just said it
 * cannot confirm, park every later message behind a run that may never start,
 * and -- since the backstop drain only looks at idle and failed sessions --
 * close the door the preserved row is being kept for.
 *
 * The uncounted-attempt tally is left alone for the same reason: it is about a
 * message that has still not been dispatched.
 */
function deliveryUnsettled(
  input: PendingDispatchInput,
  taskId: string,
): PendingDispatchResult {
  logger.warn(
    { sessionId: input.sessionId, pendingId: input.pendingId, taskId },
    "pending.handoff_delivery_unsettled",
  );
  return { runId: null };
}

/**
 * Let go of a queue row whose turn a run already has.
 *
 * The queue row is the only durable memory that this message is owed, so it is
 * released exactly when a run has taken the debt over, and the session gate is
 * shut only for `open` -- a run that is over owes the gate nothing, and shutting
 * it for a consumed turn would park every later message behind a run nobody is
 * waiting for.
 *
 * Shared by the two places that reach this conclusion: the classification at
 * the top of a drain, and the admission refusal that reads the same handoff
 * again before it publishes anything. One function so the two cannot drift
 * about what settling a hand-off means.
 */
async function settleHandedOffTurn(
  input: PendingDispatchInput,
  taskId: string,
  recorded: "open" | "consumed",
): Promise<PendingDispatchResult> {
  await db.query("DELETE FROM claw_pending_messages WHERE id = $1", [input.pendingId]);
  forgetUncountedAttempts(input.pendingId);
  if (recorded === "open") await takeSessionGate(input.sessionId, input.messageId);
  logger.info(
    { sessionId: input.sessionId, pendingId: input.pendingId, taskId, recorded },
    "pending.handoff_already_recorded",
  );
  return { runId: recorded === "open" ? taskId : null };
}

type PreparedPendingHandoff =
  | { kind: "ready"; taskId: string }
  | { kind: "settled"; result: PendingDispatchResult };

async function preparePendingHandoff(
  input: PendingDispatchInput,
): Promise<PreparedPendingHandoff> {
  let handoffId = await reserveDispatchTaskId(input.pendingId);
  if (!handoffId) return { kind: "settled", result: handedOffElsewhere(input) };
  while (true) {
    const recorded = await recordedHandoffState(handoffId);
    if (recorded === "retryable") {
      // The only place the reservation is ever rotated, and it is reached only
      // from a terminal row -- that is what "retryable" now means. Rotating off
      // a row that is still open loses the turn's durable identity to a run
      // that is still going to publish under it, and the loss is committed here
      // even when the insert the rotation was for is refused a moment later.
      if (!await clearReservedDispatchTaskId(input.pendingId, handoffId)) {
        return { kind: "settled", result: handedOffElsewhere(input) };
      }
      handoffId = await reserveDispatchTaskId(input.pendingId);
      if (!handoffId) return { kind: "settled", result: handedOffElsewhere(input) };
      continue;
    }
    if (recorded === "unsettled") {
      return { kind: "settled", result: deliveryUnsettled(input, handoffId) };
    }
    if (recorded === "open" || recorded === "consumed") {
      return {
        kind: "settled",
        result: await settleHandedOffTurn(input, handoffId, recorded),
      };
    }
    return { kind: "ready", taskId: handoffId };
  }
}

async function finishPendingDoorbell(
  input: PendingDispatchInput,
  task: Record<string, unknown>,
  handoffId: string,
): Promise<PendingDispatchResult> {
  const result = await handOffAssembledRun({
    taskId: handoffId,
    path: "pending",
    task,
    sessionId: input.sessionId,
    userId: input.userId,
    messageId: input.messageId,
    prompt: input.prompt,
    workspaceId: input.workspaceId,
    filesWorkspaceId: typeof task.files_workspace_id === "string" ? task.files_workspace_id : undefined,
    pluginId: input.pluginId,
    sandboxImage: input.sandboxImage,
    publish: (subject, payload, msgId) => pendingDispatchPorts.publish(subject, payload, msgId),
    openRun: pendingDispatchPorts.openChatRun,
    failRun: (taskId, reason, failureReason) => pendingDispatchPorts.failChatRunDispatch(
      taskId,
      reason,
      failureReason,
      { statuses: SWEEPABLE_RUN_STATUSES },
    ),
    admit: pendingDispatchPorts.admit,
  });
  if (result.kind === "open_failed") {
    logger.error({ sessionId: input.sessionId, pendingId: input.pendingId }, "pending.open_failed");
    throw new Error("chat_run.open_failed");
  }
  if (result.kind === "rejected") {
    // `result.taskId` is this same id when the refusal came after the insert
    // and absent when it came before, so the reservation is the one value that
    // names the turn on both. The refusal needs it either way: it is what it
    // re-reads the hand-off by.
    return await refusePendingAdmission(input, result.reason, handoffId);
  }
  await db.query("DELETE FROM claw_pending_messages WHERE id = $1", [input.pendingId]);
  forgetUncountedAttempts(input.pendingId);
  await takeSessionGate(input.sessionId, input.messageId);
  logger.info(
    { sessionId: input.sessionId, kind: result.kind, runId: result.taskId },
    "pending.dispatched",
  );
  return { runId: result.taskId };
}
