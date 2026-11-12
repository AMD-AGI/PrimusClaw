// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { StringCodec, type JsMsg, type KV } from "nats";
import type { ExecCompleteRunIdentity, ExecuteRequest, ExecuteResult } from "@claw/protocol";
import { currentFatDelivery } from "../delivery/dispatch.js";
import {
  HandsRebuildFailed,
  HandsRecoveryBudgetExhausted,
  HandsRecoveryRefused,
  type CheckpointState,
  type Engine,
  type HandsRecoveryAllowance,
  type RecreateHandsResult,
} from "../agent/index.js";
import type { TurnPool } from "../agent/agent-loop.js";
import { EmitStoodDownError, type NatsEmitter } from "../events/emitter.js";
import {
  HandsClient, isHandsNetworkError,
  type OutstandingReconciliation, type ReclaimCause,
} from "../clients/hands.js";
import {
  syncWorkspaceToS3, syncWorkspaceFromS3, syncUploadsFromS3, archiveRunToS3, copyS3Prefix, syncLeftSnapshot,
  TRANSCRIPT_PREFIX,
} from "../workspace/s3-uploader.js";
import { invalidateSyncManifest, isRestoreHeld, releaseRestoreHold, withoutAddresses } from "../workspace/sync-delta.js";
import { syncWorkspace, restoreWorkspace } from "../workspace/sync.js";
import { SIGTERM_PROBE_TIMEOUT_SEC, gitReportKey, type GitReport } from "../workspace/git-dirs.js";
import { cutDrainedCalls } from "../agent/drain-shield.js";
import {
  workspaceSyncSemaphore,
  workspaceSigtermSyncSemaphore,
} from "../workspace/sync-semaphore.js";
import { isRetryable, retryableNakMs } from "../infra/retry.js";
import { unregisterSandbox, markHandsIdle } from "../sandbox/keepalive.js";
import { attributionOf } from "../sandbox/attribution.js";
import { markRetryPending } from "./retry-pending.js";
import { isSessionDeletedLocally } from "../infra/deleted-sessions.js";
import { buildOutstandingStartHint, classifyResumeOutcome } from "./resume-outcome.js";
import {
  sleep, redactSecrets, isSensitiveKey, looksLikeCredentialValue, isCredentialFreeLocator,
  decodeAeadKey,
} from "@claw/utils";
import {
  BRAIN_ID, BRAIN_VERSION, CHECKPOINT_TTL_MS,
  CHECKPOINT_WRITE_VERSION, BRAIN_CHECKPOINT_KEY,
  WORKSPACE_SYNC_INTERVAL_MS, WORKSPACE_SYNC_GRACE_MS,
  WORKSPACE_RESTORE_TIMEOUT_MS, WORKSPACE_PERSIST_BASE, SIGTERM_PENDING_SYNC_WAIT_MS,
  S3_ACCESS_KEY, S3_SECRET_KEY, S3_BUCKET, S3_REGION, S3_API_ENDPOINT,
  BRAIN_WORKSPACE_SNAPSHOT_ENABLED,
  RETRY_PENDING_KEEPALIVE_GRACE_SEC,
  TASK_MAX_DELIVER, BRAIN_LAZY_SANDBOX, BRAIN_SANDBOX_PRESTART,
  RUN_LEASE_HEARTBEAT_MS, RUN_LEASE_TTL_MS,
  LOCK_REFRESH_INTERVAL_MS,
  SANDBOX_HANDS_RESTART_ENABLED,
} from "../config.js";
import { ensureHands } from "../sandbox/ensure-hands.js";
import { parseToolAllowlist } from "../tools/allowlist.js";
import { allowsSandboxUse, isSandboxTool } from "../tools/hands.js";
import { isMultiNodeRequest } from "../sandbox/multi-node/prompt-flags.js";
import { applyReviewProfileBackstop, reviewTurnBudgetRefusal } from "../agent/review-profile.js";
import { gpuWorkspaceFor } from "../sandbox/workspace-select.js";
import { getMultiNodeProvider, multiNodeAvailable } from "../sandbox/multi-node/factory.js";
import type { MultiNodeContext } from "../sandbox/multi-node/types.js";
import { destroyHands, reapPendingHands, classifySandboxFailure } from "../sandbox/reaper.js";
import { rememberRouterCredential } from "../sandbox/sandbox-router.js";
import { probeSandboxContainer } from "../sandbox/container-probe.js";
import { fetchPlatformFacts } from "../sandbox/platform-facts-read.js";
import type { PlatformFacts, RunEndedParkOutcome } from "@claw/protocol";
import type { ContainerProbeVerdict, HandsProbeEntry } from "../sandbox/container-probe.js";
import { checkHandsHealth } from "../sandbox/hands-health.js";
import { restartHandsInSandbox } from "../sandbox/hands-restart.js";
import { resolveSandboxAction } from "../sandbox/params.js";
import { SANDBOX_WORKSPACE_FORBIDDEN, SANDBOX_WORKSPACE_NOT_ALLOWED, provisionTerminalOf, sandboxUnavailableOf } from "../sandbox/errors.js";
import { runScript, type ScriptProgress } from "./script-runner.js";
import { createAppRunner } from "../apps/app-runner-wiring.js";
import { AppRunFailedError, type AppRunOutcome } from "../apps/app-runner.js";

/** A finish-only run that could not finish: nothing is reported, the sweeper hands it over again. */
class FinishOnlyHandOver extends Error {
  constructor(why: string) { super(why); this.name = "FinishOnlyHandOver"; }
}
import {
  AgentDoneDeliveryError, postAgentDone, postAppFinishDone, postAppFinishHandOver, postRunLease, postTaskRunning, sandboxForLease,
  type LeaseRenewal, type RunAttemptToken,
} from "./callback.js";
import { taskSubject, type RunTimeReport, WORKSPACE_SAVE_EVENT, WORKSPACE_SAVE_ID_FIELD, WORKSPACE_SAVE_PENDING, WORKSPACE_SAVE_PENDING_FIELD, type WorkspaceSaveFinishedEvent, type WorkspaceSaveOutcome } from "@claw/protocol";
import { randomUUID } from "node:crypto";
import { declareFinalReport } from "../delivery/doorbell-delivery.js";
import { settleClaimedRun } from "../clients/run-claim.js";
import { beginRun, endRun, phaseOf, runTimeOf } from "./run-phase.js";
import { resolveRunIdentity, type RunIdentity, taskIdFromLease } from "./run-identity.js";
import {
  clearActiveAbort, markGracefulStop, LEASE_LOST_ABORT_REASON, SIGTERM_ABORT_REASON, isUserCancelReason,
  DEADLINE_EXCEEDED_ABORT_REASON, RUN_ROW_TERMINAL_ABORT_REASON,
} from "./abort-registry.js";
import { transientNatsErrorIn } from "../infra/nats-transient.js";
import { lockPastSelfFence, pickRunScope, pickShellRun, refreshTaskLock, releaseTaskLock } from "./lock.js";
import {
  redactEgressPayload, redactPersistedEvent, type RuntimeSecrets,
} from "../events/redaction.js";
import {
  encodeCheckpoint, decodeCheckpoint, type CheckpointEnvelope,
} from "./checkpoint-codec.js";
import pino from "pino";
import { metrics, type TerminalRefusalReason, type TaskOutcome } from "../infra/metrics.js";
import { deleteRunRows } from "../sandbox/bg-handle-rows.js";
import { bgRowStore } from "../sandbox/bg-row-store.js";
import { readHandsEntry } from "../sandbox/registry.js";

const logger = pino({ name: "task-runner" });
const sc = StringCodec();

/**
 * How often a repeating script step re-writes the run's progress while it goes
 * on. Far inside the checkpoint TTL, so a step that waits for a day still has a
 * checkpoint to be taken over from; the progress itself changes only when a
 * step finishes, which is always written at once.
 */
const SCRIPT_PROGRESS_REFRESH_MS = 5 * 60 * 1000;

/**
 * How often a run checks, locally, whether it has passed its lock's self-fence.
 * Small against the refresh interval the fence keeps in hand, so the check's own
 * granularity cannot eat that margin.
 */
export const SELF_FENCE_CHECK_MS = 1_000;

/**
 * The v4 seal key, decoded once.
 *
 * Validated eagerly so a malformed key is a boot failure rather than a write
 * failure on the first interesting turn, and null when unset so the v3 path
 * needs no key at all. encodeCheckpoint throws if a v4 write is asked for
 * without one -- there is deliberately no "fall back to plaintext" branch.
 */
const CHECKPOINT_SEAL_KEY: Buffer | null = BRAIN_CHECKPOINT_KEY
  ? decodeAeadKey(BRAIN_CHECKPOINT_KEY, "BRAIN_CHECKPOINT_KEY")
  : null;

if (CHECKPOINT_WRITE_VERSION === 4 && !CHECKPOINT_SEAL_KEY) {
  throw new Error(
    "CHECKPOINT_WRITE_VERSION=4 requires BRAIN_CHECKPOINT_KEY (base64 of 32 bytes)",
  );
}

/**
 * The exact credential strings this run knows about, for the substring pass in
 * redaction.ts. A value listed here is replaced wherever it appears in any
 * string that leaves the process.
 *
 * An env var is included on one of two grounds -- its NAME reads as a
 * credential, or its VALUE is shaped like one -- and never merely for being
 * present, because that pass is an exact-substring replace with no notion of
 * what it is cutting.
 * Feeding it every user_env / session_env value made it delete ordinary
 * content. Any session whose environment named a path put that path's text
 * into the hunt, so `sed -n '140,340p' <redacted>` came back for a command
 * that had named a directory, `MODEL_PATH=<redacted>/model-name` for one that
 * had named a model root, and `backends/<redacted>_runner.py` for a word that
 * merely happened to occur in the middle of an identifier. Those strings are
 * also replayed to the model, so the agent came back from a resume having lost
 * the paths it was itself working with.
 *
 * isSensitiveKey is the same predicate the key-name pass uses, so a name that
 * gets a field masked also gets its value hunted; the two halves cannot drift
 * apart. It errs towards redacting, which is the right direction here: a
 * config value wrongly treated as a secret costs one mangled log line, and the
 * distinctiveness filter in redactValue keeps a short one from mangling
 * anything at all.
 *
 * A name is not the only way in, because a name is not always told the truth.
 * `BUILD_CONFIG=P@ssw0rd` is a live credential filed under a name that reads
 * as configuration, and no name rule will ever see it. looksLikeCredentialValue
 * asks the complementary question of the value itself, and asks it narrowly
 * enough that the paths and model names this function was rewritten to protect
 * do not answer yes -- anything with a slash or a space is out before the test
 * begins.
 *
 * The two grounds are kept apart on the way out, because they are not equally
 * true. The run's own keys were handed to it AS credentials and nothing about
 * them is inferred; the env values were picked by a name rule or a shape rule,
 * and both of those are guesses. Only the guesses are filtered by shape at the
 * point of use -- applying a heuristic to a value already known to be a key
 * only creates a way to be wrong about it, which is how
 * `llm_api_key=XkjQmzPlVbNrTqWd20240903` came to be spared for looking like a
 * dated identifier. Collection decides what is worth looking at;
 * distinctiveness decides which of the guesses is safe to cut.
 */
function runtimeSecrets(request: ExecuteRequest, resolvedPlatformKey = ""): RuntimeSecrets {
  const present = (values: (string | undefined)[]) =>
    values.filter((value): value is string => typeof value === "string" && value.length > 0);
  return {
    certain: present([
      request.platform_key,
      resolvedPlatformKey,
      request.llm_api_key,
      request.backend_internal_token,
    ]),
    nominated: present([
      ...sensitiveEnvValues(request.user_env),
      ...sensitiveEnvValues(request.session_env),
    ]),
  };
}

/**
 * Values of the env vars whose name -- or whose own shape -- reads as a
 * credential, minus the ones whose name is the only thing that says so.
 *
 * The name rule is broad on purpose, and a credential-named variable holding a
 * location rather than a credential is the ordinary case, not the exotic one:
 * `TOKEN_ENDPOINT` is where a token is fetched from, `SSH_KEY_PATH` is where a
 * key lives, and an OAuth client and an SSH config are supposed to name them
 * exactly that way. Collected, each was blind-substring-replaced out of every
 * transcript line that mentioned the endpoint or ran a command against the
 * path -- and those transcripts are replayed to the model.
 *
 * The exemption applies ONLY to the name branch. A value that answers
 * looksLikeCredentialValue was collected for what it is rather than for what
 * it is called, and nothing about its name can talk it back out of the list.
 */
function sensitiveEnvValues(env: Record<string, string> | undefined): string[] {
  if (!env) return [];
  return Object.entries(env)
    .filter(([name, value]) => {
      if (looksLikeCredentialValue(value)) return true;
      if (!isSensitiveKey(name)) return false;
      return !isCredentialFreeLocator(value);
    })
    .map(([, value]) => value);
}

function pendingCallbackKey(taskId: string): string {
  return `task-result.${taskId}`;
}

/**
 * Persist the terminal result before delivery. If Brain dies after execution
 * but before the callback is acknowledged, redelivery replays this result
 * instead of executing the task (and its tools) again.
 */
async function deliverAgentDone(
  kvCkpt: KV,
  request: ExecuteRequest,
  result: ExecuteResult,
  runTime?: RunTimeReport,
): Promise<void> {
  if (!request.task_id) {
    await fx().postAgentDone(request, result, runTime);
    return;
  }
  const key = pendingCallbackKey(request.task_id);
  const pending = runTime ? { ...result, run_time: runTime } : result;
  await kvCkpt.put(key, sc.encode(JSON.stringify(pending)));
  await fx().postAgentDone(request, result, runTime);
}

async function ackAndClearCallback(msg: JsMsg, kvCkpt: KV, request: ExecuteRequest): Promise<void> {
  msg.ack();
  if (!request.task_id) return;
  await kvCkpt.delete(pendingCallbackKey(request.task_id)).catch((err) => {
    logger.warn({ err, taskId: request.task_id }, "task.agent_done_outbox_cleanup_failed");
  });
}

/**
 * The record that a run's turn has already ended on the session.
 *
 * `exec_complete` goes out before the workspace is saved (see `finalizeSuccess`),
 * and the API admits the session's next turn once it has the completion and the
 * save's finish. A run that stops after its completion and before its ack -- a
 * SIGTERM that outlasts the save, a pod lost, a lease lost -- is redelivered, and
 * running that turn again would answer it twice and race the turn after it. So
 * the completion is recorded first, with what the Backend handoff needs, and a
 * redelivery that finds the record finishes the turn instead of running it
 * (`finishEndedTurn`).
 */
export function endedTurnKey(sessionId: string, messageId: string): string {
  return `turn-ended.${sessionId}.${messageId}`;
}

interface EndedTurn {
  /** The completion as published (redacted), published again by a redelivery. */
  completion?: Record<string, unknown>;
  result: ExecuteResult;
  run_time?: RunTimeReport;
  /** The save announced on the completion, which the redelivery reports over. */
  save_id?: string;
}

/**
 * A delivery refused because its row is already terminal: if it is a run whose
 * turn ended before its workspace save finished (the Brain saving was lost),
 * report that save over, so the API lets the session's next message out of its
 * queue now rather than when the hold runs out. Nothing is run or published
 * besides; the row's ending was decided by whoever closed it.
 */
export async function settleEndedTurnOfGoneRow(request: ExecuteRequest): Promise<void> {
  const sessionId = request.session_id;
  const messageId = request.message_id || "";
  if (!sessionId || !messageId) return;
  const { kvCkpt, emitter } = getDeps();
  const key = endedTurnKey(sessionId, messageId);
  const entry = await kvCkpt.get(key);
  if (!entry || entry.operation === "DEL" || entry.operation === "PURGE" || entry.value.length === 0) return;
  let ended: EndedTurn | null = null;
  try {
    ended = JSON.parse(sc.decode(entry.value)) as EndedTurn;
  } catch (err) {
    logger.error({ err, sessionId, messageId }, "task.ended_turn_unreadable");
  }
  if (ended?.save_id) {
    const finished: WorkspaceSaveFinishedEvent = {
      type: WORKSPACE_SAVE_EVENT, phase: "finished", outcome: "failed",
      reason: "run_stopped_during_save", save_id: ended.save_id, message_id: messageId,
    };
    await emitter.emit(sessionId, { ...finished });
  }
  await kvCkpt.delete(key).catch(() => {});
  logger.warn({ sessionId, messageId, saveId: ended?.save_id }, "task.ended_turn_settled_on_gone_row");
}

/**
 * Finish a turn whose completion an earlier delivery already published, without
 * running it again: publish the completion again (the API skips a second one),
 * report its save over, hand the result to Backend, ack.
 *
 * The save is not retried. It is reported `failed`, so the API stops holding the
 * session's next message for it, and the files are where they were -- in the
 * sandbox, for the next turn's save to upload.
 */
async function finishEndedTurn(
  msg: JsMsg,
  request: ExecuteRequest,
  sessionId: string,
  messageId: string,
  lockKey: string,
  run?: AbortController,
): Promise<boolean> {
  if (!messageId) return false;
  const { kvCkpt, emitter } = getDeps();
  const key = endedTurnKey(sessionId, messageId);
  let entry;
  try {
    entry = await kvCkpt.get(key);
  } catch (err) {
    // Not knowing whether the turn already ended is not a reason to run it again.
    logger.error({ err, sessionId, messageId }, "task.ended_turn_lookup_failed");
    msg.nak(5_000);
    clearActiveAbort(lockKey, run);
    await fx().releaseTaskLock(lockKey, run).catch(() => {});
    return true;
  }
  if (!entry || entry.operation === "DEL" || entry.operation === "PURGE" || entry.value.length === 0) return false;
  let ended: EndedTurn;
  try {
    ended = JSON.parse(sc.decode(entry.value)) as EndedTurn;
  } catch (err) {
    logger.error({ err, sessionId, messageId }, "task.ended_turn_unreadable");
    await kvCkpt.delete(key).catch(() => {});
    return false;
  }
  try {
    // Again, in case the earlier delivery stopped between the record and the
    // publish: the API handles one completion per turn and skips the rest.
    if (ended.completion) await emitter.emit(sessionId, ended.completion);
    if (ended.save_id) {
      const finished: WorkspaceSaveFinishedEvent = {
        type: WORKSPACE_SAVE_EVENT, phase: "finished", outcome: "failed",
        reason: "run_stopped_during_save", save_id: ended.save_id, message_id: messageId,
      };
      await emitter.emit(sessionId, { ...finished }).catch((err: unknown) => {
        logger.warn({ err, sessionId, messageId }, "task.ended_turn_save_event_failed");
      });
    }
    await deliverAgentDone(kvCkpt, request, ended.result, ended.run_time);
    await ackAndClearCallback(msg, kvCkpt, request);
    await kvCkpt.delete(key).catch((err) => {
      logger.warn({ err, sessionId, messageId }, "task.ended_turn_cleanup_failed");
    });
    logger.warn(
      { sessionId, messageId, deliveryCount: msg.info.deliveryCount, saveId: ended.save_id },
      "task.ended_turn_not_rerun",
    );
  } catch (err) {
    logger.error({ err, sessionId, messageId }, "task.ended_turn_finish_failed");
    msg.nak(5_000);
  } finally {
    clearActiveAbort(lockKey, run);
    await fx().releaseTaskLock(lockKey, run).catch(() => {});
  }
  return true;
}

/**
 * Which row and which generation a completion is reporting for.
 *
 * The generation belongs to the delivery rather than to any one phase of it,
 * so it is read from the delivery context the handler runs under. Omitted,
 * never invented, when the acceptance was served by an API that issued none:
 * a completion carrying a generation the row never handed out would close a
 * row this run does not own.
 */
function runIdentity(request: ExecuteRequest, claimedGeneration?: number): ExecCompleteRunIdentity {
  // A claimed doorbell holds the generation its claim minted, outside any fat
  // delivery context. Carried so the API closes the row only while that claim
  // is still the row's: a completion from a holder that stood down (a lost
  // lease, the lock's self-fence) and was succeeded by another claim no longer
  // matches, however late the event arrives.
  const runClaim = currentFatDelivery()?.runClaim ?? claimedGeneration;
  // A fat payload published by an API that predates the field carries no
  // `task_id`, only the lease URL -- and the URL names the row, which is why
  // `resolveRunIdentity` already reads it. Without the same fallback here such
  // a run reports a completion that names nothing, and an unnamed completion is
  // closed by `closeUnnamedChatRun`, whose predicate excludes a fenced row --
  // which this row is, because the pre-gate accepted it and every acceptance
  // fences. The turn finishes, its answer reaches the user, and the row stays
  // open until a reaper decides the worker was lost.
  const taskId = request.task_id || taskIdFromLease(request).id || undefined;
  return {
    ...(taskId ? { task_id: taskId } : {}),
    ...(runClaim === undefined ? {} : { run_claim: runClaim }),
  };
}

/**
 * Give this delivery's fat pre-gate lease back, ahead of a nak that is asking
 * for a redelivery.
 *
 * A fat chat delivery takes its lease before it queues for an execution slot,
 * and holds it across everything that follows -- the queue wait, and then every
 * dispatch check. So a delivery that decides in `tasks/dispatch.ts` to wait and
 * come back is holding, at the moment it naks, exactly the thing that stops the
 * redelivery it asked for from getting anywhere: `acquireFatLease` takes a
 * pristine row, a lapsed-and-fenced one, or one a holder gave back, and a live
 * lease is none of the three. The redelivery is answered `superseded`, refused
 * at the pre-gate before it ever probes the lock, and naks in turn -- so the
 * turn stands still for the rest of the TTL, one wasted delivery at a time.
 *
 * The same window swallows a Stop: `stoppedAndUnheld`, the one arm that answers
 * an acceptance with `stop: "cancelling"` so the delivery can emit the
 * interrupted completion, requires `lease_owner IS NULL`. While this pod holds
 * an unreleased lease the row cannot say it was stopped, and the user's Stop is
 * answered by nothing until the lease lapses.
 *
 * Renewal is stopped first and the nak only after the release returns -- the
 * order `nakAfterAttempt` and the drain branch in `delivery/dispatch.ts` both
 * use. Both halves matter: a renewal tick landing after the release retakes the
 * lease the release just gave back (the renewal path acquires an unheld or
 * lapsed row as readily as an acceptance does), and a nak issued before the
 * release lands races the redelivery against it.
 *
 * Lives here, beside `nakAfterAttempt`, because that is what it mirrors and
 * because `settleRunAttempt` is the seam a test can answer. It is a no-op on
 * every other path by construction: only a fat pre-gate delivery runs inside
 * `fatDeliveryContext`, so a claimed doorbell, a claim-next run and a DAG or
 * script delivery all find no context and hold no lease to give back.
 */
export async function releasePreGateLease(request: ExecuteRequest): Promise<void> {
  const fat = currentFatDelivery();
  // Nothing to fence with is nothing to release -- see the pre-gate's own
  // `release`: `brain_id` is a pod name, the same string for every lease this
  // pod ever takes on the row, so without the generation the settle cannot say
  // which lease is being given back. Left to lapse instead.
  if (!fat || fat.runClaim === undefined) return;
  const taskId = settlementTaskIdOf(request);
  if (!taskId) return;
  fat.handOffRenewal();
  await fx().settleRunAttempt(taskId, fat.runClaim, undefined, true);
}

/**
 * The row a settlement addresses: what the wire says, or what the lease URL
 * says when the wire says nothing.
 *
 * The second half is the rolling-upgrade shape `runIdentity` above documents at
 * length -- a fat message published before `task_id` was a field -- and the two
 * readers below are the ones that settle a row rather than describe one, where
 * missing the id means the settle never happens at all.
 */
function settlementTaskIdOf(request: ExecuteRequest): string | null {
  return request.task_id || taskIdFromLease(request).id;
}

/**
 * Resolve a task whose JetStream delivery budget is exhausted.
 *
 * DAG tasks must use the same durable callback/outbox handoff as every other
 * terminal path. Emitting exec_complete alone only closes the chat session;
 * it leaves the backend task row running and blocks every downstream node.
 */
export async function resolvePoisonedTask(
  msg: JsMsg,
  request: ExecuteRequest,
  reason: TerminalRefusalReason,
  finalText: string,
): Promise<void> {
  const { emitter, kvCkpt } = getDeps();
  const sessionId = request.session_id;
  const messageId = request.message_id || "";
  const event: Record<string, unknown> = {
    type: "exec_complete",
    session_id: sessionId,
    message_id: messageId,
    user_id: request.user_id || "default",
    final_text: finalText,
    failed: true,
    failure_reason: reason,
    error_count: 0,
    skills_used: {},
    prompt: request.prompt,
    delivery_count: msg.info.deliveryCount,
    ...runIdentity(request),
  };
  if (messageId) event.message_id = messageId;

  const result: ExecuteResult = {
    finalText,
    tokenUsage: { input_tokens: 0, output_tokens: 0, cache_read: 0, cache_create: 0, turns: 0 },
    turns: 0,
    pendingSkills: [],
    skillsUsed: {},
    errorCount: 0,
    toolStats: { total_calls: 0, error_calls: 0, by_tool: {} },
    elapsedMs: 0,
    abortReason: "error",
    failureReason: reason,
  };

  // A handoff that fails naks, and the redelivery re-enters the guard rather
  // than runHandleTask, so replayPendingCallback's idempotence never gets to
  // apply here -- without a check of its own this path emits a second terminal
  // event for the same task on every retry. The outbox entry is the durable
  // record that a previous pass already emitted one: deliverAgentDone writes
  // it before the post that is the thing most likely to fail.
  //
  // An unreadable bucket emits. The two orderings each lose something and only
  // one is recoverable: a duplicate terminal event is noise, while an event
  // suppressed on the strength of a marker that was written but never followed
  // by an emit leaves the session with no terminal event at all.
  const outboxKey = request.task_id ? pendingCallbackKey(request.task_id) : null;
  const prior = outboxKey ? await kvCkpt.get(outboxKey).catch(() => null) : null;
  const alreadyEmitted = Boolean(prior?.value?.length);

  try {
    if (!alreadyEmitted) await emitter.emit(sessionId, event);
    await deliverAgentDone(kvCkpt, request, result);
    await ackAndClearCallback(msg, kvCkpt, request);
    metrics.onTaskPoisonDiscarded(reason);
  } catch (err) {
    // The guard fires at TASK_MAX_DELIVER-1, so a failed handoff normally has
    // exactly one delivery left to retry on -- unless the guard spent that one
    // letting a task that never ran make a last attempt, which lands the
    // resolve here on the final delivery instead. On the last one there is
    // nothing left to nak into: NATS refuses the redelivery and the message is
    // gone, session still marked running -- the silent drop this guard exists
    // to prevent, arrived at from the one direction the guard cannot fix,
    // because the handoff itself is what is failing. Terminate explicitly and
    // count it, so it shows up as a task the brain knowingly abandoned rather
    // than as a message that quietly stopped existing.
    const lastDelivery = msg.info.deliveryCount >= TASK_MAX_DELIVER;
    logger.error(
      {
        err, taskId: request.task_id, sessionId, reason,
        deliveryCount: msg.info.deliveryCount, lastDelivery,
      },
      err instanceof AgentDoneDeliveryError
        ? "task.poison_agent_done_delivery_exhausted"
        : "task.poison_terminal_handoff_failed",
    );
    if (lastDelivery) {
      metrics.onTaskPoisonUnresolved(reason);
      msg.term();
      return;
    }
    msg.nak(5_000);
  }
}

// ===== Shared deps (bound once from index.ts main()) =====

export interface TaskRunnerDeps {
  kv: KV;        // BRAIN_REGISTRY bucket: hands/lock/deleted/etc.
  kvCkpt: KV;    // BRAIN_CHECKPOINTS bucket: task-ckpt.<sid>.<messageId>
  emitter: NatsEmitter;
  engine: Engine;
  /**
   * Test seam. Every entry defaults to the real implementation imported above;
   * a test overrides only what its scenario needs. Production never sets this,
   * and with it unset the spread below yields exactly the imported functions.
   *
   * This exists because the terminal-state routing in run() — SIGTERM vs user
   * interrupt vs retryable vs fatal, and the SIGTERM detour that stops a
   * normally-returning engine from deleting a checkpoint it still needs — is
   * the part of this file most worth pinning and the part least reachable,
   * sitting behind sandbox provisioning, S3 and a task callback.
   */
  sideEffects?: Partial<TaskRunnerSideEffects>;
}

/** The outside world as task-runner touches it. See TaskRunnerDeps.sideEffects. */
export interface TaskRunnerSideEffects {
  ensureHands: typeof ensureHands;
  destroyHands: typeof destroyHands;
  reapPendingHands: typeof reapPendingHands;
  probeSandboxContainer: typeof probeSandboxContainer;
  fetchPlatformFacts: typeof fetchPlatformFacts;
  restartHandsInSandbox: typeof restartHandsInSandbox;
  unregisterSandbox: typeof unregisterSandbox;
  markHandsIdle: typeof markHandsIdle;
  markRetryPending: typeof markRetryPending;
  syncWorkspaceToS3: typeof syncWorkspaceToS3;
  syncWorkspaceFromS3: typeof syncWorkspaceFromS3;
  syncUploadsFromS3: typeof syncUploadsFromS3;
  archiveRunToS3: typeof archiveRunToS3;
  copyS3Prefix: typeof copyS3Prefix;
  syncWorkspace: typeof syncWorkspace;
  restoreWorkspace: typeof restoreWorkspace;
  postAgentDone: typeof postAgentDone;
  postTaskRunning: typeof postTaskRunning;
  postAppFinishDone: typeof postAppFinishDone;
  postAppFinishHandOver: typeof postAppFinishHandOver;
  postRunLease: typeof postRunLease;
  settleRunAttempt: typeof settleClaimedRun;
  runScript: typeof runScript;
  /** The AppRunner for a run of mode `app`. */
  createAppRunner: typeof createAppRunner;
  /** Publish a task message again, as a new message on the same subject. */
  republishTask: (subject: string, data: Uint8Array) => Promise<void>;
  refreshTaskLock: typeof refreshTaskLock;
  /** Local, no I/O: whether this run must stop before another brain may take its lock. */
  lockPastSelfFence: typeof lockPastSelfFence;
  releaseTaskLock: typeof releaseTaskLock;
  flushTranscript: typeof flushTranscript;
  /** Constructing the client is itself a seam: it opens an MCP transport. */
  makeHandsClient: (
    url: string, token: string, owner: string, run: string, deadlineAt: string | undefined, shellRun: string,
  ) => HandsClient;
}

const REAL_SIDE_EFFECTS: TaskRunnerSideEffects = {
  ensureHands,
  destroyHands,
  reapPendingHands,
  probeSandboxContainer,
  fetchPlatformFacts,
  restartHandsInSandbox,
  unregisterSandbox,
  markHandsIdle,
  markRetryPending,
  syncWorkspaceToS3,
  syncWorkspaceFromS3,
  syncUploadsFromS3,
  archiveRunToS3,
  copyS3Prefix,
  syncWorkspace,
  restoreWorkspace,
  postAgentDone,
  postTaskRunning,
  postAppFinishDone,
  postAppFinishHandOver,
  postRunLease,
  settleRunAttempt: settleClaimedRun,
  runScript,
  createAppRunner: (runId, platformKey, claimCount) =>
    createAppRunner(runId, platformKey, claimCount, (sessionId, event, opts) => getDeps().emitter.emit(sessionId, event, opts)),
  republishTask: async (subject, data) => {
    await getDeps().emitter.nc.jetstream().publish(subject, data);
  },
  refreshTaskLock,
  lockPastSelfFence,
  releaseTaskLock,
  // Hoisted function declaration: the binding exists before this const runs.
  flushTranscript,
  makeHandsClient: (url, token, owner, run, deadlineAt, shellRun) =>
    new HandsClient(url, token, owner, run, deadlineAt, shellRun),
};

let _deps: TaskRunnerDeps | null = null;

/**
 * Bind the shared NATS KV buckets / emitter / engine singletons created in
 * index.ts main(). Must be called once before the first task arrives.
 */
export function bindTaskRunnerDeps(deps: TaskRunnerDeps): void {
  _deps = deps;
}

function getDeps(): TaskRunnerDeps {
  if (!_deps) throw new Error("tasks/runner.ts: bindTaskRunnerDeps() must be called before use");
  return _deps;
}

/** Side effects for the current binding: real ones unless a test overrode some. */
function fx(): TaskRunnerSideEffects {
  const over = _deps?.sideEffects;
  return over ? { ...REAL_SIDE_EFFECTS, ...over } : REAL_SIDE_EFFECTS;
}

// ── TaskCheckpoint KV schema (Plan Y v2 — checkpoint-architecture-redesign §5.2)
// v3 bumps from the v1 S3-coupled schema. v1 was the pre-Plan-Y schema with
// `has_s3_snapshot` / `s3_snapshot_prefix`; v2 was a never-shipped transitional
// design; v3 replaces S3 snapshot pointers with workspace-sync metadata
// populated via configured shared-filesystem rsync.
//
// Readers (readKvCheckpoint) reject any payload with `version !== 3`; v1 has
// no upgrade path because none ever made it to production NATS KV.
interface TaskCheckpoint extends CheckpointState {
  version: 3;
  session_id: string;
  message_id: string;
  user_id: string;
  has_workspace_sync: boolean;  // set true after a successful workspace_sync in onCheckpoint
  last_sync_turn: number;       // turns_completed value at the last successful sync
  checkpointed_at: number;
}

// ===== Checkpoint helpers =====

/**
 * Checkpoint key, one per run rather than one per session.
 *
 * Keying on the session alone made concurrent runs sharing a session overwrite
 * each other. That is not a corner case: Workbench creates one hidden session
 * for a whole DAG, so every parallel node in that DAG wrote the same key, and
 * whichever wrote last decided what all of them would resume from. Readers also
 * reject a payload whose `message_id` does not match, so a node that lost the
 * race did not merely resume from someone else's progress — it found the key
 * occupied by a foreign message id and resumed from nothing.
 *
 * `messageId` is carried in the published request rather than generated per
 * delivery, so it is stable across redeliveries and this key still resolves to
 * the same entry when a run comes back. The three places that build this prefix
 * (here, workspace-reaper, admin-routes) have to agree; a drift is silent.
 */
/**
 * The stable `reason` a `workspace_sync_failed` or `workspace_restore_failed`
 * event carries for an error: the two failures every workspace transfer meets
 * named as such, anything else by its error class.
 */
function workspaceTransferFailureReason(e: unknown, errMsg: string): string {
  if (isHandsNetworkError(e)) return "sandbox_unreachable";
  if (/Payload Too Large|BODY_TOO_LARGE|413/i.test(errMsg)) return "payload_too_large";
  return (e as { constructor?: { name?: string } })?.constructor?.name ?? "Error";
}

function checkpointKey(sessionId: string, messageId: string): string {
  // A trailing empty token is not a legal NATS subject, so a run with no
  // message id gets an explicit placeholder instead of `task-ckpt.<sid>.`.
  return `task-ckpt.${sessionId}.${messageId || "_nomsg"}`;
}

function checkpointS3Prefix(userId: string, sessionId: string, messageId: string): string {
  return `checkpoints/${userId}/${sessionId}/${messageId}/`;
}

/**
 * Translate a non-sandbox fatal error into a stable reason code + a single
 * readable sentence safe to display in chat. The previous behavior assigned
 * the raw err.message verbatim to final_text, which on
 * upstream_overloaded paths leaked the provider's JSON body
 * (e.g. `{"type":"error","error":{"type":"overloaded_error",...},"request_id":"req_vrtx_*"}`)
 * straight into the user's transcript. Reproduced by session
 * e32c683c-9809-40c1-a1a7-0cee3565465b. Keep vendor request_id in the
 * surfaced text so support can still trace upstream incidents.
 */
function classifyTaskFailure(rawMsg: string, err?: unknown): {
  reason: string;
  userText: string;
} {
  const msg = String(rawMsg || "");
  const reqIdMatch = msg.match(/"request_id"\s*:\s*"(req_[A-Za-z0-9_]+)"/);
  const reqIdSuffix = reqIdMatch ? ` (vendor request_id: ${reqIdMatch[1]})` : "";

  // Before every message pattern below: a NatsError's message is the bare word
  // "TIMEOUT", which the timeout pattern would read as the model timing out.
  // It is Claw's own event bus or lock store that did not answer, the model was
  // never involved, and saying otherwise sends whoever reads the reason to the
  // wrong system. Normally such an error is retried rather than reaching here;
  // this is what a run that used up its retries on one says. Wrapped ones too:
  // the sandbox layer's own sentence around a KV TIMEOUT reads "(TIMEOUT)" and
  // would be filed as the model's by the pattern below.
  if (transientNatsErrorIn(err)) {
    return {
      reason: "infra_transient",
      userText: "Claw's internal messaging was briefly unavailable and the run could not continue. Please retry.",
    };
  }

  // First, because the sentence below mentions a deadline and would otherwise
  // be classified as an upstream timeout -- telling the user to retry a run
  // that will hit the same budget again.
  if (/^run_budget_exhausted\b/.test(msg)) {
    return {
      reason: "run_budget_exhausted",
      userText:
        "This run used up the time budget allowed for it and was stopped. "
        + "Partial results above are kept. Raise the run's budget or split the work into smaller steps.",
    };
  }

  if (/"type"\s*:\s*"overloaded_error"/i.test(msg)
      || /\boverloaded\b/i.test(msg)) {
    return {
      reason: "upstream_overloaded",
      userText: `The model provider was overloaded and did not recover after retries. Please retry in a moment.${reqIdSuffix}`,
    };
  }
  if (/"type"\s*:\s*"rate_limit_error"/i.test(msg)
      || /\brate.?limit|too many requests\b/i.test(msg)) {
    return {
      reason: "upstream_rate_limited",
      userText: `The model provider rate-limited the request. Please retry after a short pause.${reqIdSuffix}`,
    };
  }
  if (/(other side closed|UND_ERR_SOCKET|premature close|socket hang up|ECONNRESET|EPIPE)/i.test(msg)
      || /^terminated$/i.test(msg)) {
    return {
      reason: "mid_stream_drop",
      userText: `The model connection dropped mid-stream and did not recover after retries. Please retry.${reqIdSuffix}`,
    };
  }
  if (/All connection attempts failed/i.test(msg)
      || /APIConnection(Timeout)?Error/i.test(msg)) {
    return {
      reason: "upstream_unreachable",
      userText: `Could not reach the model provider after retries. Please retry shortly.${reqIdSuffix}`,
    };
  }
  if (/\b(abort|timeout|deadline exceeded)\b/i.test(msg)) {
    return {
      reason: "upstream_timeout",
      userText: `The model call timed out after retries. Please retry.${reqIdSuffix}`,
    };
  }
  // Default: keep the raw message but capped, since unknown errors may still
  // contain actionable hints. Length matches existing onEvent payload caps.
  return {
    reason: "agent_error",
    userText: msg.slice(0, 500) || "Task failed with an unknown error.",
  };
}

/** Classify retryable exits so retry-pending logs are actionable. */
function classifyRetryableReason(err: unknown): string {
  const e = err as { name?: string; status?: number; message?: string; cause?: { message?: string; code?: string } };
  const msg = String(e?.message || err || "");
  const causeMsg = String(e?.cause?.message || "");
  const causeCode = String(e?.cause?.code || "");
  // First, for the reason classifyTaskFailure gives: "TIMEOUT" is a NatsError's
  // whole message, and the line below would file it as the model's.
  if (transientNatsErrorIn(err)) return "nats_transient";
  if (e?.name === "APIConnectionTimeoutError" || /timeout|deadline/i.test(msg)) return "llm_connection_timeout";
  if (e?.name === "APIConnectionError" || /connection error|fetch failed/i.test(msg)) return "llm_connection_error";
  if (typeof e?.status === "number") return `http_${e.status}`;
  if (/nats/i.test(msg)) return "nats_error";
  if (/econnreset|econnrefused|etimedout/i.test(`${msg} ${causeMsg} ${causeCode}`)) return "network_error";
  if (/enotfound|getaddrinfo/i.test(`${msg} ${causeMsg} ${causeCode}`)) return "dns_error";
  return "retryable_unknown";
}

// Exported for unit tests; not used by production code paths.
/**
 * `state` with the freshest cache-use timestamp the run has seen.
 *
 * Kept apart from the checkpoint the agent loop hands over because the two
 * know different things: the loop's state is what was true at the last turn
 * BOUNDARY, and `fresh` is what was true inside the turn still running. A
 * terminal path that persists the former alone reports a cache entry as older
 * than it is by the length of that turn's tool batch.
 *
 * Returns the same object whenever there is nothing fresher to say, so the
 * common path allocates nothing. Never moves the timestamp backwards: a
 * resumed run's checkpoint carries a timestamp from a previous attempt, and
 * that is evidence too.
 */
function freshenCacheUse(
  state: CheckpointState, fresh: number | undefined,
): CheckpointState {
  if (fresh === undefined) return state;
  const known = state.last_cache_use_at;
  if (known !== undefined && known >= fresh) return state;
  return { ...state, last_cache_use_at: fresh };
}

/**
 * The same state with no cache-use timestamp at all.
 *
 * The counterpart to freshening, and the direction that only compaction can
 * ask for: a fresher number says the entry is still being read, and this says
 * there is no entry. Returns its argument by identity when there was nothing
 * to remove, so callers can keep testing "did anything change" by identity.
 */
function clearCacheUse(state: CheckpointState): CheckpointState {
  if (state.last_cache_use_at === undefined) return state;
  return { ...state, last_cache_use_at: undefined };
}

/**
 * `state` carrying whatever the run currently knows about the cache entry.
 *
 * The two directions are mutually exclusive -- `cleared` says compaction
 * destroyed the entry, `fresh` says it was read again -- so this is the single
 * place that decides between them. Identity-preserving in both directions, so
 * "did anything change" stays a test rather than a comparison.
 */
function overlayCacheUse(
  state: CheckpointState, fresh: number | undefined, cleared: boolean,
): CheckpointState {
  return cleared ? clearCacheUse(state) : freshenCacheUse(state, fresh);
}

/**
 * The state a SIGTERM should persist, or null if it has nothing to say.
 *
 * `attempt` is this attempt's own last checkpoint and `resume` is the one the
 * run was resumed from. Persisting the attempt's is the ordinary case and the
 * only one that used to exist -- which meant a run SIGTERMed during its FIRST
 * new tool batch after a resume had no attempt checkpoint yet, so the fresh
 * cache-use timestamp that batch produced was computed and then dropped. That
 * is exactly the window the freshening was added for, missed in exactly the
 * runs most likely to hit it: a run is resumed because it was interrupted
 * once, and a rolling restart interrupts it again.
 *
 * The resume checkpoint is used only when there is something fresher to write
 * onto it. Re-persisting it unchanged would republish a checkpoint this
 * attempt did not produce for no gain, which is the reason the attempt's own
 * state was the only source in the first place; returning null keeps that
 * property. `freshenCacheUse` returning its argument by identity is what makes
 * "nothing fresher" a test rather than a second comparison.
 */
function sigtermCheckpointState(
  attempt: CheckpointState | null,
  resume: CheckpointState | null,
  fresh: number | undefined,
  cleared: boolean,
): CheckpointState | null {
  const overlay = (state: CheckpointState): CheckpointState => (
    overlayCacheUse(state, fresh, cleared)
  );
  if (attempt) return overlay(attempt);
  if (!resume) return null;
  const overlaid = overlay(resume);
  return overlaid === resume ? null : overlaid;
}

export const __test__ = {
  classifyTaskFailure,
  classifyRetryableReason,
  checkpointKey,
  checkpointS3Prefix,
  runtimeSecrets,
  freshenCacheUse,
  clearCacheUse,
  overlayCacheUse,
  sigtermCheckpointState,
};

// ===== Post-task keepalive teardown =====
//
// Called on every task terminal state (success / interrupt / fatal): remove the
// session from the keepalive in-memory registry + delete its NATS KV entry so
// the Brain stops pinging the sandbox once the task is done.
//
// The Brain intentionally does NOT stop the SaFE workload here. Idle reclamation
// of the now un-pinged sandbox is owned by the control-plane
// sandbox-idle-gc-controller (agent-sandbox-system); a Brain-side GC timer would
// be redundant with it.

// ===== Transcript persistence =====

async function flushTranscript(
  sessionId: string, userId: string, messageId: string,
  startedAt: number, log: Array<Record<string, unknown>>,
  summary: Record<string, unknown>,
): Promise<void> {
  // Cheap and first, because this is the writer most likely to lose the race:
  // a session delete marks the session gone and then aborts the run, and the
  // interrupt path's very first await is this flush. It lands in the same
  // prefix the delete has already listed, so the transcript of a session that
  // no longer exists survives with nothing left that would ever collect it.
  // See infra/deleted-sessions.ts.
  if (isSessionDeletedLocally(sessionId)) {
    logger.info({ sessionId, messageId }, "brain.transcript.skipped_session_deleted");
    return;
  }
  if (!log.length) return;
  try {
    const s3Prefix = `users/${userId}/sessions/${sessionId}/`;
    const mid = messageId || `run-${Date.now()}`;
    // Differentiate non-terminal exits so retries / sigterm checkpoints don't
    // overwrite each other (same messageId across deliveries). Final success /
    // fatal / interrupt keep the canonical "<mid>.jsonl" name.
    let suffix = "";
    if (summary.retrying) suffix = `-attempt${summary.attempt ?? Date.now()}`;
    else if (summary.sigterm) suffix = `-sigterm-${Date.now()}`;
    // Under a reserved directory rather than flat beside the workspace, because
    // that is what lets the sync tell a transcript from a file a user's own run
    // wrote: see TRANSCRIPT_PREFIX. Flat, they were restored into `/workspace`,
    // re-uploaded and re-archived on every following turn, and the prune could
    // only protect them by sparing every flat `.jsonl` -- which made a
    // `results.jsonl` the user deleted undeletable.
    //
    // The flat location is what shipped until now, so every session that has
    // already run has transcripts there. Nothing moves them and nothing exempts
    // them: they stay the workspace files they were already being treated as.
    const transcriptKey = `${s3Prefix}${TRANSCRIPT_PREFIX}${mid}${suffix}.jsonl`;
    const header = JSON.stringify({
      sessionId, messageId, brainId: BRAIN_ID, brainVersion: BRAIN_VERSION,
      startedAt: new Date(startedAt).toISOString(),
      completedAt: new Date().toISOString(),
      eventCount: log.length,
      ...summary,
    });
    // Transcripts that bubbled internal tokens through stdout / tool args /
    // engine events must be sanitized before landing in S3. redactSecrets
    // covers token literal, Bearer, x-api-key and raw 32-byte hex shapes —
    // false-positive risk is low because legitimate transcript bodies rarely
    // contain 64-hex blobs.
    const rawBody = [header, ...log.map(e => JSON.stringify(e))].join("\n") + "\n";
    const body = redactSecrets(rawBody).text;
    const { S3Client: S3C, PutObjectCommand: PutCmd } = await import("@aws-sdk/client-s3");
    const s3 = new S3C({
      region: S3_REGION, endpoint: S3_API_ENDPOINT || undefined,
      forcePathStyle: true,
      credentials: { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY },
    });
    await s3.send(new PutCmd({ Bucket: S3_BUCKET, Key: transcriptKey, Body: body, ContentType: "application/x-ndjson" }));
    logger.info({ sessionId, transcriptKey, events: log.length }, "brain.transcript.saved");
  } catch (e: any) {
    logger.warn({ err: e?.message || String(e), sessionId }, "brain.transcript.save_failed");
  }
}

async function replayPendingCallback(
  msg: JsMsg,
  request: ExecuteRequest,
  lockKey: string,
  run?: AbortController,
): Promise<boolean> {
  if (!request.task_id) return false;
  const { kvCkpt } = getDeps();
  const key = pendingCallbackKey(request.task_id);
  let entry;
  try {
    entry = await kvCkpt.get(key);
  } catch (err) {
    logger.error({ err, taskId: request.task_id }, "task.agent_done_replay_lookup_failed");
    msg.nak(5_000);
    clearActiveAbort(lockKey, run);
    await fx().releaseTaskLock(lockKey, run).catch(() => {});
    return true;
  }
  if (!entry) return false;

  // A cleared outbox is no pending callback. NATS KV answers a key deleted by
  // ackAndClearCallback with its delete marker (operation DEL/PURGE, empty
  // value) rather than null, and the marker stays until the bucket's TTL. It
  // says an earlier execution of this task_id delivered its callback, not that
  // this delivery's did: a script task that returned wait_external is put back
  // to queued and published again under the same task_id to run from step 0,
  // and an app run's finish is handed to a new Brain the same way. Either is a
  // fresh execution, exactly as when the key was never written.
  if (entry.operation === "DEL" || entry.operation === "PURGE" || entry.value.length === 0) return false;

  let stored: ExecuteResult & { run_time?: RunTimeReport };
  try {
    stored = JSON.parse(sc.decode(entry.value)) as ExecuteResult & { run_time?: RunTimeReport };
  } catch (err) {
    // deliverAgentDone writes only JSON, so this entry holds no result that can
    // be replayed, and retrying cannot make it parse. Drop it and run this
    // delivery as if nothing was pending, rather than failing every delivery
    // until the message is poisoned.
    logger.error({ err, taskId: request.task_id }, "task.agent_done_replay_unreadable");
    await kvCkpt.delete(key).catch((e) => {
      logger.warn({ err: e, taskId: request.task_id }, "task.agent_done_outbox_cleanup_failed");
    });
    return false;
  }

  try {
    const { run_time: runTime, ...result } = stored;
    await fx().postAgentDone(request, result, runTime);
    await ackAndClearCallback(msg, kvCkpt, request);
    logger.info({ taskId: request.task_id }, "task.agent_done_replayed");
  } catch (err) {
    logger.error({ err, taskId: request.task_id }, "task.agent_done_replay_failed");
    msg.nak(5_000);
  } finally {
    clearActiveAbort(lockKey, run);
    await fx().releaseTaskLock(lockKey, run).catch(() => {});
  }
  return true;
}

/**
 * Fast-path for `mode=script` + `sandbox_spec="none"` tasks dispatched from
 * the V2 Task DAG (task-design.md §7.3). No SaFE workload is provisioned,
 * no /workspace rehydrate, no S3 sync — just run the script (which only
 * touches Backend-side MCP tools) and POST `agent_done` back to Backend.
 *
 * Returns true if the request was handled on the fast path; false means
 * the caller must continue the legacy full sandbox flow.
 */
async function maybeRunSandboxlessTask(
  msg: JsMsg,
  request: ExecuteRequest,
  sessionId: string,
  lockKey: string,
  abortCtrl: AbortController,
): Promise<boolean> {
  if (!request.task_id) return false;
  if (request.sandbox_spec !== "none") return false;
  if (request.mode !== "script") return false;

  const { emitter, kvCkpt } = getDeps();
  const onEvent = async (evt: Record<string, unknown>) => {
    const safeEvent = redactPersistedEvent(evt, runtimeSecrets(request));
    if (request.message_id) safeEvent.message_id = request.message_id;
    await emitter.emit(sessionId, safeEvent);
  };

  try {
    logger.info(
      { sessionId, taskId: request.task_id, mode: request.mode },
      "task.sandboxless.start",
    );
    let result: ExecuteResult;
    try {
      result = await fx().runScript(request, { hands: null, signal: abortCtrl.signal }, onEvent);
    } catch (e) {
      const errMsg = (e as Error).message;
      const safeErrMsg = redactEgressPayload(errMsg, runtimeSecrets(request));
      logger.error({ sessionId, taskId: request.task_id, err: safeErrMsg }, "task.sandboxless.failed");
      await deliverAgentDone(kvCkpt, request, {
        finalText: "",
        tokenUsage: { input_tokens: 0, output_tokens: 0, cache_read: 0, cache_create: 0, turns: 0 },
        turns: 0,
        pendingSkills: [],
        skillsUsed: {},
        errorCount: 1,
        toolStats: { total_calls: 0, error_calls: 1, by_tool: {} },
        elapsedMs: 0,
        abortReason: "error",
        failureReason: safeErrMsg,
      });
      await ackAndClearCallback(msg, kvCkpt, request);
      return true;
    }
    await deliverAgentDone(
      kvCkpt,
      request,
      redactEgressPayload(result, runtimeSecrets(request)),
    );
    await ackAndClearCallback(msg, kvCkpt, request);
    logger.info(
      { sessionId, taskId: request.task_id, abortReason: result.abortReason },
      "task.sandboxless.done",
    );
  } catch (err) {
    if (err instanceof AgentDoneDeliveryError) {
      logger.error({ err, taskId: request.task_id }, "task.sandboxless_agent_done_delivery_exhausted");
      msg.nak(5_000);
      return true;
    }
    throw err;
  } finally {
    // Drop the in-process abort handle and release the per-task lock so
    // the next DAG step (or unrelated task) can be picked up immediately.
    clearActiveAbort(lockKey, abortCtrl);
    await fx().releaseTaskLock(lockKey, abortCtrl).catch(() => {});
  }
  return true;
}

/** Why a task of a mode this Brain does not run is refused. */
export const unsupportedModeReason = (mode: unknown): string =>
  `task mode "${String(mode)}" is not implemented in this Brain build`;

/**
 * A task whose mode this Brain cannot run is failed outright. Without this, a
 * mode the dispatch below does not know would fall through to the LLM engine,
 * which would answer the task's input as a chat prompt. Only `llm`, `script`,
 * `app` and an omitted mode go on.
 */
export async function refuseUnsupportedMode(
  msg: JsMsg,
  request: ExecuteRequest,
  sessionId: string,
  lockKey: string,
  run?: AbortController,
): Promise<boolean> {
  if (request.mode === undefined || request.mode === "llm" || request.mode === "script" || request.mode === "app") return false;
  logger.error({ sessionId, taskId: request.task_id, mode: request.mode }, "task.mode_not_implemented");
  await refuseBeforeRun(msg, request, lockKey, unsupportedModeReason(request.mode), run);
  return true;
}

/**
 * A requested review (`sandbox_profile: "review"`) with no positive turn budget is failed before anything runs: no sandbox, no cluster,
 * no model turn. The agent loop reads 0 as no limit, so running it would spend the reviewer's quota without one
 * (`agent/review-profile.ts` `reviewTurnBudgetRefusal`).
 */
export async function refuseReviewWithoutTurnBudget(
  msg: JsMsg,
  request: ExecuteRequest,
  sessionId: string,
  lockKey: string,
  run?: AbortController,
): Promise<boolean> {
  const why = reviewTurnBudgetRefusal(request);
  if (why === null) return false;
  logger.error({ sessionId, taskId: request.task_id, maxTurns: request.max_turns ?? null }, "task.review_without_turn_budget_refused");
  await refuseBeforeRun(msg, request, lockKey, why, run);
  return true;
}

/** Fail a task that is not to run at all, with the reason, and let go of it. */
async function refuseBeforeRun(
  msg: JsMsg, request: ExecuteRequest, lockKey: string, failureReason: string, run?: AbortController,
): Promise<void> {
  const { kvCkpt } = getDeps();
  try {
    await deliverAgentDone(kvCkpt, request, {
      finalText: "",
      tokenUsage: { input_tokens: 0, output_tokens: 0, cache_read: 0, cache_create: 0, turns: 0 },
      turns: 0,
      pendingSkills: [],
      skillsUsed: {},
      errorCount: 1,
      toolStats: { total_calls: 0, error_calls: 1, by_tool: {} },
      elapsedMs: 0,
      abortReason: "error",
      failureReason,
    });
    await ackAndClearCallback(msg, kvCkpt, request);
  } catch (err) {
    if (err instanceof AgentDoneDeliveryError) {
      logger.error({ err, taskId: request.task_id }, "task.refusal_delivery_exhausted");
      msg.nak(5_000);
    } else {
      throw err;
    }
  } finally {
    clearActiveAbort(lockKey, run);
    await fx().releaseTaskLock(lockKey, run).catch(() => {});
  }
}

/**
 * What the post-task park did, plus the case the shared type has no room for:
 * a turn that never built a sandbox, so there was no handle to park.
 */
type PostTaskParkOutcome = RunEndedParkOutcome | "no_sandbox";

/**
 * Encapsulates one in-flight task execution (sandbox lifecycle, resume
 * decision, engine dispatch, checkpointing, and all terminal-state
 * handling). One instance per task; never reused across tasks.
 */
/**
 * The claim a doorbell run holds, or null for a fat delivery that took none.
 *
 * Its generation is the discriminator the fat path gets from the delivery pair
 * instead, so the attempt is minted with a zero there. That zero is not the
 * row's generation: a fat acceptance does issue one, and the runner quotes it
 * back in `run_claim` beside this token rather than folding it in here.
 */
export type RunClaim = { claimCount: number } | null;

/**
 * Whether a run that opens its sandbox lazily starts opening it as soon as it
 * starts (`ExecuteRequest.sandbox_prestart`): only when the API asked for it, the
 * deployment allows it, and the run's tool list leaves it a tool that can reach a
 * sandbox -- a run cut to MCP tools has nothing that would use one. Exported for
 * its test; `enabled` is BRAIN_SANDBOX_PRESTART.
 */
export function wantsSandboxPrestart(
  request: ExecuteRequest,
  enabled: boolean = BRAIN_SANDBOX_PRESTART,
): boolean {
  if (!enabled || request.sandbox_prestart !== true) return false;
  const allowlist = parseToolAllowlist(request.tools_allowlist);
  return !allowlist || allowsSandboxUse((name) => allowlist.allows(name));
}

/**
 * Whether the attempts a checkpoint records had a sandbox to lose: a workspace
 * sync was taken, or a tool that only runs in a sandbox -- a sandbox tool, a
 * sub-agent (`task`, which runs on its parent's sandbox) or `deliver_file` --
 * succeeded. Exported for its test.
 *
 * Successes, not attempts, when the checkpoint says which: a call whose sandbox
 * could not be opened is still counted as an attempt, and an account the platform
 * refuses a sandbox records one for every such call -- which is exactly the run
 * that must not be made to open one before it can continue. A checkpoint written
 * before successes were recorded has only the attempts, and is read by them.
 */
export function checkpointUsedSandbox(
  ckpt: Pick<CheckpointState, "tool_calls_by_name" | "tool_ok_by_name"> & { has_workspace_sync?: boolean },
): boolean {
  if (ckpt.has_workspace_sync) return true;
  const counts = ckpt.tool_ok_by_name ?? ckpt.tool_calls_by_name ?? {};
  return Object.entries(counts).some(([name, n]) =>
    (n ?? 0) > 0 && (isSandboxTool(name) || name === "task" || name === "deliver_file"));
}

/** Why a prestarted open was given up: the run ended without anything asking for its sandbox. */
const PRESTART_UNUSED_REASON = new Error("sandbox_prestart_unused");

class TaskRunner {
  // Injected singletons (bound once via bindTaskRunnerDeps in main()).
  private readonly kv: KV;
  private readonly kvCkpt: KV;
  private readonly emitter: NatsEmitter;
  private readonly engine: Engine;

  private readonly msg: JsMsg;
  private readonly request: ExecuteRequest;
  private readonly sessionId: string;
  private readonly lockKey: string;
  private readonly messageId: string;
  private readonly userId: string;
  private readonly abortCtrl: AbortController;

  /**
   * Identity for background-start rows and deduplication across redeliveries.
   * Uses the task id, or the message id for chat without a task row.
   */
  private readonly runId: string;

  /**
   * Phase-ledger identity, whose lease and message fallbacks differ from the
   * background-start row identity in {@link runId}.
   */
  private readonly runIdentity: RunIdentity;

  /**
   * Which attempt of this run the row should accept reports from. Minted here,
   * so a lost allocation write costs a row update rather than a lease: the
   * row's first renewal adopts the token instead.
   */
  private readonly attempt: RunAttemptToken;

  /** Whether this attempt has issued the identity-only report that opens it. */
  private coverageOpened = false;

  /** A claimed run settles on its ack; a fat one settles through `agent_done`. */
  private readonly claimed: boolean;

  /**
   * The scope those shells are addressable in: this DAG, or this conversation.
   *
   * Not the gate key, even though it used to be the same string. The gate now
   * keys on the workspace, which several sessions can share, and passing it here
   * would let one session poll and kill another's background processes.
   */
  private readonly handsOwner: string;

  /** Shell-filing key: the DAG node's task or node id, or empty for a conversation. */
  private readonly shellRun: string;

  // userIdHex: only sessions whose user_id matches /^[0-9a-f]{32}$/ go
  // through the Plan Y v2 workspace-sync path (shared-filesystem restore
  // requires a hex user id; see workspace/sync.ts assertSafeIds). Other
  // sessions (e.g. dev user_id="default", legacy non-hex ids) skip the
  // sync hook entirely and rely on the existing S3 baseline restore.
  private readonly userIdHex: string | null;
  private readonly userIdForSync: string;
  private readonly inflightCkptPrefix: string;
  private readonly transcriptStartedAt: number;

  private keepAlive!: ReturnType<typeof setInterval>;
  private selfFence?: ReturnType<typeof setInterval>;
  private cancelDeadline: () => void = () => {};
  private readonly transcriptLog: Array<Record<string, unknown>> = [];

  // Mutable checkpoint state (updated by onCheckpoint callback).
  private latestCheckpointState: CheckpointState | null = null;
  /** A requested review's turn pool, handed over by the engine (`ExecuteExtras.onTurnPool`). */
  private turnPool: TurnPool | null = null;
  /**
   * The turns an interrupted or failed run reports: its checkpoint's, or under a review's pool what the pool gave if that is more. A
   * checkpoint counts the parent's finished turns only, so a run stopped inside a `task` would otherwise not be charged its sub-agents'.
   */
  private reportedTurns(ckptTurns: number): number {
    return this.turnPool ? Math.max(ckptTurns, this.turnPool.used) : ckptTurns;
  }
  /**
   * What the run had done as of the last thing that recorded it, which is what
   * every terminal path reports.
   *
   * `latestCheckpointState` is written only by this attempt's own onCheckpoint,
   * so on a resumed run it stays null until the first new turn finishes -- and
   * a run is resumed precisely because it has hours behind it. Reading it alone
   * reports the longest runs on the fleet as the shortest ones.
   *
   * `pendingResumeCkpt` and not `resumeCheckpoint`: the two hold the same
   * object, but the latter is assigned by the last line of a successful attach,
   * and the resumed run whose progress is worth reporting usually dies or is
   * stopped inside the attach itself.
   *
   * This is the run's total. A per-attempt figure -- an operator log about what
   * this brain did before it died -- wants `latestCheckpointState` directly.
   */
  private get reportedCkpt(): CheckpointState | null {
    return this.latestCheckpointState ?? this.pendingResumeCkpt;
  }

  /**
   * How long the run has been going, in the terms every terminal path reports.
   *
   * Whatever it had already done before this attempt, plus this attempt's wall
   * clock. Deliberately not the agent loop's own clock as the last checkpoint
   * recorded it: a checkpoint is written at a turn boundary, and skipped
   * outright once the signal is aborted, so that figure stops at the end of the
   * last completed turn and cannot see the turn in flight -- which is the turn
   * a user interrupts and the turn a failure throws from. Three quick turns
   * followed by one that ran 25 minutes would report 60s, and on an interrupt
   * that error is not even random: a user stops a run because a turn is
   * dragging, so the turn being dropped is systematically the longest one.
   *
   * Nothing is lost by preferring this. The checkpoint's figure is this same
   * base plus the loop's own elapsed time, and the loop starts after
   * `transcriptStartedAt`, so this sum is never the smaller of the two. The
   * terms do not overlap: `elapsed_ms_before` is the loop's clock up to the
   * checkpoint this attempt resumed from, and this attempt began at
   * `transcriptStartedAt`.
   *
   * It is still a lower bound, and worth knowing where it loses time. This
   * attempt is counted whole. Every attempt before the last one is counted
   * only as far as its final checkpoint -- so each of them drops its own
   * provisioning, which the loop's clock never included, plus whatever ran
   * after its last turn boundary. One resume loses a few seconds that way; a
   * run that has resumed many times can be reporting a good deal less than it
   * really cost.
   *
   * `pendingResumeCkpt` and not `resumeCheckpoint`, for the reason
   * `reportedCkpt` gives.
   */
  private elapsedMsForRun(): number {
    return (this.pendingResumeCkpt?.elapsed_ms_before ?? 0)
      + (Date.now() - this.transcriptStartedAt);
  }

  // INV-7 short-circuit flag (checkpoint-architecture-redesign §5.3, §22):
  // - set to true on successful task completion (just before deleteKvCheckpoint)
  // - set to true at the head of the SIGTERM catch block
  // Once true, in-flight onCheckpoint callbacks from the agent-loop must NOT
  // overwrite KV — otherwise a late "turn N-1" write can clobber the SIGTERM
  // catch's "turn N" write and we lose a turn on redelivery.
  private taskFinished = false;

  // Async workspace_sync state (§5.5): debounce by lastSyncAt and prevent
  // overlap with pendingSync. pendingSync resolves to the SyncResult for
  // the most recent in-flight sync; consumers Promise.race against
  // SIGTERM/completion timeouts before using it.
  private lastSyncAt = 0;
  private pendingSync: Promise<unknown> | null = null;
  private lastSyncedTurn = 0; // updated post-sync; gates has_workspace_sync KV bit
  /** What the user was last told about repositories in this run (gitReportKey); see announceGitSkipped. */
  private lastGitKey: string | undefined;
  /** Monotonic write counter; see CheckpointEnvelope.seq. */
  private checkpointSeq = 0;
  private lastWrittenSeq = 0;

  private platformKey: string;
  private hands: HandsClient | null = null;
  /**
   * How to reach the sandbox this run is attached to, kept because recovery may
   * need to build a second client against the same sandbox. Reading it back off
   * the client is not possible, and reading it out of KV would find whichever
   * sandbox last wrote the session's key -- which for a DAG node is not
   * necessarily this one.
   */
  private handsUrl = "";
  private handsToken = "";
  /**
   * Which sandbox this run is on, as ensureHands reported it.
   *
   * Passed to every probe and repair so they address this sandbox rather than
   * looking it up under the session, which a DAG's nodes all share. Null only
   * before the sandbox is attached, and in local-dev mode where there is no
   * workload to name.
   */
  private handsIdentity: HandsProbeEntry | null = null;
  /**
   * When this run asked for a sandbox of its own, or null while it never has.
   *
   * The one thing that separates the PENDING KV entry this run's provision
   * wrote from one an earlier run of the same session left behind: the entry is
   * written by `onProvisioned`, in this process, after `ensureHands` has been
   * called from here, so an entry stamped before this instant cannot be the one
   * this attempt is waiting on. See `pendingHandsIdentity`, which is the only
   * reader.
   */
  /**
   * Whether this run ever asked for a sandbox of its own.
   *
   * A boolean and not a timestamp, because nothing reads a time from it any
   * more: ownership of a PENDING entry is settled by the `attemptId` the entry
   * records, and this only answers the prior question of whether this run could
   * own one at all. It was a threshold until the comparison it fed was measured
   * across two processes and found to turn on their clocks.
   */
  private sandboxAsked = false;
  /**
   * What the platform said about this run's sandbox dying, read at the moment we
   * found out and kept until the callback carries it.
   *
   * Read once and never overwritten with nothing: a later read of a workload
   * whose pods have been collected returns null, and letting that replace a real
   * reason would lose the one fact nothing else can supply.
   */
  private platformFacts: PlatformFacts | null = null;
  // Workload id from this run's identity, never the DAG-shared session key.
  private handsWorkloadId = "";
  /**
   * Set the moment a renewal reports the lock gone, whatever else has happened
   * to the abort signal by then. The abort reason cannot carry this on its own:
   * only the first abort sets it, so any earlier one hides it.
   */
  private leaseLost = false;
  private multiNodeContext: MultiNodeContext | null = null;
  private inflightCkptHasData = false;
  private inflightCkptInProgress = false;

  private resumeCheckpoint: CheckpointState | undefined;
  /** Which script progress was last written, and when; see `onScriptProgress`. */
  private scriptProgressKey = "";
  private scriptProgressAt = 0;
  private resumeMode: "sandbox_reuse" | "workspace_restore"
                    | "no_data_turn0" | "skip_no_ckpt" = "skip_no_ckpt";
  // Read from KV before any provisioning and consumed by the sandbox attach,
  // which may happen much later than the read on a deferred run.
  private pendingResumeCkpt: TaskCheckpoint | null = null;
  /**
   * The checkpointed conversation went to the engine before any sandbox was
   * opened (`resumeWithoutSandbox`). A sandbox opened later in the run restores
   * /workspace as any resume does, but the conversation is the engine's by then,
   * so `resolveResumeState` neither replaces it nor adds to it.
   */
  private resumeHandedOver = false;
  private handsAttach: Promise<HandsClient> | null = null;
  /**
   * Whether anything in this run has asked for its sandbox: the up-front open, or
   * a tool, a sub-agent or the engine's own setup through `attachHands`.
   *
   * Separate from whether a sandbox is open, because a prestarted one
   * (`prestartSandbox`) is open before anything asks, and may never be asked for.
   * Until it is, it holds nothing of this run's -- no file the run wrote, no shell
   * it started -- so every path that saves or stops the run's work in its sandbox
   * reads `workHands()`, which is null until this is set, and finds what a lazy
   * run that never opened one finds.
   */
  private sandboxClaimed = false;
  /**
   * The main agent has said this run's turn is over (`ResultMessage`). A run the
   * user stops before that says it itself (`handleUserInterrupt`): the session's
   * stream forwards no `exec_complete`, so without it a client following the
   * stream never sees the turn end.
   */
  private turnEndAnnounced = false;
  /**
   * The open started ahead of the first tool call, while it may still be the
   * run's only open: its abort, which gives that open up, and its settlement,
   * which never rejects. See `prestartSandbox` and `retireUnclaimedPrestart`.
   */
  private prestart: { abort: AbortController; settled: Promise<void> } | null = null;
  /**
   * Why this run cannot have a sandbox, once opening one has ended on one of
   * SANDBOX_UNAVAILABLE_REASONS. Every later attempt to open it is refused with
   * this same error instead of provisioning again: the platform had no sandbox
   * for this run after as long a wait as the deployment allows, and a second
   * wait inside the same run is the same wait again. Per run, not per session --
   * the next message of the session tries afresh.
   */
  private sandboxUnavailable: unknown = null;
  private resumeMetricsRecorded = false;
  // Set by the first successful reap, which a terminal path may do early to
  // keep a still-writing process out of its snapshot; the release on the way
  // out then has nothing left to ask for. See reapBackgroundShells.
  private shellsReaped = false;

  constructor(
    msg: JsMsg,
    request: ExecuteRequest,
    sessionId: string,
    lockKey: string,
    messageId: string,
    userId: string,
    abortCtrl: AbortController,
    claim: RunClaim,
  ) {
    const deps = getDeps();
    this.kv = deps.kv;
    this.kvCkpt = deps.kvCkpt;
    this.emitter = deps.emitter;
    this.engine = deps.engine;

    this.msg = msg;
    this.request = request;
    this.sessionId = sessionId;
    this.lockKey = lockKey;
    this.messageId = messageId;
    this.userId = userId;
    this.abortCtrl = abortCtrl;
    this.runId = request.task_id || messageId;
    // A claimed doorbell has no delivery to count -- its wakeup was acked at
    // claim time -- and a fat delivery takes no claim, so each path presents
    // the row's true value for the half it does not have.
    this.claimed = claim !== null;
    this.attempt = claim
      ? { attemptId: randomUUID(), claimCount: claim.claimCount, deliverySeq: 0, deliveryCount: 0 }
      : {
          attemptId: randomUUID(),
          claimCount: 0,
          deliverySeq: msg.seq,
          deliveryCount: msg.info.deliveryCount,
        };
    const resolved = resolveRunIdentity(request, messageId);
    this.runIdentity = resolved.identity;
    if (resolved.leaseShapeMiss) {
      logger.warn(
        { sessionId, messageId, leaseUrl: request.run_lease?.url },
        "run_identity.lease_shape_miss",
      );
    }
    // Distinct from the event above: a run with nothing to identify it is a
    // degradation this design expects, while an unrecognised lease URL is an
    // upstream regression, and folding the two would let the second hide.
    if (this.runIdentity.source === "unknown") {
      logger.warn(
        { sessionId, messageId, runIdentityKey: this.runIdentity.key },
        "run_identity.unknown",
      );
    }
    this.handsOwner = pickRunScope(request);
    this.shellRun = pickShellRun(request);

    this.userIdHex = /^[0-9a-f]{32}$/.test(userId) ? userId : null;
    this.userIdForSync = request.user_id || "default";
    this.inflightCkptPrefix = `${checkpointS3Prefix(this.userIdForSync, sessionId, messageId)}inflight/`;
    this.transcriptStartedAt = Date.now();

    // Resolve the platform key for SaFE calls. Normal /messages POST paths
    // pass it via task.platform_key, but background-driven re-dispatch paths
    // (e.g. event-consumer's pending-message replay) have no user request
    // context and emit "". resolvePlatformKey() below fills the KV fallback.
    this.platformKey = request.platform_key || "";
  }

  private readonly onEvent = async (
    evt: Record<string, unknown>, opts: { stillMine?: () => boolean } = {},
  ): Promise<void> => {
    const safeEvent = redactPersistedEvent(
      evt,
      runtimeSecrets(this.request, this.platformKey),
    );
    if (this.messageId) safeEvent.message_id = this.messageId;
    if (evt.type === "ResultMessage" && !evt.subagent_id) this.turnEndAnnounced = true;
    this.transcriptLog.push({ ts: Date.now(), ...safeEvent });
    if (opts.stillMine) await this.emitter.emit(this.sessionId, safeEvent, { stillMine: opts.stillMine });
    else await this.emitter.emit(this.sessionId, safeEvent);
  };

  /**
   * Tell the user a snapshot left a repository out, or could not measure one.
   *
   * The event is the only place they can learn that commits in it will not survive
   * the sandbox. Both ways the workspace is saved report it -- the S3 sync that ends
   * a run, and the shared-disk sync after a checkpoint -- and the second runs every
   * turn, so what is said is which repositories were left out and why, once: not
   * again while that stays the same, though the sizes in the sentence move with
   * every turn. Once a sync leaves nothing out the next one that does is news again.
   * A sync that left nothing out says nothing.
   */
  private async announceGitSkipped(git: GitReport | undefined): Promise<void> {
    if (!git) { this.lastGitKey = undefined; return; }
    const key = gitReportKey(git);
    if (key === this.lastGitKey) return;
    await this.onEvent({
      type: "sandboxStatus",
      status: "workspace_git_skipped",
      reason: git.unmeasured ? "git_unmeasured" : "git_over_limit",
      message: git.note,
      message_id: this.messageId,
    });
    // Only once it went out: an event the stream refused is tried again next turn.
    this.lastGitKey = key;
  }

  /**
   * Freshest proof the run's prefix cache entry existed, ahead of the
   * checkpoint that would record it.
   *
   * The agent loop learns a turn used the cache from that turn's response, and
   * persists it at the NEXT turn boundary -- with the turn's whole tool batch
   * in between. A SIGTERM landing in that window writes the previous turn's
   * timestamp, so on resume the detector measures a gap that is too long by
   * the length of the batch and calls a live entry expired.
   *
   * A field and not a write: the SIGTERM path is already about to persist a
   * checkpoint, so the fix is to hand that write a fresher number, not to add
   * a second one. The periodic cadence is untouched.
   *
   * Only ever moves forward, and only overlays when it is strictly fresher
   * than what the checkpoint already carries -- a resumed run's checkpoint can
   * hold a timestamp from before this attempt began.
   */
  private latestCacheUseAt: number | undefined;

  /**
   * Whether the loop has told this runner that the cache entry is GONE.
   *
   * `latestCacheUseAt === undefined` cannot say this on its own: it is also
   * what "nothing heard yet" looks like, and those two want opposite things
   * from a checkpoint that carries a timestamp. Nothing-heard must leave it
   * alone; compaction must take it off.
   */
  private cacheUseCleared = false;

  private readonly onCacheUse = (at: number | undefined): void => {
    // `undefined` is compaction: the entry the timestamp described no longer
    // exists. It arrives on the line that destroys the entry rather than at
    // the next turn boundary, because the checkpoint holding the stale value
    // is already written and a SIGTERM in between would persist it.
    if (at === undefined) {
      this.latestCacheUseAt = undefined;
      this.cacheUseCleared = true;
      return;
    }
    this.cacheUseCleared = false;
    if (this.latestCacheUseAt === undefined || at > this.latestCacheUseAt) {
      this.latestCacheUseAt = at;
    }
  };

  /**
   * The workspace-sync metadata that belongs with the state this runner holds
   * right now.
   *
   * One expression, called from both the turn write and the repair below,
   * because the two have to agree. `lastSyncedTurn` only ever advances, so a
   * value derived from it here is never older than the one a caller captured
   * earlier -- which is the whole point: a repair re-writes
   * `latestCheckpointState`, and pairing that with a caller's captured
   * `workspaceInfo` would put `has_workspace_sync: false` back on a run whose
   * sync has since completed.
   */
  private currentWorkspaceInfo(): { has_workspace_sync: boolean; last_sync_turn: number } | undefined {
    return this.lastSyncedTurn > 0
      ? { has_workspace_sync: true, last_sync_turn: this.lastSyncedTurn }
      : undefined;
  }

  /**
   * Record a script run's progress in the run's checkpoint.
   *
   * The same checkpoint a conversation is resumed from, read back the same way
   * by whichever worker takes the run over; a script's state is just smaller.
   * Written when a step finishes, and again while a repeating step goes on --
   * at most every SCRIPT_PROGRESS_REFRESH_MS, enough to keep the entry inside
   * its TTL through a step that waits for a day.
   *
   * Not skipped once the run is aborted, unlike a turn's checkpoint: a step
   * that finished just as a drain began still has to be recorded as done, or
   * the worker taking over runs it again.
   *
   * Only into a sealed (v4) checkpoint. Progress is tool results verbatim --
   * captures and the last structured result, fields a conversation checkpoint
   * never holds -- and the v3 format is plaintext behind its redactor, which
   * both leaves values it does not recognise readable and rewrites the ones it
   * does, so a later step would read `<redacted>` where it needs the value.
   * Without it a takeover starts from the first step again, as before; a
   * background start there resolves to the shell already running (see
   * `allocateStartIdentity`), which is what keeps a long job attached.
   */
  private readonly onScriptProgress = async (progress: ScriptProgress): Promise<void> => {
    if (this.taskFinished || CHECKPOINT_WRITE_VERSION !== 4) return;
    const now = Date.now();
    // A new step, or the first call of a repetition, is written at once: the
    // repetition's start time is what keeps its bounds across a takeover.
    const key = `${progress.step}:${progress.repeat_started_at ?? ""}`;
    if (key === this.scriptProgressKey
      && now - this.scriptProgressAt < SCRIPT_PROGRESS_REFRESH_MS) return;
    const state: CheckpointState = {
      messages: [],
      turns_completed: progress.step,
      usage: { input_tokens: 0, output_tokens: 0, cache_read: 0, cache_create: 0, turns: 0 },
      text_parts: [],
      error_count: 0,
      tool_calls_by_name: {},
      total_tool_calls: 0,
      elapsed_ms_before: this.elapsedMsForRun(),
      setup_commands: [],
      script: progress,
    };
    if (await this.writeKvCheckpoint(state)) {
      this.scriptProgressKey = key;
      this.scriptProgressAt = now;
    }
  };

  /**
   * Persist a turn caught part-way through its tool calls (`PendingTurn`).
   *
   * Not skipped once the run is aborted, unlike `onCheckpoint`: a call that
   * finished just as a drain began is the one a resumed run must be told
   * about, or it asks the model again and the call is made twice. Skipped
   * only once the run has settled (`taskFinished`), which is also what keeps
   * it from landing under the SIGTERM path's own write: that path latches
   * the flag before it reads `latestCheckpointState`, and so persists this
   * state itself. No workspace sync: the boundary checkpoint schedules those.
   */
  private readonly onTurnJournal = async (state: CheckpointState): Promise<void> => {
    if (this.taskFinished) return;
    this.latestCheckpointState = state;
    const written = await this.writeKvCheckpoint(state, this.currentWorkspaceInfo());
    if (!written) {
      throw new Error(`turn journal KV write failed at turn ${state.turns_completed}`);
    }
  };

  private readonly onCheckpoint = async (state: CheckpointState): Promise<void> => {
    if (this.abortCtrl.signal.aborted || this.taskFinished) {
      logger.debug(
        { sessionId: this.sessionId, reason: this.abortCtrl.signal.aborted ? "aborted" : "finished" },
        "checkpoint.skip",
      );
      return;
    }
    // Held verbatim. This is the conversation a resumed run replays to the
    // model, and mutating it here is what deleted file paths and identifiers
    // out of live sessions. There is deliberately no copy taken: the agent
    // loop already hands this in as `workingMessages.slice()`, and the v3
    // write path redacts on its way to the bucket (see encodeCheckpointV3)
    // while v4 seals instead. Anything that takes a string out of this object
    // and sends it somewhere -- the partial summary below is the one that does
    // -- has to redact for itself now.
    this.latestCheckpointState = state;
    // The checkpoint is authoritative about cache use, so this assignment can
    // move the timestamp BACKWARDS -- or clear it -- where `onCacheUse` only
    // ever moves it forward. That asymmetry is the fix: compaction discards
    // the cache entry and the agent loop clears its own timestamp to say so,
    // but said it by omission, and the runner kept the pre-compaction value.
    // A SIGTERM then freshened the checkpoint with a timestamp for an entry
    // compaction had already destroyed, and the resumed run measured a gap
    // against it and reported a cache loss that never happened -- the exact
    // false positive the clear exists to prevent, reintroduced downstream of
    // it. Within a turn `onCacheUse` is still the fresher of the two; at a
    // turn boundary the loop's state is the one that knows.
    this.latestCacheUseAt = state.last_cache_use_at;
    this.cacheUseCleared = state.last_cache_use_at === undefined;
    const written = await this.writeKvCheckpoint(state, this.currentWorkspaceInfo());

    // Trigger an async workspace sync if it's been long enough since the
    // last one AND we are not already syncing AND we have a hex user id
    // AND we still have a live hands client. The sync itself runs through
    // the normal-priority semaphore so a burst across sessions cannot
    // saturate shared-filesystem IO.
    const now = Date.now();
    const workHands = this.workHands();
    if (
      WORKSPACE_PERSIST_BASE
      && this.userIdHex
      && workHands
      && !this.pendingSync
      && now - this.lastSyncAt > WORKSPACE_SYNC_INTERVAL_MS
    ) {
      this.lastSyncAt = now;
      const frozenHands = workHands;
      const frozenUidHex = this.userIdHex;
      const turnSnapshot = state.turns_completed;
      this.pendingSync = workspaceSyncSemaphore
        .run(async () => {
          await this.refuseSharedSyncIfHeld(frozenHands);
          return fx().syncWorkspace(frozenHands, this.sessionId, frozenUidHex, turnSnapshot);
        })
        .then(async (info) => {
          if (this.taskFinished || this.abortCtrl.signal.aborted) return info;
          this.lastSyncedTurn = turnSnapshot;
          // Re-write KV so the next reader sees has_workspace_sync=true.
          // Use the cached latestCheckpointState if the agent loop has
          // since advanced; otherwise fall back to the state captured at
          // sync issue time so the flip is never lost.
          const stateToCommit = this.latestCheckpointState ?? state;
          await this.writeKvCheckpoint(
            stateToCommit,
            { has_workspace_sync: true, last_sync_turn: turnSnapshot },
          );
          logger.info(
            { sessionId: this.sessionId, turn: turnSnapshot, sizeBytes: info.size, durationMs: info.durationMs },
            "checkpoint.workspace_sync_done",
          );
          // Last, and on its own: the snapshot is saved and the flag is set whether
          // or not the user can be told what it left out.
          await this.announceGitSkipped(info.git).catch((e: unknown) => {
            logger.warn({ err: e, sessionId: this.sessionId }, "checkpoint.git_skipped_event_failed");
          });
          return info;
        })
        .catch((e: unknown) => {
          logger.warn({ err: e, sessionId: this.sessionId, turn: turnSnapshot },
            "checkpoint.workspace_sync_failed");
        })
        .finally(() => {
          this.pendingSync = null;
        });
    }

    // Raised last so a failed KV write still gets the workspace sync above
    // scheduled. agent-loop turns this into "don't advance lastCheckpointAt",
    // which makes the wall-clock fallback retry on the next turn instead of
    // treating the failed write as a fresh checkpoint.
    if (!written) {
      throw new Error(
        `checkpoint KV write failed at turn ${state.turns_completed}`,
      );
    }
  };

  /** Health poll for the recovery decision: one question, asked once. */
  private static readonly RECOVERY_HEALTH_TIMEOUT_MS = 2_000;

  /**
   * Make the sandbox usable again, choosing the least destructive repair that
   * the evidence supports.
   *
   * agent-loop calls this when Hands MCP has failed enough times to stop being
   * worth reporting. What that means is genuinely ambiguous, and the three
   * possibilities want three different answers:
   *
   *   - The container is gone. Rebuild: destroy what is left, provision a
   *     replacement, restore /workspace.
   *   - The container is alive and Hands answers /health. Then only Brain's own
   *     MCP client is at fault -- a wedged socket, or a session id the Hands on
   *     the other end no longer knows -- and a fresh client fixes it without
   *     touching the sandbox.
   *   - The container is alive and Hands does not answer. The Hands process
   *     died inside a container that is still running whatever the task started
   *     in it. Restart Hands in place; rebuilding here would kill the very
   *     thing the container is worth keeping for.
   *
   * Only the first may destroy anything, and an unknown verdict counts as "not
   * the first". Handing back the existing client unchanged is the one thing
   * this must not do on the strength of a probe alone: that was the previous
   * behaviour and it had no repair in it at all, so a container that stayed up
   * with a dead Hands produced an unbounded run of identical failures.
   */
  /**
   * Ask the platform why this run's sandbox is gone, and keep the answer.
   *
   * Called wherever we first establish that it IS gone, which is the only window
   * in which the answer exists: SaFE serves a pod's account of its own ending
   * from the pod, and a reclaimed node's pods are collected within minutes. By
   * the time a dispatcher above Claw asks, there is nothing left to read -- which
   * is why the fact is stored on the row rather than resolved on request.
   *
   * Never overwrites a fact already held, and never records an absence.
   */
  private async capturePlatformFacts(): Promise<void> {
    if (this.platformFacts) return;
    const identity = await this.reportableIdentity();
    const facts = await fx().fetchPlatformFacts(
      identity?.workloadId,
      identity?.platformKey ?? this.platformKey,
    ).catch(() => null);
    if (facts) this.platformFacts = facts;
  }

  /**
   * The workload of a provision that has not come back, out of its own KV record.
   *
   * `handsIdentity` is assigned from what `ensureHands` returns, so it is still
   * null for every failure that happens before the sandbox is ready -- which is
   * the entire pre-ready family (sandbox_exited_before_ready, sandbox_gone,
   * sandbox_pending_timeout, sandbox_workload_terminal, ...), and precisely the
   * family where the platform is the only witness: the run did not fail, the
   * cluster took it. Asking about `undefined` returns null on the first line of
   * `fetchPlatformFacts`, so those runs were booked as ordinary failures.
   *
   * The id does exist by then, and durably: the provider mints it and the
   * provision writes a PENDING entry naming it before it starts waiting for the
   * pod (ensure-hands' onProvisioned), because a workload nobody has recorded
   * is a workload nobody can reap. That entry is the only copy of the id this
   * worker holds while the provision is still in flight.
   *
   * Two callers live in that window, and neither can name the workload any
   * other way: `capturePlatformFacts`, which is one line away from destroying
   * it, and the lease heartbeat, which reports it upward so the row keeps a
   * handle for whoever asks about the ending afterwards. Only the first
   * destroys anything; what they share is that `handsIdentity` is null.
   *
   * PENDING only, deliberately, and it is the same test `reapPendingHands`
   * applies a moment later -- so what this reads is the workload that is about
   * to be stopped, or the one this run is still waiting on. A READY entry is
   * the opposite case twice over: it cannot be this attempt's (a READY entry
   * means `ensureHands` returned, and then `handsIdentity` is set and neither
   * caller reaches this), so it belongs to a live sandbox some earlier message
   * built and this run never attached to, and SaFE answers for a live workload
   * with the node it is happily running on -- which would record a placement,
   * an ending, or a sandbox handle for a run that has none of them.
   *
   * PENDING does not say *whose*, though, and that is a separate question the
   * entry itself cannot answer: nothing in it names a run. A provision that
   * died between minting its workload and reaping it leaves an entry of exactly
   * this shape behind, and the next turn of the same session -- which under
   * BRAIN_LAZY_SANDBOX can fail on an LLM error without ever calling
   * `ensureHands` -- then reads that workload as the sandbox it was on, asks
   * SaFE about it, and delivers the previous run's preemption as its own
   * ending. So ownership is established before anything is reported, and by the
   * same test the teardown uses: the entry names the task that asked for it, and
   * an entry naming a different one -- or naming none, which no task-bearing run
   * of this build can write -- is somebody else's. The attempt then separates
   * one delivery of that task from the next: the entry records the `attemptId`
   * that minted it, and a redelivery's is different, so the entry its
   * predecessor left is refused without any clock being consulted. A run that
   * never asked owns no entry at all.
   *
   * Null on anything unreadable. An absent entry, an unreachable bucket, a
   * corrupt payload and a missing or unparseable `createdAt` all mean the same
   * thing here: we cannot show the workload is ours, so we ask about nothing
   * and record nothing, exactly as a run with no entry does.
   */
  private async pendingHandsIdentity(): Promise<HandsProbeEntry | null> {
    // Read once: a rebuild moves it, and the comparison below has to be made
    // against the ask this read is answering.
    if (!this.sandboxAsked) return null;
    try {
      const entry = await readHandsEntry(this.kv, this.sessionId);
      if (!entry) return null;
      const info = JSON.parse(entry.value) as HandsProbeEntry
        & { status?: string; createdAt?: string; taskId?: string | null;
            attemptId?: string | null };
      if (info.status !== "pending" || !info.workloadId) return null;
      // By name first, the way the teardown asks it. `reapPendingHands` matches
      // the task the entry records, and this path was left comparing timestamps
      // -- so the two readers of one question disagreed, and the weaker test was
      // the one on the reporting side. The gap does not need a skewed clock: a
      // sibling DAG's entry written AFTER this run asked is genuinely newer, so
      // a run whose own provision was refused before `onProvisioned` reported
      // the sibling's workload, node and preemption reason as its own ending.
      //
      // Every entry this build writes carries the task that asked
      // (`makeOnProvisioned`), so an entry naming a different task -- or naming
      // none, which no task-bearing run of this build can produce -- is not this
      // run's to report.
      // One predicate, shared with every other attribution reader, instead of
      // each one inlining its own comparison -- which is how this path ended up
      // on timestamps while the teardown was on task ids. `mine` is the only
      // answer that permits a report: `other` is somebody else's ending,
      // `unattributed` is an entry from a build that recorded nothing and no
      // caller can show is theirs, and `unasked` cannot arise here because the
      // branch above already refused a run that asked for nothing.
      //
      // Deliberately NOT a reuse gate. A sandbox minted by one attempt and
      // taken over by the next task is re-stamped as it changes hands
      // (`clearIdleMarkers`), so the reuser reports its own ending.
      return attributionOf(info, {
        taskId: this.request.task_id ?? null,
        attemptId: this.attempt.attemptId,
      }) === "mine" ? info : null;
    } catch (e) {
      logger.warn({ err: e, sessionId: this.sessionId }, "platform_facts.pending_identity_unreadable");
      return null;
    }
  }

  /**
   * Which sandbox to name when this run tells anything outside itself which
   * sandbox it is on -- as opposed to which one to act on, which is always
   * `handsIdentity` and nothing else.
   *
   * The two are the same once `ensureHands` has returned and differ before it
   * does, and the difference is the whole of the pre-ready family: a run killed
   * as sandbox_pending_timeout, sandbox_exited_before_ready or sandbox_gone
   * never reaches the assignment, so every report it makes named no sandbox at
   * all. Both reporters wanted the same thing from the same window and only one
   * of them had been given it, which is why the rule is stated here rather than
   * at either call site:
   *
   *   - `capturePlatformFacts` asks SaFE what happened to the workload.
   *   - the lease heartbeat puts the handle on the row, where the API lifts it
   *     off (`recordLeaseSandbox`) for platform-backfill to ask SaFE with later.
   *     Backfill's own KV fallback deliberately refuses a reused sandbox, so
   *     from the second turn of a session the renewal is the only source the
   *     handle has -- and a row with no handle is a kill nobody can attribute.
   *
   * The fallback costs a KV read, and the heartbeat caller runs every
   * RUN_LEASE_HEARTBEAT_MS for every run on the fleet, so it is reached for
   * only when `handsIdentity` is genuinely null -- the pre-ready window, which
   * is already paying for this exact read on a shorter timer:
   * `startDeliveryHeartbeat` reads the same key unconditionally for the whole
   * run, every LOCK_REFRESH_INTERVAL_MS (10s, against 15s here). A turn
   * answered from context under BRAIN_LAZY_SANDBOX has `handsIdentity` null
   * too, and costs nothing at all: `pendingHandsIdentity` answers it from
   * `sandboxAsked` without opening the bucket, because a run that never asked
   * for a sandbox cannot own the entry it would find. So this adds strictly
   * less KV traffic than the run already makes, and none once the sandbox is
   * attached or while none was ever wanted.
   */
  private async reportableIdentity(): Promise<HandsProbeEntry | null> {
    return this.handsIdentity ?? await this.pendingHandsIdentity();
  }

  /**
   * The result as delivered, carrying whatever the platform said.
   *
   * Attached here rather than at each construction site so a new terminal path
   * cannot forget it, and attached to the result rather than to the POST because
   * `deliverAgentDone` checkpoints the result before sending: a Brain that dies
   * between the two replays the facts instead of losing them.
   */
  private withPlatformFacts(result: ExecuteResult): ExecuteResult {
    if (!this.platformFacts) return result;
    return { ...result, platformFacts: this.platformFacts };
  }

  private readonly recreateHands = async (
    allowance: HandsRecoveryAllowance = { rebuild: true, nondestructive: true },
  ): Promise<RecreateHandsResult> => {
    logger.warn({ sessionId: this.sessionId }, "sandbox.recovery.start");
    const probe = await fx().probeSandboxContainer(
      this.sessionId,
      this.handsIdentity ?? undefined,
      this.abortCtrl.signal,
    );
    if (probe.verdict !== "dead") {
      if (!allowance.nondestructive) throw new HandsRecoveryBudgetExhausted("recovery");
      return this.recoverWithoutDestroy(probe.verdict, probe.reason);
    }
    // The container is gone and we are about to destroy what is left of the
    // workload. Ask the platform why first: after the destroy there is nothing
    // to ask, and a preemption is only ever visible here.
    await this.capturePlatformFacts();
    // A node running on a sandbox it inherited must not destroy it, whatever
    // the probe says: `use` names one sandbox and the destroy path addresses
    // the session, which every node of the DAG shares. See
    // inheritedSandboxHandle.
    const inherited = this.inheritedSandboxHandle();
    if (inherited) {
      // Typed, because this refusal can never come out differently: the node
      // still will not own the sandbox on the next batch. An untyped Error is
      // charged to the non-destructive budget and latches nothing, so every
      // later batch pays for another probe to be told the same thing.
      throw new HandsRecoveryRefused(
        `sandbox_spec.use='${inherited}' inherited a sandbox that is no longer `
        + `reachable (${probe.reason}), and a node cannot rebuild a sandbox it `
        + `did not create -- the upstream node's files would be lost, and the `
        + `sandbox may still be in use by sibling nodes. Re-run the node that `
        + `created this handle.`,
      );
    }
    if (!allowance.rebuild) throw new HandsRecoveryBudgetExhausted("rebuild");
    // Past here the repair is destructive and no other one is still on the
    // table, so every exit -- including a destroy that succeeded and a
    // provision that then did not -- is a spent rebuild. Wrapping says so to
    // the loop, which otherwise charges the failure to the non-destructive
    // budget, leaves the rebuild budget at zero, and re-enters this same path
    // (destroying a workload each time) for the rest of the task.
    return await this.runRebuild().catch((err) => {
      throw err instanceof HandsRebuildFailed ? err : new HandsRebuildFailed(err);
    });
  };

  /** The destructive half of `recreateHands`, entered only once it is chosen. */
  private async runRebuild(): Promise<RecreateHandsResult> {
    if (this.abortCtrl.signal.aborted) {
      throw new Error("sandbox recovery aborted before destroy");
    }
    // destroyHands stops THIS sandbox (handsIdentity), not whichever sibling
    // last wrote the session KV key. Session KV/token/keepalive are dropped
    // only when that key still names the same sandbox.
    await fx().destroyHands(
      this.sessionId,
      this.handsIdentity ?? undefined,
      this.handsToken,
      undefined,
      { activeMessageId: this.messageId },
    );
    if (this.abortCtrl.signal.aborted) {
      throw new Error("sandbox recovery aborted after destroy");
    }
    // The handle naming the sandbox just stopped is freed by `destroyHands`
    // itself, which is where every stop goes through -- rebuild here, and the
    // retryable-provisioning reap that would otherwise strand a redelivery.
    // Best-effort close of the dead client (its socket is likely already
    // wedged; ignore failures).
    const oldHands = this.hands;
    oldHands?.close().catch(() => {});
    // Pass multiNodeContext so the rebuilt sandbox keeps the dispatcher external-mode
    // env and the Infera SSH key for the cluster already provisioned above.
    // Marked like the first provision: a rebuild mints its own workload and
    // writes its own PENDING entry, and the destroy above has just removed the
    // one the old sandbox left.
    this.sandboxAsked = true;
    const { handsUrl: newUrl, token: newToken, identity: newIdentity } = await fx().ensureHands(
      this.sessionId, this.request, this.platformKey, this.onEvent, this.multiNodeContext ?? undefined,
      { skipSessionReuse: true, signal: this.abortCtrl.signal,
        reclaimOnAbort: () => this.abortReclaimsSandbox(),
        attemptId: this.attempt.attemptId },
    );
    const newHands = fx().makeHandsClient(
      newUrl, newToken, this.handsOwner, this.runId, this.request.deadline_at, this.shellRun,
    );
    // Fold the newest in-flight snapshot into the session prefix *before*
    // restoring from it. The session prefix only advances on a successful
    // terminal sync, so mid-run it holds the state from before this run
    // started, while the KV checkpoint the loop keeps using holds the whole
    // conversation. Restoring straight from the session prefix therefore
    // handed the agent an empty workspace together with a memory of having
    // created files in it — a silent split between conversation state and file
    // state, with nothing emitted to say so. The in-flight snapshot is the
    // most recent file state that exists anywhere, so it has to be promoted
    // first. No-ops when no snapshot was ever written.
    await this.recoverInflightCheckpoint("sandbox_rebuild");
    // A new sandbox, whatever address it was given: a hold this process kept for
    // an earlier one at that address is not this one's (see resolveResumeState).
    releaseRestoreHold(newHands, this.sessionId);
    // Always rehydrate after a rebuild: the new sandbox is empty regardless
    // of whether ensureHands reused a (concurrently-revived) KV entry.
    await this.restoreWorkspaceFromS3(newHands, this.request.user_id || "default", "after_rebuild");
    this.handsUrl = newUrl;
    this.handsToken = newToken;
    this.handsIdentity = newIdentity ?? null;
    this.handsWorkloadId = newIdentity?.workloadId ?? "";
    this.hands = newHands;
    // The facts explained a sandbox that no longer has anything to do with how
    // this run ends. They were read to account for an ending, and the rebuild
    // is the proof there was no ending: the task keeps going on a live sandbox,
    // and whatever it does next is its own. Left set, a run preempted at turn
    // three and finished normally at turn forty delivered that preemption's
    // message, node, and exit code on a successful completion -- the platform
    // read is attached to every terminal path by design, and the success path
    // is one of them -- so the row said "the cluster took this run away" about
    // a run that returned an answer.
    //
    // Cleared here rather than at the top of the recovery, so that everything
    // between the capture and a working sandbox still carries them: a destroy
    // that succeeded and a provision that then did not is exactly the ending
    // the facts were read for. And cleared rather than merely ignored, so a
    // second sandbox death later in the same run captures its own account
    // instead of finding the first one already held.
    this.platformFacts = null;
    await fx().postTaskRunning(this.request, {
      brainId: BRAIN_ID,
      sandboxWorkloadId: this.handsWorkloadId,
      attempt: this.attempt,
    });
    return { hands: newHands, action: "rebuilt" };
  }

  /**
   * Repair the link to a sandbox that must not be destroyed.
   *
   * `verdict` is `alive` or `unknown`, and the difference only changes how much
   * is worth attempting: with the container confirmed alive it is worth
   * restarting Hands inside it, while an unreachable control plane leaves
   * nothing to act on but Brain's own client.
   */
  private async recoverWithoutDestroy(
    verdict: ContainerProbeVerdict,
    probeReason: string,
  ): Promise<RecreateHandsResult> {
    if (!this.hands || !this.handsUrl) {
      throw new Error(`sandbox.recovery.no_client_to_recover: probe=${probeReason}`);
    }
    const health = await checkHandsHealth(
      this.handsUrl,
      TaskRunner.RECOVERY_HEALTH_TIMEOUT_MS,
      this.abortCtrl.signal,
    );

    // Hands is answering, so the sandbox is fine and this client is not. A
    // fresh one re-runs the MCP handshake, which is what recovers a transport
    // whose session the server has forgotten -- the failure mode that no number
    // of retries on the old client can clear.
    if (health.ok) {
      return {
        hands: this.replaceHandsClient(),
        action: "reconnected",
        detail: `probe=${probeReason}`,
      };
    }

    if (verdict === "alive" && SANDBOX_HANDS_RESTART_ENABLED) {
      const restart = await fx().restartHandsInSandbox({
        sessionId: this.sessionId,
        handsUrl: this.handsUrl,
        token: this.handsToken,
        entry: this.handsIdentity ?? undefined,
        signal: this.abortCtrl.signal,
      });
      if (restart.ok) {
        logger.warn(
          { sessionId: this.sessionId, probeReason },
          "sandbox.recovery.hands_restarted",
        );
        return {
          hands: this.replaceHandsClient(),
          action: "hands_restarted",
          detail: `health=${health.detail}`,
        };
      }
      // The container is alive and Hands will not come up in it. Rebuilding
      // would fix Hands and lose the container, and this path exists because
      // that trade is not ours to make silently -- the loop reports it and its
      // recovery budget decides when to stop.
      logger.error(
        { sessionId: this.sessionId, probeReason, restart: restart.detail },
        "sandbox.recovery.hands_restart_failed",
      );
      return {
        hands: this.replaceHandsClient(),
        action: "left_alone",
        detail: `hands_restart=${restart.detail}`,
      };
    }

    logger.warn(
      { sessionId: this.sessionId, verdict, probeReason, health: health.detail },
      "sandbox.recovery.left_alone",
    );
    return {
      hands: this.replaceHandsClient(),
      action: "left_alone",
      detail: `probe=${probeReason} health=${health.detail}`,
    };
  }

  /**
   * A new client against the same sandbox, with the old one discarded.
   *
   * Always a new object rather than a reset of the existing one: `HandsClient`
   * latches `connected` on its first successful handshake and the MCP transport
   * holds the server-assigned session id, so a client that has gone bad has
   * state in two places and no way to prove either is still good. Building
   * another is cheap -- the connection pool is shared at module level.
   */
  private replaceHandsClient(): HandsClient {
    this.hands?.close().catch(() => {});
    const fresh = fx().makeHandsClient(
      this.handsUrl, this.handsToken, this.handsOwner, this.runId, this.request.deadline_at, this.shellRun,
    );
    this.hands = fresh;
    return fresh;
  }

  /**
   * The handle this run inherited its sandbox through, or "" when it built its
   * own.
   *
   * Load-bearing for the destroy path. `sandbox_spec.use` names one sandbox,
   * but every node of a DAG shares a `session_id`, and both `destroyHands` and
   * the session's KV entry are addressed by that session -- so a `use` node
   * that decided to rebuild would stop whichever sandbox last wrote the key,
   * which is the shared one its siblings are still working in.
   */
  private inheritedSandboxHandle(): string {
    try {
      const action = resolveSandboxAction(this.request);
      return action.kind === "use" ? action.handle : "";
    } catch {
      // Unparseable specs are the legacy chat shapes, which never inherit.
      return "";
    }
  }

  /** Recover the latest in-flight workspace checkpoint into the session prefix. */
  /**
   * Reap a PENDING entry this attempt left behind -- and only this attempt's.
   *
   * The entry records the task that wrote it, which keeps a failing task off a
   * sibling DAG's workload. It cannot tell two ATTEMPTS of the same task apart:
   * a delivery whose lease expired is redelivered under the same task_id, so
   * the new attempt's entry carries the identity the old attempt compares
   * against, and the old one stops a workload the new one is using.
   *
   * The lock is what separates them. Losing the lease means this session has
   * moved to another holder, and a holder that no longer has the lock has no
   * business tearing anything down -- whatever it would reap now belongs to
   * whoever took it. The heartbeat has already aborted us by this point; this
   * failure handler simply had not been looking.
   */
  /**
   * Does this attempt still hold the session's lock?
   *
   * One expression, asked from two places -- before the reap and again from
   * inside it, immediately before the stop -- because two copies of a rule are
   * two things to keep true, and the second copy is the one that gets missed.
   *
   * Two ways to have lost it. The abort reason carries it when the lease loss
   * is what aborted us; `leaseLost` carries it when something else had already
   * aborted and taken that slot.
   */
  /**
   * Whether a sandbox wait cut short by this run's abort may reclaim what it was
   * provisioning: only for a user's cancel, and only while this replica still
   * owns the run. A restart or a lease loss hands the sandbox to the next run, and
   * a deadline or terminal row is settled by the failure path.
   */
  private abortReclaimsSandbox(): boolean {
    return this.stillOwnsLock() && isUserCancelReason(this.abortCtrl.signal.reason);
  }

  private stillOwnsLock(): boolean {
    return !this.leaseLost
      && this.abortCtrl.signal.reason !== LEASE_LOST_ABORT_REASON;
  }

  private async reapOwnPendingHands(): Promise<void> {
    if (!this.stillOwnsLock()) {
      logger.warn(
        { sessionId: this.sessionId, taskId: this.request.task_id, lockKey: this.lockKey },
        "hands.reap_pending_skipped_lease_lost",
      );
      return;
    }
    await fx().reapPendingHands(this.sessionId, {
      taskId: this.request.task_id,
      // Asked again on the far side of the reaper's KV read: this check and the
      // teardown are a round trip apart, which is long enough for the heartbeat
      // to notice, and the snapshot that comes back is then the successor's.
      stillOwned: () => this.stillOwnsLock(),
    });
  }

  private async recoverInflightCheckpoint(reason: string): Promise<void> {
    // The destination is the session prefix a delete has just emptied, so this
    // is the same hazard as a late workspace flush, only with a whole snapshot
    // behind it rather than one object. See infra/deleted-sessions.ts.
    if (isSessionDeletedLocally(this.sessionId)) {
      logger.info(
        { sessionId: this.sessionId, reason },
        "s3.recover_skipped_session_deleted",
      );
      return;
    }
    if (!this.inflightCkptHasData) return;
    try {
      const sessionPrefix = `users/${this.userIdForSync}/sessions/${this.sessionId}/`;
      const rec = await fx().copyS3Prefix(this.sessionId, this.inflightCkptPrefix, sessionPrefix);
      if (rec.copied > 0 && this.hands) {
        // The copy has just put an older snapshot over the session prefix, so the
        // sandbox's record of what it last uploaded there is no longer true.
        // Forgetting it makes the next sync upload everything, which is what
        // makes S3 match the workspace again.
        await invalidateSyncManifest(this.hands, sessionPrefix, 5);
      }
      if (rec.copied > 0) {
        await this.onEvent({
          type: "sandboxStatus",
          status: "workspace_sync_recovered",
          reason,
          message: `recovered ${rec.copied} files from checkpoint (failed=${rec.failed})`,
          message_id: this.messageId,
        });
      }
    } catch (re) {
      logger.warn({ err: re, sessionId: this.sessionId }, "s3.recover_failed");
    }
  }

  private async resolvePlatformKey(): Promise<void> {
    if (this.platformKey) return;
    try {
      // Read-through: an old replica in a rolling upgrade writes only the
      // legacy key, and looking at the canonical one alone would lose the
      // platform key this session's sandbox was created with.
      const e = await readHandsEntry(this.kv, this.sessionId);
      if (e) {
        const info = JSON.parse(e.value);
        this.platformKey = info.platformKey || "";
        if (this.platformKey) {
          logger.info({ sessionId: this.sessionId }, "task.platform_key.recovered_from_kv");
        }
      }
    } catch { /* no KV entry — ensureHands will surface a clear error */ }
  }

  /**
   * Write KV checkpoint to the BRAIN_CHECKPOINTS bucket (Plan Y v2 §5.2).
   *
   * Returns whether the write landed. It used to return void and swallow the
   * error, which meant the one failure that actually matters was invisible: a
   * payload over the bucket's 16MiB max_value_size is rejected outright, so the
   * run kept executing while silently losing its ability to resume. Callers now
   * decide what to do, and the failure is surfaced to the session as an event.
   *
   * `workspaceInfo` is populated by the onCheckpoint hook after a successful
   * async workspace_sync; callers that don't track workspace sync leave it
   * undefined → both fields default to "not yet synced".
   */
  private async writeKvCheckpoint(
    state: CheckpointState,
    workspaceInfo?: { has_workspace_sync: boolean; last_sync_turn: number },
    kind: "turn" | "sigterm" | "post_sync" = "turn",
    /** Set on the one re-write issued to undo a lost ordering race; see below. */
    isRepair = false,
  ): Promise<boolean> {
    const seq = ++this.checkpointSeq;
    const envelope: CheckpointEnvelope = {
      session_id: this.sessionId,
      message_id: this.messageId,
      user_id: this.userId,
      has_workspace_sync: workspaceInfo?.has_workspace_sync ?? false,
      last_sync_turn: workspaceInfo?.last_sync_turn ?? 0,
      checkpointed_at: Date.now(),
      turns_completed: state.turns_completed,
      seq,
    };
    const sSerialize = Date.now();
    const encoded = encodeCheckpoint(state, envelope, {
      writeVersion: CHECKPOINT_WRITE_VERSION === 4 ? 4 : 3,
      key: CHECKPOINT_SEAL_KEY,
      redactV3: (s) => redactEgressPayload(s, runtimeSecrets(this.request, this.platformKey)),
    });
    const serializeSec = (Date.now() - sSerialize) / 1000;
    if (CHECKPOINT_WRITE_VERSION === 4) metrics.onCheckpointSeal(serializeSec);
    metrics.onCheckpointVersion("write", CHECKPOINT_WRITE_VERSION);
    const payloadBytes = encoded.length;
    const t0 = Date.now();
    try {
      await this.kvCkpt.put(checkpointKey(this.sessionId, this.messageId), encoded);
      // Checked here rather than before the put, which is where it was and
      // where it could never fire: `seq` is freshly incremented, so it is the
      // largest issued and cannot be below a previously written one. The race
      // it guards against only becomes visible across the await -- a
      // post-workspace-sync rewrite runs in a `.then()` and can complete after
      // a later turn has already landed, putting the older conversation back
      // under the same key. Serializing and writing an already-superseded
      // payload is wasted work but harmless; publishing it as the newest is
      // not, so the ordering is fixed by recording only forward progress and
      // re-writing the newer state.
      if (seq < this.lastWrittenSeq) {
        metrics.onCheckpointSeqRegressed();
        logger.debug(
          { sessionId: this.sessionId, kind, seq, lastWritten: this.lastWrittenSeq },
          "checkpoint.seq_regressed",
        );
        // Bounded to one attempt. The repair issues a fresh, higher seq so it
        // cannot regress against the value it just recorded, but a third
        // writer landing in between could start the cycle again -- and an
        // unbounded repair loop on the awaited turn path is a worse failure
        // than a checkpoint that is one turn stale until the next one lands.
        // The repair's result is the caller's result. Returning true
        // regardless would tell the loop a durable checkpoint exists when the
        // key still holds the older state -- and the loop uses that to decide
        // whether to keep retrying, so a swallowed failure stops the retries
        // as well as losing the write.
        //
        // The repair carries `currentWorkspaceInfo()` rather than this call's
        // `workspaceInfo`, because the state it re-writes is not this call's
        // state. Handing the newest conversation the captured flag of a turn
        // write issued before a sync completed is how a repair used to clear
        // `has_workspace_sync` on a run that had in fact synced, which sends
        // the next attempt to restore from S3 instead of the shared disk.
        //
        // The cache-use overlay is re-applied rather than taken from the
        // snapshot. `latestCheckpointState` is the state the agent loop handed
        // over at the last turn BOUNDARY, and the SIGTERM path deliberately
        // writes a state overlaid with what the run learned after it -- the
        // snapshot it was built from is never written back. A repair landing
        // after that write would otherwise republish the pre-overlay
        // timestamp, undoing the correction and reporting the cache entry as
        // older than the run knows it to be. Same source as the SIGTERM's own
        // overlay, so the two agree by construction.
        if (!isRepair && this.latestCheckpointState) {
          return await this.writeKvCheckpoint(
            overlayCacheUse(
              this.latestCheckpointState, this.latestCacheUseAt, this.cacheUseCleared,
            ),
            this.currentWorkspaceInfo(), kind, true,
          );
        }
        // Either there was no newer state to restore, or this IS the repair
        // and it was itself overtaken before its put landed. Both leave the
        // key holding something other than what this call was asked to
        // persist, so neither may be reported as a write that landed -- the
        // loop uses this to decide whether to keep retrying, and a false
        // success stops the retries as well as losing the write.
        return false;
      }
      this.lastWrittenSeq = seq;
      metrics.onCheckpointWrite(
        kind, "success", (Date.now() - t0) / 1000, payloadBytes, serializeSec,
      );
      return true;
    } catch (e) {
      metrics.onCheckpointWrite(
        kind, "failure", (Date.now() - t0) / 1000, payloadBytes, serializeSec,
      );
      logger.error(
        { err: e, sessionId: this.sessionId, kind, payloadBytes },
        "checkpoint.kv_write_failed",
      );
      // Tell the session, not just the log: from here on the run is not
      // resumable, and payloadBytes is the number needed to tell an oversized
      // payload apart from a transient NATS failure.
      await this.onEvent({
        type: "sandboxStatus",
        status: "checkpoint_write_failed",
        reason: kind,
        payload_bytes: payloadBytes,
        message: `Failed to persist checkpoint (${payloadBytes} bytes); this run cannot be resumed if it is interrupted.`,
        message_id: this.messageId,
      }).catch(() => { /* event emission must not mask the write failure */ });
      return false;
    }
  }

  /**
   * Read KV checkpoint from BRAIN_CHECKPOINTS bucket. Returns null on any of:
   *   - absent / decode error
   *   - schema version != 3 (v1 / v2 / future-unknown are all rejected)
   *   - message_id mismatch (stale checkpoint from a previous user prompt)
   *   - checkpointed_at older than CHECKPOINT_TTL_MS (defence-in-depth on top
   *     of bucket-level max_age; covers brain/NATS clock drift edge cases)
   *   - minimal schema sanity (messages: array, turns_completed: number) —
   *     guards against upstream bugs / manual KV patches that wrote a payload
   *     parseable as JSON but semantically broken (Plan Y v2 §5.2)
   */
  private async readKvCheckpoint(): Promise<TaskCheckpoint | null> {
    const miss = (reason: Parameters<typeof metrics.onCheckpointRead>[0]) => {
      metrics.onCheckpointRead(reason);
      return null;
    };
    try {
      const entry = await this.kvCkpt
        .get(checkpointKey(this.sessionId, this.messageId)).catch(() => null);
      if (!entry) return miss("absent");

      const decoded = decodeCheckpoint(entry.value, CHECKPOINT_SEAL_KEY, {
        sessionId: this.sessionId,
        messageId: this.messageId,
        userId: this.userId,
      });
      if (!decoded.ok) {
        // Every one of these used to be a bare `return null`, which is why a
        // run restarting from turn zero was indistinguishable from one that
        // never had a checkpoint. During a format rollout that difference is
        // the whole signal.
        logger.warn(
          { sessionId: this.sessionId, reason: decoded.reason, version: decoded.version },
          "ckpt.read_rejected",
        );
        return miss(decoded.reason);
      }
      metrics.onCheckpointVersion("read", decoded.version);

      const { envelope, state } = decoded.value;
      // Session, message and user are verified inside decodeCheckpoint against
      // the identity passed above -- on v4 by the AAD itself, so a payload from
      // another run does not decrypt at all. Only the TTL is left, and it is
      // meaningful because checkpointed_at is sealed: outside the seal, anyone
      // able to write the bucket could move an expired checkpoint back into
      // its window.
      if (Date.now() - envelope.checkpointed_at > CHECKPOINT_TTL_MS) return miss("absent");

      metrics.onCheckpointRead("ok");
      return {
        ...state,
        version: 3,
        session_id: envelope.session_id,
        message_id: envelope.message_id,
        user_id: envelope.user_id,
        has_workspace_sync: envelope.has_workspace_sync,
        last_sync_turn: envelope.last_sync_turn,
        checkpointed_at: envelope.checkpointed_at,
      };
    } catch {
      return miss("not_json");
    }
  }

  /**
   * Delete KV checkpoint after successful task completion (or terminal failure).
   * The shared `.claw/workspaces/<sid>/` directory is intentionally NOT removed
   * here; a separate reaper CronJob (see workspace-reaper-design.md) sweeps
   * stale per-session workspace dirs ~7 days after last activity.
   */
  private async deleteKvCheckpoint(): Promise<void> {
    try {
      await this.kvCkpt.delete(checkpointKey(this.sessionId, this.messageId));
    } catch { /* ignore */ }
  }

  /**
   * Called on every task terminal state (success / interrupt / fatal): stop
   * pinging the sandbox, but keep its `hands.<sid>` KV entry as an idle reuse
   * handle (markHandsIdle) instead of deleting it outright, so the next
   * message in this session can reuse the still-warm pod via ensureHands
   * within SANDBOX_IDLE_REUSE_MS. See sandbox/keepalive.ts collectTargets for
   * the idle-skip-ping + expiry side of this.
   */
  private stopKeepaliveAfterTask(): void {
    // The handle is kept for the next message, so the sandbox is still a target
    // the sweep can reconcile back in. Its admission slot stays with it: given
    // up here, the ceiling is handed to another provisioning while this sandbox
    // is still counted, which is the over-cap state reached through ordinary
    // use rather than through a race.
    const keepSlot = { releaseSlot: false };
    if (this.handsIdentity) {
      fx().unregisterSandbox(this.sessionId, this.handsIdentity, keepSlot);
    } else if (this.handsWorkloadId) {
      fx().unregisterSandbox(this.sessionId, { workloadId: this.handsWorkloadId }, keepSlot);
    }
    void this.parkHandsForIdleReuse().then((outcome) => {
      logger.info(
        {
          sessionId: this.sessionId,
          workloadId: this.handsWorkloadId,
          parked: outcome === "parked",
          outcome,
        },
        "keepalive.stopped_after_task",
      );
    });
  }

  /**
   * Put this run's handle back in the idle pool, reporting what the write did.
   *
   * Only the outcome says a park happened: under BRAIN_LAZY_SANDBOX a turn
   * answered from context alone never built a sandbox, and `markHandsIdle`
   * writes nothing for a handle that is gone, still provisioning, or now naming
   * a different sandbox, and can lose its conditional write to a concurrent one.
   */
  private async parkHandsForIdleReuse(): Promise<PostTaskParkOutcome> {
    if (this.handsIdentity) {
      return (await fx().markHandsIdle(this.kv, this.sessionId, this.handsIdentity)).outcome;
    }
    if (this.handsWorkloadId) {
      return (await fx().markHandsIdle(this.kv, this.sessionId, this.handsWorkloadId)).outcome;
    }
    return "no_sandbox";
  }

  /**
   * End the background shells this run started, if nothing will read them again.
   *
   * A DAG node that has reported its result is over: nobody will poll the dev
   * server it left running, and it is holding CPU in a sandbox shared with the
   * rest of the workspace, so its processes go with it. A chat turn is the
   * opposite -- the user is still there, and a shell started this turn is
   * expected to still be running when they ask about it in the next one, which
   * is the reason background shells exist at all.
   *
   * Called only from the paths that mean the run is finished. A SIGTERM
   * checkpoint, a lost lease and a retryable error all mean it will be picked up
   * again, in which case its shells are still its own.
   *
   * Best-effort: the run's result is already reported, and a sandbox that cannot
   * be reached is one whose processes are going away with it anyway.
   *
   * At most one round that succeeded. A path that reaps early -- before reading
   * /workspace for the snapshot -- reaches the release afterwards, where a
   * second round would only ask a sandbox to stop shells it has already
   * stopped. A round that failed is not a round: the shells are still running,
   * and the release is the run's last chance to reach them, so the flag is set
   * where the answer came back rather than where the attempt was made.
   */
  private async reapBackgroundShells(cause?: ReclaimCause): Promise<void> {
    // DAG shells end with the node; conversation shells survive turns and cancellations.
    const isDagNode = !!(this.request.dag_root_task_id || this.request.dag_node_id);
    const reason: ReclaimCause | null = cause ?? (isDagNode ? "dag_node_terminal" : null);
    const hands = this.workHands();
    if (this.shellsReaped || !reason || !hands) return;
    // Names the operation this reap belongs to, so every shell it ends is
    // attributable to one decision rather than to a class of them.
    const reclaimOp = `${this.request.task_id ?? this.sessionId}:${reason}`;
    try {
      const report = await hands.reapShells(reason, reclaimOp);
      this.shellsReaped = true;
      if (report.shells.length > 0) {
        // `surviving` is the honest half: a shell that ignored both signals is
        // still running, and reporting the addressed count as stopped is how a
        // run came to be reported finished over work that had not ended.
        const log = report.surviving > 0 ? logger.warn : logger.info;
        log.call(
          logger,
          {
            sessionId: this.sessionId,
            taskId: this.request.task_id,
            cause: reason,
            reclaimOp,
            stopped: report.stopped,
            escalated: report.escalated,
            surviving: report.surviving,
          },
          "task.background_shells_reaped",
        );
      }
    } catch (e) {
      logger.warn(
        { err: (e as Error)?.message ?? e, sessionId: this.sessionId, taskId: this.request.task_id, cause: reason },
        "task.background_shells_reap_failed",
      );
    }
  }

  /**
   * A sandbox is provisioned before the first turn only when the run is about
   * the sandbox: script mode drives a fixed tool sequence with no model in
   * between, a multi-node run exists to get its cluster, and a resumed run whose
   * earlier attempts used a sandbox needs its /workspace back before the model
   * reads its own history. Every other run — the ordinary chat turn, and a
   * resumed run that never used one — gets one the first time a tool actually
   * asks, which for a question answered from the conversation alone never
   * happens. That is the difference between a 20-second pod start on every
   * "what did we decide yesterday?" and none at all.
   *
   * A resumed run that never used a sandbox used to open one here anyway, and an
   * account the platform refuses a sandbox then lost a run that had never needed
   * one: a 30-turn research task, taken over after a rollout, failed on its first
   * step with "You do not have a CPU sandbox workspace yet".
   */
  private needsSandboxUpFront(ckpt: TaskCheckpoint | null): boolean {
    if (!BRAIN_LAZY_SANDBOX) return true;
    if (this.request.mode === "script") return true;
    if (isMultiNodeRequest(this.request)) return true;
    return ckpt !== null && checkpointUsedSandbox(ckpt);
  }

  /**
   * Whether a resumed run whose up-front open failed with `err` can carry on
   * without a sandbox instead of failing: only when the open was up front for
   * the resume alone (not a script or a cluster, which are nothing without it),
   * and only when the platform has said it has no sandbox for this run
   * (SANDBOX_UNAVAILABLE_REASONS). The tools that need one are then told why,
   * as on any lazy run, and the model carries on with the rest.
   */
  private mayResumeWithoutSandbox(err: unknown): boolean {
    return BRAIN_LAZY_SANDBOX
      && this.pendingResumeCkpt !== null
      && this.request.mode !== "script"
      && !isMultiNodeRequest(this.request)
      && sandboxUnavailableOf(err) !== null;
  }

  /**
   * Hand a resumed run's checkpointed conversation to the engine without
   * opening a sandbox. The attach would have done this in `resolveResumeState`;
   * on a run that opens none it has to happen here, or the run starts over from
   * the user's message and its earlier turns are lost.
   */
  private resumeWithoutSandbox(): void {
    const ckpt = this.pendingResumeCkpt;
    if (!ckpt || this.resumeCheckpoint) return;
    this.resumeCheckpoint = ckpt;
    this.resumeHandedOver = true;
    logger.info(
      { sessionId: this.sessionId, messageId: this.messageId, turns: ckpt.turns_completed,
        has_workspace_sync: ckpt.has_workspace_sync },
      "task.resume.without_sandbox",
    );
  }

  /**
   * Announce a started run that has no sandbox yet. The task row still needs
   * its owning brain recorded — the sweeper uses it to tell a run whose brain
   * is gone from one still making progress — but the sandbox workload id is
   * left unset rather than blanked, so attachHands can fill it in later
   * without the two writes fighting (internal-tasks COALESCEs).
   */
  private async startWithoutSandbox(prestarting = false): Promise<void> {
    logger.info(
      { sessionId: this.sessionId, messageId: this.messageId, prestarting },
      "task.sandbox_deferred",
    );
    await this.onEvent({ type: "statusUpdate", agentStatus: "running" });
    // A run starting used to be the same statement as a sandbox existing, and
    // a client with no way to tell them apart would now enable a terminal or
    // a file browser against a sandbox that has not been created and may
    // never be. Said explicitly so the two can be distinguished: `deferred`
    // is followed by `ready` if and when a tool asks for one, and by nothing
    // at all for a turn that only talks.
    // A prestarted run says so, because what follows `deferred` differs: `ready`
    // once the sandbox is up, whether or not a tool ever asks for it.
    await this.onEvent({
      type: "sandboxStatus",
      status: "deferred",
      ...(prestarting
        ? { reason: "opening_ahead", message: "this turn is opening a sandbox beside its first model call" }
        : { reason: "no_tool_called_yet", message: "this turn has not opened a sandbox; one opens on the first tool call" }),
      message_id: this.messageId,
    }).catch(() => { /* a status event must not fail the run */ });
    await fx().postTaskRunning(this.request, { brainId: BRAIN_ID, attempt: this.attempt });
  }

  /**
   * Open the sandbox for this run, at most once. Called up front for the runs
   * that need one from the start, and from inside the agent loop for the rest,
   * where several tool calls can race for it — hence the shared promise rather
   * than a plain `if (!this.hands)`. A failure is not cached: the tool that
   * triggered it reports the error, and a later tool gets a fresh attempt --
   * except a failure that says the platform has no sandbox for this run
   * (SANDBOX_UNAVAILABLE_REASONS), which is: see `sandboxUnavailable`.
   */
  private readonly attachHands = (): Promise<HandsClient> => {
    this.sandboxClaimed = true;
    return this.openOnce();
  };

  /**
   * The open behind `attachHands`, shared with `prestartSandbox`, which opens the
   * sandbox without asking for it. `prestart` is passed only by that one: it can
   * give the open up, and is never fired once anything has asked.
   */
  private openOnce(prestart?: AbortController): Promise<HandsClient> {
    if (this.sandboxUnavailable) return Promise.reject(this.sandboxUnavailable);
    // The in-flight attach is consulted before the assigned client, because
    // openSandbox assigns `this.hands` and only then restores /workspace from
    // S3. A caller that read the field would be handed a sandbox whose files
    // rsync is still rewriting underneath it.
    if (this.handsAttach) return this.handsAttach;
    if (this.hands) return Promise.resolve(this.hands);
    // Cleared once it settles, which is both how the failure above stops being
    // cached and how a rebuild is not undone: `recreateHands` replaces
    // `this.hands` without coming through here, so a retained promise would keep
    // handing out the sandbox the rebuild has already destroyed.
    this.handsAttach = this.openSandbox(prestart).catch(async (err: unknown) => {
      await this.settleUnavailableOpen(err);
      throw err;
    }).finally(() => {
      this.handsAttach = null;
    });
    return this.handsAttach;
  }

  /**
   * The sandbox as this run's own work sees it: null until something in the run
   * has asked for it (`sandboxClaimed`). A sandbox opened ahead of time and never
   * used holds none of the run's files or shells, so the paths that save or stop
   * them -- the workspace syncs and the shell reap -- skip it, as they skip a lazy
   * run that opened none. The release at the end still finds it, through the
   * identity the open recorded, and parks it like any other.
   */
  private workHands(): HandsClient | null {
    return this.sandboxClaimed ? this.hands : null;
  }

  /**
   * Start opening the sandbox now, beside the first model call, rather than on the
   * first tool call that asks for it.
   *
   * Only for a run the API marked as one that will use it (`wantsSandboxPrestart`)
   * and that would otherwise open it lazily: an up-front run has opened it already.
   * It is the same open a tool would start -- the one `attachHands` hands out -- so
   * a tool that asks while it is in flight waits for it rather than starting a
   * second, and a failure is not cached: it is logged here, and the next tool that
   * asks gets a fresh attempt, exactly as after a tool's own failed open. A failure
   * that says the platform has no sandbox for this run is latched as always
   * (`settleUnavailableOpen`), and the tools that ask later are told that.
   *
   * A run that ends without asking gives it back in `retireUnclaimedPrestart`.
   */
  private prestartSandbox(): void {
    const abort = new AbortController();
    logger.info({ sessionId: this.sessionId, messageId: this.messageId }, "task.sandbox_prestart");
    const settled = this.openOnce(abort).then(
      () => undefined,
      (err: unknown) => {
        logger.warn(
          { err: (err as Error)?.message ?? String(err), sessionId: this.sessionId,
            messageId: this.messageId, claimed: this.sandboxClaimed },
          "task.sandbox_prestart_failed",
        );
      },
    );
    this.prestart = { abort, settled };
  }

  /**
   * Settle a prestarted open that nothing in the run asked for, before the run's
   * ending reads any sandbox state.
   *
   * Called once the engine has returned or thrown, so nothing will ask any more.
   * A run whose engine did ask has an ordinary attached sandbox and nothing here
   * applies. Otherwise the open is given up where it can be -- the wait for the
   * workload to be scheduled and become ready, and a reuse probe -- and waited for
   * where it cannot, so the run's ending sees one of two states and never a third
   * in which a sandbox comes up after it:
   *
   *   - the open finished: the sandbox is this run's, with nothing of the run's in
   *     it. The release parks it for the session's next message, as it parks any
   *     run's, and the idle reclaim ends it if no message comes.
   *   - the open did not: the workload it was creating has been stopped (the wait
   *     reclaims what it created when it is given up), and its PENDING entry is
   *     reaped here -- the same reap a failed run makes, gated the same way.
   *
   * An abort of the run itself (a cancel, a restart, a successor taking over, a
   * deadline) has already reached the open through its signal, with the reclaim
   * rule that abort carries, so the open is only waited for then: a restart's
   * PENDING workload is the successor's to adopt, not this run's to reap.
   *
   * Never throws: it runs ahead of the run's own ending, which must not be
   * replaced by a failure to clean up after a sandbox the run never used.
   */
  private async retireUnclaimedPrestart(): Promise<void> {
    const prestart = this.prestart;
    if (!prestart || this.sandboxClaimed) return;
    this.prestart = null;
    try {
      const runAborted = this.abortCtrl.signal.aborted;
      if (!runAborted) prestart.abort.abort(PRESTART_UNUSED_REASON);
      await prestart.settled;
      logger.info(
        { sessionId: this.sessionId, messageId: this.messageId, opened: this.hands !== null,
          workloadId: this.handsWorkloadId, runAborted },
        "task.sandbox_prestart_unused",
      );
      if (!this.hands && !runAborted) await this.reapOwnPendingHands();
    } catch (e) {
      logger.warn({ err: e, sessionId: this.sessionId }, "task.sandbox_prestart_retire_failed");
    }
  }

  /**
   * An open that ended because the platform cannot give this run a sandbox: stop
   * offering it another, and clean up the one it left behind.
   *
   * The latch is set before anything awaited, so a tool call racing this one
   * cannot slip in a second provision while the clean-up runs.
   *
   * The clean-up is the failure path's own, in its own order -- the platform's
   * account, the handle onto the row, then the reap -- run here because a failed
   * open is not always the end of the run. Opened lazily, which is the default
   * for a chat turn, the failure is a tool error the model reads and the run
   * carries on, so the failure path never comes and nothing would reap the
   * workload (the next open's stale-entry check used to, which the latch now
   * stops from happening). Run on the eager path as well it does what that path
   * would have done a moment later, and the failure path finds nothing left to
   * redo.
   *
   * The platform is not asked about an unschedulable workload: it never ran,
   * the provider has already stopped it, and what the platform would then say of
   * it is our own stop.
   */
  private async settleUnavailableOpen(err: unknown): Promise<void> {
    const unavailable = sandboxUnavailableOf(err);
    if (!unavailable) return;
    this.sandboxUnavailable = err;
    logger.warn(
      { sessionId: this.sessionId, messageId: this.messageId, reason: unavailable.reason },
      "task.sandbox_unavailable_latched",
    );
    try {
      if (unavailable.reason !== "sandbox_unschedulable") await this.capturePlatformFacts();
      await this.recordSandboxBeforeReap();
      await this.reapOwnPendingHands();
    } catch (e) {
      logger.warn({ err: e, sessionId: this.sessionId }, "task.sandbox_unavailable_cleanup_failed");
    }
  }

  private async openSandbox(prestart?: AbortController): Promise<HandsClient> {
    // Multi-node: provision the GPU cluster before the Hands sandbox, via
    // whichever mechanism the deploy mode dictates (see multi-node/factory.ts).
    if (isMultiNodeRequest(this.request) && !this.multiNodeContext) {
      const provider = getMultiNodeProvider();
      logger.info(
        { sessionId: this.sessionId, messageId: this.messageId, provider: provider.kind },
        "task.rayjob_ensuring",
      );
      this.multiNodeContext = await provider.ensure(
        this.sessionId,
        this.request,
        this.onEvent,
        { deliveryCount: this.msg.info.deliveryCount, platformKey: this.platformKey, signal: this.abortCtrl.signal,
          reclaimOnAbort: () => this.abortReclaimsSandbox() },
      );
    }

    // Ensure Hands sandbox (GPU custom image when sandbox_image is specified).
    logger.info({ sessionId: this.sessionId, messageId: this.messageId }, "task.sandbox_ensuring");
    // Before the call, not after it: the PENDING entry this marks the run as
    // eligible for is written from inside it.
    //
    // A latch now, not a threshold. It used to keep the EARLIEST ask, because
    // `pendingHandsIdentity` compared the entry's `createdAt` against it and
    // re-stamping would have moved the floor past an entry this very run had
    // created. That comparison is gone -- it was two processes' clocks, and a
    // replica five seconds fast was enough to adopt a previous attempt's
    // workload -- so the only thing read here is whether this run asked at all.
    // `runRebuild` sets it too, which is now the same statement rather than a
    // deliberate re-stamp.
    this.sandboxAsked = true;
    // A prestarted open can also be given up on its own (`retireUnclaimedPrestart`).
    // The run's signal carries no abort reason then, which `abortReclaimsSandbox`
    // reads as a cancel: what the wait was creating is reclaimed while the run still
    // holds its lock, since nobody else will adopt a sandbox the run never used.
    const { handsUrl, created, token: handsToken, identity } = await fx().ensureHands(
      this.sessionId, this.request, this.platformKey, this.onEvent, this.multiNodeContext ?? undefined,
      { signal: prestart ? AbortSignal.any([this.abortCtrl.signal, prestart.signal]) : this.abortCtrl.signal,
        reclaimOnAbort: () => this.abortReclaimsSandbox(),
        attemptId: this.attempt.attemptId },
    );
    logger.info({ sessionId: this.sessionId, messageId: this.messageId, created, handsUrl }, "task.sandbox_ready");
    this.handsUrl = handsUrl;
    this.handsToken = handsToken;
    this.handsIdentity = identity ?? null;
    this.handsWorkloadId = identity?.workloadId ?? "";

    // The sandbox exists and the engine is about to start, which is the first
    // moment the row is genuinely running rather than being set up. Reported
    // separately from the session event because that one reaches
    // `claw_sessions.agent_status` and this one has to reach the task row,
    // which the session event carries no identifier for. On the deferred path
    // the run already announced itself; this write adds the workload id.
    await this.onEvent({ type: "statusUpdate", agentStatus: "running" });
    await fx().postTaskRunning(this.request, {
      brainId: BRAIN_ID,
      sandboxWorkloadId: this.handsWorkloadId,
      attempt: this.attempt,
    });
    this.hands = fx().makeHandsClient(
      handsUrl, handsToken, this.handsOwner, this.runId, this.request.deadline_at, this.shellRun,
    );
    // ensureHands returns only after bootstrap and the health check, so this
    // is the first moment a sandbox can actually be used -- unlike the
    // provider's own `running`, which fires when the pod is scheduled. The
    // url is not in the payload: it is an internal address, and a client
    // needs to know that a sandbox exists, not how to reach it.
    await this.onEvent({
      type: "sandboxStatus",
      status: "ready",
      reason: created ? "created" : "reused",
      message_id: this.messageId,
    }).catch(() => { /* a status event must not fail the run */ });

    await this.resolveResumeState(this.pendingResumeCkpt, created);
    // Only a sandbox restored from S3 has the files the user uploaded while it
    // was up: one reused, or refilled from the shared filesystem, is given them.
    if (!created || this.resumeMode === "workspace_restore") {
      try { await fx().syncUploadsFromS3(this.hands, this.sessionId, this.userId); } catch (e) {
        logger.warn({ err: e, sessionId: this.sessionId }, "s3.uploads_sync_failed");
      }
    }
    return this.hands;
  }

  /**
   * Settle the background starts a previous attempt committed to and never
   * confirmed, before this one issues anything.
   *
   * A crash between the durable dispatched write and the transport handoff
   * leaves a commitment for a request that may never have gone out. Left to the
   * dispatch path it is closed only if the model happens to re-emit that exact
   * call; and left to the sandbox attach it is not reached at all by the run
   * that most needs it -- a redelivery with no checkpoint, which opens a sandbox
   * only if some tool asks for one.
   *
   * A failure is logged, not raised: nothing here is a precondition for running,
   * and an unsettled row still answers every replay fail-closed.
   */
  private async reconcileBackgroundStarts(): Promise<void> {
    // Not gated on the feature flag: rows written before it was turned off are
    // still commitments, and nothing else would ever settle them.
    if (this.msg.info.deliveryCount <= 1 && !this.pendingResumeCkpt) return;
    try {
      const client = await this.reconcilingClient();
      if (!client) return;
      this.reportOutstandingStarts(await client.reconcileOutstandingStarts());
    } catch (err) {
      logger.warn(
        { err, sessionId: this.sessionId, runId: this.runId },
        "task.bg_starts_reconcile_failed",
      );
    }
  }

  /**
   * The client to reconcile against, without provisioning one.
   *
   * A run that has not attached is not a run with no sandbox: the binding of
   * the one its predecessor used is still in the registry, and it is the
   * generation the outstanding rows name. Provisioning here instead would open
   * a pod for a turn that may never need one, and against a *new* generation,
   * which resolves every outstanding row to unknown by construction.
   */
  private async reconcilingClient(): Promise<HandsClient | null> {
    if (this.hands) return this.hands;
    const entry = await readHandsEntry(this.kv, this.sessionId).catch(() => null);
    if (!entry) return null;
    const info = JSON.parse(entry.value) as { handsUrl?: unknown; token?: unknown; platformKey?: unknown };
    if (typeof info.handsUrl !== "string" || !info.handsUrl) return null;
    rememberRouterCredential(info.handsUrl, info.platformKey);
    // Not closed afterwards: the reconciliation reads two plain HTTP routes and
    // never opens the MCP transport, so there is nothing holding a connection.
    return fx().makeHandsClient(
      info.handsUrl, typeof info.token === "string" ? info.token : "",
      this.handsOwner, this.runId, this.request.deadline_at, this.shellRun,
    );
  }

  /**
   * Tell the resumed conversation which of its background starts did not
   * finish, so the model can decide rather than discover.
   *
   * Releasing a commitment on positive evidence that nothing ran is what stops
   * the request being stranded, but on its own it is a deletion the model never
   * hears about: the call simply never happens unless the same tool use is
   * re-emitted by chance.
   */
  private reportOutstandingStarts(settled: OutstandingReconciliation): void {
    if (!settled.released.length && !settled.unresolved.length) return;
    logger.warn(
      { sessionId: this.sessionId, runId: this.runId, ...settled },
      "task.bg_starts_unfinished",
    );
    const hint = buildOutstandingStartHint(settled);
    if (!hint || !this.resumeCheckpoint) return;
    const already = this.resumeCheckpoint.messages.some(
      (m) => m.role === "user" && m.content === hint.content,
    );
    if (already) return;
    this.resumeCheckpoint.messages = [...this.resumeCheckpoint.messages, hint];
  }

  /**
   * Resume classification counters (§12.1.2), recorded exactly once per run by
   * whichever path reaches them first: the sandbox attach, or the end of a run
   * that never attached one. `hit` means KV held a usable v3 checkpoint;
   * miss_first_delivery and miss_redelivery split by deliveryCount so
   * dashboards can tell an expected turn-0 miss from a surprising one.
   */
  private recordResumeMetrics(
    ckpt: TaskCheckpoint | null,
    probe: "alive" | "alive_no_kv" | "dead" | "no_hands",
  ): void {
    if (this.resumeMetricsRecorded) return;
    this.resumeMetricsRecorded = true;
    metrics.onCheckpointResume(
      ckpt ? "hit" : this.msg.info.deliveryCount > 1 ? "miss_redelivery" : "miss_first_delivery",
    );
    metrics.onTaskRedelivery(ckpt ? "true" : "false");
    metrics.onResumeWorkspaceMode(this.resumeMode);
    metrics.onSandboxProbe(probe);
  }

  /**
   * Refuse the shared-filesystem snapshot of a sandbox whose restore failed.
   *
   * That snapshot is what the next sandbox of the session is filled from, by a
   * restore that succeeds and so leaves the new sandbox unheld: an incomplete
   * /workspace written there would come back as a whole one, and that sandbox's
   * S3 saves would prune what it lacks. Refused, the snapshot stays the last one
   * a whole workspace wrote (or none, and the next sandbox restores from S3); a
   * SIGTERM falls back to the S3 save, which a held sandbox makes add-only.
   */
  private async refuseSharedSyncIfHeld(hands: HandsClient): Promise<void> {
    // A sandbox that cannot say is not refused here: the snapshot is a command it
    // runs, which a sandbox that cannot answer this one will not run either.
    if (await isRestoreHeld(hands, this.sessionId, { unknownIsHeld: false })) {
      throw new Error("workspace_sync_held: this sandbox's restore failed, so its /workspace is not the session's");
    }
  }

  /**
   * Fill a new sandbox's /workspace from the session's S3 prefix, and say so
   * when it could not be filled.
   *
   * A failure does not end the run: the turn goes on in the workspace it has.
   * But it is not silent either. The user is told, as a `sandboxStatus`
   * `workspace_restore_failed` event, that /workspace is missing files the
   * session saved; and `syncWorkspaceFromS3` has already held the sandbox, so
   * the saves that follow keep every saved file instead of deleting the ones the
   * restore did not bring back, or replacing them with what the new sandbox
   * started with (`holdAfterFailedRestore`). Never throws.
   */
  private async restoreWorkspaceFromS3(
    hands: HandsClient, userId: string, site: "new_sandbox" | "resume_fallback" | "after_rebuild",
  ): Promise<void> {
    logger.info({ sessionId: this.sessionId, site }, "s3.restore_start");
    try {
      await fx().syncWorkspaceFromS3(hands, this.sessionId, userId);
      metrics.onWorkspaceRestore("ok");
      logger.info({ sessionId: this.sessionId, site }, "s3.restore_done");
    } catch (e) {
      const errMsg = (e as { message?: string })?.message
        ? String((e as { message: string }).message).slice(0, 500)
        : String(e);
      const reason = workspaceTransferFailureReason(e, errMsg);
      // The user is told what went wrong, never where: a sandbox's address is
      // internal and a presigned URL is a credential.
      const shown = withoutAddresses(errMsg);
      metrics.onWorkspaceRestore("failed");
      logger.warn({ err: e, sessionId: this.sessionId, site, reason }, "s3.restore_failed");
      await this.onEvent({
        type: "sandboxStatus",
        status: "workspace_restore_failed",
        reason,
        message: "The saved workspace could not be restored, so /workspace is missing files this session saved "
          + `(${shown}). The saved copy is kept as it was: saves from this sandbox add new files to it `
          + "and do not delete or replace any.",
        message_id: this.messageId,
      }).catch((err: unknown) => {
        logger.warn({ err, sessionId: this.sessionId }, "s3.restore_failed_event_failed");
      });
    }
  }

  /**
   * Plan Y v2 resume path has three modes (checkpoint-architecture-redesign
   * §5.6): sandbox_reuse (ensureHands returned created=false — KV hit +
   * /health pass — so /workspace is already intact), workspace_restore
   * (sandbox was rebuilt but ckpt.has_workspace_sync=true, so rsync
   * .claw/workspaces/<sid>/current/ back into /workspace), and
   * no_data_turn0 (sandbox rebuilt with no prior workspace_sync, so
   * /workspace starts empty). `created=false` alone is a sufficient
   * liveness signal since ensureHands already ran the /health probe.
   *
   * The legacy syncWorkspaceFromS3 baseline restore remains a fall-through
   * for dev-path sessions (no hex user id) or a failed workspace restore.
   */
  private async resolveResumeState(ckpt: TaskCheckpoint | null, created: boolean): Promise<void> {
    // A script run taken over part-way is continued in the sandbox it was
    // running in, because that is where its earlier steps' work is -- a
    // background job still running, files a later step reads. A new sandbox
    // has none of it, so carrying on there would report the steps after it as
    // done over work that never happened. That is the one case in which the run
    // is lost, and it fails saying so.
    if (ckpt?.script && created) {
      throw new Error(
        `script_sandbox_lost: the sandbox this script was running in is gone, so it cannot `
        + `continue from step ${ckpt.script.step}; its earlier steps' work went with the sandbox`,
      );
    }
    // A sandbox just created starts with nothing held, whatever address it was
    // given: pod IPs are reused, and a hold this process kept for an earlier
    // sandbox of this session at the same address is not this one's. Released
    // here, after the one way out above that restores nothing, and before every
    // route below -- each of which restores into the new sandbox, the
    // shared-filesystem one included, which never reaches the S3 restore's own
    // release -- so the sandbox is held again exactly when its own restore fails.
    if (created && this.hands) releaseRestoreHold(this.hands, this.sessionId);
    if (!ckpt) {
      // No prior progress: still run S3 baseline restore for new sandboxes
      // so any pre-Plan-Y persisted workspace materializes back into
      // /workspace (legacy chat sessions, dev mode).
      if (created) {
        await this.restoreWorkspaceFromS3(this.hands!, this.userId, "new_sandbox");
      }
      this.resumeMode = "skip_no_ckpt";
    } else if (!created) {
      // Sandbox still alive: KV ckpt restores conversation state; /workspace
      // is already in place from the live sandbox itself. Most common
      // resume path under normal SIGTERM redelivery (≤ 10 min ack_wait,
      // sandbox idle GC at ~15 min).
      if (!this.resumeHandedOver) this.resumeCheckpoint = ckpt;
      this.resumeMode = "sandbox_reuse";
      logger.info(
        { sessionId: this.sessionId, turns: ckpt.turns_completed,
          has_workspace_sync: ckpt.has_workspace_sync },
        "task.resume.sandbox_alive",
      );
    } else {
      // Sandbox was rebuilt. Try Plan Y v2 shared-filesystem restore first (only
      // safe when we have a hex user id AND the prior brain marked
      // has_workspace_sync). Fall through to S3 baseline restore on any
      // failure so the user still gets the best workspace we have.
      if (!this.resumeHandedOver) this.resumeCheckpoint = ckpt;
      let restored = false;
      if (WORKSPACE_PERSIST_BASE && this.userIdHex && ckpt.has_workspace_sync) {
        const restoreCtl = new AbortController();
        const restoreTimer = setTimeout(
          () => restoreCtl.abort(new Error("workspace_restore_timeout")),
          WORKSPACE_RESTORE_TIMEOUT_MS,
        );
        try {
          const r = await fx().restoreWorkspace(
            this.hands!, this.sessionId, this.userIdHex, { signal: restoreCtl.signal },
          );
          restored = true;
          this.resumeMode = "workspace_restore";
          logger.info(
            { sessionId: this.sessionId, turns: ckpt.turns_completed, sizeBytes: r.size,
              lastSyncTurn: ckpt.last_sync_turn },
            "task.resume.workspace_restored",
          );
        } catch (e) {
          logger.warn(
            { err: e, sessionId: this.sessionId, hasWorkspaceSync: ckpt.has_workspace_sync },
            "task.resume.workspace_restore_failed",
          );
        } finally {
          clearTimeout(restoreTimer);
        }
      }
      if (!restored) {
        // Either no workspace_sync to restore from, or restore failed.
        // Fall back to the legacy S3 baseline restore (best-effort).
        await this.restoreWorkspaceFromS3(this.hands!, this.userId, "resume_fallback");
        this.resumeMode = "no_data_turn0";
      }
    }
    logger.info({ sessionId: this.sessionId, resumeMode: this.resumeMode }, "task.resume.mode");
    // sandboxProbe (§12.1.2 four-value enum): "dead" when ensureHands had to
    // rebuild, "alive" for the common reused+checkpointed case, "alive_no_kv"
    // for the rare sandbox-up-but-checkpoint-missing corner case (KV TTL
    // expiry / manual purge / wider KV pruning on rollout), and "no_hands"
    // defensively for the unreachable no-hands-client case.
    this.recordResumeMetrics(
      ckpt,
      !this.hands ? "no_hands" : created ? "dead" : ckpt ? "alive" : "alive_no_kv",
    );

    // Plan Y v2 §5.6: derive the resume outcome (hint message + toast
    // reason) from the same classifier so the two are guaranteed to
    // agree on what happened. The hint is appended to resumeFrom.messages
    // (role="user" + "[system-notice]:" prefix; Anthropic API rejects
    // role="system" inside the messages array — NP0-1), and the toast
    // reason flows out as a sandboxStatus event the api/event-consumer
    // forwards to the frontend. agent-loop.filterResumeNotices keeps
    // the last 3 such hints before each LLM call (NP1-2) so a long-
    // running session does not accumulate hint pollution.
    const tail = this.resumeCheckpoint?.messages?.[this.resumeCheckpoint.messages.length - 1];
    const isPartialAssistantTail = !!tail
      && tail.role === "assistant"
      && Array.isArray(tail.content)
      && tail.content.some(
        (c: unknown) =>
          typeof c === "object" && c !== null
          && (c as { type?: string; _partial?: boolean }).type === "text"
          && (c as { _partial?: boolean })._partial === true,
      );
    const resumeOutcome = classifyResumeOutcome(
      this.resumeMode, ckpt, isPartialAssistantTail, this.msg.info.deliveryCount,
    );
    // Not on a conversation already handed to the engine: it is the loop's now.
    if (resumeOutcome.hint && this.resumeCheckpoint && !this.resumeHandedOver) {
      // By content, not by the prefix: other notices share it -- an unfinished
      // background start says so through the same channel -- and matching the
      // prefix would let one of those suppress this one on the next resume.
      const alreadyInjected = this.resumeCheckpoint.messages.some(
        (m) => m.role === "user" && m.content === resumeOutcome.hint!.content,
      );
      if (!alreadyInjected) {
        this.resumeCheckpoint.messages = [
          ...this.resumeCheckpoint.messages,
          resumeOutcome.hint,
        ];
        logger.info({ sessionId: this.sessionId, resumeMode: this.resumeMode }, "task.resume.notice_injected");
      }
    }
    if (resumeOutcome.toastReason) {
      await this.onEvent({
        type: "sandboxStatus",
        reason: resumeOutcome.toastReason,
        from_turn: ckpt?.turns_completed ?? 0,
        delivery_count: this.msg.info.deliveryCount,
      }).catch((e) =>
        logger.warn({ err: e, sessionId: this.sessionId }, "task.resume.toast_emit_failed"),
      );
    }
  }

  // ── In-flight workspace checkpoint ─────────────────────────────────
  // Long-running tasks (≥30 min) periodically snapshot /workspace into a
  // checkpoint prefix outside the live session prefix while exec is still
  // running. Keeping the checkpoint outside `users/<u>/sessions/<sid>/`
  // prevents normal restore/list/archive paths from rehydrating checkpoint
  // files into `/workspace/_inflight_ckpt` and recursively re-uploading
  // them. If the post-exec main sync fails (sandbox GC, 413, ...), recovery
  // server-side copies this prefix back to the session prefix so the user
  // does not lose all artifacts. Short tasks never trigger (first fire is
  // 30 min after start).
  private startInflightCheckpointTimer(): ReturnType<typeof setInterval> {
    const CHECKPOINT_INTERVAL_MS = 30 * 60 * 1000;
    return setInterval(() => {
      if (this.inflightCkptInProgress || this.abortCtrl.signal.aborted) return;
      // A throwaway workspace has nothing for this to protect. The checkpoint
      // exists so a failed terminal sync does not lose the run's artifacts, and
      // this run publishes none -- so the only thing it would do is repeat the
      // upload the flag was set to avoid, every half hour, for runs measured in
      // days. Skipped rather than gated at the terminal, so nothing is written
      // and there is correspondingly nothing for the recovery copy to find.
      if (this.request.workspace_throwaway === true) return;
      // Capture the current hands client; recreateHands may swap `hands`
      // mid-run after a sandbox rebuild, but for this checkpoint we want
      // the live reference that exists at fire time.
      const currentHands = this.workHands();
      if (!currentHands) return;
      this.inflightCkptInProgress = true;
      // Fire-and-forget: never block the agent loop on checkpoint sync.
      void (async () => {
        try {
          const r = await fx().syncWorkspaceToS3(currentHands, this.sessionId, this.userIdForSync, {
            s3PrefixOverride: this.inflightCkptPrefix,
          });
          if (syncLeftSnapshot(r)) this.inflightCkptHasData = true;
          logger.info(
            { sessionId: this.sessionId, uploaded: r.uploaded, total: r.totalFiles, exhausted: r.exhausted },
            "s3.checkpoint.synced",
          );
        } catch (e) {
          logger.warn({ err: e, sessionId: this.sessionId }, "s3.checkpoint.failed");
        } finally {
          this.inflightCkptInProgress = false;
        }
      })();
    }, CHECKPOINT_INTERVAL_MS);
  }

  private async executeEngine(): Promise<ExecuteResult> {
    logger.info({ sessionId: this.sessionId, messageId: this.messageId, mode: this.request.mode ?? "llm" }, "task.engine_execute_start");
    const checkpointTimer = this.startInflightCheckpointTimer();
    let result: ExecuteResult;
    try {
      if (this.request.mode === "app") {
        // executeRun hands app runs to the AppRunner before this point; keep
        // the engine from ever treating an app task as a chat turn.
        throw new Error("an app run reached the chat engine");
      }
      if (this.request.mode === "script") {
        // mode=script: predefined tool sequence, no LLM (task-design.md §7.3).
        // AgentHook fire(...) is wired by the engine layer; the hooks runtime
        // lives behind agent-loop, so pass undefined here to avoid dragging
        // it into the script-mode path.
        result = await fx().runScript(this.request, {
          hands: this.hands!,
          signal: this.abortCtrl.signal,
          resume: this.resumeCheckpoint?.script,
          onProgress: this.onScriptProgress,
        }, this.onEvent);
      } else {
        result = await this.engine.execute(this.request, this.onEvent, this.abortCtrl.signal, this.workHands(), {
          recreateHands: this.recreateHands,
          onCheckpoint: this.onCheckpoint,
          onTurnJournal: this.onTurnJournal,
          onCacheUse: this.onCacheUse,
          resumeCheckpoint: this.resumeCheckpoint,
          attachHands: this.attachHands,
          runIdentity: this.runIdentity,
          natsConnection: getDeps().emitter.nc,
          onTurnPool: (pool) => { this.turnPool = pool; },
        });
      }
    } finally {
      clearInterval(checkpointTimer);
      // Briefly wait for an in-flight checkpoint to settle so it does not
      // race with hands.close(). 5s is generous — a checkpoint that's still
      // running after that is almost certainly stuck on a dying sandbox and
      // hands.close() / GC will tear it down anyway.
      const settleStart = Date.now();
      while (this.inflightCkptInProgress && Date.now() - settleStart < 5_000) {
        await sleep(100);
      }
      // A run that never opened a sandbox still owes its resume classification;
      // resolveResumeState, which normally reports it, only runs on attach.
      this.recordResumeMetrics(this.pendingResumeCkpt, "no_hands");
      await this.hands?.close().catch(() => {});
    }
    logger.info({ sessionId: this.sessionId, messageId: this.messageId, turns: result.turns, elapsedMs: result.elapsedMs }, "task.engine_execute_done");
    return result;
  }

  /** Release the message-scoped cluster. */
  private async teardownRayJob(): Promise<void> {
    if (!isMultiNodeRequest(this.request)) return;
    // The same rule the sandbox teardown follows, and it has to be here too:
    // the cluster is addressed by messageId, and a successor that took this
    // run over ADOPTS it under that same id. So a terminal handler that has
    // already been told its sandbox is not its to stop would go on to delete
    // the GPU cluster the successor is now running on -- which is what
    // happened: `hands.destroy_skipped_not_owned` followed by
    // `DELETE /api/v1/workloads/M` against a Running, adopted cluster.
    if (!this.stillOwnsLock()) {
      logger.warn(
        { sessionId: this.sessionId, messageId: this.messageId, taskId: this.request.task_id },
        "task.cluster_release_skipped_not_owned",
      );
      return;
    }
    // Where ensure created the cluster; failing that, where it would have (a run that
    // failed before the context existed still owes the release), by the same rule.
    const namespace = this.multiNodeContext?.namespace ?? gpuWorkspaceFor(this.request.workspace_id);
    if (!namespace || !this.messageId) return;
    // A deployment without SaFE has no cluster to release. Reachable: a prompt
    // carrying multi-node flags is not rejected before it gets here, it just
    // fails to provision, and this still runs on the way out.
    if (!multiNodeAvailable()) return;
    await getMultiNodeProvider()
      .releaseForMessage(this.sessionId, namespace, this.messageId, { platformKey: this.platformKey });
  }

  /**
   * Give back what the run was holding, once its outcome has been reported.
   *
   * The three every terminal path ends with, kept together because the paths
   * that do one and not the others are the ones that leak: an unreleased
   * cluster costs GPUs until the workload's own timeout, a sandbox left
   * registered for keepalive is pinged forever -- which refreshes the
   * platform's lastActivity and so suppresses the idle collector this module
   * relies on -- and a batch node's background shells go on holding CPU in a
   * sandbox nobody is watching.
   *
   * Asked for before the delivery is settled, because settling is the step that
   * can throw: `msg.nak` and `msg.ack` on a connection that is already closing
   * both do, and a drain is also when a terminal handoff to an unreachable
   * backend is likeliest, so the two arrive together. In the other order that
   * throw carries the release away with it and the pod finishes the drain
   * holding a cluster and pinging a sandbox no run is using. Nothing is lost by
   * going first: this touches nothing of the message, and every part swallows
   * its own failures, so there is no order in which it costs the settle.
   *
   * `finalizeSuccess` is the one path that settles first, deliberately, and it
   * could not be reordered anyway: its ack is early so a hot reload cannot
   * repeat a completed execution, and the workspace-sync drain between the two
   * is still using the sandbox this would hand back.
   *
   * The cluster goes first where both have something to give back -- a
   * multi-node request on a batch node, the only case in which neither returns
   * immediately. There the cluster is the expensive one and the reap cannot help
   * it: the shells are in the session's sandbox, which is a different workload
   * from the message's GPU cluster and is deliberately left running for the next
   * message to reuse. So the reap's fifteen-second timeout -- and an unreachable
   * sandbox is the ordinary reason a fatal path is here -- is fifteen seconds of
   * GPUs nobody is using, if it is allowed to go first.
   *
   * A path that has to stop the shells earlier still may: `finalizeSuccess`
   * does, so that its snapshot is not read from underneath a process still
   * writing, and when that round succeeded `reapBackgroundShells` has nothing
   * left to ask for. A round that failed is not a round, and then this is the
   * run's last chance to reach them.
   */
  private async releaseAfterTerminal(): Promise<void> {
    await this.releaseStep("rayjob", () => this.teardownRayJob());
    await this.releaseStep("background_shells", () => this.reapBackgroundShells());
    await this.releaseStep("bg_handle_rows", () => this.dropBackgroundHandleRows());
    await this.releaseStep("keepalive", () => this.stopKeepaliveAfterTask());
  }

  /**
   * Drop this run's background-shell reference rows.
   *
   * Only from here, and only because this path means the run is over: a
   * termination checkpoint, a lost lease or a retryable error all mean the run
   * will be picked up again, and its rows are what stop the resumed attempt
   * executing a command that already ran.
   */
  private async dropBackgroundHandleRows(): Promise<void> {
    const store = bgRowStore();
    if (!store || !this.handsOwner || !this.runId) return;
    const dropped = await deleteRunRows(store, this.handsOwner, this.runId);
    if (dropped) {
      logger.info({ sessionId: this.sessionId, runId: this.runId, dropped }, "task.bg_rows_dropped");
    }
  }

  /**
   * Run one release step, isolated from the others.
   *
   * Each of the three is independently worth doing, and each can fail on its
   * own: the cluster release inspects the request's topology and reaches SaFE,
   * the reap reaches the sandbox. Sharing one failure would hand the ordering a
   * second meaning nobody chose -- whichever release happens to be first
   * deciding whether the rest run at all -- so the order stays free to be about
   * what costs most while it is held.
   *
   * Nothing reaches this catch today: each of the three already swallows its
   * own failures, and the one call that could throw past them --
   * `getMultiNodeProvider` -- is behind the `multiNodeAvailable()` check in
   * `teardownRayJob`. It is here so the day one of them stops doing that -- a
   * fourth step, a provider that throws where it used to log -- the ordering
   * does not quietly acquire a second meaning as a short circuit for the steps
   * behind it. Being unreachable is also why there is no seam for injecting a
   * failing step: the test would have to build the thing this defends against.
   *
   * The step is called inside the try rather than having `.catch()` chained onto
   * its result, so that a step throwing before it returns a promise is isolated
   * too -- a rejection handler on the returned promise never sees that.
   */
  private async releaseStep(step: string, run: () => void | Promise<void>): Promise<void> {
    try {
      await run();
    } catch (e) {
      logger.warn(
        { err: (e as Error)?.message ?? e, step, sessionId: this.sessionId, messageId: this.messageId },
        "task.release_failed",
      );
    }
  }

  /**
   * Tell the session the end-of-turn workspace save is over. Never fails the
   * run: an event the stream refused leaves the listing saying "saving" until the
   * mark goes stale, while a run failed for it would cost the turn.
   */
  private async announceWorkspaceSave(evt: WorkspaceSaveFinishedEvent): Promise<void> {
    await this.onEvent({ ...evt }).catch((e: unknown) => {
      logger.warn({ err: e, sessionId: this.sessionId, phase: evt.phase }, "s3.save_event_failed");
    });
  }

  private async finalizeSuccess(result: ExecuteResult): Promise<void> {
    // 4. Emit stats before completion
    await this.onEvent({
      type: "executionStats",
      token_usage: result.tokenUsage,
      turns: result.turns,
      tool_stats: result.toolStats,
      elapsed_ms: result.elapsedMs,
      error_count: result.errorCount,
    });

    // The turn's end, published before the workspace is saved rather than after.
    //
    // The answer is final the moment the engine returns, and `exec_complete` is
    // what sets the session idle. Saving /workspace below is bounded by nothing
    // but the number of files in it: a review that cloned a large repository
    // uploaded 79,353 files in 62 minutes, and for all of that time the session
    // read `running` with the answer already on screen. Nothing the API does with
    // `exec_complete` reads what the save writes -- deliveries are stored when
    // `deliver_file` answers, skill files travel in the event.
    //
    // The session's next message still waits for the save, but in the API's
    // queue: the completion names the save (`workspace_save_id`), the API holds
    // the queue until that save's `workspaceSave` `finished`, and only then
    // dispatches (api sessions/save-hold.ts). Dispatched at once, it would wait on
    // this run's workspace lock, where its redelivery budget runs out in about an
    // hour. What also still follows the save is the handoff to Backend
    // (`deliverAgentDone`), so a task whose successors read its files is not
    // reported done before they are there.
    //
    // The run may already have stood down: a lost lease, or the lock's
    // self-fence, after which another brain may hold this run. A success
    // published from here would then close the successor's row, so it is not
    // published -- not first, and not on a retry once the stand-down arrives
    // mid-publish. The ending is the stand-down's, as if the abort had been seen
    // before this method was entered.
    if (this.leaseLost) throw LEASE_LOST_ABORT_REASON;
    // Whether the save below will run, on the completion itself: the file
    // listing reads it to say the turn's files are still on their way, and it
    // is stored before the session is set idle, so no read falls between them.
    const hands = this.workHands();
    // Named per save, not per turn: a redelivered turn keeps its message id, and
    // the finish of an earlier attempt's save must not end this one's.
    const saveId = !!hands && this.request.workspace_throwaway !== true ? randomUUID() : undefined;
    const completion: Record<string, unknown> = {
      type: "exec_complete",
      session_id: this.sessionId,
      message_id: this.messageId,
      user_id: this.request.user_id || "default",
      final_text: result.finalText,
      token_usage: result.tokenUsage,
      turns: result.turns,
      failed: false,
      error_count: result.errorCount,
      tool_stats: result.toolStats,
      elapsed_ms: result.elapsedMs,
      skills_used: result.skillsUsed,
      selected_skills: Object.keys(this.request.skills || {}),
      skills_to_save: result.pendingSkills,
      skill_file_mutations: result.pendingSkillFileMutations,
      prompt: this.request.prompt,
      delivery_count: this.msg.info.deliveryCount,
      ...(saveId ? { [WORKSPACE_SAVE_PENDING_FIELD]: WORKSPACE_SAVE_PENDING, [WORKSPACE_SAVE_ID_FIELD]: saveId } : {}),
      ...runIdentity(this.request, this.claimed ? this.attempt.claimCount : undefined),
    };
    const secrets = runtimeSecrets(this.request, this.platformKey);
    const handoff = redactEgressPayload<ExecuteResult>(
      this.withPlatformFacts(result),
      secrets,
    );
    // Recorded before it is published, with the completion itself: a delivery of
    // this run that comes back once the completion may be out finishes the turn
    // (`finishEndedTurn`, which publishes the completion again -- the API takes
    // one per turn) and does not run it again.
    const endedKey = this.messageId ? endedTurnKey(this.sessionId, this.messageId) : null;
    if (endedKey) {
      const runTime = this.coverageReport()?.runTime;
      const ended: EndedTurn = {
        completion: redactEgressPayload<Record<string, unknown>>({ ...completion, message_id: this.messageId }, secrets),
        result: handoff,
        ...(runTime ? { run_time: runTime } : {}),
        ...(saveId ? { save_id: saveId } : {}),
      };
      await this.kvCkpt.put(endedKey, sc.encode(JSON.stringify(ended)));
    }
    await this.onEvent(completion, { stillMine: () => !this.leaseLost }).catch(async (err: unknown) => {
      if (err instanceof EmitStoodDownError) {
        // Refused before it was published: the turn did not end, and the brain
        // that holds the run now must run it, not skip it on this record.
        if (endedKey) await this.kvCkpt.delete(endedKey).catch(() => {});
        throw LEASE_LOST_ABORT_REASON;
      }
      throw err;
    });
    // Nothing from here to the handoff may end the run as a failure: the turn has
    // ended on the session, and a failure is naked and redelivered. A step that
    // throws is logged and the run goes on to its handoff and ack.
    try {
      // Ahead of the upload below, for the runs that reap at all: a process still
      // writing while /workspace is read gets captured half-written, and anything
      // it would have written after the read is lost when it is killed anyway.
      // Stopping it first makes the snapshot the last complete state instead.
      await this.reapBackgroundShells();

      // 5. S3 upload: always sync /workspace so artifacts survive sandbox GC
      //    and syncWorkspaceFromS3 has something to rehydrate on the next
      //    sandbox. Failure is logged AND surfaced as a `sandboxStatus` event
      //    (status=workspace_sync_*) so the user / monitoring can see it —
      //    previously silent `logger.warn` was the root cause of 13% of long
      //    sessions losing their /workspace artifacts despite a successful
      //    `exec_complete`. Task completion still doesn't depend on object-
      //    storage availability (event is informational, not fatal).
      //    The optional per-message immutable archive (claw-<messageId>/) is
      //    gated behind BRAIN_WORKSPACE_SNAPSHOT_ENABLED.
      //    SIGTERM-checkpoint path below uses its own sync into the
      //    checkpoint prefix and is independent of this block.
      //    A run that never attached a sandbox has nothing here to do: no
      //    /workspace to upload and no sandbox GC to outlive. Logged rather than
      //    passed over silently, because "nothing was uploaded" otherwise reads
      //    exactly like an upload that failed.
      let syncOk = false;
      if (!hands) {
        logger.info(
          { sessionId: this.sessionId, messageId: this.messageId },
          "s3.sync_skipped_no_sandbox",
        );
      } else if (this.request.workspace_throwaway === true) {
        // The task declared its workspace throwaway -- it has already delivered
        // its output somewhere of its own -- so this run publishes nothing. The
        // prune is skipped with the upload, on purpose: pruning against a tree we
        // never uploaded would delete the last durable copy of whatever an
        // earlier, non-throwaway run of this session left in S3.
        logger.info(
          { sessionId: this.sessionId, messageId: this.messageId },
          "s3.sync_skipped_workspace_throwaway",
        );
      } else {
        // The turn has already ended on the session (above), saying a save follows,
        // so its files in the object store trail it until this is over. `finished`
        // goes out however the save ends, so the file listing stops saying "saving"
        // (WORKSPACE_SAVE_EVENT).
        let saveOutcome: WorkspaceSaveOutcome = "failed";
        try {
          logger.info({ sessionId: this.sessionId, messageId: this.messageId }, "s3.sync_start");
          let syncedGit: GitReport | undefined;
          try {
            const r = await fx().syncWorkspaceToS3(hands, this.sessionId, this.request.user_id || "default");
            syncOk = !r.exhausted && !r.empty;
            saveOutcome = r.empty ? "empty" : r.exhausted ? "partial" : "synced";
            syncedGit = r.git;
            if (r.empty) {
              await this.onEvent({
                type: "sandboxStatus",
                status: "workspace_sync_empty",
                reason: "empty_workspace",
                message: "no files under /workspace at sync time",
                message_id: this.messageId,
              });
            } else if (r.exhausted) {
              await this.onEvent({
                type: "sandboxStatus",
                status: "workspace_sync_partial",
                reason: "upload_exhausted",
                // Out of what this sync tried to upload: files the last sync that
                // landed already put in S3 are not attempts.
                message: `uploaded=${r.uploaded}/${r.totalFiles - (r.unchanged ?? 0) - (r.withheld ?? 0)}, failed=${r.failedCount}`,
                message_id: this.messageId,
              });
            }
          } catch (e: unknown) {
            const errMsg = (e as { message?: string })?.message
              ? String((e as { message: string }).message).slice(0, 500)
              : String(e);
            const reason = workspaceTransferFailureReason(e, errMsg);
            logger.warn({ err: e, sessionId: this.sessionId }, "s3.sync_failed");
            await this.onEvent({
              type: "sandboxStatus",
              status: "workspace_sync_failed",
              reason,
              message: errMsg,
              message_id: this.messageId,
            });
            // Recovery: if a periodic in-flight checkpoint had been written, copy
            // it server-side back to the session prefix. This is the safety net
            // for long sessions whose sandbox dies right at sync time — we still
            // surface the artifacts captured at the last checkpoint window.
            await this.recoverInflightCheckpoint("from_inflight_checkpoint");
          }
          // Independent of the above: a sync can land and still have left a repository
          // behind. Outside the try on purpose: the upload succeeded, and an event the
          // stream refused must not turn it into the failure above, whose recovery
          // copies an older in-flight checkpoint over the files just uploaded.
          await this.announceGitSkipped(syncedGit).catch((e: unknown) => {
            logger.warn({ err: e, sessionId: this.sessionId }, "s3.git_skipped_event_failed");
          });
          if (BRAIN_WORKSPACE_SNAPSHOT_ENABLED && this.messageId && syncOk) {
            try { await fx().archiveRunToS3(this.sessionId, this.request.user_id || "default", this.messageId); } catch (e) {
              logger.warn({ err: e, sessionId: this.sessionId, messageId: this.messageId }, "s3.archive_failed");
            }
          }
          logger.info({ sessionId: this.sessionId, messageId: this.messageId, syncOk }, "s3.sync_done");
        } finally {
          await this.announceWorkspaceSave({
            type: WORKSPACE_SAVE_EVENT, phase: "finished", outcome: saveOutcome, save_id: saveId, message_id: this.messageId,
          });
        }
      }

      // 5b. Write execution transcript as JSONL to S3
      await fx().flushTranscript(this.sessionId, this.request.user_id || "default", this.messageId, this.transcriptStartedAt, this.transcriptLog, {
        turns: result.turns, elapsedMs: result.elapsedMs,
        tokenUsage: result.tokenUsage, toolStats: result.toolStats, failed: false,
      });
    } catch (e) {
      if (e === LEASE_LOST_ABORT_REASON) throw e;
      logger.error(
        { err: e, sessionId: this.sessionId, messageId: this.messageId },
        "task.after_turn_end_failed",
      );
    }

    // The save is the one long stretch of this method, and the run can stand
    // down during it. The turn's end is already published, and was this run's to
    // publish; the task is not, once another brain may hold it -- reporting it
    // done would close that brain's row. The ending from here is the stand-down's.
    if (this.leaseLost) throw LEASE_LOST_ABORT_REASON;
    // The user-visible completion event is persisted before handing task state to
    // Backend. If Brain dies after the callback, outbox replay can safely skip
    // task execution without losing the session's terminal event.
    await deliverAgentDone(this.kvCkpt, this.request, handoff, this.coverageReport()?.runTime);
    // Ack BEFORE logging task.completed: if the process is killed by a hot-
    // reload between the log line and msg.ack(), NATS redelivers the task after
    // ack_wait and the entire execution repeats from scratch. Since exec_complete
    // is already persisted in JetStream, the event-consumer can handle post-
    // completion logic (pending messages, summaries) even if Brain dies here.
    await this.ackTerminal();
    if (endedKey) {
      await this.kvCkpt.delete(endedKey).catch((e: unknown) => {
        logger.warn({ err: e, sessionId: this.sessionId, messageId: this.messageId }, "task.ended_turn_cleanup_failed");
      });
    }
    logger.info({
      sessionId: this.sessionId, messageId: this.messageId, turns: result.turns, elapsedMs: result.elapsedMs,
      // A completed run always has both -- the loop that produced this result
      // counted them. They are optional on the type for the terminal paths
      // that end before anything did.
      inputTokens: result.tokenUsage?.input_tokens, outputTokens: result.tokenUsage?.output_tokens,
      cacheRead: result.tokenUsage?.cache_read, cacheCreate: result.tokenUsage?.cache_create,
      toolCalls: result.toolStats?.total_calls, toolErrors: result.toolStats?.error_calls,
      toolBreakdown: result.toolStats?.by_tool,
    }, "task.completed");
    // INV-7: latch BEFORE the pending-sync drain so any in-flight
    // onCheckpoint callbacks past their own short-circuit cannot re-
    // write KV after deleteKvCheckpoint below. Drain pendingSync with a
    // small grace window so the shared `current/` snapshot reflects the
    // final turn (used by reaper grace + post-mortem debugging); we
    // bound the wait so a wedged sandbox never holds task completion.
    this.taskFinished = true;
    const pendingSyncSnapshot = this.pendingSync;
    if (pendingSyncSnapshot) {
      await Promise.race([
        pendingSyncSnapshot.catch(() => undefined),
        new Promise<void>((r) => setTimeout(r, WORKSPACE_SYNC_GRACE_MS)),
      ]);
    }
    await this.deleteKvCheckpoint();
    await this.releaseAfterTerminal();
  }

  /**
   * Another replica holds this task now: stand down and keep nothing of it.
   *
   * Every other terminal path is wrong here, because they all assume this
   * replica is the one running the task. The replica that holds it is driving
   * the same sandbox, the same workspace and the same checkpoint key, so
   * syncing the workspace would overwrite its files, deleting the checkpoint
   * would strand it, `markHandsIdle` would tell the whole fleet to stop
   * pinging a sandbox it is using, and emitting a terminal event would tell
   * the API the run ended while it is still going. Hence not
   * `stopKeepaliveAfterTask`, which does that shared write.
   *
   * Its other half is not the same act and has to happen. `unregisterSandbox`
   * drops this process's own entry from the keepalive registry and writes
   * nothing shared; the holder registered an entry of its own when it called
   * `ensureHands`, so the live run loses nothing.
   *
   * What it buys is an end to the pinging, not an end to it now. This pod keeps
   * the session on its ping list either way, because `collectTargets` re-derives
   * it from the `hands.*` KV scan the moment the local entry is gone -- so while
   * the holder is running, an entry dropped here and an entry left behind ping
   * the same sandbox on the same tick and reach the eviction branch on the same
   * failures. The difference is what happens when the holder finishes: it parks
   * the shared entry with `markHandsIdle`, and a KV-derived target reads
   * `keepalive === false` and stops pinging, then expires with the idle window.
   * A local entry is never consulted about that field, so it would have gone on
   * `exec`ing into a sandbox no run was using, re-putting `hands.<sid>` to
   * refresh its TTL and keeping the platform's `lastActivity` fresh, for the
   * life of this pod -- suppressing the idle collector this module delegates
   * sandbox reclamation to. Bounded instead of unbounded is the whole of it.
   *
   * The message is left alone as well: the holder is running from a redelivery
   * of this same message, so settling it here would settle it for both of us.
   * If that redelivery has not happened yet, letting ack_wait lapse produces
   * one, and task-dispatch stands that copy down against the held lock.
   * `releaseTaskLock` in the outer `finally` is holder-checked, so it will not
   * delete a lock owned by someone else.
   *
   * Reached from either witness -- the lock renewal saying it is no longer
   * ours, or the lease endpoint saying the row belongs to another worker --
   * because what the two observe is one fact, and the response to it is this
   * one either way. One caveat is still open there: `refreshTaskLock` also
   * answers `"expired"`, which is this pod concluding it can no longer prove it
   * holds the lock rather than a witness naming a successor, so there may be no
   * holder at all. With nobody to park the shared entry, the KV scan goes on
   * rebuilding this session's ping target every tick and the bound above never
   * arrives. Noted rather than fixed: parking it from here is the shared write
   * this path exists not to make, and a redelivery that does take the run over
   * would find its handle already put away.
   */
  private handleLeaseLost(): void {
    logger.error(
      { sessionId: this.sessionId, messageId: this.messageId, lockKey: this.lockKey,
        turns: this.reportedCkpt?.turns_completed ?? 0 },
      "task.lease_lost.stood_down",
    );
    // The admission slot is the one part of the local entry that is not local,
    // and it belongs to the sandbox rather than to whoever is pinging it. The
    // holder reached this same container through `ensureHands`'s reuse path,
    // which claims no slot of its own and names the same roster identity, so
    // the entry dropped here is that live sandbox's only claim on the ceiling
    // -- and giving it up is exactly the fleet-shared write this path exists
    // not to make. Same reasoning as `stopKeepaliveAfterTask`, one step
    // further: there the sandbox outlives the turn, here it outlives the pod.
    const keepSlot = { releaseSlot: false };
    if (this.handsIdentity) {
      fx().unregisterSandbox(this.sessionId, this.handsIdentity, keepSlot);
    } else if (this.handsWorkloadId) {
      fx().unregisterSandbox(this.sessionId, { workloadId: this.handsWorkloadId }, keepSlot);
    }
  }

  /**
   * The row is terminal and nobody else is running this: give everything back.
   *
   * The mirror image of the case above, which is why they used to share a path
   * and why sharing it was wrong. There is no other replica to inherit what
   * this run holds, so leaving the sandbox registered pins the pod until the
   * idle collector happens past, and leaving a multi-node cluster unreleased
   * holds its GPUs until the workload's own 24h timeout; and there is no other
   * copy of this delivery to settle it, so leaving it unsettled brings the
   * message back every ack_wait to provision a sandbox and abort again, until
   * the delivery budget is spent and the poison guard writes off a task that
   * simply had nowhere to go. Hence the whole release rather than the keepalive
   * half of it: a cancel, a session delete and the deadline backstop closing
   * the row all arrive here, and any of them can be a run with a cluster
   * behind it.
   *
   * Released before the message is settled, for the reason
   * `releaseAfterTerminal` gives: settling is the step that can throw, and
   * nothing this run was holding should depend on it.
   *
   * Terminated rather than acked for what it says to an operator: a message
   * discarded on purpose, visible as such, rather than one indistinguishable
   * from work that completed.
   */
  private async handleRunRowTerminal(): Promise<void> {
    logger.error(
      { sessionId: this.sessionId, messageId: this.messageId, taskId: this.request.task_id,
        turns: this.reportedCkpt?.turns_completed ?? 0 },
      "task.run_row_terminal.released",
    );
    await this.releaseAfterTerminal();
    try { this.msg.term(); } catch { /* already settled; the point was to not redeliver */ }
  }

  // ── SIGTERM abort: checkpoint and re-queue ──────────────────────────
  private async handleSigtermAbort(): Promise<void> {
    // INV-7: latch taskFinished BEFORE any await so in-flight onCheckpoint
    // callbacks (already past their own short-circuit check) can no longer
    // overwrite KV between here and our final write below.
    this.taskFinished = true;
    const sigtermStartedAt = Date.now();
    // sigtermSyncResult flows into sigtermCheckpointDurationSeconds at
    // the end of this branch so dashboards can split P95 latency by
    // outcome (success vs timeout vs error vs skipped).
    let sigtermSyncResult: "success" | "timeout" | "error" | "skipped"
      = "skipped";
    logger.info({ sessionId: this.sessionId }, "task.sigterm.checkpointing");
    // ⓪ Drain any normal-priority pendingSync first (bounded). The
    // priority workspace_sync below is reserved for the SIGTERM path
    // and will not be queued behind ordinary turn-driven syncs.
    const pendingSyncSnapshot = this.pendingSync;
    if (pendingSyncSnapshot) {
      await Promise.race([
        pendingSyncSnapshot.catch(() => undefined),
        new Promise<void>((r) => setTimeout(r, SIGTERM_PENDING_SYNC_WAIT_MS)),
      ]);
    }
    // Overlay the freshest cache-use timestamp: the last turn boundary wrote
    // whatever was true before this turn's tool batch, and this SIGTERM is
    // landing inside that batch. See `latestCacheUseAt`.
    const ckptState = sigtermCheckpointState(
      this.latestCheckpointState, this.pendingResumeCkpt, this.latestCacheUseAt,
      this.cacheUseCleared,
    );
    if (ckptState && ckptState.turns_completed > 0) {
      // ① Priority workspace_sync (§5.5.1) — independent semaphore so
      // rolling-restart SIGTERMs are never starved by routine syncs.
      // Falls back to a KV-only checkpoint if the sync fails or is
      // skipped (no hex user id, no hands client, sync throws).
      let syncedFlag = false;
      // The workspace half is everything a sandbox is needed for; the KV write
      // below is not. They used to share this branch's condition, so a run
      // that never attached one -- network and backend MCP tools need no
      // sandbox, and the client is attached lazily -- wrote no checkpoint at
      // all on SIGTERM, however many turns it had completed. The conversation
      // and its timestamp were lost for want of a workspace that did not
      // exist. Without hands there is simply nothing to sync, and
      // `sigtermSyncResult` stays "skipped", which is what it means.
      const workHands = this.workHands();
      if (workHands && WORKSPACE_PERSIST_BASE && this.userIdHex) {
        try {
          await workspaceSigtermSyncSemaphore.run(async () => {
            await this.refuseSharedSyncIfHeld(workHands);
            return fx().syncWorkspace(workHands, this.sessionId, this.userIdHex!, ckptState.turns_completed,
              { kind: "sigterm" });
          });
          syncedFlag = true;
          sigtermSyncResult = "success";
          logger.info({ sessionId: this.sessionId, turns: ckptState.turns_completed },
            "task.sigterm.workspace_sync_done");
        } catch (e) {
          const msg = String((e as { message?: string })?.message ?? e);
          sigtermSyncResult = /timeout/.test(msg) ? "timeout" : "error";
          logger.warn({ err: e, sessionId: this.sessionId },
            "task.sigterm.workspace_sync_failed");
        }
      }
      // Deliberately NOT gated on workspace_throwaway, unlike the terminal sync
      // above. The two calls share code and share nothing else: the terminal one
      // publishes a finished run's output, which a throwaway task has already
      // delivered elsewhere, so it is pure duplication. This one is the only
      // thing that lets a preempted run pick up where it stopped -- skipping it
      // would not save a copy of anything, it would discard work in flight.
      //
      // Fall back to S3 whenever the shared-filesystem sync did not happen.
      // This guard used to be the only one, so with WORKSPACE_PERSIST_BASE
      // unset — the default, in code and in the Helm values alike — a SIGTERM
      // persisted the conversation to KV and the workspace nowhere. The run
      // then resumed against whatever the session prefix held from before it
      // started. Writing to the session prefix is what the terminal path
      // already does, and it is where resolveResumeState's fall-through reads
      // from, so the resumed run finds these files.
      if (!syncedFlag && workHands) {
        const hands = workHands;
        try {
          // The measurement of the repositories is capped like the shared-disk SIGTERM
          // sync's: with the shared disk unset, which is the default, this is the
          // only sync a SIGTERM runs, and its budget cannot hold a long one.
          const r = await fx().syncWorkspaceToS3(
            hands, this.sessionId, this.userIdForSync,
            { gitProbeTimeoutSec: SIGTERM_PROBE_TIMEOUT_SEC },
          );
          if (!r.empty) {
            sigtermSyncResult = r.exhausted ? "timeout" : "success";
            logger.info(
              { sessionId: this.sessionId, uploaded: r.uploaded, total: r.totalFiles,
                exhausted: r.exhausted },
              "task.sigterm.s3_fallback_done",
            );
          }
        } catch (e) {
          const msg = String((e as { message?: string })?.message ?? e);
          sigtermSyncResult = /timeout/.test(msg) ? "timeout" : "error";
          logger.warn({ err: e, sessionId: this.sessionId },
            "task.sigterm.s3_fallback_failed");
        }
      }
      try {
        await this.writeKvCheckpoint(
          ckptState,
          syncedFlag
            ? { has_workspace_sync: true, last_sync_turn: ckptState.turns_completed }
            : undefined,
          "sigterm",
        );
        logger.info(
          { sessionId: this.sessionId, turns: ckptState.turns_completed,
            hasWorkspaceSync: syncedFlag },
          "task.sigterm.checkpoint_written",
        );
      } catch (e) {
        logger.warn({ err: e, sessionId: this.sessionId }, "task.sigterm.checkpoint_write_failed");
      }
    } else {
      logger.info({ sessionId: this.sessionId }, "task.sigterm.no_completed_turns_skip_checkpoint");
    }

    // INV-8 (checkpoint-architecture-redesign §5.3): announce the
    // interruption so api-side event-consumer flips agent_status to
    // 'interrupted'. wallclock_ms is used by the consumer's monotonic
    // status_event_at guard to drop stale out-of-order events.
    await this.onEvent({
      type: "taskInterrupted",
      reason: "sigterm",
      // The run's count, like the two records below it: three statements about
      // one interruption, and two of them saying four turns while this one
      // says none is how they stop being usable together.
      turns_completed: this.reportedCkpt?.turns_completed ?? 0,
      has_kv_checkpoint: !!ckptState,
      wallclock_ms: Date.now(),
    }).catch((e) =>
      logger.warn({ err: e, sessionId: this.sessionId }, "task.sigterm.interrupted_event_failed"),
    );
    this.transcriptLog.push({
      ts: Date.now(),
      type: "task_exit",
      reason: "sigterm",
      // Both figures are the run's, not this attempt's: a run SIGTERMed twice
      // would otherwise leave three records each reporting only its own slice,
      // and a record pairing the run's hour with this attempt's zero turns
      // contradicts itself. `ckptState` above stays per-attempt because the
      // checkpoint write below must not re-persist a checkpoint this attempt
      // did not produce; only what is reported changes here.
      turnsCompleted: this.reportedCkpt?.turns_completed ?? 0,
      workloadId: this.handsWorkloadId,
      elapsedMs: this.elapsedMsForRun(),
      workspaceSyncResult: sigtermSyncResult,
    });
    await fx().flushTranscript(this.sessionId, this.userId, this.messageId, this.transcriptStartedAt, this.transcriptLog, {
      failed: false, sigterm: true,
      turnsCompleted: this.reportedCkpt?.turns_completed ?? 0,
    });
    metrics.onSigtermCheckpoint(
      (Date.now() - sigtermStartedAt) / 1000,
      sigtermSyncResult,
    );
    if (this.request.mode === "script" && !this.claimed) {
      await this.handOverScriptRun();
      return;
    }
    await this.nakAfterAttempt(0);
  }

  /**
   * Give a draining pod's script run to another worker now.
   *
   * A nak cannot be relied on to do it. The task stream's `max_age` removes a
   * message by age alone, whether or not a worker is still on it, so a run
   * older than the retention -- about 2h41m on the default budget, and a DAG
   * script step can run for a day -- has no message left to redeliver: the nak
   * lands nowhere, nothing takes the run over, and the reaper closes it as
   * `worker_lost` while its sandbox is still running the job.
   *
   * So the same request goes out again as a new message, and this delivery is
   * acked. The lease is given back first, exactly as `nakAfterAttempt` does it,
   * so the new message's first renewal finds it free; the worker that takes it
   * reads this run's progress from the checkpoint and carries on in the same
   * sandbox. Falls back to the nak if the publish fails, which is still right
   * for a run young enough to be redelivered.
   */
  private async handOverScriptRun(): Promise<void> {
    await this.releaseAttempt();
    try {
      await fx().republishTask(this.msg.subject || taskSubject(), this.msg.data);
    } catch (err) {
      logger.warn(
        { err: (err as Error)?.message ?? err, sessionId: this.sessionId, taskId: this.request.task_id },
        "task.sigterm.handover_publish_failed",
      );
      this.msg.nak(0);
      return;
    }
    logger.info(
      { sessionId: this.sessionId, taskId: this.request.task_id,
        progress: this.scriptProgressKey },
      "task.sigterm.script_handed_over",
    );
    this.msg.ack();
  }

  // ── User interrupt (existing behavior) ─────────────────────────────
  private async handleUserInterrupt(): Promise<void> {
    logger.warn({ sessionId: this.sessionId }, "task.interrupt_done.pending_dropped");
    // Build a non-empty final_text and propagate `interrupted: true` so the
    // API event-consumer persists the user prompt + an assistant placeholder
    // turn into claw_conversation_turns. Without this an interrupt drops the
    // entire task from the LLM's future context (root cause for session
    // 90e2344a's "tool_use[ls] empty input" hallucinate loop after a user
    // sent a follow-up message right after pressing interrupt).
    // `reportedCkpt`, so an interrupt during a resumed run's first new turn
    // reports the hour already behind it rather than nothing. Absence here
    // would be a false statement rather than a missing one, which is the
    // distinction the `undefined` further down exists to draw.
    const ckptState = this.reportedCkpt;
    // Once, so the two sinks below cannot disagree by however long the first
    // of them takes.
    const elapsedMs = this.elapsedMsForRun();
    const turnsCompleted = this.reportedTurns(ckptState?.turns_completed ?? 0);
    // Bound once and shared by the three sinks below -- the event, the DAG
    // callback and the S3 transcript. Spelling the same mapping out at each of
    // them is how they came to disagree in the first place.
    // `turns` overridden rather than taken from `usage`: agent-loop keeps its
    // own count precisely because a gateway that omits `usage` leaves
    // `usage.turns` at zero (agent/agent-loop.ts, `turnsExecuted`). The checkpoint's
    // `turns_completed` is the one that is always right, and it is what the
    // DAG row was already storing.
    const tokenUsage = ckptState ? { ...ckptState.usage, turns: turnsCompleted } : undefined;
    const toolStats = ckptState
      ? {
        total_calls: ckptState.total_tool_calls,
        error_calls: ckptState.error_count,
        by_tool: ckptState.tool_calls_by_name,
      }
      : undefined;
    // Redact BEFORE truncating, and redact at all: latestCheckpointState is
    // held verbatim now, and this string becomes the interrupted run's
    // final_text -- it reaches NATS, the event DB, SSE and any downstream node
    // that templates this task's output. Truncating first would also cut a
    // credential in half, and an exact-substring pass cannot match a fragment,
    // so the tail would survive. Same order safePreview() settled on.
    const partialSummary = ckptState?.text_parts?.length
      ? redactEgressPayload(
        ckptState.text_parts.join("\n\n"),
        runtimeSecrets(this.request, this.platformKey),
      ).slice(-4000)
      : "";
    const interruptMarker = `[Interrupted by user${turnsCompleted ? ` after ${turnsCompleted} turns` : " before any turn completed"}]`;
    const finalText = partialSummary
      ? `${partialSummary}\n\n${interruptMarker}`
      : interruptMarker;
    // The transcript gets the same four figures the completion and failure
    // paths write. It is the artifact an after-the-fact analysis reads, so an
    // interrupt that leaves them out is invisible to exactly the question this
    // change exists to answer -- and they are already in hand, two lines up.
    await fx().flushTranscript(this.sessionId, this.request.user_id || "default", this.messageId, this.transcriptStartedAt, this.transcriptLog, {
      failed: false, interrupted: true,
      turns: turnsCompleted, elapsedMs, tokenUsage, toolStats,
    });
    // The turn's end on the session's stream. `exec_complete` below is the API's
    // and is never forwarded to a stream's readers (routes/events.ts SKIP_EVENTS),
    // and a stopped engine never reached its own `ResultMessage`: without this a
    // reader -- a chat's "Thinking..." status, an A2A or MCP caller -- waits for
    // an end that never comes. Stopped while the sandbox was still being prepared
    // is the common case: the engine had said nothing yet. Not a success, and no
    // text: what the turn said before the stop is already on the stream.
    if (!this.turnEndAnnounced) {
      await this.onEvent({ type: "ResultMessage", data: { subtype: "interrupted" } })
        .catch((e) => logger.warn({ err: e, sessionId: this.sessionId }, "task.interrupt_result_event_failed"));
    }
    await this.onEvent({
      type: "exec_complete",
      session_id: this.sessionId,
      message_id: this.messageId,
      user_id: this.request.user_id || "default",
      final_text: finalText,
      interrupted: true,
      failed: false,
      turns: turnsCompleted,
      token_usage: tokenUsage,
      // How long the run had been working and what it had been doing, without
      // which an interrupt is invisible to any duration or activity
      // measurement -- and an interrupt is how a large share of runs on this
      // fleet end.
      //
      // The duration is a wall clock where the completion path sends the agent
      // loop's own, so aggregating the two mixes a figure that includes this
      // attempt's provisioning with one that does not. That gap is seconds;
      // the gap it buys out of is the whole turn an interrupt lands in. See
      // `elapsedMsForRun`.
      //
      // The two are not knowable on the same terms, so they are not reported
      // on the same terms.
      //
      // How long is always knowable: a run being interrupted has been going
      // since `transcriptStartedAt` whatever else is true, and
      // `elapsedMsForRun` says why that is the figure rather than the last
      // checkpoint's -- an interrupt lands mid-turn by definition, and the
      // checkpoint cannot see the turn it lands in.
      //
      // What it was doing is not. With no checkpoint at all -- neither this
      // attempt's nor one it resumed from, an interrupt before any turn
      // anywhere finished -- nothing counted the tool calls, and zeroes there
      // would be indistinguishable from a run that really made none. A zero
      // meaning "unknown" is worse than an absence: it survives into
      // percentiles and drags them down without ever looking wrong, which is
      // the failure that made a wall-clock proxy for this read 0 across
      // hundreds of sessions.
      elapsed_ms: elapsedMs,
      tool_stats: toolStats,
      error_count: ckptState?.error_count ?? 0,
      skills_used: {},
      selected_skills: Object.keys(this.request.skills || {}),
      prompt: this.request.prompt,
      delivery_count: this.msg.info.deliveryCount,
      ...runIdentity(this.request, this.claimed ? this.attempt.claimCount : undefined),
    });
    await deliverAgentDone(
      this.kvCkpt,
      this.request,
      redactEgressPayload<ExecuteResult>(
        this.withPlatformFacts({
          finalText,
          // Absent rather than zeroed when nothing recorded them, which is the
          // same statement the event above makes and for a sharper reason:
          // `applyAgentDone` writes these into `claw_tasks`, so a zero here is
          // not a number in a stream someone might sanity-check but a stored
          // row asserting the run made no calls and spent no tokens.
          tokenUsage,
          turns: turnsCompleted,
          pendingSkills: [],
          skillsUsed: {},
          errorCount: ckptState?.error_count ?? 0,
          toolStats,
          // The same number the `exec_complete` above carries, from the same
          // variable: two sinks for one ending should not be able to report two
          // lengths for it.
          elapsedMs,
          abortReason: "cancelled",
          failureReason: "cancelled by user",
        }),
        runtimeSecrets(this.request, this.platformKey),
      ),
      this.coverageReport()?.runTime,
    );
    // Hands reaps run-scoped shells; conversation shells survive cancellation.
    await this.reapBackgroundShells("run_cancelled");
    await this.releaseAfterTerminal();
    await this.ackTerminal();
  }

  private async handleRetryableError(err: any): Promise<void> {
    const retryReasonClass = classifyRetryableReason(err);
    logger.warn({ err, sessionId: this.sessionId, messageId: this.messageId, lockKey: this.lockKey, reasonClass: retryReasonClass }, "task.retryable");
    const retryReason = String(err?.message || err).slice(0, 300);
    const retryPendingCreatedAtMs = Date.now();
    const retryPendingDeadlineMs = retryPendingCreatedAtMs + RETRY_PENDING_KEEPALIVE_GRACE_SEC * 1000;
    await fx().markRetryPending(this.kv, {
      sessionId: this.sessionId,
      messageId: this.messageId,
      lockKey: this.lockKey,
      attempt: this.msg.info.deliveryCount,
      reason: retryReason,
      reasonClass: retryReasonClass,
      workloadId: this.handsWorkloadId,
      createdAtMs: retryPendingCreatedAtMs,
      deadlineMs: retryPendingDeadlineMs,
      graceSec: RETRY_PENDING_KEEPALIVE_GRACE_SEC,
      brainId: BRAIN_ID,
      brainVersion: BRAIN_VERSION,
    }).catch((markErr) =>
      logger.warn(
        { err: markErr, sessionId: this.sessionId, messageId: this.messageId, lockKey: this.lockKey, attempt: this.msg.info.deliveryCount },
        "retry_pending.mark_failed",
      ),
    );
    logger.info(
      {
        sessionId: this.sessionId,
        messageId: this.messageId,
        lockKey: this.lockKey,
        attempt: this.msg.info.deliveryCount,
        reasonClass: retryReasonClass,
        workloadId: this.handsWorkloadId,
        graceSec: RETRY_PENDING_KEEPALIVE_GRACE_SEC,
        createdAtMs: retryPendingCreatedAtMs,
        deadlineMs: retryPendingDeadlineMs,
        deadlineIso: new Date(retryPendingDeadlineMs).toISOString(),
      },
      "retry_pending.marked",
    );
    await this.onEvent({
      type: "sandboxStatus",
      status: "pending",
      event: "retry",
      // Neutral reason for transient/retryable errors; the specific cause lives
      // in reason_class. (Previously hardcoded `resource_unavailable`, which
      // conflated an ordinary transient retry with an actual resource shortage.)
      reason: "retryable_error",
      reason_class: retryReasonClass,
      message: retryReason,
      delivery_count: this.msg.info.deliveryCount,
      retry_pending_deadline_ms: retryPendingDeadlineMs,
      workload_id: this.handsWorkloadId,
      lock_key: this.lockKey,
    });
    // B: reap orphan SaFE workload if ensureHands left a PENDING entry
    // (no-op when the entry is READY — a healthy sandbox is kept for the
    // retry to reuse). Done BEFORE nak so the retry starts clean.
    // Ownership-gated, and on more than the session id: the entry is per
    // session, so a run that asked for no sandbox, or asked and was refused
    // before `onProvisioned` ran, would otherwise destroy whichever workload an
    // earlier message of this session is still provisioning. See
    // `reapOwnPendingHands`, which carries all three gates.
    await this.reapOwnPendingHands();
    // Flush a per-attempt transcript before NAK so the JSONL captures
    // events of THIS attempt even if the next delivery / pod loses state.
    this.transcriptLog.push({
      ts: Date.now(),
      type: "task_exit",
      reason: "retryable",
      attempt: this.msg.info.deliveryCount,
      error: retryReason,
      reasonClass: retryReasonClass,
      workloadId: this.handsWorkloadId,
      lockKey: this.lockKey,
      retryPendingDeadlineMs,
      retryPendingGraceSec: RETRY_PENDING_KEEPALIVE_GRACE_SEC,
    });
    await fx().flushTranscript(this.sessionId, this.userId, this.messageId, this.transcriptStartedAt, this.transcriptLog, {
      failed: false, retrying: true,
      attempt: this.msg.info.deliveryCount, error: retryReason,
      reasonClass: retryReasonClass,
      workloadId: this.handsWorkloadId,
      lockKey: this.lockKey,
      retryPendingDeadlineMs,
      retryPendingGraceSec: RETRY_PENDING_KEEPALIVE_GRACE_SEC,
    });
    // Backed off by the attempt this was: a claimed run counts its claims, a
    // fat delivery its deliveries.
    await this.nakAfterAttempt(retryableNakMs(
      this.claimed ? this.attempt.claimCount : this.msg.info.deliveryCount,
    ));
  }

  private async handleFatalError(err: any): Promise<void> {
    // This attempt's own state and no fallback, deliberately: the line below is
    // an operator record of what this brain did before it died, not of what the
    // run had done in total. The reported figures further down are the latter.
    const failedCkpt = this.latestCheckpointState;
    logger.error({
      err,
      sessionId: this.sessionId,
      workloadId: this.handsWorkloadId,
      turnsCompleted: failedCkpt?.turns_completed ?? 0,
      totalToolCalls: failedCkpt?.total_tool_calls ?? 0,
      elapsedMs: Date.now() - this.transcriptStartedAt,
      errorClass: String(err?.constructor?.name ?? "Error"),
      errorMessage: String(err?.message ?? err).slice(0, 500),
    }, "task.failed");
    await this.recoverInflightCheckpoint("from_failed_task_checkpoint");
    // Before the reap, and not merely "somewhere on the failure path".
    //
    // Every failed run asks the platform, not only one that reached the rebuild
    // path: a sandbox can vanish in ways that surface as an ordinary tool error,
    // and a run that fails for its own reasons simply gets nothing back. No-op
    // when the facts were already read at the probe.
    //
    // It used to be asked after the completion event, ~90 lines below, and by
    // then the reap on the next line had stopped the workload and deleted the
    // only record of which workload it was -- so the one failure family that
    // has a platform account to collect, a sandbox that died during its own
    // provisioning, was the one family that could never collect it. Asking here
    // is the property `capturePlatformFacts` claims for itself: the pod's own
    // account of its ending still exists, and Claw has not yet changed the
    // workload's state itself.
    //
    // The reap is delayed by one GET capped at FETCH_TIMEOUT_MS (10s) and
    // wrapped in `.catch`, never by a failure of the read -- a bounded wait
    // ahead of the reap is not new either, `recoverInflightCheckpoint` above
    // already takes one.
    await this.capturePlatformFacts();
    // And, in the same window and for the same reason, leave the handle on the
    // row: the facts above reach a chat run's row through nothing else, and the
    // reap on the next line is about to delete the only record of which
    // workload this was. See `recordSandboxBeforeReap`.
    await this.recordSandboxBeforeReap();
    // B: reap orphan SaFE workload if ensureHands died mid-creation and
    // left a PENDING entry. READY entries are left alone so a subsequent
    // user message can still reuse the working sandbox.
    // Ownership-gated, and on more than the session id: the entry is per
    // session, so a run that asked for no sandbox, or asked and was refused
    // before `onProvisioned` ran, would otherwise destroy whichever workload an
    // earlier message of this session is still provisioning. See
    // `reapOwnPendingHands`, which carries all three gates.
    await this.reapOwnPendingHands();
    // Classify sandbox-originated failures so the frontend can render a
    // dedicated banner (and so the user sees a readable reason rather than
    // a raw stack-trace tail). Non-sandbox errors fall through with the
    // original err.message.
    const rawMsg = String(err?.message || err);
    // A SandboxProvisionTerminalError carries an authoritative machine reason
    // (e.g. sandbox_workload_terminal); else fall back to the message-regex classifier.
    const sandboxReason = provisionTerminalOf(err)?.reason ?? classifySandboxFailure(rawMsg);
    if (sandboxReason) {
      await this.onEvent({
        type: "sandboxStatus",
        status: "failed",
        reason: sandboxReason,
        message: rawMsg.slice(0, 500),
      });
    }
    // Build readable user-facing text + a stable failure_reason. Sandbox
    // failures keep their existing format (banner + raw msg) since the
    // dedicated sandboxStatus event already carries the structured reason;
    // upstream LLM failures get the new classifier so the chat panel does
    // not display a raw provider JSON body.
    // A refused workspace is already written for the person reading it (see
    // `sandboxWorkspaceForbiddenText`); the code prefix would only add noise.
    const taskFailure = sandboxReason
      ? {
        reason: sandboxReason,
        userText: sandboxReason === SANDBOX_WORKSPACE_FORBIDDEN || sandboxReason === SANDBOX_WORKSPACE_NOT_ALLOWED
          ? rawMsg.slice(0, 500)
          : `Sandbox failure (${sandboxReason}): ${rawMsg.slice(0, 500)}`,
      }
      : classifyTaskFailure(rawMsg, err);
    const finalText = taskFailure.userText;
    // Partial progress fields. agentLoop's `result` is unavailable on the
    // failure path, so we fall back to the latest checkpoint state captured
    // by onCheckpoint (same source the interrupt path already trusts), and
    // behind that to the checkpoint this attempt resumed from, so a run that
    // fails before its first new turn still reports the turns and tool calls
    // it already had rather than zeroes. When there is neither — a failure on
    // a fresh run before the first turn finishes — we emit zeroed counters,
    // strictly better than the previous behavior which dropped these fields
    // entirely and forced operators to grep brain logs to quantify partial
    // work.
    const ckptStateF = this.reportedCkpt;
    const partialTokenUsage = ckptStateF?.usage ?? {
      input_tokens: 0, output_tokens: 0, cache_read: 0, cache_create: 0,
    };
    const partialToolStats = {
      by_tool: ckptStateF?.tool_calls_by_name ?? {},
      total_calls: ckptStateF?.total_tool_calls ?? 0,
      error_calls: ckptStateF?.error_count ?? 0,
    };
    const partialTurns = this.reportedTurns(ckptStateF?.turns_completed ?? 0);
    // The same rule the interrupt path reports on, for the same reason: a
    // failure is by definition inside the turn after the last checkpoint, so
    // the checkpoint's own clock cannot see the part of the run that was still
    // going when it died. See `elapsedMsForRun`.
    const elapsedMsAtFailure = this.elapsedMsForRun();
    await fx().flushTranscript(this.sessionId, this.request.user_id || "default", this.messageId, this.transcriptStartedAt, this.transcriptLog, {
      failed: true, error: rawMsg.slice(0, 500),
      turns: partialTurns, elapsedMs: elapsedMsAtFailure,
      tokenUsage: partialTokenUsage, toolStats: partialToolStats,
      failureReason: taskFailure.reason,
    });
    // Surface the failure text in the chat stream. agent-loop would have
    // emitted these on the success path; on a fatal init/ensureHands error
    // the loop never ran, so the SSE consumer saw only sandboxStatus and
    // an (SKIP_EVENTS-filtered) exec_complete. Emitting the synthetic pair
    // below maps to chat_delta + chat_delta{finished:true} for the client.
    await this.onEvent({
      type: "AssistantMessage",
      data: { content: [{ type: "text", text: finalText }] },
    });
    await this.onEvent({ type: "ResultMessage" });
    await this.onEvent({ type: "statusUpdate", agentStatus: "failed" });
    await this.onEvent({
      type: "exec_complete",
      session_id: this.sessionId,
      message_id: this.messageId,
      user_id: this.request.user_id || "default",
      final_text: finalText,
      failed: true,
      failure_reason: taskFailure.reason,
      turns: partialTurns,
      elapsed_ms: elapsedMsAtFailure,
      token_usage: partialTokenUsage,
      tool_stats: partialToolStats,
      error_count: ckptStateF?.error_count ?? 0,
      skills_used: {},
      selected_skills: Object.keys(this.request.skills || {}),
      prompt: this.request.prompt,
      delivery_count: this.msg.info.deliveryCount,
      ...runIdentity(this.request, this.claimed ? this.attempt.claimCount : undefined),
    });
    // Task DAG: tell Backend the task failed so the scheduler can cascade
    // to downstream nodes and (eventually) tear sandboxes down.
    await deliverAgentDone(
      this.kvCkpt,
      this.request,
      redactEgressPayload<ExecuteResult>(
        this.withPlatformFacts({
          finalText: finalText,
          // The same partial progress the `exec_complete` above reports. These
          // were hard-coded to zero, and `applyAgentDone` writes them straight
          // into `claw_tasks`, so every failed task in the DAG recorded itself
          // as having done nothing -- including a resumed one that had hours
          // behind it. `errorCount` stays 1: it describes the ending, not the
          // work, and the ending is that this failed.
          tokenUsage: { ...partialTokenUsage, turns: partialTurns },
          turns: partialTurns,
          pendingSkills: [],
          skillsUsed: {},
          errorCount: 1,
          toolStats: partialToolStats,
          elapsedMs: elapsedMsAtFailure,
          abortReason: "error",
          failureReason: sandboxReason || rawMsg.slice(0, 500),
          ...(err instanceof AppRunFailedError && err.captures ? { captures: err.captures } : {}),
        }),
        runtimeSecrets(this.request, this.platformKey),
      ),
      this.coverageReport()?.runTime,
    );
    await this.releaseAfterTerminal();
    await this.ackTerminal();
  }

  /**
   * Run a terminal handler, turning an exhausted `agent_done` delivery into a
   * redelivery rather than letting it escape.
   *
   * Every terminal handler reports the outcome from the middle of itself: after
   * the transcript and the session's terminal event, before the ack and the
   * release of what the run was holding. `deliverAgentDone` throws
   * AgentDoneDeliveryError once its own retries are spent, and an escape from
   * there leaves the message settled neither way -- so it comes back when
   * ack_wait lapses rather than in five seconds -- and skips the release, which
   * pins the cluster and leaves this pod pinging a sandbox no run is using. So
   * the nak is asked for here and the release is done anyway; only the ack is
   * not, because the outbox entry `deliverAgentDone` writes before the post is
   * what lets the redelivery replay the callback instead of executing the task
   * a second time, and clearing it would throw that away.
   *
   * The release goes first, for the reason `releaseAfterTerminal` gives: the nak
   * is the part of this that can fail, and a drain is where both halves of that
   * failure meet.
   *
   * This one error and no other. Anything else out of a terminal handler is a
   * bug in it, and converting that to a nak would hide the failure of the very
   * path whose job is to report failures.
   */
  private async settleTerminal(
    handler: () => Promise<void>,
    exhaustedLog: string,
  ): Promise<void> {
    try {
      await handler();
    } catch (err) {
      if (!(err instanceof AgentDoneDeliveryError)) throw err;
      logger.error(
        { err, sessionId: this.sessionId, taskId: this.request.task_id },
        exhaustedLog,
      );
      await this.releaseAfterTerminal();
      this.msg.nak(5_000);
    }
  }

  /**
   * Stop the run when its budget is spent, so it can say so itself.
   *
   * The API's sweeper is the backstop for a run whose process is gone; it can
   * only write a row. A run that is alive should end the way any other terminal
   * run ends -- transcript flushed, partial progress reported, a stated reason
   * -- and that only happens if the deadline reaches the process holding it.
   *
   * Returns a cancel function, since the timer has to be cleared on every exit
   * path or a finished run keeps the process awake until its deadline.
   */
  private armDeadline(): () => void {
    const raw = this.request.deadline_at;
    if (!raw) return () => {};
    const deadlineMs = Date.parse(raw);
    if (!Number.isFinite(deadlineMs)) {
      logger.warn({ sessionId: this.sessionId, deadlineAt: raw }, "task.deadline_unparseable");
      return () => {};
    }
    const fire = (): void => {
      if (this.abortCtrl.signal.aborted) return;
      logger.warn(
        {
          sessionId: this.sessionId,
          taskId: this.request.task_id,
          deadlineAt: raw,
          // The budget is the run's, not this attempt's, so the turn count
          // said next to it has to be the run's too.
          turns: this.reportedCkpt?.turns_completed ?? 0,
        },
        "task.deadline_exceeded",
      );
      this.abortCtrl.abort(DEADLINE_EXCEEDED_ABORT_REASON);
    };
    // Already past it on arrival: a redelivery, or a hand-over, of a run whose
    // budget expired meanwhile. Aborted now rather than on the next tick, which
    // a run with nothing left to do -- a script taken over after its last step
    // -- could finish ahead of, reporting a completion after its deadline. This
    // is called from executeRun, inside run()'s try, so the abort is caught.
    const delay = deadlineMs - Date.now();
    if (delay <= 0) {
      fire();
      return () => {};
    }
    const timer = setTimeout(fire, delay);
    timer.unref();
    return () => clearTimeout(timer);
  }

  /**
   * Renew the run row's lease while this process is executing it.
   *
   * Separate from the JetStream keepalive above, which tells the queue the
   * message is still being worked on. That is not the same statement: an
   * unacknowledged message says a delivery is outstanding, not that a worker
   * is alive, and reading liveness out of it takes the whole redelivery budget
   * to conclude anything. The row's lease says it directly, in seconds, and it
   * is the state the sweeper and the run API read.
   *
   * Each renewal also reports whether the run is executing or waiting on
   * something external, which is the measurement that decides whether handing
   * the slot back during waits is worth building (see tasks/run-phase.ts).
   */
  /**
   * This attempt's coverage, or nothing when it has none to report yet.
   *
   * The opening tick carries no covering field, whatever the clock did between
   * `beginRun` and it: a report that measured nothing must not advance the
   * row's watermark, and the interval stays visibly unbanked.
   */
  /**
   * The generation this attempt actually holds on the row.
   *
   * Two dispatch shapes keep it in two places. A claimed doorbell carries it in
   * `attempt.claimCount`, minted from the claim. A fat delivery's acceptance
   * mints one too -- `acquireFatLease` does `claim_count + 1` -- but hands it
   * back out of band, in the pre-gate context, because `attempt.claimCount` was
   * fixed at 0 when a fat delivery genuinely took no claim.
   *
   * It does take one now, so 0 is a stale answer, and every fence that reads it
   * refuses: the settle behind a nak returns `not_holder`, its coverage is
   * never banked, and the row keeps this attempt's token and a live lease that
   * turns the redelivery's first heartbeat away until the lease lapses. The
   * renewal path already asks the context; these are the two that did not.
   */
  private heldGeneration(): number {
    return currentFatDelivery()?.runClaim ?? this.attempt.claimCount;
  }

  private coverageReport(): { runTime: RunTimeReport } | null {
    if (!this.coverageOpened) return null;
    const snapshot = runTimeOf(this.runIdentity.key);
    if (!snapshot) return null;
    const covered = Object.values(snapshot.stateMs).some((ms) => (ms ?? 0) > 0);
    if (!covered) return null;
    return {
      runTime: {
        key: this.runIdentity.key,
        attemptId: this.attempt.attemptId,
        claimCount: this.heldGeneration(),
        deliverySeq: this.attempt.deliverySeq,
        deliveryCount: this.attempt.deliveryCount,
        // Differences, never instants, so the database's own budget bounds them.
        basis: { kind: "same_domain", domain: "brain" },
        cumulativeStateMs: snapshot.stateMs,
        cumulativeReasonMs: snapshot.reasonMs,
      },
    };
  }

  /**
   * Hand this attempt's coverage to the release about to be issued: it goes out
   * from the delivery loop, which has the task id and nothing else.
   */
  private declareCoverage(): void {
    declareFinalReport(this.request.task_id ?? "", this.coverageReport()?.runTime);
  }

  /**
   * End this attempt, then ask for the redelivery that follows it.
   *
   * A claimed run's wrapper takes the declaration and settles the row from the
   * delivery loop. A fat delivery's nak is a real JetStream nak that takes
   * nothing, so its attempt is settled here instead: otherwise its coverage is
   * never reported at all, and the row keeps this attempt's token and a live
   * lease that refuses the redelivery's first heartbeat until it lapses.
   */
  private async nakAfterAttempt(delayMs: number): Promise<void> {
    await this.releaseAttempt();
    this.msg.nak(delayMs);
  }

  /** End this attempt's hold on the row, so the next delivery can take it at once. */
  private async releaseAttempt(): Promise<void> {
    if (this.claimed) this.declareCoverage();
    else {
      // Through `settlementTaskIdOf`, not `request.task_id` alone. Reading the
      // wire only meant that a fat message from an API too old to carry the
      // field -- the whole of a rolling-upgrade window -- skipped this settle
      // entirely: no coverage banked, and the lease left live under an attempt
      // that has just asked for a redelivery, which is then refused
      // `superseded` and naks in turn until the lease lapses on its own.
      const taskId = settlementTaskIdOf(this.request);
      if (taskId) {
        await fx().settleRunAttempt(
          taskId, this.heldGeneration(), this.coverageReport()?.runTime, true,
        );
      }
    }
  }

  /**
   * Ack this delivery, having first handed the ack what the attempt covered.
   *
   * Only for a claimed run: a fat delivery's ack is a real JetStream ack that
   * takes no declaration, and its coverage has already gone out on `agent_done`.
   * Declaring there would leave an entry nothing ever takes.
   */
  private async ackTerminal(): Promise<void> {
    if (this.claimed) this.declareCoverage();
    await ackAndClearCallback(this.msg, this.kvCkpt, this.request);
  }

  /**
   * One renewal of the row's lease, naming the sandbox it is told to name.
   *
   * Its own method rather than a closure inside the heartbeat because the
   * terminal path sends one too (`recordSandboxBeforeReap`), and the body is
   * the part that must not drift between them: the row fences a renewal on the
   * attempt token and the generation, so a second sender assembling its own
   * body is a second chance to assemble it wrong. The heartbeat keeps the
   * verdict handling, which is the half that belongs to a run still going.
   */
  private renewLease(sandbox: LeaseRenewal["sandbox"]): Promise<string | null> {
    const phase = phaseOf(this.runIdentity.key);
    const runClaim = currentFatDelivery()?.runClaim;
    const coverage = this.coverageReport();
    // Only from the second renewal onward, by construction rather than because
    // the clock happened not to advance since `beginRun`.
    this.coverageOpened = true;
    return fx().postRunLease(this.request, {
      brainId: BRAIN_ID,
      sandbox,
      leaseSeconds: Math.ceil(RUN_LEASE_TTL_MS / 1000),
      phase: phase.phase,
      waitReason: phase.waitReason,
      waitedMs: phase.waitedMs,
      waits: phase.waits,
      attempt: this.attempt,
      ...(runClaim === undefined ? {} : { runClaim }),
      ...(coverage ?? {}),
    });
  }

  /**
   * Put this run's sandbox handle on the row before the reap takes the last
   * copy of it away.
   *
   * The heartbeat resolves the handle every RUN_LEASE_HEARTBEAT_MS (15s) and
   * the opening renewal carries none, so a run that dies inside its first
   * fifteen seconds sends exactly one renewal and it names nothing. That is not
   * a rare corner: the pre-ready family -- sandbox_exited_before_ready,
   * sandbox_gone, sandbox_pending_timeout -- is a pod dying during its own
   * provisioning, and a pod that never starts is over well inside one tick.
   *
   * What the row loses by it depends on the run. A task with a `callback_url`
   * carries the platform account itself, in `agent_done`'s platform fields. A
   * chat run has no callback at all -- `postAgentDone` and `postTaskRunning`
   * both return on the first line without one -- so `platformFacts` is read,
   * held, attached to a result nobody posts, and dropped; `exec_complete` has
   * no field for it. The row's own handle is what is left, and it is enough,
   * because platform-backfill asks SaFE with it later. Its KV fallback cannot
   * stand in here: `reapPendingHands` deletes the entry on the next line, which
   * is the whole reason this runs first.
   *
   * Only a handle this run is entitled to name, and only when there is a lease
   * to name it on. `reportableIdentity` refuses a READY entry some earlier
   * message left and a PENDING one this run did not provision, so the row is
   * never given a workload that is still somebody's live sandbox.
   *
   * A bounded wait ahead of the reap, like the platform read above it: one POST
   * capped at 5s by `askRunLease`, which answers `unresolved` rather than
   * throwing on anything it cannot complete.
   */
  private async recordSandboxBeforeReap(): Promise<void> {
    if (!this.request.run_lease?.url) return;
    const identity = await this.reportableIdentity().catch(() => null);
    const sandbox = sandboxForLease(identity);
    if (!sandbox) return;
    // The verdict is deliberately not read. `startLeaseHeartbeat` acts on a
    // refusal by aborting the run; this run has already ended, and aborting it
    // here would change how the failure in hand is filed on the way out.
    await this.renewLease(sandbox);
  }

  private startLeaseHeartbeat(): ReturnType<typeof setInterval> | null {
    // Tracked whether or not there is anywhere to report it to. The ledger is
    // what hands the execution slot back during a wait, and a run dispatched
    // by a path that does not issue leases waits exactly as long as any other.
    beginRun(this.runIdentity.key);
    if (!this.request.run_lease?.url) return null;
    const tick = (sandbox: LeaseRenewal["sandbox"]) => {
      void this.renewLease(sandbox).then((status) => {
        // The row no longer recognises this worker, and carrying on would mean
        // two workers driving one sandbox, or a run writing a workspace a
        // cancelled run is no longer entitled to -- the same reason a lost lock
        // aborts, arrived at from the other direction.
        //
        // Which ending it gets is the whole point of asking why. A row that
        // went terminal leaves this worker holding a sandbox and a delivery
        // nobody else can release; a row another worker took over leaves it
        // holding neither, whatever it still has handles for.
        // A Stop this run never heard on the wire.
        //
        // The interrupt is core NATS and at-most-once, and it is dropped by
        // every pod with no abort registered for the address -- which this pod
        // is, from the moment the claim writes the lease until `activeAbort`
        // is populated two KV round trips later. A Stop landing in there wrote
        // `cancelling` on the row and then had nothing left to reach: the
        // durable half deliberately leaves a held row to its holder, and the
        // holder was not listening yet. Anything else that loses the publish
        // -- a pod restarting, a blip on the subject -- ends the same way.
        //
        // `postRunLease` has answered with the row's status all along, for
        // exactly this ("so a caller can notice a run that has been
        // cancelled"), and the fat delivery path already stops on it. This is
        // the doorbell half of the same answer, one heartbeat behind at worst.
        //
        // Aborted with no reason on purpose: `cancelling` is not a terminal
        // row and this replica still owns everything it holds, so the generic
        // branch -- the one that files the ending as a user interrupt -- is
        // the true account of what happened.
        if (status === "cancelling") {
          // (a Stop during a drain cuts the call the drain was letting finish: the person asked for it to stop)
          this.cutDrainedCalls("cancelled");
          if (this.abortCtrl.signal.aborted) return;
          logger.info(
            { sessionId: this.sessionId, messageId: this.messageId,
              taskId: this.request.task_id },
            "run.stop_seen_on_renewal",
          );
          this.abortCtrl.abort();
          return;
        }
        const refused = status === "gone" || status === "superseded";
        // Recorded before the early return, exactly as the lock renewal does.
        // `superseded` means another worker holds this run, which is the same
        // news as a lost lock and arrives by a different road -- fixing only
        // the other road left this one swallowed by any earlier abort. `gone`
        // is not: the row went terminal and nobody took over, so this worker is
        // still the one holding the sandbox.
        if (status === "superseded") this.noteLeaseLost();
        if (status === "gone") this.cutDrainedCalls(RUN_ROW_TERMINAL_ABORT_REASON);
        if (!refused || this.abortCtrl.signal.aborted) return;
        logger.error(
          { sessionId: this.sessionId, messageId: this.messageId,
            taskId: this.request.task_id, refusal: status },
          "run.lease_refused",
        );
        this.abortCtrl.abort(
          status === "gone" ? RUN_ROW_TERMINAL_ABORT_REASON : LEASE_LOST_ABORT_REASON,
        );
      }).catch(() => { /* renewal already logs; a failure is not a verdict */ });
    };
    // The opening renewal is sent without resolving anything, unlike the ones
    // on the interval below. `handOffRenewal` releases the delivery layer's
    // pre-gate heartbeat the moment this method returns, so a first renewal
    // parked behind an await -- even a KV read -- is a stretch with nobody
    // renewing the row, which is a live run another pod's reaper finds expired.
    // Nothing is given up for it: this runs before `executeRun` has asked for a
    // sandbox, so there is no PENDING entry of this attempt's to find, and
    // `handsIdentity` is null for the same reason.
    //
    // What resolves it is the interval below -- one tick later, and only if the
    // run lasts that long. A pod killed during its own provisioning usually
    // does not, which is why the terminal path sends its own renewal rather
    // than relying on this timer to have come round: see
    // `recordSandboxBeforeReap`.
    tick(sandboxForLease(this.handsIdentity));
    // Never at the cost of the renewal itself: a handle that cannot be resolved
    // is a missing diagnostic, while a renewal that never goes out is a run
    // taken away from a user, so the tick is sent either way.
    const timer = setInterval(
      () => {
        void this.reportableIdentity()
          .catch(() => null)
          .then((identity) => tick(sandboxForLease(identity)));
      },
      RUN_LEASE_HEARTBEAT_MS,
    );
    timer.unref();
    return timer;
  }

  /**
   * Another replica holds this run now. Recorded whatever else happened, and a
   * call a drain is letting finish (`agent/drain-shield.ts`) is cut at once:
   * the drain's abort came first, so the run's signal cannot carry this news.
   * The same holds for a Stop and a terminal row (`cutDrainedCalls`).
   */
  private noteLeaseLost(): void {
    this.leaseLost = true;
    this.cutDrainedCalls(LEASE_LOST_ABORT_REASON);
  }

  /** Cut, at once, a call a drain is letting finish: the run has to stop touching the sandbox now, for `reason`. */
  private cutDrainedCalls(reason: unknown): void {
    if (this.abortCtrl.signal.reason === SIGTERM_ABORT_REASON) cutDrainedCalls(this.abortCtrl.signal, reason);
  }

  private startDeliveryHeartbeat(): void {
    // keepAlive must be much shorter than the consumer's ack_wait to avoid
    // redelivery while a task is still making progress. That is
    // TASK_CONSUMER_ACK_WAIT_NS, two minutes, against the ten seconds here.
    this.keepAlive = setInterval(() => {
      try { this.msg.working(); } catch {}
      fx().refreshTaskLock(this.lockKey).then((renewal) => {
        const yielding = renewal === "lost" || renewal === "expired";
        // Recorded before the early return. An abort that already happened for
        // an ordinary reason -- a user interrupt, say -- used to swallow the
        // news entirely, because the only trace of a lost lease was the abort
        // REASON and that slot was taken. Teardown then read the successor's
        // entry, asked whether it still held the lock, and was told yes.
        if (yielding) this.noteLeaseLost();
        if (!yielding || this.abortCtrl.signal.aborted) return;
        logger.error(
          { sessionId: this.sessionId, messageId: this.messageId, lockKey: this.lockKey, renewal },
          "task.lease_lost",
        );
        this.abortCtrl.abort(LEASE_LOST_ABORT_REASON);
      }).catch(() => {});
      readHandsEntry(this.kv, this.sessionId).then(e => {
        if (e) this.kv.update(e.key, sc.encode(e.value), e.revision).catch((err) => {
          logger.warn({ err: err?.message || String(err), sessionId: this.sessionId }, "task.kv_ttl_refresh_failed");
        });
      }).catch((err) => {
        logger.warn({ err: err?.message || String(err), sessionId: this.sessionId }, "task.kv_ttl_get_failed");
      });
    }, LOCK_REFRESH_INTERVAL_MS);

    // The renewal above only reports once its write has answered, and a write
    // to an unreachable NATS answers late or never -- while another brain may
    // take a lock that names its run once it has gone unwritten for
    // TASK_LOCK_DEAD_HOLDER_MS. So the deadline is also watched locally, on a
    // timer short enough that this run stops (and runs no further tool) before
    // that moment: `lockPastSelfFence` fires one refresh interval ahead of it,
    // counted from when the last successful renewal was sent.
    this.selfFence = setInterval(() => {
      if (!fx().lockPastSelfFence(this.lockKey)) return;
      this.noteLeaseLost();
      if (this.abortCtrl.signal.aborted) return;
      logger.error(
        { sessionId: this.sessionId, messageId: this.messageId, lockKey: this.lockKey },
        "task.lock_self_fenced",
      );
      metrics.onLockSelfFenced();
      this.abortCtrl.abort(LEASE_LOST_ABORT_REASON);
    }, SELF_FENCE_CHECK_MS);
    this.selfFence.unref?.();
  }

  private async executeRun(): Promise<void> {
    if (this.msg.info.deliveryCount > 1) {
      await this.onEvent({
        type: "taskResumed",
        delivery_count: this.msg.info.deliveryCount,
        wallclock_ms: Date.now(),
      }).catch((e) =>
        logger.warn({ err: e, sessionId: this.sessionId }, "task.resumed_event_failed"),
      );
    }

    await this.resolvePlatformKey();

    this.pendingResumeCkpt = await this.readKvCheckpoint();
    // Armed only here, after the checkpoint read directly above, and not when
    // the run was set up. A deadline that is already past on arrival -- a
    // redelivery of a run whose budget expired while it was queued, which is
    // the resumed case this reports on -- fires on the next tick, and armed
    // any earlier that tick lands before `pendingResumeCkpt` is assigned, so
    // the run's turn count reads as zero in the one log line that exists to
    // say how far it had got. What this gives up is the deadline's cover over
    // three awaits, not one -- the taskResumed emit, the platform-key fetch
    // and the checkpoint read. None of them observes the abort signal, so
    // arming earlier could not have cut any of them short, and both KV reads
    // are inside try/catch behind the client's own request timeout.
    this.cancelDeadline = this.armDeadline();
    if (this.request.mode === "app") {
      await this.executeAppRun();
      return;
    }
    let upFront = this.needsSandboxUpFront(this.pendingResumeCkpt);
    const prestart = !upFront && wantsSandboxPrestart(this.request);
    if (upFront) {
      try {
        await this.attachHands();
      } catch (err) {
        if (!this.mayResumeWithoutSandbox(err)) throw err;
        logger.warn(
          { sessionId: this.sessionId, messageId: this.messageId, reason: sandboxUnavailableOf(err)?.reason },
          "task.resume.sandbox_unavailable_continuing",
        );
        upFront = false;
      }
    }
    if (!upFront) {
      this.resumeWithoutSandbox();
      await this.startWithoutSandbox(prestart);
    }
    await this.reconcileBackgroundStarts();
    // After the reconciliation, which reads the session's existing sandbox binding
    // and must not find this run's own provisioning in its place.
    if (prestart) this.prestartSandbox();

    let result: ExecuteResult;
    try {
      result = await this.executeEngine();
    } finally {
      await this.retireUnclaimedPrestart();
    }

    // MCP SDK 1.12 does not propagate AbortSignal through callTool.
    //
    // A script is handed over here even if it reached its end just as the
    // drain began: every step it finished is recorded, so the next worker runs
    // nothing again and reports the outcome with the time it needs, rather than
    // this pod racing its grace period through the terminal path.
    if (this.abortCtrl.signal.reason === SIGTERM_ABORT_REASON) {
      logger.info(
        { sessionId: this.sessionId, messageId: this.messageId,
          engineAbortReason: result.abortReason ?? "completed", turns: result.turns },
        "task.engine_execute_done.sigterm_detour",
      );
      throw SIGTERM_ABORT_REASON;
    }
    if (this.abortCtrl.signal.aborted) {
      throw this.abortCtrl.signal.reason ?? new Error("cancelled by user");
    }

    await this.finalizeSuccess(result);
  }

  /**
   * A run of mode `app`: the AppRunner drives the application in its own
   * sandbox under this run's lease, which the heartbeat started in `run()`
   * keeps renewing. There is no Hands, no engine and no workspace sync here.
   *
   * How it ends decides who owns the sandbox afterwards. A finished run was
   * wound up by the AppRunner itself. A run that lost its lease or is being
   * drained for a restart is left exactly as it is, for the Brain that takes it
   * over to reconcile. Anything else -- a cancel, the deadline, a row that went
   * terminal -- is a run nobody else will finish, so it is finished here.
   */
  private async executeAppRun(): Promise<void> {
    const runId = this.request.task_id;
    const finishOnly = this.request.app_finish_only === true;
    // Not an AppRunFailedError: that means the app run is already `ended` on its row
    // (see handleRunFailure), and these two are refusals made before anything ran.
    if (!runId) throw new Error("an app run needs a task id");
    const epoch = this.heldGeneration();
    // Without it SaFE cannot be asked for anything, and every tick would fail the same way.
    if (!this.platformKey && finishOnly) {
      // The task is already over for the user: no terminal report. The sweeper hands the finish over again.
      logger.error({ taskId: runId }, "task.app_finish_only_without_platform_key");
      throw new FinishOnlyHandOver("no platform key");
    }
    if (!this.platformKey) {
      const closed = await fx().createAppRunner(runId, "", epoch)
        .markEnded("the session owner's platform key is not available to this worker")
        .catch((err) => { logger.error({ err: String(err?.message ?? err), taskId: runId }, "task.app_run_close_failed"); return false; });
      // Any sandbox an earlier worker made is not stopped from here (no key to
      // stop it with); it ends with its workload time limit.
      if (!closed) {
        // The row was not closed (another worker holds it, or it could not be written):
        // it is not `ended`, so this is not the terminal AppRunFailedError.
        logger.error({ taskId: runId }, "task.app_run_row_left_open_no_platform_key");
        throw new Error("an app run needs the session owner's platform key");
      }
      throw new AppRunFailedError("an app run needs the session owner's platform key");
    }
    // A session that acts as a user is not given a hosted application's sandbox, which is made with the owner's model key (the API refuses
    // to admit one). A run admitted before it did is wound up here instead of started: whatever sandbox an earlier worker made is stopped and
    // the grant revoked, as for a cancel, and the row is ended. Not a finish-only dispatch: that is this already.
    if (this.request.withhold_sandbox_keys === true && !finishOnly) {
      await fx().createAppRunner(runId, this.platformKey, epoch).finishNow("cancelled");
      throw new AppRunFailedError("a hosted application is not run for a session that acts as a user");
    }
    const runner = fx().createAppRunner(runId, this.platformKey, epoch);
    // A finish-only dispatch is not a run starting: the task is already over as far as the
    // user is concerned, so nothing says "running" and nothing reports a terminal state.
    if (!finishOnly) {
      await this.onEvent({ type: "statusUpdate", agentStatus: "running" });
      await fx().postTaskRunning(this.request, { brainId: BRAIN_ID, attempt: this.attempt });
    }

    // The run's signal also cuts short a wait for the sandbox. Whether the workload
    // being waited on is stopped there follows the same split as below: a run this
    // Brain finishes (a cancel, the deadline, a terminal row) stops it at once; a
    // run handed over (a drain, a lost lease) leaves it for its successor to adopt.
    const result = await runner.run(this.abortCtrl.signal, {
      reclaimOnAbort: () => this.stillOwnsLock() && this.abortCtrl.signal.reason !== SIGTERM_ABORT_REASON,
    });
    if (result.kind === "ended" && finishOnly) {
      await this.settleFinishOnly();
      return;
    }
    if (result.kind === "ended") {
      if (!result.outcome.success) throw new AppRunFailedError(result.outcome.reason, result.outcome.captures);
      await this.finalizeAppSuccess(result.outcome);
      return;
    }

    if (result.kind === "superseded" && !this.abortCtrl.signal.aborted) {
      this.leaseLost = true;
      this.abortCtrl.abort(LEASE_LOST_ABORT_REASON);
    }
    const reason = this.abortCtrl.signal.reason;
    const handedOver = reason === SIGTERM_ABORT_REASON || reason === LEASE_LOST_ABORT_REASON;
    if (!handedOver) {
      // The grace wait of a cancel can outlast the 30 s the interrupt handler
      // gives a run before it releases the lock by force; this run is not stuck.
      markGracefulStop(this.abortCtrl);
      const cause = reason === DEADLINE_EXCEEDED_ABORT_REASON ? "deadline"
        : reason === RUN_ROW_TERMINAL_ABORT_REASON ? "row_terminal" : "cancelled";
      const outcome = await runner.finishNow(cause).catch((err) => {
        logger.error({ err: String(err?.message ?? err), taskId: this.request.task_id }, "task.app_finish_failed");
        return null;
      });
      // An application that wrote a successful `final` within its grace keeps its
      // own result: reported as the success it is, with its captures, not as the
      // cancel that asked it to stop.
      if (outcome && finishOnly) {
        await this.settleFinishOnly();
        return;
      }
      if (outcome?.success) {
        await this.finalizeAppSuccess(outcome);
        return;
      }
    }
    // Finish-only never reports a terminal state, whatever stopped it (a finish that kept failing,
    // the deadline): the lease lapses and the sweeper hands the finish over again.
    if (finishOnly && !handedOver) throw new FinishOnlyHandOver(String(reason ?? "finish not completed"));
    throw reason ?? new Error("cancelled by user");
  }

  /**
   * A finish-only dispatch is over: the run row is `ended`. The task goes back to the
   * terminal state it had, with no event, and the delivery is settled. If Backend would not
   * settle it (the lease went) the delivery is given back instead of dropped.
   */
  private async settleFinishOnly(): Promise<void> {
    const settled = await fx().postAppFinishDone(this.request, BRAIN_ID);
    await this.releaseAfterTerminal();
    if (settled) this.msg.ack(); else this.msg.nak(5_000);
  }

  /** Report an app run that ended as a success. */
  private async finalizeAppSuccess(outcome: AppRunOutcome): Promise<void> {
    await this.finalizeSuccess({
      finalText: outcome.reason,
      tokenUsage: { input_tokens: 0, output_tokens: 0, cache_read: 0, cache_create: 0, turns: 0 },
      turns: 0,
      pendingSkills: [],
      skillsUsed: {},
      errorCount: 0,
      toolStats: { total_calls: 0, error_calls: 0, by_tool: {} },
      elapsedMs: this.elapsedMsForRun(),
      ...(outcome.captures ? { captures: outcome.captures } : {}),
    });
  }

  private failureOutcome(err: unknown): TaskOutcome {
    if (err instanceof FinishOnlyHandOver) return "retryable";
    if (err instanceof AppRunFailedError && this.stillOwnsLock()) return "failed";
    if (this.abortCtrl.signal.reason === SIGTERM_ABORT_REASON) return "retryable";
    // `stillOwnsLock()` rather than the abort reason alone: the reason belongs
    // to whoever aborted first, so a run interrupted normally and THEN
    // superseded carries an ordinary reason while the lock has moved. Losing
    // it is retryable either way -- a second replica is already running this
    // task -- and this has to agree with `handleRunFailure` below, which
    // dispatches on the same question.
    if (!this.stillOwnsLock()) return "retryable";
    if (this.abortCtrl.signal.reason === RUN_ROW_TERMINAL_ABORT_REASON) return "failed";
    if (this.abortCtrl.signal.reason === DEADLINE_EXCEEDED_ABORT_REASON) return "failed";
    if (this.abortCtrl.signal.aborted) return "interrupted";
    if (err instanceof AgentDoneDeliveryError) return "retryable";
    if (provisionTerminalOf(err)) return "failed";
    return isRetryable(err) ? "retryable" : "failed";
  }

  private async handleRunFailure(err: any): Promise<void> {
    if (err instanceof FinishOnlyHandOver) {
      // No agent_done and no status update: the task keeps the terminal state it had.
      logger.warn({ taskId: this.request.task_id, why: err.message }, "task.app_finish_only_handed_over");
      await this.releaseAfterTerminal();
      // Give the lease on the task row back, as every other ending does, so the sweeper hands
      // the finish over at once rather than after the lost-lease grace as a lost worker.
      await fx().postAppFinishHandOver(this.request, BRAIN_ID);
      await this.releaseAttempt().catch((e) => logger.warn({ err: String(e?.message ?? e) }, "task.app_finish_only_release_failed"));
      this.msg.ack();
      return;
    }
    if (this.abortCtrl.signal.reason === SIGTERM_ABORT_REASON) {
      await this.handleSigtermAbort();
      return;
    }
    // Same question as `failureOutcome`, and it must be asked the same way: a
    // run that was aborted for an ordinary reason and then lost the lock has
    // the lock gone and the reason taken.
    if (!this.stillOwnsLock()) {
      this.handleLeaseLost();
      return;
    }
    if (this.abortCtrl.signal.reason === RUN_ROW_TERMINAL_ABORT_REASON) {
      await this.handleRunRowTerminal();
      return;
    }

    if (this.abortCtrl.signal.reason === DEADLINE_EXCEEDED_ABORT_REASON) {
      await this.settleTerminal(
        () => this.handleFatalError(
          new Error(
            `run_budget_exhausted: the run reached its deadline of ${this.request.deadline_at} `
            + `after ${this.reportedCkpt?.turns_completed ?? 0} turns`,
          ),
        ),
        "task.deadline_agent_done_delivery_exhausted",
      );
      return;
    }

    if (this.abortCtrl.signal.aborted) {
      await this.settleTerminal(
        () => this.handleUserInterrupt(),
        "task.cancelled_agent_done_delivery_exhausted",
      );
      return;
    }
    if (err instanceof AgentDoneDeliveryError) {
      logger.error(
        { err, sessionId: this.sessionId, taskId: this.request.task_id },
        "task.agent_done_delivery_exhausted",
      );
      await this.releaseAfterTerminal();
      this.msg.nak(5_000);
      return;
    }
    if (err instanceof AppRunFailedError) {
      // Terminal by construction: the app run is already `ended` on its row, so
      // a redelivery could only report the same failure again.
      await this.settleTerminal(
        () => this.handleFatalError(err),
        "task.app_run_failed_agent_done_delivery_exhausted",
      );
      return;
    }
    if (provisionTerminalOf(err)) {
      await this.settleTerminal(
        () => this.handleFatalError(err),
        "task.provision_terminal_agent_done_delivery_exhausted",
      );
      return;
    }
    if (isRetryable(err)) {
      await this.handleRetryableError(err);
      return;
    }
    await this.settleTerminal(
      () => this.handleFatalError(err),
      "task.failed_agent_done_delivery_exhausted",
    );
  }

  private async finishRun(
    outcome: TaskOutcome | null,
    runStartedAt: number,
    leaseTimer: ReturnType<typeof setInterval> | null,
  ): Promise<void> {
    if (outcome) metrics.onTask(outcome, (Date.now() - runStartedAt) / 1000);
    this.cancelDeadline();
    clearInterval(this.keepAlive);
    if (this.selfFence) clearInterval(this.selfFence);
    if (leaseTimer) clearInterval(leaseTimer);
    endRun(this.runIdentity.key);
    clearActiveAbort(this.lockKey, this.abortCtrl);
    await fx().releaseTaskLock(this.lockKey, this.abortCtrl);
    await this.hands?.close().catch(() => {});
  }

  async run(): Promise<void> {
    // Every terminal ending sets this -- the catch through `failureOutcome`,
    // the happy path here -- and the `finally` reports it once. Recording it
    // inside each terminal branch instead would mean nine call sites and a
    // silent gap the first time a tenth is added, and the gap would read as
    // "no tasks ran", which is the same shape as an outage.
    const runStartedAt = Date.now();
    let outcome: TaskOutcome | null = null;
    const leaseTimer = this.startLeaseHeartbeat();
    // Only once this run's own renewal is armed, so the two owners overlap:
    // the delivery layer keeps the lease alive until this line, and a gap
    // between them is a lease another pod could take the row over on.
    if (leaseTimer) currentFatDelivery()?.handOffRenewal();
    this.startDeliveryHeartbeat();
    try {
      await this.executeRun();
      outcome = "ok";
    } catch (err) {
      outcome = this.failureOutcome(err);
      await this.handleRunFailure(err);
    } finally {
      await this.finishRun(outcome, runStartedAt, leaseTimer);
    }
  }
}

/**
 * Entry point called from index.ts handleTask() once the lock is held and
 * the abort controller is registered. Handles the sandboxless fast path,
 * then delegates the full sandbox/engine/checkpoint flow to a TaskRunner.
 */
export async function runHandleTask(
  msg: JsMsg,
  request: ExecuteRequest,
  sessionId: string,
  lockKey: string,
  messageId: string,
  userId: string,
  abortCtrl: AbortController,
  claim: RunClaim = null,
): Promise<void> {
  // Before anything decides the run's sandbox (a multi-node cluster, the image, the workspace): a requested review keeps only its fixed
  // profile, and the prompt that holds the requester's words is not read as configuration (`agent/review-profile.ts`).
  applyReviewProfileBackstop(request);
  if (await replayPendingCallback(msg, request, lockKey, abortCtrl)) return;
  if (await finishEndedTurn(msg, request, sessionId, messageId, lockKey, abortCtrl)) return;
  if (await refuseUnsupportedMode(msg, request, sessionId, lockKey, abortCtrl)) return;
  if (await refuseReviewWithoutTurnBudget(msg, request, sessionId, lockKey, abortCtrl)) return;
  if (await maybeRunSandboxlessTask(msg, request, sessionId, lockKey, abortCtrl)) return;
  await new TaskRunner(
    msg, request, sessionId, lockKey, messageId, userId, abortCtrl, claim,
  ).run();
}
