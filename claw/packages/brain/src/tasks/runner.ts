// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { StringCodec, type JsMsg, type KV } from "nats";
import type { ExecuteRequest, ExecuteResult } from "@claw/protocol";
import {
  HandsRebuildFailed,
  HandsRecoveryBudgetExhausted,
  HandsRecoveryRefused,
  type CheckpointState,
  type Engine,
  type HandsRecoveryAllowance,
  type RecreateHandsResult,
} from "../agent/index.js";
import type { NatsEmitter } from "../events/emitter.js";
import { HandsClient, isHandsNetworkError } from "../clients/hands.js";
import {
  syncWorkspaceToS3, syncWorkspaceFromS3, archiveRunToS3, copyS3Prefix, TRANSCRIPT_PREFIX,
} from "../workspace/s3-uploader.js";
import { syncWorkspace, restoreWorkspace } from "../workspace/sync.js";
import {
  workspaceSyncSemaphore,
  workspaceSigtermSyncSemaphore,
} from "../workspace/sync-semaphore.js";
import { isRetryable } from "../infra/retry.js";
import { unregisterSandbox, markHandsIdle } from "../sandbox/keepalive.js";
import { markRetryPending } from "./retry-pending.js";
import { isSessionDeletedLocally } from "../infra/deleted-sessions.js";
import { classifyResumeOutcome } from "./resume-outcome.js";
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
  TASK_MAX_DELIVER, BRAIN_LAZY_SANDBOX,
  RUN_LEASE_HEARTBEAT_MS, RUN_LEASE_TTL_MS,
  LOCK_REFRESH_INTERVAL_MS,
  SANDBOX_HANDS_RESTART_ENABLED,
} from "../config.js";
import { ensureHands } from "../sandbox/ensure-hands.js";
import { isMultiNodeRequest } from "../sandbox/multi-node/prompt-flags.js";
import { getMultiNodeProvider, multiNodeAvailable } from "../sandbox/multi-node/factory.js";
import type { MultiNodeContext } from "../sandbox/multi-node/types.js";
import { destroyHands, reapPendingHands, classifySandboxFailure } from "../sandbox/reaper.js";
import { probeSandboxContainer } from "../sandbox/container-probe.js";
import type { ContainerProbeVerdict, HandsProbeEntry } from "../sandbox/container-probe.js";
import { checkHandsHealth } from "../sandbox/hands-health.js";
import { restartHandsInSandbox } from "../sandbox/hands-restart.js";
import { resolveSandboxAction } from "../sandbox/params.js";
import { SandboxProvisionTerminalError } from "../sandbox/errors.js";
import { runScript } from "./script-runner.js";
import {
  AgentDoneDeliveryError, postAgentDone, postRunLease, postTaskRunning,
} from "./callback.js";
import { beginRun, endRun, phaseOf } from "./run-phase.js";
import {
  activeAbort, LEASE_LOST_ABORT_REASON, SIGTERM_ABORT_REASON,
  DEADLINE_EXCEEDED_ABORT_REASON, RUN_ROW_TERMINAL_ABORT_REASON,
} from "./abort-registry.js";
import { pickRunScope, refreshTaskLock, releaseTaskLock } from "./lock.js";
import {
  redactEgressPayload, redactPersistedEvent, type RuntimeSecrets,
} from "../events/redaction.js";
import {
  encodeCheckpoint, decodeCheckpoint, type CheckpointEnvelope,
} from "./checkpoint-codec.js";
import pino from "pino";
import { metrics, type TerminalRefusalReason, type TaskOutcome } from "../infra/metrics.js";

const logger = pino({ name: "task-runner" });
const sc = StringCodec();

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
): Promise<void> {
  if (!request.task_id) {
    await fx().postAgentDone(request, result);
    return;
  }
  const key = pendingCallbackKey(request.task_id);
  await kvCkpt.put(key, sc.encode(JSON.stringify(result)));
  await fx().postAgentDone(request, result);
}

async function ackAndClearCallback(msg: JsMsg, kvCkpt: KV, request: ExecuteRequest): Promise<void> {
  msg.ack();
  if (!request.task_id) return;
  await kvCkpt.delete(pendingCallbackKey(request.task_id)).catch((err) => {
    logger.warn({ err, taskId: request.task_id }, "task.agent_done_outbox_cleanup_failed");
  });
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
  };
  if (messageId) event.message_id = messageId;

  const result: ExecuteResult = {
    finalText,
    tokenUsage: { input_tokens: 0, output_tokens: 0, cache_read: 0, cache_create: 0, turns: 0 },
    turns: 0,
    pendingMemories: [],
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
  restartHandsInSandbox: typeof restartHandsInSandbox;
  unregisterSandbox: typeof unregisterSandbox;
  markHandsIdle: typeof markHandsIdle;
  markRetryPending: typeof markRetryPending;
  syncWorkspaceToS3: typeof syncWorkspaceToS3;
  syncWorkspaceFromS3: typeof syncWorkspaceFromS3;
  archiveRunToS3: typeof archiveRunToS3;
  copyS3Prefix: typeof copyS3Prefix;
  syncWorkspace: typeof syncWorkspace;
  restoreWorkspace: typeof restoreWorkspace;
  postAgentDone: typeof postAgentDone;
  postTaskRunning: typeof postTaskRunning;
  postRunLease: typeof postRunLease;
  runScript: typeof runScript;
  refreshTaskLock: typeof refreshTaskLock;
  releaseTaskLock: typeof releaseTaskLock;
  flushTranscript: typeof flushTranscript;
  /** Constructing the client is itself a seam: it opens an MCP transport. */
  makeHandsClient: (url: string, token: string, owner: string, run: string) => HandsClient;
}

const REAL_SIDE_EFFECTS: TaskRunnerSideEffects = {
  ensureHands,
  destroyHands,
  reapPendingHands,
  probeSandboxContainer,
  restartHandsInSandbox,
  unregisterSandbox,
  markHandsIdle,
  markRetryPending,
  syncWorkspaceToS3,
  syncWorkspaceFromS3,
  archiveRunToS3,
  copyS3Prefix,
  syncWorkspace,
  restoreWorkspace,
  postAgentDone,
  postTaskRunning,
  postRunLease,
  runScript,
  refreshTaskLock,
  releaseTaskLock,
  // Hoisted function declaration: the binding exists before this const runs.
  flushTranscript,
  makeHandsClient: (url, token, owner, run) => new HandsClient(url, token, owner, run),
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
function classifyTaskFailure(rawMsg: string): {
  reason: string;
  userText: string;
} {
  const msg = String(rawMsg || "");
  const reqIdMatch = msg.match(/"request_id"\s*:\s*"(req_[A-Za-z0-9_]+)"/);
  const reqIdSuffix = reqIdMatch ? ` (vendor request_id: ${reqIdMatch[1]})` : "";

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
    activeAbort.delete(lockKey);
    await fx().releaseTaskLock(lockKey).catch(() => {});
    return true;
  }
  if (!entry) return false;

  try {
    const result = JSON.parse(sc.decode(entry.value)) as ExecuteResult;
    await fx().postAgentDone(request, result);
    await ackAndClearCallback(msg, kvCkpt, request);
    logger.info({ taskId: request.task_id }, "task.agent_done_replayed");
  } catch (err) {
    logger.error({ err, taskId: request.task_id }, "task.agent_done_replay_failed");
    msg.nak(5_000);
  } finally {
    activeAbort.delete(lockKey);
    await fx().releaseTaskLock(lockKey).catch(() => {});
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
        pendingMemories: [],
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
    activeAbort.delete(lockKey);
    await fx().releaseTaskLock(lockKey).catch(() => {});
  }
  return true;
}

/**
 * Encapsulates one in-flight task execution (sandbox lifecycle, resume
 * decision, engine dispatch, checkpointing, and all terminal-state
 * handling). One instance per task; never reused across tasks.
 */
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
   * This one execution, as Hands files background shells under it.
   *
   * The task id, so a redelivered attempt of the same run re-adopts the shells
   * the previous attempt started rather than orphaning them. Falls back to the
   * message id for the legacy chat path, which dispatches without a task row.
   */
  private readonly runId: string;

  /**
   * The scope those shells are addressable in: this DAG, or this conversation.
   *
   * Not the gate key, even though it used to be the same string. The gate now
   * keys on the workspace, which several sessions can share, and passing it here
   * would let one session poll and kill another's background processes.
   */
  private readonly handsOwner: string;

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
  private readonly transcriptLog: Array<Record<string, unknown>> = [];

  // Mutable checkpoint state (updated by onCheckpoint callback).
  private latestCheckpointState: CheckpointState | null = null;
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
  // Workload id from this run's identity, never the DAG-shared session key.
  private handsWorkloadId = "";
  private multiNodeContext: MultiNodeContext | null = null;
  private inflightCkptHasData = false;
  private inflightCkptInProgress = false;

  private resumeCheckpoint: CheckpointState | undefined;
  private resumeMode: "sandbox_reuse" | "workspace_restore"
                    | "no_data_turn0" | "skip_no_ckpt" = "skip_no_ckpt";
  // Read from KV before any provisioning and consumed by the sandbox attach,
  // which may happen much later than the read on a deferred run.
  private pendingResumeCkpt: TaskCheckpoint | null = null;
  private handsAttach: Promise<HandsClient> | null = null;
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
    this.handsOwner = pickRunScope(request);

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

  private readonly onEvent = async (evt: Record<string, unknown>): Promise<void> => {
    const safeEvent = redactPersistedEvent(
      evt,
      runtimeSecrets(this.request, this.platformKey),
    );
    if (this.messageId) safeEvent.message_id = this.messageId;
    this.transcriptLog.push({ ts: Date.now(), ...safeEvent });
    await this.emitter.emit(this.sessionId, safeEvent);
  };

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
    if (
      WORKSPACE_PERSIST_BASE
      && this.userIdHex
      && this.hands
      && !this.pendingSync
      && now - this.lastSyncAt > WORKSPACE_SYNC_INTERVAL_MS
    ) {
      this.lastSyncAt = now;
      const frozenHands = this.hands;
      const frozenUidHex = this.userIdHex;
      const turnSnapshot = state.turns_completed;
      this.pendingSync = workspaceSyncSemaphore
        .run(() => fx().syncWorkspace(frozenHands, this.sessionId, frozenUidHex, turnSnapshot))
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
          return info;
        })
        .catch((e) => {
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
    );
    if (this.abortCtrl.signal.aborted) {
      throw new Error("sandbox recovery aborted after destroy");
    }
    // Best-effort close of the dead client (its socket is likely already
    // wedged; ignore failures).
    const oldHands = this.hands;
    oldHands?.close().catch(() => {});
    // Pass multiNodeContext so the rebuilt sandbox keeps Hyperloom external-mode
    // env and the Infera SSH key for the cluster already provisioned above.
    const { handsUrl: newUrl, token: newToken, identity: newIdentity } = await fx().ensureHands(
      this.sessionId, this.request, this.platformKey, this.onEvent, this.multiNodeContext ?? undefined,
      { skipSessionReuse: true, signal: this.abortCtrl.signal },
    );
    const newHands = fx().makeHandsClient(newUrl, newToken, this.handsOwner, this.runId);
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
    // Always rehydrate after a rebuild: the new sandbox is empty regardless
    // of whether ensureHands reused a (concurrently-revived) KV entry.
    try { await fx().syncWorkspaceFromS3(newHands, this.sessionId, this.request.user_id || "default"); } catch (e) {
      logger.warn({ err: e, sessionId: this.sessionId }, "s3.restore_failed_after_rebuild");
    }
    this.handsUrl = newUrl;
    this.handsToken = newToken;
    this.handsIdentity = newIdentity ?? null;
    this.handsWorkloadId = newIdentity?.workloadId ?? "";
    this.hands = newHands;
    await fx().postTaskRunning(this.request, {
      brainId: BRAIN_ID,
      sandboxWorkloadId: this.handsWorkloadId,
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
      this.handsUrl, this.handsToken, this.handsOwner, this.runId,
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
      const e = await this.kv.get(`hands.${this.sessionId}`);
      if (e) {
        const info = JSON.parse(sc.decode(e.value));
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
    if (this.handsIdentity) {
      fx().unregisterSandbox(this.sessionId, this.handsIdentity);
    } else if (this.handsWorkloadId) {
      fx().unregisterSandbox(this.sessionId, { workloadId: this.handsWorkloadId });
    }
    if (this.handsIdentity) {
      fx().markHandsIdle(this.kv, this.sessionId, this.handsIdentity);
    } else if (this.handsWorkloadId) {
      fx().markHandsIdle(this.kv, this.sessionId, this.handsWorkloadId);
    }
    logger.info({ sessionId: this.sessionId, workloadId: this.handsWorkloadId }, "keepalive.stopped_after_task");
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
  private async reapBackgroundShells(): Promise<void> {
    const isDagNode = !!(this.request.dag_root_task_id || this.request.dag_node_id);
    if (this.shellsReaped || !isDagNode || !this.hands) return;
    try {
      const stopped = await this.hands.reapShells();
      this.shellsReaped = true;
      if (stopped > 0) {
        logger.info(
          { sessionId: this.sessionId, taskId: this.request.task_id, stopped },
          "task.background_shells_reaped",
        );
      }
    } catch (e) {
      logger.warn(
        { err: (e as Error)?.message ?? e, sessionId: this.sessionId, taskId: this.request.task_id },
        "task.background_shells_reap_failed",
      );
    }
  }

  /**
   * A sandbox is provisioned before the first turn only when the run is about
   * the sandbox: script mode drives a fixed tool sequence with no model in
   * between, a multi-node run exists to get its cluster, and a resumed run
   * needs its /workspace rehydrated before the model sees a single message.
   * Every other run — the ordinary chat turn — gets one the first time a tool
   * actually asks, which for a question answered from the conversation alone
   * never happens. That is the difference between a 20-second pod start on
   * every "what did we decide yesterday?" and none at all.
   */
  private needsSandboxUpFront(ckpt: TaskCheckpoint | null): boolean {
    if (!BRAIN_LAZY_SANDBOX) return true;
    if (this.request.mode === "script") return true;
    if (isMultiNodeRequest(this.request)) return true;
    return ckpt !== null;
  }

  /**
   * Announce a started run that has no sandbox yet. The task row still needs
   * its owning brain recorded — the sweeper uses it to tell a run whose brain
   * is gone from one still making progress — but the sandbox workload id is
   * left unset rather than blanked, so attachHands can fill it in later
   * without the two writes fighting (internal-tasks COALESCEs).
   */
  private async startWithoutSandbox(): Promise<void> {
    logger.info(
      { sessionId: this.sessionId, messageId: this.messageId },
      "task.sandbox_deferred",
    );
    await this.onEvent({ type: "statusUpdate", agentStatus: "running" });
    // A run starting used to be the same statement as a sandbox existing, and
    // a client with no way to tell them apart would now enable a terminal or
    // a file browser against a sandbox that has not been created and may
    // never be. Said explicitly so the two can be distinguished: `deferred`
    // is followed by `ready` if and when a tool asks for one, and by nothing
    // at all for a turn that only talks.
    await this.onEvent({
      type: "sandboxStatus",
      status: "deferred",
      reason: "no_tool_called_yet",
      message: "this turn has not opened a sandbox; one opens on the first tool call",
      message_id: this.messageId,
    }).catch(() => { /* a status event must not fail the run */ });
    await fx().postTaskRunning(this.request, { brainId: BRAIN_ID });
  }

  /**
   * Open the sandbox for this run, at most once. Called up front for the runs
   * that need one from the start, and from inside the agent loop for the rest,
   * where several tool calls can race for it — hence the shared promise rather
   * than a plain `if (!this.hands)`. A failure is not cached: the tool that
   * triggered it reports the error, and a later tool gets a fresh attempt.
   */
  private readonly attachHands = (): Promise<HandsClient> => {
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
    this.handsAttach = this.openSandbox().finally(() => {
      this.handsAttach = null;
    });
    return this.handsAttach;
  };

  private async openSandbox(): Promise<HandsClient> {
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
        { deliveryCount: this.msg.info.deliveryCount, platformKey: this.platformKey },
      );
    }

    // Ensure Hands sandbox (GPU custom image when sandbox_image is specified).
    logger.info({ sessionId: this.sessionId, messageId: this.messageId }, "task.sandbox_ensuring");
    const { handsUrl, created, token: handsToken, identity } = await fx().ensureHands(
      this.sessionId, this.request, this.platformKey, this.onEvent, this.multiNodeContext ?? undefined,
      { signal: this.abortCtrl.signal },
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
    });
    this.hands = fx().makeHandsClient(handsUrl, handsToken, this.handsOwner, this.runId);
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
    return this.hands;
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
    if (!ckpt) {
      // No prior progress: still run S3 baseline restore for new sandboxes
      // so any pre-Plan-Y persisted workspace materializes back into
      // /workspace (legacy chat sessions, dev mode).
      if (created) {
        logger.info({ sessionId: this.sessionId }, "s3.restore_start");
        try { await fx().syncWorkspaceFromS3(this.hands!, this.sessionId, this.userId); } catch (e) {
          logger.warn({ err: e, sessionId: this.sessionId }, "s3.restore_failed");
        }
        logger.info({ sessionId: this.sessionId }, "s3.restore_done");
      }
      this.resumeMode = "skip_no_ckpt";
    } else if (!created) {
      // Sandbox still alive: KV ckpt restores conversation state; /workspace
      // is already in place from the live sandbox itself. Most common
      // resume path under normal SIGTERM redelivery (≤ 10 min ack_wait,
      // sandbox idle GC at ~15 min).
      this.resumeCheckpoint = ckpt;
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
      this.resumeCheckpoint = ckpt;
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
        logger.info({ sessionId: this.sessionId }, "s3.restore_start");
        try { await fx().syncWorkspaceFromS3(this.hands!, this.sessionId, this.userId); } catch (e) {
          logger.warn({ err: e, sessionId: this.sessionId }, "s3.restore_failed");
        }
        logger.info({ sessionId: this.sessionId }, "s3.restore_done");
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
    if (resumeOutcome.hint && this.resumeCheckpoint) {
      const alreadyInjected = this.resumeCheckpoint.messages.some(
        (m) =>
          m.role === "user"
          && typeof m.content === "string"
          && m.content.startsWith("[system-notice]:"),
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
      // Capture the current hands client; recreateHands may swap `hands`
      // mid-run after a sandbox rebuild, but for this checkpoint we want
      // the live reference that exists at fire time.
      const currentHands = this.hands;
      if (!currentHands) return;
      this.inflightCkptInProgress = true;
      // Fire-and-forget: never block the agent loop on checkpoint sync.
      void (async () => {
        try {
          const r = await fx().syncWorkspaceToS3(currentHands, this.sessionId, this.userIdForSync, {
            s3PrefixOverride: this.inflightCkptPrefix,
          });
          if (r.uploaded > 0) this.inflightCkptHasData = true;
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
      if (this.request.mode === "script") {
        // mode=script: predefined tool sequence, no LLM (task-design.md §7.3).
        // AgentHook fire(...) is wired by the engine layer; the hooks runtime
        // lives behind agent-loop, so pass undefined here to avoid dragging
        // it into the script-mode path.
        result = await fx().runScript(this.request, { hands: this.hands!, signal: this.abortCtrl.signal }, this.onEvent);
      } else {
        result = await this.engine.execute(this.request, this.onEvent, this.abortCtrl.signal, this.hands, {
          recreateHands: this.recreateHands,
          onCheckpoint: this.onCheckpoint,
          onCacheUse: this.onCacheUse,
          resumeCheckpoint: this.resumeCheckpoint,
          attachHands: this.attachHands,
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
    const namespace = this.multiNodeContext?.namespace ?? this.request.workspace_id?.trim();
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
    await this.releaseStep("keepalive", () => this.stopKeepaliveAfterTask());
  }

  /**
   * Run one release step, isolated from the other two.
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
    const hands = this.hands;
    let syncOk = false;
    if (!hands) {
      logger.info(
        { sessionId: this.sessionId, messageId: this.messageId },
        "s3.sync_skipped_no_sandbox",
      );
    } else {
      logger.info({ sessionId: this.sessionId, messageId: this.messageId }, "s3.sync_start");
      try {
        const r = await fx().syncWorkspaceToS3(hands, this.sessionId, this.request.user_id || "default");
        syncOk = !r.exhausted && !r.empty;
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
            message: `uploaded=${r.uploaded}/${r.totalFiles}, failed=${r.failedCount}`,
            message_id: this.messageId,
          });
        }
      } catch (e: unknown) {
        const errMsg = (e as { message?: string })?.message
          ? String((e as { message: string }).message).slice(0, 500)
          : String(e);
        const errType = (e as { constructor?: { name?: string } })?.constructor?.name ?? "Error";
        const reason = isHandsNetworkError(e)
          ? "sandbox_unreachable"
          : /Payload Too Large|BODY_TOO_LARGE|413/i.test(errMsg)
            ? "payload_too_large"
            : errType;
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
      if (BRAIN_WORKSPACE_SNAPSHOT_ENABLED && this.messageId && syncOk) {
        try { await fx().archiveRunToS3(this.sessionId, this.request.user_id || "default", this.messageId); } catch (e) {
          logger.warn({ err: e, sessionId: this.sessionId, messageId: this.messageId }, "s3.archive_failed");
        }
      }
      logger.info({ sessionId: this.sessionId, messageId: this.messageId, syncOk }, "s3.sync_done");
    }

    // 5b. Write execution transcript as JSONL to S3
    await fx().flushTranscript(this.sessionId, this.request.user_id || "default", this.messageId, this.transcriptStartedAt, this.transcriptLog, {
      turns: result.turns, elapsedMs: result.elapsedMs,
      tokenUsage: result.tokenUsage, toolStats: result.toolStats, failed: false,
    });

    await this.onEvent({
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
      memories_to_save: result.pendingMemories,
      skills_to_save: result.pendingSkills,
      skill_file_mutations: result.pendingSkillFileMutations,
      prompt: this.request.prompt,
      delivery_count: this.msg.info.deliveryCount,
    });
    // Persist the user-visible completion event before handing task state to
    // Backend. If Brain dies after the callback, outbox replay can safely skip
    // task execution without losing the session's terminal event.
    await deliverAgentDone(
      this.kvCkpt,
      this.request,
      redactEgressPayload<ExecuteResult>(
        result,
        runtimeSecrets(this.request, this.platformKey),
      ),
    );
    // Ack BEFORE logging task.completed: if the process is killed by a hot-
    // reload between the log line and msg.ack(), NATS redelivers the task after
    // ack_wait and the entire execution repeats from scratch. Since exec_complete
    // is already persisted in JetStream, the event-consumer can handle post-
    // completion logic (pending messages, summaries) even if Brain dies here.
    await ackAndClearCallback(this.msg, this.kvCkpt, this.request);
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
    if (this.handsIdentity) {
      fx().unregisterSandbox(this.sessionId, this.handsIdentity);
    } else if (this.handsWorkloadId) {
      fx().unregisterSandbox(this.sessionId, { workloadId: this.handsWorkloadId });
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
      if (this.hands && WORKSPACE_PERSIST_BASE && this.userIdHex) {
        try {
          await workspaceSigtermSyncSemaphore.run(() =>
            fx().syncWorkspace(this.hands!, this.sessionId, this.userIdHex!, ckptState.turns_completed,
              { kind: "sigterm" }),
          );
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
      // Fall back to S3 whenever the shared-filesystem sync did not happen.
      // This guard used to be the only one, so with WORKSPACE_PERSIST_BASE
      // unset — the default, in code and in the Helm values alike — a SIGTERM
      // persisted the conversation to KV and the workspace nowhere. The run
      // then resumed against whatever the session prefix held from before it
      // started. Writing to the session prefix is what the terminal path
      // already does, and it is where resolveResumeState's fall-through reads
      // from, so the resumed run finds these files.
      if (!syncedFlag && this.hands) {
        const hands = this.hands;
        try {
          const r = await fx().syncWorkspaceToS3(
            hands, this.sessionId, this.userIdForSync,
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
    this.msg.nak(0);
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
    const turnsCompleted = ckptState?.turns_completed ?? 0;
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
    });
    await deliverAgentDone(
      this.kvCkpt,
      this.request,
      redactEgressPayload<ExecuteResult>(
        {
          finalText,
          // Absent rather than zeroed when nothing recorded them, which is the
          // same statement the event above makes and for a sharper reason:
          // `applyAgentDone` writes these into `claw_tasks`, so a zero here is
          // not a number in a stream someone might sanity-check but a stored
          // row asserting the run made no calls and spent no tokens.
          tokenUsage,
          turns: turnsCompleted,
          pendingMemories: [],
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
        },
        runtimeSecrets(this.request, this.platformKey),
      ),
    );
    await this.releaseAfterTerminal();
    await ackAndClearCallback(this.msg, this.kvCkpt, this.request);
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
    await fx().reapPendingHands(this.sessionId);
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
    this.msg.nak(5000);
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
    // B: reap orphan SaFE workload if ensureHands died mid-creation and
    // left a PENDING entry. READY entries are left alone so a subsequent
    // user message can still reuse the working sandbox.
    await fx().reapPendingHands(this.sessionId);
    // Classify sandbox-originated failures so the frontend can render a
    // dedicated banner (and so the user sees a readable reason rather than
    // a raw stack-trace tail). Non-sandbox errors fall through with the
    // original err.message.
    const rawMsg = String(err?.message || err);
    // A SandboxProvisionTerminalError carries an authoritative machine reason
    // (e.g. sandbox_workload_terminal); else fall back to the message-regex classifier.
    const sandboxReason = err instanceof SandboxProvisionTerminalError
      ? err.reason
      : classifySandboxFailure(rawMsg);
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
    const taskFailure = sandboxReason
      ? { reason: sandboxReason, userText: `Sandbox failure (${sandboxReason}): ${rawMsg.slice(0, 500)}` }
      : classifyTaskFailure(rawMsg);
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
    const partialTurns = ckptStateF?.turns_completed ?? 0;
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
    });
    // Task DAG: tell Backend the task failed so the scheduler can cascade
    // to downstream nodes and (eventually) tear sandboxes down.
    await deliverAgentDone(
      this.kvCkpt,
      this.request,
      redactEgressPayload<ExecuteResult>(
        {
          finalText: finalText,
          // The same partial progress the `exec_complete` above reports. These
          // were hard-coded to zero, and `applyAgentDone` writes them straight
          // into `claw_tasks`, so every failed task in the DAG recorded itself
          // as having done nothing -- including a resumed one that had hours
          // behind it. `errorCount` stays 1: it describes the ending, not the
          // work, and the ending is that this failed.
          tokenUsage: { ...partialTokenUsage, turns: partialTurns },
          turns: partialTurns,
          pendingMemories: [],
          pendingSkills: [],
          skillsUsed: {},
          errorCount: 1,
          toolStats: partialToolStats,
          elapsedMs: elapsedMsAtFailure,
          abortReason: "error",
          failureReason: sandboxReason || rawMsg.slice(0, 500),
        },
        runtimeSecrets(this.request, this.platformKey),
      ),
    );
    await this.releaseAfterTerminal();
    await ackAndClearCallback(this.msg, this.kvCkpt, this.request);
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
    // Already past it on arrival: a redelivery of a task whose budget expired
    // while it was queued. Firing on the next tick rather than immediately so
    // the abort lands after run() has entered its try block and can catch it.
    const delay = Math.max(0, deadlineMs - Date.now());
    const timer = setTimeout(() => {
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
    }, delay);
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
  private startLeaseHeartbeat(): ReturnType<typeof setInterval> | null {
    // Tracked whether or not there is anywhere to report it to. The ledger is
    // what hands the execution slot back during a wait, and a run dispatched
    // by a path that does not issue leases waits exactly as long as any other.
    beginRun(this.lockKey);
    if (!this.request.run_lease?.url) return null;
    const tick = () => {
      const phase = phaseOf(this.lockKey);
      void fx().postRunLease(this.request, {
        brainId: BRAIN_ID,
        leaseSeconds: Math.ceil(RUN_LEASE_TTL_MS / 1000),
        phase: phase.phase,
        waitReason: phase.waitReason,
        waitedMs: phase.waitedMs,
        waits: phase.waits,
      }).then((status) => {
        // The row no longer recognises this worker, and carrying on would mean
        // two workers driving one sandbox, or a run writing a workspace a
        // cancelled run is no longer entitled to -- the same reason a lost lock
        // aborts, arrived at from the other direction.
        //
        // Which ending it gets is the whole point of asking why. A row that
        // went terminal leaves this worker holding a sandbox and a delivery
        // nobody else can release; a row another worker took over leaves it
        // holding neither, whatever it still has handles for.
        const refused = status === "gone" || status === "superseded";
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
    tick();
    const timer = setInterval(tick, RUN_LEASE_HEARTBEAT_MS);
    timer.unref();
    return timer;
  }

  async run(): Promise<void> {
    // Every terminal branch below sets this; the `finally` reports it once.
    // Recording at each branch instead would mean nine call sites and a silent
    // gap the first time a tenth is added -- and the gap would read as "no
    // tasks ran", which is the same shape as an outage.
    const runStartedAt = Date.now();
    let outcome: TaskOutcome | null = null;
    // Armed below, once the resume checkpoint has been read. A deadline that is
    // already past on arrival -- a redelivery of a run whose budget expired
    // while it was queued, which is the resumed case this reports on -- fires
    // on the next tick, and armed from here that tick lands before
    // `pendingResumeCkpt` is assigned, so the run's turn count reads as zero in
    // the one log line that exists to say how far it had got. What this gives
    // up is the deadline's cover over three awaits, not one -- the taskResumed
    // emit, the platform-key fetch and the checkpoint read. None of them
    // observes the abort signal, so arming earlier could not have cut any of
    // them short, and both KV reads are inside try/catch behind the client's
    // own request timeout.
    let cancelDeadline: () => void = () => {};
    const leaseTimer = this.startLeaseHeartbeat();
    // keepAlive must be much shorter than the consumer's ack_wait to avoid
    // redelivery while a task is still making progress. That is
    // TASK_CONSUMER_ACK_WAIT_NS, two minutes, against the ten seconds here.
    this.keepAlive = setInterval(() => {
      try { this.msg.working(); } catch {}
      // A lost lease means a second replica is already running this task. Both
      // would then be driving the same sandbox and writing the same workspace
      // and checkpoint key, and the loser is the one that has to yield.
      //
      // `expired` is the same conclusion reached without a witness: renewals
      // have been failing for long enough that the lock may already have gone,
      // and a run that cannot prove it holds the lock has to stop rather than
      // wait to be told by a second worker turning up in its workspace.
      fx().refreshTaskLock(this.lockKey).then((renewal) => {
        const yielding = renewal === "lost" || renewal === "expired";
        if (!yielding || this.abortCtrl.signal.aborted) return;
        logger.error(
          { sessionId: this.sessionId, messageId: this.messageId, lockKey: this.lockKey, renewal },
          "task.lease_lost",
        );
        this.abortCtrl.abort(LEASE_LOST_ABORT_REASON);
      }).catch(() => {});
      // Conditional on the revision just read, not a plain put. This writes the
      // same bytes back purely to push the TTL out, so it has no opinion about
      // the contents -- but an unconditional put still bumps the revision, and
      // ensureHands' reuse path holds a revision across a health check, a probe
      // and a Hands restart. At one of these every ten seconds it was the
      // reason those CAS writes lost. A lost race here needs no handling: the
      // writer that beat us refreshed the same TTL.
      this.kv.get(`hands.${this.sessionId}`).then(e => {
        if (e) this.kv.update(`hands.${this.sessionId}`, e.value, e.revision).catch((err) => {
          logger.warn({ err: err?.message || String(err), sessionId: this.sessionId }, "task.kv_ttl_refresh_failed");
        });
      }).catch((err) => {
        logger.warn({ err: err?.message || String(err), sessionId: this.sessionId }, "task.kv_ttl_get_failed");
      });
    }, LOCK_REFRESH_INTERVAL_MS);

    // Everything from here is inside the try whose finally hands back the
    // timers, the ledger entry, the abort registration and the lock. Two
    // statements used to sit in the gap between arming them and entering it,
    // and a throw from either -- resolvePlatformKey reaches the API -- left the
    // whole set behind. Not merely leaked: the abandoned keepalive goes on
    // telling the queue this delivery is being worked on and goes on renewing
    // the lock, so the message is never redelivered and the session's lock is
    // never released. The run is gone and nothing can replace it until the pod
    // restarts.
    try {
      // INV-8 state-machine closure (checkpoint-architecture-redesign §5.3):
      // any redelivery (whether the previous attempt hit SIGTERM, ack_wait
      // timeout, or a hard crash) must announce that the brain is taking the
      // task back over so the api-side event-consumer can transition the
      // session row from 'interrupted' back to 'running'. Fired before any
      // expensive work so the UI clears its toast promptly.
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

      // 2. Resume decision comes before any provisioning: the checkpoint lives
      // in KV, and whether one exists decides whether this run needs a sandbox
      // up front (a resumed run had one, and its /workspace has to be back
      // before the first turn) or can wait until a tool asks for one.
      this.pendingResumeCkpt = await this.readKvCheckpoint();
      cancelDeadline = this.armDeadline();
      if (this.needsSandboxUpFront(this.pendingResumeCkpt)) {
        await this.attachHands();
      } else {
        await this.startWithoutSandbox();
      }

      const result = await this.executeEngine();

      // NP1-7 (2026-05-20): MCP SDK 1.12 doesn't propagate
      // AbortSignal through hands.callTool (see clients/hands.ts:212-216), so a
      // long bash/read/glob tool that's mid-RPC when SIGTERM fires finishes on
      // its own and returns a NORMAL ExecuteResult instead of throwing —
      // which would otherwise fall through to the happy path and delete the
      // v3 checkpoint, permanently stranding the session (breaking the
      // SIGTERM invariants INV-7/INV-8, checkpoint-architecture-redesign §5.3).
      //
      // Force the SIGTERM catch branch by re-raising the same abort reason
      // the signal handler set; the catch block below runs the full
      // SIGTERM-correct sequence (priority workspace_sync, KV PUT,
      // taskInterrupted emit, NAK).
      if (this.abortCtrl.signal.reason === SIGTERM_ABORT_REASON) {
        logger.info(
          { sessionId: this.sessionId, messageId: this.messageId, engineAbortReason: result.abortReason ?? "completed",
            turns: result.turns },
          "task.engine_execute_done.sigterm_detour",
        );
        throw SIGTERM_ABORT_REASON;
      }
      if (this.abortCtrl.signal.aborted) {
        throw this.abortCtrl.signal.reason ?? new Error("cancelled by user");
      }

      outcome = "ok";
      await this.finalizeSuccess(result);
    } catch (err: any) {
      if (this.abortCtrl.signal.reason === SIGTERM_ABORT_REASON) {
        // Checkpointed and re-queued: this pod did not finish it, another will.
        outcome = "retryable";
        await this.handleSigtermAbort();
        return;
      }

      if (this.abortCtrl.signal.reason === LEASE_LOST_ABORT_REASON) {
        // A second replica already holds the lock and is running this task.
        outcome = "retryable";
        this.handleLeaseLost();
        return;
      }

      if (this.abortCtrl.signal.reason === RUN_ROW_TERMINAL_ABORT_REASON) {
        outcome = "failed";
        await this.handleRunRowTerminal();
        return;
      }

      // Ahead of the generic aborted branch, which would otherwise file this as
      // a user interrupt -- the transcript would read "Interrupted by user" for
      // a run nobody touched.
      if (this.abortCtrl.signal.reason === DEADLINE_EXCEEDED_ABORT_REASON) {
        outcome = "failed";
        await this.settleTerminal(
          () => this.handleFatalError(
            new Error(
              `run_budget_exhausted: the run reached its deadline of ${this.request.deadline_at} `
              // Not this attempt's count: a deadline is spent across resumes,
              // and handleFatalError records this sentence beside a `turns`
              // field that counts the whole run. Two numbers for one thing in
              // one transcript entry, and the smaller one is the wrong one.
              + `after ${this.reportedCkpt?.turns_completed ?? 0} turns`,
            ),
          ),
          "task.deadline_agent_done_delivery_exhausted",
        );
        return;
      }

      if (this.abortCtrl.signal.aborted) {
        outcome = "interrupted";
        await this.settleTerminal(
          () => this.handleUserInterrupt(),
          "task.cancelled_agent_done_delivery_exhausted",
        );
      } else if (err instanceof AgentDoneDeliveryError) {
        // Thrown by finalizeSuccess rather than by a handler called from here,
        // so there is no handler to wrap: the run finished and only the handoff
        // failed. Settled and released the same way regardless, release first
        // for the reason releaseAfterTerminal gives.
        logger.error(
          { err, sessionId: this.sessionId, taskId: this.request.task_id },
          "task.agent_done_delivery_exhausted",
        );
        // The run finished; only the handoff failed, and the nak redelivers it.
        outcome = "retryable";
        await this.releaseAfterTerminal();
        this.msg.nak(5_000);
      } else if (err instanceof SandboxProvisionTerminalError) {
        // Terminal sandbox-provisioning outcome (SaFE workload Failed/Stopped,
        // pod died before ready, workload gone, or status unreadable past the
        // deadline). Never retry: fail the session terminally so it is
        // queryable/replayable instead of a zombie launching/active session.
        // Checked before isRetryable so a terminal reason cannot be misrouted
        // into the retry loop.
        //
        // Settled like the other terminal branches, because it reports through
        // the same handler: an AgentDoneDeliveryError raised in the middle of
        // handleFatalError has to be turned into a nak and a release here, or it
        // leaves the catch chain with the message neither acked nor nak'd.
        outcome = "failed";
        await this.settleTerminal(
          () => this.handleFatalError(err),
          "task.provision_terminal_agent_done_delivery_exhausted",
        );
      } else if (isRetryable(err)) {
        outcome = "retryable";
        await this.handleRetryableError(err);
      } else {
        outcome = "failed";
        await this.settleTerminal(
          () => this.handleFatalError(err),
          "task.failed_agent_done_delivery_exhausted",
        );
      }
    } finally {
      // `outcome` is null only if a branch was added above without setting it;
      // reporting a made-up value there would be worse than the missing sample.
      if (outcome) metrics.onTask(outcome, (Date.now() - runStartedAt) / 1000);
      cancelDeadline();
      clearInterval(this.keepAlive);
      if (leaseTimer) clearInterval(leaseTimer);
      endRun(this.lockKey);
      activeAbort.delete(this.lockKey);
      await fx().releaseTaskLock(this.lockKey);
      // The transport, not the sandbox: the pod is parked for the next message
      // by markHandsIdle, which is what reuse reads, and that message builds a
      // client of its own against it. executeEngine closes this on every path
      // that reaches the engine, so what is left here is a failure between
      // makeHandsClient and that call. Last in the block because a close
      // against a sandbox that is already gone can hang, and none of the
      // releases above may wait on it; idempotent, so the ordinary path pays
      // nothing for the second call.
      await this.hands?.close().catch(() => {});
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
): Promise<void> {
  if (await replayPendingCallback(msg, request, lockKey)) return;
  if (await maybeRunSandboxlessTask(msg, request, sessionId, lockKey, abortCtrl)) return;
  await new TaskRunner(msg, request, sessionId, lockKey, messageId, userId, abortCtrl).run();
}
