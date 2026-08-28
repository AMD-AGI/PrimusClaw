// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// What happens to a task message between arriving on the durable and being
// handed to the engine: the poison guard, the deleted-session tombstone, the
// in-process and cross-pod lock checks.
//
// Split out of index.ts so this is reachable without booting a brain. Every
// branch here decides whether a task runs, waits, or is given up on, and the
// ones that matter most are invisible in production until they misfire: the
// poison guard must fire strictly before NATS exhausts the redelivery budget,
// or tasks disappear with their session still marked running; it must tell a
// task queued behind a lock apart from one that keeps failing, or the metric
// blames the wrong thing; and it must not give up on a task that never ran
// and whose lock is now free, or a healthy task is thrown away one delivery
// before it would have succeeded.

import { StringCodec, type JsMsg, type KV } from "nats";
import type { ExecuteRequest } from "@claw/protocol";
import { isRunDoorbell } from "@claw/protocol";
import pino from "pino";
import { TASK_MAX_DELIVER, TASK_POISON_DELIVERY_COUNT } from "../config.js";
import { metrics } from "../infra/metrics.js";
import { clearRetryPending, hasFailedAttempt } from "./retry-pending.js";
import { resolveSandboxImageFromRequest } from "../sandbox/ensure-hands.js";
import {
  requestedNodeCount, resolveTopology,
} from "../sandbox/multi-node/prompt-flags.js";
import { activeAbort, forgetRunAddresses, registerRunAddresses } from "./abort-registry.js";
import { markSessionDeleted } from "../infra/deleted-sessions.js";
import {
  pickLockKey, acquireTaskLock, gateBindingError, lockContentionNakMs, readTaskLock,
} from "./lock.js";
import { runHandleTask, resolvePoisonedTask } from "./runner.js";
import { claimRun, failClaimedRun, type ClaimedRun } from "../clients/run-claim.js";
import { claimedDoorbellMsg, declareRetryReason } from "../delivery/doorbell-delivery.js";
import { intakeDoorbell } from "../delivery/doorbell-intake.js";

// Same name as index.ts's logger on purpose: these records used to come from
// there, and alerts keyed on the logger name should not care that the code
// moved.
const logger = pino({ name: "brain" });
const sc = StringCodec();

let _kv: KV | null = null;
let _kvTombstones: KV | null = null;

/** BRAIN_REGISTRY bucket, bound from main() alongside the other kv consumers. */
export function bindTaskDispatchKv(kv: KV, tombstones?: KV): void {
  _kv = kv;
  _kvTombstones = tombstones ?? null;
}

function getKv(): KV {
  if (!_kv) throw new Error("tasks/dispatch.ts: bindTaskDispatchKv() must be called before use");
  return _kv;
}

function deferForLockContention(
  msg: JsMsg,
  fields: {
    sessionId: string;
    lockKey: string;
    claimedDoorbell: boolean;
    taskId?: string;
    event: "task.in_progress.nak" | "task.lock_not_acquired.nak";
  },
): void {
  const nakMs = lockContentionNakMs(msg.info.deliveryCount);
  // Stated here because this is the one site that knows the wait is a lock.
  if (fields.claimedDoorbell && fields.taskId) declareRetryReason(fields.taskId, "lock_contention");
  logger[fields.event === "task.in_progress.nak" ? "warn" : "info"](
    {
      sessionId: fields.sessionId,
      lockKey: fields.lockKey,
      deliveryCount: msg.info.deliveryCount,
      nakMs,
      claimedDoorbell: fields.claimedDoorbell,
    },
    fields.event,
  );
  msg.nak(nakMs);
}

/**
 * Whether this session was deleted, from whichever bucket still holds the mark.
 *
 * Both are consulted because they expire on different clocks. The tombstone
 * bucket's TTL is sized by the API to outlast every window a message can reach a
 * worker from -- the redelivery budget, and the retention of the API's own event
 * stream, whichever of the two is longer -- so it is the one that answers late;
 * the registry copy lives five minutes and exists so that an API replica from
 * before the tombstone bucket -- which writes only there -- is still heard
 * during a rolling upgrade. Either one present is an answer, and finding neither
 * is only ever read as "not deleted", which is what it meant before as well.
 */
async function sessionWasDeleted(sessionId: string): Promise<boolean> {
  const buckets = [_kvTombstones, _kv].filter((b): b is KV => b !== null);
  for (const bucket of buckets) {
    try {
      if (await bucket.get(`deleted.${sessionId}`)) {
        // Remembered locally so the uploader can ask the same question without
        // a round trip. The cleanup notification usually gets here first, but
        // it is at-most-once, and this path is the one that answers durably.
        markSessionDeleted(sessionId);
        return true;
      }
    } catch { /* a bucket that cannot answer is not a verdict */ }
  }
  return false;
}

const inflightHandleTasks = new Set<Promise<void>>();

/** In-flight handlers, for the graceful drain in main() to await. */
export function inflightTasks(): Promise<void>[] {
  return [...inflightHandleTasks];
}

/** Minimal non-secret fields for correlating an incoming task (IDs, plugin, auth flags). */
function logTaskReceived(request: ExecuteRequest, msg: JsMsg): void {
  const pt = request.plugin_tools;
  const pluginToolsCount =
    pt === null ? null : Array.isArray(pt) ? pt.length : undefined;
  // Whatever the request asked for, from wherever it asked. A declaration that
  // does not validate is not this function's problem to report -- the run
  // itself refuses it with the reasons -- but it must not stop the line that
  // says a task arrived from being written.
  let multiNodeSpec: ReturnType<typeof resolveTopology> = null;
  let topologyError: string | undefined;
  try {
    multiNodeSpec = resolveTopology(request);
  } catch (e) {
    topologyError = (e as Error).message;
  }
  const fields: Record<string, unknown> = {
    sessionId: request.session_id,
    messageId: request.message_id,
    userId: request.user_id,
    model: request.model,
    pluginId: request.plugin_id,
    pluginToolsCount,
    toolIdsCount: request.tool_ids?.length ?? 0,
    promptChars: typeof request.prompt === "string" ? request.prompt.length : 0,
    historyLen: Array.isArray(request.history) ? request.history.length : 0,
    hasPlatformKey: Boolean(request.platform_key),
    hasLlmApiKey: Boolean(request.llm_api_key),
    workspaceId: request.workspace_id,
    customWorkload: Boolean(
      resolveSandboxImageFromRequest(request) || request.resources,
    ),
    // Multi-node comes from the declared topology, or from the prompt's
    // Hyperloom flags when the request declares none. Never from
    // `request.resources`, which sizes the Hands sandbox alone.
    multiNode: multiNodeSpec !== null,
    multiNodeCount: multiNodeSpec?.nodes ?? 0,
    multiNodeBackend: multiNodeSpec?.backend,
    topologyDeclared: request.topology !== undefined && request.topology !== null,
    topologyError,
  };
  if (msg.redelivered || msg.info.deliveryCount > 1) {
    fields.deliveryCount = msg.info.deliveryCount;
    fields.redelivered = msg.redelivered;
  }
  logger.info(fields, "task.received");

  // `--nodes N` without a usable `--mn-backend` runs single-node, which is easy
  // to mistake for a provisioning failure when the prompt clearly asked for a
  // cluster. Surface it rather than letting the task look ordinary.
  // Only the prompt route can silently downgrade like this: a declared
  // topology missing its backend is refused outright.
  const requestedNodes = request.topology ? 0 : requestedNodeCount(request.prompt ?? "");
  if (multiNodeSpec === null && requestedNodes >= 2) {
    logger.warn(
      {
        sessionId: request.session_id,
        messageId: request.message_id,
        requestedNodes,
      },
      "task.multi_node_ignored: --nodes >= 2 needs --mn-backend rayjob|infera; running single-node",
    );
  }
}

export async function handleTask(msg: JsMsg): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(sc.decode(msg.data));
  } catch (e) {
    logger.error({ err: e }, "task.parse_failed");
    msg.ack(); // Discard malformed message
    return;
  }

  let request: ExecuteRequest;
  let claimedDoorbell = false;
  let claimGeneration: number | undefined;
  if (isRunDoorbell(parsed)) {
    const doorbell = parsed;
    const intake = await intakeDoorbell(doorbell, {
      sessionDeleted: sessionWasDeleted,
      claim: claimRun,
    });
    switch (intake.kind) {
      case "drop":
        logger.info(
          { sessionId: doorbell.session_id, taskId: doorbell.task_id },
          "task.dropped_deleted_session",
        );
        msg.ack();
        return;
      case "miss":
        msg.ack();
        return;
      case "retry":
        logger.error({ err: intake.err, taskId: doorbell.task_id }, "task.claim_failed");
        msg.nak(5_000);
        return;
      case "claimed":
        request = intake.request;
        claimedDoorbell = true;
        claimGeneration = intake.claimCount;
        msg.ack();
        msg = claimedDoorbellMsg(
          retryBase(msg.seq, msg.info.deliveryCount, intake.claimCount),
          request.task_id || doorbell.task_id,
          intake.claimCount,
        );
        break;
    }
  } else {
    request = parsed as ExecuteRequest;
  }

  await handleResolvedRequest(request, msg, claimedDoorbell, claimGeneration);
}

/**
 * How many attempts this run has already cost, for the contention backoff.
 *
 * `lockContentionNakMs` grows the delay with the attempt number, and on the fat
 * path JetStream supplies it: every redelivery increments `deliveryCount`, so a
 * task that keeps losing its lock waits 5s, then 10s, then 20s, up to the
 * five-minute ceiling, and survives the whole redelivery budget -- around an
 * hour of contention -- before the poison guard closes it.
 *
 * A claimed doorbell has no such number. The wakeup is acked at claim time, so
 * its `deliveryCount` is whatever the single delivery was, and a run that
 * arrives through claim-next has no message at all. Pinning it at 1, which is
 * what the stub used to do, held the delay at its first value for ever, while
 * `claim_count` -- incremented by every `takeClaim` and never reset -- climbed
 * to the same poison ceiling regardless. Twenty-two claims at five seconds is
 * about two minutes, so the identical contention that the fat path rides out
 * for an hour failed a doorbell run as `max_retries_exceeded` before the lock
 * holder had finished.
 *
 * The row's own count is the number that was missing. The max keeps a genuine
 * JetStream redelivery from being ignored when it is the larger of the two.
 */
export function retryBase(
  seq: number,
  deliveryCount: number,
  claimCount: number,
): { seq: number; info: { deliveryCount: number } } {
  return { seq, info: { deliveryCount: Math.max(1, deliveryCount || 1, claimCount || 1) } };
}

/** A run already claimed from the row, with no JetStream message behind it. */
export async function handleClaimedRequest(claimed: ClaimedRun): Promise<void> {
  const { request } = claimed;
  const stub = claimedDoorbellMsg(
    retryBase(0, 1, claimed.claimCount),
    request.task_id ?? "",
    claimed.claimCount,
  );
  await handleResolvedRequest(request, stub, true, claimed.claimCount);
}

async function handleResolvedRequest(
  request: ExecuteRequest,
  msg: JsMsg,
  claimedDoorbell: boolean,
  // The generation this replica holds, carried rather than re-derived. It used
  // to be read back out of the wrapper's `deliveryCount`, where `retryBase`
  // stores max(deliveryCount, claimCount) so the backoff escalates -- fine for
  // a delay, wrong for a CAS. Any wakeup redelivered before the claim landed
  // (a drain nak, or the intake retry after a claim error) makes the two
  // diverge, and every settle from this holder is then refused as stale.
  claimGeneration?: number,
): Promise<void> {
  const kv = getKv();
  logTaskReceived(request, msg);
  const sessionId = request.session_id;
  const messageId = request.message_id || "";
  const userId = request.user_id || "default";

  // Computed up front because the poison guard needs it to tell a queued task
  // from a failing one; the contention checks below reuse it.
  const lockKey = pickLockKey(request);

  // 0a. Tombstone check: session deleted while task was queued → drop.
  //
  // Ahead of the poison guard because a deleted session has nobody left to
  // report to: resolving the task would push a failure event and a DAG
  // callback into a session the user has already thrown away. The ordering
  // only bites when the delete lands between the guard's delivery and the one
  // before it -- every earlier delivery reaches this check anyway -- but for a
  // contended task that window is the final backoff, minutes wide.
  if (await sessionWasDeleted(sessionId)) {
    logger.info(
      { sessionId, taskId: request.task_id, claimedDoorbell },
      "task.dropped_deleted_session",
    );
    msg.ack();
    // A claimed doorbell is no longer this message's work, and unclaiming it
    // would put the row back on claim-next for another replica to take and
    // drop. Fail it. A fat message has nothing on the row that a NATS ack
    // does not already settle.
    if (claimedDoorbell) await failClaimedRun(request.task_id ?? "", "session_deleted", claimGeneration);
    return;
  }

  // 0a2. The gate cannot do its job for this run.
  //
  // Ahead of everything except the tombstone because it is a property of the
  // message, not of the attempt: no redelivery will make the missing binding
  // appear, so retrying only spends the budget. Resolved the same way a
  // poisoned message is -- a terminal event the user can see -- because the
  // alternative is a session left at 'running' with nothing coming.
  const bindingError = gateBindingError(request);
  if (bindingError) {
    logger.error(
      { sessionId, messageId, taskId: request.task_id, claimedDoorbell },
      "task.refused_unbound_workspace",
    );
    // Chat doorbells have no callback_url, so agent_done is a no-op and the
    // row would sit at preparing until the lease lapsed and claim-next took
    // it again. Fail it the same way a deleted session does: the lease is
    // the liveness, not the JetStream ack.
    if (claimedDoorbell) await failClaimedRun(request.task_id ?? "", "workspace_unbound", claimGeneration);
    await resolvePoisonedTask(msg, request, "workspace_unbound", bindingError);
    return;
  }

  // 0b. Poison message guard: resolve after too many redeliveries, one
  // delivery before NATS exhausts TASK_MAX_DELIVER, so the user gets a failure
  // event instead of the task disappearing with the session still marked
  // running; see TASK_POISON_DELIVERY_COUNT.
  //
  // A doorbell that has already been claimed is not this message's work: the
  // lease is the liveness, and spending the doorbell's delivery budget would
  // fail a healthy run that never used the stream as a queue.
  if (!claimedDoorbell && msg.info.deliveryCount >= TASK_POISON_DELIVERY_COUNT) {
    // A redelivery of a message that is already running is not a task to
    // resolve: resolving here reports a failure, fails the backend task row
    // (cascading to every downstream DAG node) and clears the callback out from
    // under a run that then finishes normally minutes later. The lock records
    // the sequence it was taken for so the two readings of a held lock can be
    // told apart, and it covers the cross-pod case activeAbort cannot see -- a
    // redelivery lands on whichever replica pulls it, not the one running.
    const lock = await readTaskLock(lockKey);
    const nakMs = lockContentionNakMs(msg.info.deliveryCount);
    // The delivery NATS refuses to redeliver after. Every "wait and see"
    // verdict below changes meaning here: a nak stops being a way to wait and
    // becomes a way to settle the message, which is the drop, not the delay.
    const finalDelivery = msg.info.deliveryCount >= TASK_MAX_DELIVER;

    if (lock.seq === msg.seq) {
      logger.warn(
        {
          sessionId, messageId, lockKey, seq: msg.seq,
          deliveryCount: msg.info.deliveryCount, finalDelivery,
          nakMs: finalDelivery ? undefined : nakMs,
        },
        "task.poison_message.already_running",
      );
      metrics.onTaskPoisonDeferred(
        finalDelivery ? "already_running_final" : "already_running",
      );
      // The handler executing this message owns the ack, and both ways of
      // settling the last delivery take it away: nak spends a redelivery NATS
      // will decline and terminates the message on the way out, term does the
      // same deliberately. Leaving it unsettled costs no extra ack-pending slot
      // (one stream sequence is one pending entry), and if that handler dies
      // the ack_wait lapse ends in the same termination anyway.
      if (!finalDelivery) msg.nak(nakMs);
      return;
    }

    // Two readings the comparison above cannot separate, both of which may be
    // a pod executing this very message:
    //
    //   - A held lock carrying no seq: written by a pod from before the field
    //     existed, since every acquire on this path passes msg.seq.
    //     Self-clearing once the rollout finishes.
    //   - A probe that failed, where `held: false` means "not found out"
    //     rather than "nobody holds it". Invisible to every test below --
    //     the seq comparison misses and `contended` stays false because
    //     activeAbort only sees this process.
    //
    // Resolving on either is the failure the recorded sequence was added to
    // prevent, reached the two ways it cannot see. While there is budget left,
    // waiting costs only the last-chance attempt; resolving costs a live run
    // reported to the user as a failure with its DAG node failed underneath it.
    const holderUnknown = !lock.known || (lock.held && lock.seq === null);
    if (holderUnknown && !finalDelivery) {
      logger.warn(
        {
          sessionId, messageId, lockKey, nakMs,
          deliveryCount: msg.info.deliveryCount,
          cause: lock.known ? "unknown_holder" : "probe_failed",
        },
        "task.poison_message.unknown_holder_defer",
      );
      metrics.onTaskPoisonDeferred(lock.known ? "unknown_holder" : "probe_failed");
      msg.nak(nakMs);
      return;
    }

    // A task that spent its budget waiting for a lock is not poisoned -- it
    // never ran. Reporting it as "exceeded maximum retry attempts" blames the
    // task for a queue it was stuck in, and hides the real signal: siblings
    // are holding locks longer than the redelivery budget can outlast.
    const contended = activeAbort.has(lockKey) || lock.held;
    // The probe answers "is the lock held right now", which separates only one
    // of the three cases that arrive here. Holding no lock means either a task
    // that kept failing or one queued behind a sibling that has just now
    // finished -- and the second is both the likelier, since the final backoff
    // window is about half the budget by wall clock, and the recoverable one,
    // since the lock it was waiting for is free. Discarding it throws away a
    // task that would have run, under the label most likely to send whoever
    // reads it after the wrong thing.
    //
    // Only a task that actually ran leaves a retry-pending lease behind, so
    // that is what tells the two apart -- and it has to decide the reason as
    // well as the outcome. Leaving the reason to the probe would just move the
    // same misreading one delivery later, onto a task that spent its last
    // attempt still unable to get the lock.
    const ranBefore = await hasFailedAttempt(kv, sessionId, lockKey, messageId);
    const lastChance =
      !contended && !ranBefore &&
      // Strictly at the threshold. The delivery after it has nothing left to
      // nak into, so resolving is the only thing that still works there.
      msg.info.deliveryCount === TASK_POISON_DELIVERY_COUNT;

    if (!lastChance) {
      const reason = ranBefore ? "max_retries_exceeded" : "lock_contention_exhausted";
      // holderUnknown here means the budget for waiting ran out and the task is
      // being resolved without having ruled out a run that is still alive. No
      // verdict at this point is free of that risk -- the alternative is to
      // settle nothing and let the message vanish with its session still marked
      // running, the silent drop this whole mechanism exists to prevent -- so it
      // is logged rather than avoided.
      logger.error(
        {
          sessionId, messageId, lockKey, reason, holderUnknown,
          deliveryCount: msg.info.deliveryCount,
          poisonThreshold: TASK_POISON_DELIVERY_COUNT,
          maxDeliver: TASK_MAX_DELIVER,
        },
        "task.poison_message.discarded",
      );
      // Counted by resolvePoisonedTask, not here: the guard firing is not the
      // same event as the task actually being resolved, and the gap between
      // them is where a task goes missing.
      // Keyed off the reason rather than re-deriving it, so the text the user
      // reads and the label the metric counts cannot drift apart.
      const finalText = reason === "max_retries_exceeded"
        ? "Task failed: exceeded maximum retry attempts. Please send a new message."
        : "Task failed: timed out waiting for an earlier task in this session to finish. Please send a new message.";
      await resolvePoisonedTask(msg, request, reason, finalText);
      return;
    }
    // Spends the delivery resolvePoisonedTask keeps in reserve for a handoff
    // that fails. Affordable only because that path now terminates and counts
    // on the final delivery rather than naking into a redelivery NATS refuses.
    logger.warn(
      {
        sessionId, messageId, lockKey,
        deliveryCount: msg.info.deliveryCount,
        maxDeliver: TASK_MAX_DELIVER,
      },
      "task.poison_message.last_attempt",
    );
  }

  // Guard: if this DAG-root (or chat session) is already being processed
  // in-process (e.g. NATS redelivered after an ack_wait miss before we ack'd),
  // don't spawn a second handler — that would run two agent-loops
  // concurrently for the same DAG root. Keyed at `dag_root_task_id` for V2
  // DAG-rooted tasks so N tasks sharing a session (e.g. Agent Leaderboard
  // fan-out) can run in parallel; falls back to session_id for the chat
  // path. See bug-fanout-session-lock.md.
  //
  // A claimed doorbell must not unclaim immediately: that returns the row to
  // claim-next, which increments claim_count on every take. Fat-path nak waits
  // out the lock; the claimed wrapper's nak does the same delay then unclaim.
  if (activeAbort.has(lockKey)) {
    deferForLockContention(msg, {
      sessionId, lockKey, claimedDoorbell, taskId: request.task_id,
      event: "task.in_progress.nak",
    });
    return;
  }

  // 1. Distributed lock (NATS KV) on the same lockKey so cross-pod
  //    handlers don't race either.
  const locked = await acquireTaskLock(lockKey, msg.seq);
  if (!locked) {
    deferForLockContention(msg, {
      sessionId, lockKey, claimedDoorbell, taskId: request.task_id,
      event: "task.lock_not_acquired.nak",
    });
    return;
  }
  logger.info({ sessionId, lockKey, messageId }, "task.lock_acquired");
  await clearRetryPending(kv, sessionId, lockKey).catch((err) =>
    logger.warn({ err, sessionId, messageId }, "retry_pending.clear_failed"),
  );

  const abortCtrl = new AbortController();
  activeAbort.set(lockKey, abortCtrl);
  // The names this run can be interrupted by, taken from the same request the
  // gate key was computed from. Nobody publishes to a gate key: the stop
  // button, cancelTask and the sweeper all address a session or a DAG root.
  registerRunAddresses(lockKey, [request.session_id, request.dag_root_task_id]);
  // Track promise for graceful drain.
  const taskPromise = runHandleTask(msg, request, sessionId, lockKey, messageId, userId, abortCtrl);
  inflightHandleTasks.add(taskPromise);
  taskPromise.finally(() => {
    inflightHandleTasks.delete(taskPromise);
    // The one place every dispatched run passes through on its way out. The
    // controller itself is cleared on several paths inside the run, and
    // spreading this over those is how the two got out of step before.
    forgetRunAddresses(lockKey);
  });
  await taskPromise;
}
