// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Persist a secret-free spec, admit the run, and either queue it or ring a
 * doorbell. Shared by the immediate chat path and the pending-message drain.
 */

import { RUN_DOORBELL_KIND, taskSubject, type RunDoorbell } from "@claw/protocol";
import pino from "pino";

import { decideAdmission, hardLimitAfterInsert } from "./admission.js";
import { openChatRun, failChatRunDispatch } from "./chat-run.js";
import { RUN_CREDENTIALS_FIELD, gpuNodesFromSpec, stripRunSecrets, wantsSandboxFromSpec } from "./run-spec.js";
import { credentialsFromTask, sealRunCredentials } from "./run-secrets.js";

const logger = pino({ name: "run-dispatch" });

const INTERNAL_BACKEND_URL =
  process.env.INTERNAL_BACKEND_URL || `http://127.0.0.1:${process.env.API_PORT || "8200"}`;

export type HandOffResult =
  | { kind: "dispatched"; taskId: string; messageId: string }
  | { kind: "queued"; taskId: string; messageId: string; queuePosition: number }
  | { kind: "rejected"; reason: string }
  | { kind: "open_failed" };

export interface HandOffInput {
  task: Record<string, unknown>;
  sessionId: string;
  userId: string;
  messageId: string;
  prompt: string;
  workspaceId?: string;
  filesWorkspaceId?: string;
  pluginId?: number;
  sandboxImage?: string;
  publish: (subject: string, payload: string, msgId?: string) => Promise<void>;
  openRun?: typeof openChatRun;
  failRun?: typeof failChatRunDispatch;
  admit?: typeof decideAdmission;
  hardAfterInsert?: typeof hardLimitAfterInsert;
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
  cause: string,
): HandOffResult {
  logger.warn({ taskId, sessionId, cause }, "run.dispatch.compensation_declined_row_held");
  return { kind: "dispatched", taskId, messageId };
}

export async function handOffAssembledRun(input: HandOffInput): Promise<HandOffResult> {
  const { task, messageId } = input;
  const ask = {
    origin: "chat" as const,
    wantsSandbox: wantsSandboxFromSpec(task),
    gpuNodes: gpuNodesFromSpec(task),
  };
  const admission = await (input.admit ?? decideAdmission)(ask);
  if (admission.kind === "reject") return { kind: "rejected", reason: admission.reason };

  const spec = persistableSpec(task);
  // Always `queued` until a worker claims. An admitted run still rings a
  // doorbell; a full replica acks that wakeup and an idle one claim-next's
  // the row. Opening at `preparing` made claim-next skip the work.
  const openRun = input.openRun ?? openChatRun;
  const run = await openRun({
    sessionId: input.sessionId,
    userId: input.userId,
    messageId,
    prompt: input.prompt,
    workspaceId: input.workspaceId,
    filesWorkspaceId: input.filesWorkspaceId,
    pluginId: input.pluginId,
    sandboxImage: input.sandboxImage,
    spec,
    status: "queued",
    issueLease: false,
  });
  if (!run) return { kind: "open_failed" };

  // The recheck reads the fleet, so it can fail the way any query can. A throw
  // here used to unwind past every caller with the row already inserted at
  // `queued`: `rememberTaskId` has not run yet -- dispatchByDoorbell calls it
  // on the way out -- so the outer rollback closes `null` and does nothing.
  // The user is told the dispatch failed and the session gate reopens, while
  // claim-next takes the row seconds later and runs the turn anyway. The
  // publish below already guarded itself this way; this call did not.
  let hard: string | null;
  try {
    hard = await (input.hardAfterInsert ?? hardLimitAfterInsert)(ask, run.taskId);
  } catch (err) {
    const verdict = await (input.failRun ?? failChatRunDispatch)(
      run.taskId, String((err as Error)?.message ?? err),
    );
    if (verdict === "held") {
      return heldByWorker(run.taskId, messageId, input.sessionId, "hard_limit_recheck_threw");
    }
    throw err;
  }
  if (hard) {
    const verdict = await (input.failRun ?? failChatRunDispatch)(run.taskId, hard, hard);
    if (verdict === "held") {
      return heldByWorker(run.taskId, messageId, input.sessionId, "hard_limit_exceeded");
    }
    return { kind: "rejected", reason: hard };
  }

  if (admission.kind === "queue") {
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
  publish: (subject: string, payload: string, msgId?: string) => Promise<void>,
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
  };
  await publish(taskSubject(), JSON.stringify(doorbell), messageId);
  logger.info({ taskId, sessionId, messageId }, "run.doorbell_published");
}