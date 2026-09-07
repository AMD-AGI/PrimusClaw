// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Persist a secret-free spec, admit the run, and either queue it or ring a
 * doorbell. Shared by the immediate chat path and the pending-message drain.
 */

import {
  DOORBELL_SEMANTICS_VERSION, doorbellDedupId, RUN_DOORBELL_KIND, taskSubject,
  type RunDoorbell,
} from "@claw/protocol";
import pino from "pino";

import {
  metrics, type DispatchHeldCause, type DispatchPath, type QueueEntryCause,
} from "../infra/metrics.js";

import {
  decideAdmission, envAdmitLimits, hardLimitAfterInsert, sessionTreeShape,
  withOwnedAdmissionLock, type AdmissionAsk, type AdmitLimits,
} from "./admission.js";
import {
  clearDispatchReconcile, discardChatRunDispatch, failChatRunDispatch, openChatRun,
} from "./chat-run.js";
import { RUN_CREDENTIALS_FIELD, gpuNodesFromSpec, stripRunSecrets, wantsSandboxFromSpec } from "./run-spec.js";
import { credentialsFromTask, sealRunCredentials } from "./run-secrets.js";

const logger = pino({ name: "run-dispatch" });

const INTERNAL_BACKEND_URL =
  process.env.INTERNAL_BACKEND_URL || `http://127.0.0.1:${process.env.API_PORT || "8200"}`;

export type HandOffResult =
  | { kind: "dispatched"; taskId: string; messageId: string }
  | { kind: "queued"; taskId: string; messageId: string; queuePosition: number }
  | { kind: "rejected"; reason: string; taskId?: string }
  | { kind: "publish_unknown"; taskId: string; messageId: string }
  | { kind: "open_failed" };

export interface HandOffInput {
  /** Which caller this is, so a chat outage and a drain outage stay apart. */
  path?: DispatchPath;
  /** The row id a durable handoff was already reserved under, when one was. */
  taskId?: string;
  /** Whether a soft ceiling is what put this row on the queue. */
  queueEntryCause?: QueueEntryCause;
  task: Record<string, unknown>;
  sessionId: string;
  userId: string;
  messageId: string;
  prompt: string;
  workspaceId?: string;
  filesWorkspaceId?: string;
  pluginId?: number;
  sandboxImage?: string;
  publish: (subject: string, payload: string, msgId: string) => Promise<unknown>;
  openRun?: typeof openChatRun;
  failRun?: typeof failChatRunDispatch;
  admit?: typeof decideAdmission;
  hardAfterInsert?: typeof hardLimitAfterInsert;
  /** The ceilings to decide against, when they are not this process's own. */
  limits?: AdmitLimits;
  discardRun?: typeof discardChatRunDispatch;
}

/**
 * A row that the compensation could not close, because a worker already has it.
 *
 * The doorbell path gave `peekNextQueued` a second route to the row that does
 * not wait for the rest of this function: claim-next matches the instant
 * `insertTask` commits, which is before the post-insert recheck and before the
 * wakeup is published. `failChatRunDispatch` was made holder-safe for exactly
 * that, and stopped closing rows out from under a running turn -- but this
 * function went on reporting `rejected` anyway, and `rejected` is a rollback:
 * the caller deletes the UserMessage, unwinds, and answers 429. The turn then
 * runs to completion and publishes an AssistantMessage against a user message
 * that no longer exists.
 *
 * The row is executing, so the honest answer is that the turn was dispatched.
 * The ceiling really was exceeded, or the publish really did fail, and neither
 * is recoverable from here -- the log line is what an operator has.
 */
function heldByWorker(
  taskId: string,
  messageId: string,
  sessionId: string,
  cause: DispatchHeldCause,
): HandOffResult {
  metrics.onRunDispatchHeld(cause);
  logger.warn({ taskId, sessionId, cause }, "run.dispatch.compensation_declined_row_held");
  return { kind: "dispatched", taskId, messageId };
}

/**
 * The ask for one chat turn.
 *
 * A chat row's `dag_root_task_id` is NULL, so it is its own run root -- a team
 * child included, whose session differs but whose run root is itself. The tree
 * walk runs only when a tree ceiling is set, so an unmetered or fleet-only
 * deployment pays nothing for it.
 */
export async function admissionAskFor(input: HandOffInput): Promise<AdmissionAsk> {
  const ask: AdmissionAsk = {
    origin: "chat",
    newRunRoots: 1,
    sandboxes: wantsSandboxFromSpec(input.task) ? 1 : 0,
    gpuNodes: gpuNodesFromSpec(input.task),
  };
  const limits = envAdmitLimits();
  if (limits.treeMaxNodes <= 0 && limits.treeMaxDepth <= 0) return ask;
  // The child a create just inserted is already a node here, so a turn in it
  // adds neither a node nor a level.
  const shape = await sessionTreeShape(input.sessionId);
  return { ...ask, treeRootId: shape.rootId, treeNodeCount: shape.nodeCount, treeDepth: shape.depth };
}

async function openAdmittedRun(
  input: HandOffInput,
): Promise<{ taskId: string } | null> {
  const openRun = input.openRun ?? openChatRun;
  // Always `queued` until a worker claims. An admitted run still rings a
  // doorbell; a full replica acks that wakeup and an idle one claim-next's
  // the row. Opening at `preparing` made claim-next skip the work.
  return await openRun({
    dispatch: "doorbell",
    taskId: input.taskId,
    queueEntryCause: input.queueEntryCause ?? "direct",
    // What this dispatch owes if it never reports its publish outcome. Both
    // hand-off callers dispatch into a session that already exists, so the
    // cleanup is to hand its gate back rather than to delete it.
    reconcileAction: "idle_existing_session",
    sessionId: input.sessionId,
    userId: input.userId,
    messageId: input.messageId,
    prompt: input.prompt,
    workspaceId: input.workspaceId,
    filesWorkspaceId: input.filesWorkspaceId,
    pluginId: input.pluginId,
    sandboxImage: input.sandboxImage,
    spec: persistableSpec(input.task),
    status: "queued",
    issueLease: false,
  });
}

/**
 * Erase the row a post-insert hard refusal declined, or refuse to answer.
 *
 * `unknown` is a statement that raced rather than a settled state, and the row
 * it describes is open, unheld and claimable -- answering `rejected` over it
 * would tell the caller the turn was declined while claim-next runs it, and the
 * caller's rollback would then delete the `UserMessage` out from under it. It
 * is retried once, and a throw routes the caller to its dispatch-failure path.
 */
async function discardRefusedRun(
  input: HandOffInput,
  taskId: string,
  reason: string,
): Promise<HandOffResult> {
  const discard = input.discardRun ?? discardChatRunDispatch;
  let verdict = await discard(taskId);
  if (verdict === "unknown") verdict = await discard(taskId);
  if (verdict === "held") {
    return heldByWorker(taskId, input.messageId, input.sessionId, "hard_limit_exceeded");
  }
  if (verdict !== "closed") {
    logger.error({ taskId, sessionId: input.sessionId, reason }, "run.dispatch.discard_unknown");
    throw new Error(`could not discard refused run ${taskId}: ${reason}`);
  }
  return { kind: "rejected", reason, taskId };
}

/**
 * Count what the hand-off answered, throws included.
 *
 * This function leaves by `throw` as well as by return -- an uncompensated
 * post-insert fault, a publish failure, and whatever admission propagates --
 * and counting only the returns would keep a publish outage out of the
 * denominator instead of inside it.
 */
export async function handOffAssembledRun(input: HandOffInput): Promise<HandOffResult> {
  const path = input.path ?? "chat";
  let result: HandOffResult;
  try {
    result = await handOffUncounted(input);
  } catch (err) {
    metrics.onRunDispatch(path, "error");
    throw err;
  }
  metrics.onRunDispatch(path, result.kind);
  return result;
}

async function handOffUncounted(input: HandOffInput): Promise<HandOffResult> {
  const { messageId } = input;
  const ask = await admissionAskFor(input);
  // The decision and the insert are one critical section: creation order and
  // commit order must be the same order, or two creates that each cleared the
  // pre-insert check are both admitted against one free slot.
  const opened = await withOwnedAdmissionLock(async (client) => {
    const admission = await (input.admit ?? decideAdmission)(ask, client, input.limits);
    if (admission.kind === "reject") return { admission } as const;
    return {
      admission,
      run: await openAdmittedRun({
        ...input,
        queueEntryCause: admission.kind === "queue" ? "admission" : "direct",
      }),
    } as const;
  });
  if (opened.admission.kind === "reject") {
    return { kind: "rejected", reason: opened.admission.reason };
  }
  const run = opened.run;
  if (!run) return { kind: "open_failed" };
  const admission = opened.admission;

  // The recheck reads the fleet, so it can fail the way any query can. A throw
  // here used to unwind past every caller with the row already inserted at
  // `queued`: `rememberTaskId` has not run yet -- dispatchByDoorbell calls it
  // on the way out -- so the outer rollback closes `null` and does nothing.
  // The user is told the dispatch failed and the session gate reopens, while
  // claim-next takes the row seconds later and runs the turn anyway. The
  // publish below already guarded itself this way; this call did not.
  let hard: string | null;
  try {
    hard = await (input.hardAfterInsert ?? hardLimitAfterInsert)(
      ask, run.taskId, undefined, input.limits,
    );
  } catch (err) {
    const verdict = await (input.failRun ?? failChatRunDispatch)(
      run.taskId, String((err as Error)?.message ?? err),
    );
    if (verdict === "held") {
      return heldByWorker(run.taskId, messageId, input.sessionId, "hard_limit_recheck_threw");
    }
    throw err;
  }
  if (hard) return await discardRefusedRun(input, run.taskId, hard);

  if (admission.kind === "queue") {
    await releaseReconcileClaim(run);
    logger.info(
      { taskId: run.taskId, sessionId: input.sessionId, position: admission.position },
      "run.queued",
    );
    return {
      kind: "queued",
      taskId: run.taskId,
      messageId,
      queuePosition: admission.position,
    };
  }

  try {
    await publishDoorbell(input.publish, run.taskId, input.sessionId, messageId);
    if (!await releaseReconcileClaim(run)) {
      // Reconciliation took the row while this dispatch was publishing, so the
      // outcome is no longer this caller's to report.
      logger.warn({ taskId: run.taskId, sessionId: input.sessionId }, "run.dispatch.reconcile_taken");
      return { kind: "publish_unknown", taskId: run.taskId, messageId };
    }
  } catch (err) {
    const verdict = await (input.failRun ?? failChatRunDispatch)(
      run.taskId, String((err as Error)?.message ?? err),
    );
    // claim-next never needed the wakeup, so a failed publish does not mean
    // the row is idle. Only `held` says a worker has it: `unknown` is a
    // compensation that failed, and answering "dispatched" to that would be a
    // guess dressed as a fact.
    if (verdict === "held") {
      return heldByWorker(run.taskId, messageId, input.sessionId, "doorbell_publish_failed");
    }
    throw err;
  }
  return { kind: "dispatched", taskId: run.taskId, messageId };
}

/**
 * Hand the reconciliation marker back, if this dispatch still owns it.
 *
 * A row opened with no horizon has nothing to release, which is not a loss of
 * ownership -- so it answers true.
 */
async function releaseReconcileClaim(run: { taskId: string; reconcileAt?: Date }): Promise<boolean> {
  if (!run.reconcileAt) return true;
  return await clearDispatchReconcile(run.taskId, run.reconcileAt);
}

export function persistableSpec(task: Record<string, unknown>): Record<string, unknown> {
  const spec = stripRunSecrets(task);
  const existing = task[RUN_CREDENTIALS_FIELD];
  spec[RUN_CREDENTIALS_FIELD] = typeof existing === "string" && existing
    ? existing
    : sealRunCredentials(credentialsFromTask(task));
  spec.dispatch = "doorbell";
  return spec;
}

export async function publishDoorbell(
  publish: (subject: string, payload: string, msgId: string) => Promise<unknown>,
  taskId: string,
  sessionId: string,
  messageId: string,
): Promise<void> {
  const doorbell: RunDoorbell = {
    kind: RUN_DOORBELL_KIND,
    task_id: taskId,
    session_id: sessionId,
    message_id: messageId,
    claim_url: `${INTERNAL_BACKEND_URL}/v1/internal/tasks/${taskId}/claim`,
    semantics: DOORBELL_SEMANTICS_VERSION,
  };
  // The chat message id is a millisecond stamp with no session component and
  // the duplicate window spans the whole stream, so the raw id would drop one
  // of two turns dispatched in the same millisecond by different sessions.
  await publish(taskSubject(), JSON.stringify(doorbell), doorbellDedupId(sessionId, messageId));
  logger.info({ taskId, sessionId, messageId }, "run.doorbell_published");
}