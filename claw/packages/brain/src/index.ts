// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import Fastify from "fastify";
import {
  StringCodec,
  type ConsumerInfo, type JetStreamManager, type NatsConnection, type KV,
} from "nats";
import { createEngine, type Engine } from "./agent/index.js";
import { NatsEmitter } from "./events/emitter.js";
import {
  workspaceSyncSemaphore,
  workspaceSigtermSyncSemaphore,
} from "./workspace/sync-semaphore.js";
import { startSandboxKeepalive } from "./sandbox/keepalive.js";
import { validateKeepaliveCapacity } from "./sandbox/keepalive-capacity.js";
import { keepalivePingsPerSweep, keepaliveSweepCeilingSec } from "./sandbox/keepalive.js";
import { toolTimeoutCeilingSec } from "./tools/hands.js";
import { rosterDeps } from "./sandbox/roster-store.js";
import { bindAdmission } from "./sandbox/admission.js";
import { initA2ARegistry } from "./clients/a2a.js";
import { initSystemEnvCache } from "./infra/system-env.js";
import {
  taskSubject, decodeCleanupPayload,
  RUN_LEASE_HEARTBEATS_PER_TTL,
  TASK_CONSUMER_ACK_WAIT_MS,
  TASK_CONSUMER_NAME, TASK_STREAM_NAME,
  isRunDoorbell,
} from "@claw/protocol";
import {
  EXECUTOR_HOST, EXECUTOR_PORT, NATS_URL, BRAIN_ID,
  MAX_CONCURRENT, MAX_RESIDENT, TASK_POISON_DELIVERY_COUNT, AUTH_INTERNAL_TOKEN,
  SAFE_API_URL,
  BRAIN_BUNDLED_HANDS_BINARY,
  BRAIN_VERSION,
  BRAIN_REGISTRY_BUCKET, BRAIN_REGISTRY_TTL_MS, BRAIN_TOMBSTONES_BUCKET,
  LOCK_REFRESH_INTERVAL_MS,
  MULTI_NODE_IDLE_RECLAIM_MS, MULTI_NODE_SWEEPER_INTERVAL_MS,
  BRAIN_CHECKPOINTS_BUCKET, BRAIN_CHECKPOINTS_TTL_MS,
  LLM_API_STYLE,
  WORKSPACE_PERSIST_BASE,
  TASK_MAX_DELIVER, TASK_MAX_ACK_PENDING,
  SANDBOX_POLL_TIMEOUT_MS, SANDBOX_PENDING_TIMEOUT_MS,
  RUN_LEASE_HEARTBEAT_MS, RUN_LEASE_TTL_MS,
  DELIVERY_HEARTBEAT_MS, DELIVERY_HEARTBEATS_PER_ACK_WAIT,
  RUN_GATE_KEY, RUN_GATE_KEY_CONFIGURED,
  envSettingProblems,
  envSettingRefused,
  LLM_CACHE_STYLE,
  openAiBaseUrlFellBack,
  INTERNAL_BACKEND_URL, CLAIM_NEXT_IDLE_MS,
  BG_SHELL_ENABLED, SANDBOX_KEEPALIVE_INTERVAL_SEC,
  SANDBOX_KEEPALIVE_TARGET_CEILING, SANDBOX_KEEPALIVE_RECONCILE_RESERVE,
  SANDBOX_KEEPALIVE_IDLE_DEADLINE_SEC, SANDBOX_KEEPALIVE_SWEEP_SPAN_SEC,
} from "./config.js";
import { existsSync, createReadStream } from "fs";
import { initDagHandles } from "./sandbox/handles.js";
import { initBgHandleRows } from "./sandbox/bg-row-store.js";
import {
  assertReservedKeysFree, bindHandsKv, isValidHandsToken,
} from "./sandbox/registry.js";
import { getMultiNodeProvider, multiNodeAvailable } from "./sandbox/multi-node/factory.js";
import type { SessionDestroyResult } from "./sandbox/multi-node/types.js";
import {
  destroyHands, parkForIdleReclaim, readSessionPlatformKey, releaseLocalHandsState,
  startMultiNodeSweeper, startSandboxSweeper,
} from "./sandbox/reaper.js";
import { activeAbort, resolveAbortTargets, SIGTERM_ABORT_REASON } from "./tasks/abort-registry.js";
import { markSessionDeleted } from "./infra/deleted-sessions.js";
import {
  releaseTaskLock, bindTaskLockKv, lockContentionNakMs, lockExpiresBetweenRenewals,
} from "./tasks/lock.js";
import { bindTaskRunnerDeps } from "./tasks/runner.js";
import { handleTask, bindTaskDispatchKv, inflightTasks, handleClaimedRequest } from "./tasks/dispatch.js";
import { claimNextRun } from "./clients/run-claim.js";
import { flushPendingRetries } from "./delivery/doorbell-delivery.js";
import { startClaimNextLoop } from "./delivery/claim-next-loop.js";
import { taskExecutionGate } from "./tasks/execution-gate.js";
import { setParkHooks } from "./tasks/run-phase.js";
import { keepDeliveryAlive } from "./delivery/heartbeat.js";
import {
  runDelivery, DeliveryResidency, SURPLUS_REFUSALS, type DeliveryDeps,
} from "./delivery/dispatch.js";
import pino from "pino";
import {
  metrics,
  registry as metricsRegistry,
  type SessionCleanupIncompleteReason,
} from "./infra/metrics.js";
import { startWatchdog } from "./infra/watchdog.js";
import { registerAdminCheckpointRoutes } from "./routes/admin.js";
import { DrainState, versionDrainAction } from "./infra/drain-state.js";

const logger = pino({ name: "brain" });
const sc = StringCodec();

// --- Globals (process-level, multi-user safe by design) ---
let engine: Engine;
let emitter: NatsEmitter;
let nc: NatsConnection;
let kv: KV;        // BRAIN_REGISTRY bucket: hands/lock/deleted/etc.
let kvCkpt: KV;    // BRAIN_CHECKPOINTS bucket: task-ckpt.<sid>.<messageId>

// ── Graceful drain state ────────────────────────────────────────────────────
//
// Two different reasons to stop pulling work, deliberately kept apart.
//
// They used to be one flag, and the signal handler's own re-entrancy guard was
// that flag. So a pod that had already version-drained returned at the guard
// when SIGTERM finally arrived, and never aborted its sessions, never flushed
// its deferred claims, never called process.exit(0) -- it sat until SIGKILL at
// the end of the grace period, and its in-flight runs lost the checkpoint
// handleSigtermAbort writes, because the abort reason that path keys on is set
// by the handler that never ran. The version drain is the normal precursor to
// SIGTERM during an upgrade (upgrade.sh signals, then terminates), so this
// fired on exactly the path the drain exists to protect.
const drainState = new DrainState();
const isDraining = (): boolean => drainState.draining;
// Only for the things that must stop for good. A version drain is not one of
// them, and handing it to something that treats it as terminal is how
// claim-next used to be lost for the pod's whole life after a single drain.
const isShuttingDown = (): boolean => drainState.shuttingDown;
let consumerIter: { stop: () => void } | null = null;

// ===== Signal handlers =====

function installSignalHandlers(): void {
  const handler = (sig: string) => {
    // Guards re-entry into *shutdown* only. Testing the shared drain flag here
    // is what let a version-drained pod skip its own SIGTERM handling.
    if (!drainState.beginShutdown()) return;
    const activeSessions = [...activeAbort.keys()];
    logger.info({
      signal: sig,
      activeSessions,
      activeCount: activeSessions.length,
      uptimeMs: process.uptime() * 1000,
      memMB: Math.round((process.memoryUsage?.rss?.() ?? process.memoryUsage().rss) / 1048576),
    }, "brain.drain.signal_received");

    consumerIter?.stop();

    for (const [sid, ctrl] of activeAbort.entries()) {
      logger.info({ sessionId: sid, signal: sig }, "brain.drain.aborting_session");
      ctrl.abort(SIGTERM_ABORT_REASON);
    }

    Promise.allSettled(inflightTasks()).then(async () => {
      // Rows waiting out a lock-contention backoff are held by this pod and
      // nothing else knows it. The wait is an unref'd timer, so exiting here
      // would drop the release and leave each row to time its lease out --
      // minutes of a turn standing still after a clean shutdown. Releasing is
      // generation-guarded, so one that races a reclaim is simply refused.
      try {
        const flushed = await flushPendingRetries();
        if (flushed) logger.info({ signal: sig, flushed }, "brain.drain.released_deferred_claims");
      } catch (err) {
        logger.warn({ err, signal: sig }, "brain.drain.release_deferred_failed");
      }
      try { await nc.drain(); } catch { /* ignore */ }
      logger.info({
        signal: sig,
        drainedSessions: activeSessions.length,
      }, "brain.drain.complete");
      process.exit(0);
    });
  };

  process.once("SIGTERM", () => handler("SIGTERM"));
  process.once("SIGINT", () => handler("SIGINT"));
}

/**
 * Watch brain.min_version; self-drain when this pod is not the version the
 * operator wants.
 *
 * The test is identity, not order. It was `BRAIN_VERSION < wanted`, a JS string
 * comparison — lexicographic by code unit, which only coincides with "older"
 * when the tag is a fixed-width big-endian timestamp and nothing else. Real
 * tags are `<prefix>-<sha>-<timestamp>`, so the comparison is decided by the
 * prefix and then by a random hex sha, and the timestamp — the only part that
 * encodes recency — is never reached. All three shapes below were hit within a
 * single afternoon of deploys:
 *
 *   main-7d91c40a-…   <  202608251230             → false  ('m' > '2')
 *   main-7d91c40a-…   <  main-0abc1234-…          → false  ('7' > '0')
 *   verify-1a2b3c4d-… <  patch-b6e2f108-…         → false  ('v' > 'p')
 *
 * The first is build.sh's own default tag format. The second is a coin flip per
 * deploy on the leading hex digit. And the failure was silent: there was no
 * else branch, upgrade.sh only checks that the KV write succeeded (it always
 * does) and that the rollout completed (it always does, because replacing pods
 * has nothing to do with draining them), so a drain that never happened looked
 * exactly like one that did.
 *
 * `!==` asks the question the caller actually means — "am I the current one?" —
 * and is total over any naming scheme. It also fails in the safe direction: an
 * unrecognised version stops taking new work rather than quietly keeping it.
 *
 * The key keeps its `min_version` name so this pod still understands a value
 * written by an older upgrade.sh, and vice versa, during a mixed rollout.
 */
async function watchVersionDrain(): Promise<void> {
  if (!BRAIN_VERSION) return;
  try {
    const watcher = await kv.watch({ key: "brain.min_version" });
    (async () => {
      for await (const entry of watcher) {
        // Only a PUT carries a version to compare against. An explicit delete
        // (or an empty write) carries none, and an empty value is not this
        // pod's version -- under an identity test that alone would drain the
        // fleet. (The bucket's 5-minute MaxAge is not this case: messages that
        // age out are dropped server-side and deliver no marker at all, so an
        // expiry is simply silence.)
        if (entry.operation !== "PUT") {
          logger.info(
            { brainVersion: BRAIN_VERSION, operation: entry.operation },
            "brain.drain.version_key_removed",
          );
          continue;
        }
        const wanted = sc.decode(entry.value).trim();
        const action = versionDrainAction(BRAIN_VERSION, wanted);
        if (action === "ignore_blank") {
          logger.warn({ brainVersion: BRAIN_VERSION }, "brain.drain.version_blank_ignored");
          continue;
        }
        if (action === "current") {
          // Acted on, not just logged. A pod can have drained on a *stale*
          // value -- one written by the previous upgrade, seen at boot before
          // the tag this pod belongs to was written. This is the message that
          // says otherwise, and without releasing here the drain fails closed:
          // the upgrade reports success over a fleet that takes no work.
          if (drainState.endVersionDrain()) {
            logger.info(
              { brainVersion: BRAIN_VERSION, wanted },
              "brain.drain.version_resumed",
            );
          } else {
            logger.info({ brainVersion: BRAIN_VERSION, wanted }, "brain.drain.version_current");
          }
          continue;
        }
        if (!drainState.beginVersionDrain()) continue;
        // Deliberately no consumerIter.stop() here -- that is a one-way door,
        // and this drain has to be reversible for the stale-value case above.
        // The flag alone is enough, but only because both readers re-ask it:
        // delivery-dispatch checks per delivery, so deliveries are handed
        // straight back for another pod to take and are accepted again the
        // moment the key names this pod, and claim-next-loop checks per cycle,
        // sleeping through a drain rather than exiting on it. Only shutdown
        // stops the consumer, and only shutdown ends that loop.
        logger.info({ brainVersion: BRAIN_VERSION, wanted }, "brain.drain.version_outdated");
      }
    })().catch((e) => logger.warn({ err: e }, "brain.version_watch.error"));
  } catch (e) {
    logger.warn({ err: e }, "brain.version_watch.init_failed");
  }
}

// How long a starting pod waits for the API to bring the shared durable up to
// what this pod needs. Long enough to cover the API's own init on a cold
// cluster and to sit out a rollout that restarts brain first, short enough
// that a durable nobody is going to fix is reported rather than waited on:
// past this the pod exits and the restart makes the retry visible in kubectl
// instead of hiding it inside a process that looks healthy.
const TASK_CONSUMER_WAIT_MS = 60_000;
const TASK_CONSUMER_POLL_MS = 2_000;

/**
 * The durable settings this pod depends on, paired with what it expects.
 *
 * Both are checked because an update merges rather than replaces, so a partial
 * reconcile leaves the durable on a stale value for whichever field did not
 * land, with no error to notice. Each stale value breaks a different
 * invariant: max_deliver silently reopens the drop-without-an-event window,
 * and a max_ack_pending left at the old replicas*MAX_CONCURRENT value lets a
 * few tasks backing off on locks fill the ceiling and stop delivery to every
 * replica at once.
 */
function taskConsumerFields(info: ConsumerInfo) {
  return [
    ["max_deliver", info.config.max_deliver, TASK_MAX_DELIVER],
    ["max_ack_pending", info.config.max_ack_pending, TASK_MAX_ACK_PENDING],
  ] as const;
}

/**
 * Read the shared durable, waiting for the API to bring it up to spec.
 *
 * Brain does not provision it (see api/src/infra/nats.ts ensureTaskConsumer), which
 * leaves a starting pod two ways to find it unusable: missing entirely, or
 * present but still carrying the ceiling from before the API reconciled. A
 * rollout that restarts brain ahead of api produces the second routinely, and
 * both are the same race with the same answer -- wait -- so both are handled
 * here rather than the second being treated as a misconfiguration. Rejecting a
 * stale reading outright would crash-loop every replica for as long as the API
 * takes to catch up, trading an outage for a state that clears itself.
 *
 * Only a value below the expectation makes the durable unusable. One above it
 * means this pod is configured under the fleet, which a retune or a rolling
 * upgrade produces legitimately; the caller logs it instead.
 */
async function awaitTaskConsumer(jsm: JetStreamManager): Promise<ConsumerInfo> {
  const deadline = Date.now() + TASK_CONSUMER_WAIT_MS;
  let warned = false;
  for (;;) {
    let reason: string | null = null;
    try {
      const info = await jsm.consumers.info(TASK_STREAM_NAME, TASK_CONSUMER_NAME);
      for (const [field, actual, expected] of taskConsumerFields(info)) {
        // Also rejects an absent field and the -1 that means "unlimited",
        // which for max_ack_pending is the no-ceiling case this catches.
        if (typeof actual !== "number" || actual < expected) {
          reason = `${field}=${actual} is below the required ${expected}`;
          break;
        }
      }
      if (!reason) return info;
    } catch (err) {
      reason = `consumer not found (${(err as Error)?.message ?? String(err)})`;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `consumer ${TASK_CONSUMER_NAME} on ${TASK_STREAM_NAME} was not usable within `
        + `${TASK_CONSUMER_WAIT_MS}ms: ${reason}; it is provisioned by the api `
        + `process (api/src/infra/nats.ts)`,
      );
    }
    if (!warned) {
      warned = true;
      logger.warn(
        { taskConsumerName: TASK_CONSUMER_NAME, reason },
        "brain.consumer.awaiting_provisioning",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, TASK_CONSUMER_POLL_MS));
  }
}

// ===== Main =====

/**
 * Warn at startup when credentials needed later are missing, so operators
 * see an actionable log line instead of a cryptic runtime failure when the
 * first task arrives.
 */
function validateStartupConfig(): void {
  const missing: string[] = [];
  if (!AUTH_INTERNAL_TOKEN) missing.push("AUTH_INTERNAL_TOKEN");
  if (!SAFE_API_URL) missing.push("SAFE_API_URL");
  if (missing.length) {
    logger.warn({ missing }, "startup.config_missing");
  }
  // The OpenAI wire protocol was selected with no URL of its own, so
  // chat/completions is pointed at whatever ANTHROPIC_BASE_URL names. In this
  // fleet that is a gateway serving Anthropic models, which honours cache
  // markers -- and leaving LLM_CACHE_STYLE at its "off" default there means
  // paying full price on every request. Said at boot because the alternative
  // is finding out on a bill: that is exactly how the incident this caching
  // work came from went unnoticed for two years.
  if (openAiBaseUrlFellBack()) {
    logger.warn(
      { llmCacheStyle: LLM_CACHE_STYLE },
      LLM_CACHE_STYLE === "anthropic"
        ? "startup.openai_base_url_fell_back: OPENAI_BASE_URL is unset, so chat/completions targets ANTHROPIC_BASE_URL; LLM_CACHE_STYLE=anthropic, so cache markers will be sent"
        : `startup.openai_base_url_fell_back: OPENAI_BASE_URL is unset, so chat/completions targets ANTHROPIC_BASE_URL -- a gateway that likely honours prompt caching, but LLM_CACHE_STYLE is "${LLM_CACHE_STYLE}", which sends no cache_control, so every request pays full price. Set LLM_CACHE_STYLE=anthropic if that endpoint fronts Anthropic models.`,
    );
  }

  if (!WORKSPACE_PERSIST_BASE) {
    logger.warn(
      "startup.workspace_persistence_disabled: WORKSPACE_PERSIST_BASE is empty; using S3-only durability",
    );
  }
  // SANDBOX_POLL_TIMEOUT_MS kept its exact key and default but its meaning
  // changed: it now bounds ONLY an UNREADABLE SaFE status, not the whole
  // provisioning wait. A value tuned under the old "absolute ceiling" meaning
  // (e.g. "give up if the sandbox isn't up in 10min") is now silently
  // reinterpreted — healthy queuing is instead bounded by
  // SANDBOX_PENDING_TIMEOUT_SECONDS. Surface that to any site that set a
  // non-default value so the reinterpretation is loud, not silent.
  const rawPollTimeout = process.env.SANDBOX_POLL_TIMEOUT_MS;
  if (rawPollTimeout && rawPollTimeout.trim() && SANDBOX_POLL_TIMEOUT_MS !== 60 * 60 * 1000) {
    logger.warn(
      {
        sandboxPollTimeoutMs: SANDBOX_POLL_TIMEOUT_MS,
        sandboxPendingTimeoutMs: SANDBOX_PENDING_TIMEOUT_MS,
      },
      "startup.sandbox_poll_timeout_semantics_changed: SANDBOX_POLL_TIMEOUT_MS now bounds ONLY an unreadable SaFE status; the Pending/queue wait is bounded by SANDBOX_PENDING_TIMEOUT_SECONDS. Re-check both values.",
    );
  }

  // A gate key nobody recognises is a deployment that thinks it configured
  // something. It resolves to "workspace" rather than to the old per-session
  // behaviour, so the failure is a log line and not two runs writing one
  // directory -- but an operator who typed "Workspace" needs to be told, because
  // otherwise the only evidence is runs queueing where they expected them not to.
  if (RUN_GATE_KEY_CONFIGURED !== RUN_GATE_KEY) {
    logger.error(
      { configured: RUN_GATE_KEY_CONFIGURED, using: RUN_GATE_KEY },
      "startup.run_gate_key_unrecognised (RUN_GATE_KEY must be \"workspace\" or \"session\")",
    );
  }

  // The idle-reclaim fallback rests on a parked handle outliving the gap between
  // two sweeps. The keepalive tick refreshes most of them, but not a PENDING one
  // and not any of them when keepalive is off, and those live a single bucket TTL
  // -- the interval has to fit under the shortest case, not the common one. At or
  // above the TTL such an entry expires before any pass sees it and the fallback
  // is gone without a trace. Checked here because the two values are set
  // independently, and the failure produces no symptom of its own -- just GPU
  // clusters running until the workload's timeout.
  if (
    MULTI_NODE_IDLE_RECLAIM_MS > 0
    && MULTI_NODE_SWEEPER_INTERVAL_MS >= BRAIN_REGISTRY_TTL_MS
  ) {
    logger.error(
      {
        sweeperIntervalMs: MULTI_NODE_SWEEPER_INTERVAL_MS,
        entryTtlMs: BRAIN_REGISTRY_TTL_MS,
      },
      "startup.idle_reclaim_unreachable (MULTI_NODE_SWEEPER_INTERVAL_MS must be below BRAIN_REGISTRY_TTL_MS)",
    );
  }

  // Mutual exclusion rests on `lock.<key>` outliving the gap between two
  // renewals, and that needs room for a second attempt inside the TTL. Too
  // close to it, the entry lapses between renewals that are all succeeding, and
  // the redelivered copy that finds the lock free runs the same turn beside the
  // run that never noticed -- two agents in one workspace, one checkpoint key
  // written by both. Checked here because the interval is an env var while the
  // TTL belongs to a bucket the API configures, so nothing else compares them.
  if (lockExpiresBetweenRenewals()) {
    logger.error(
      {
        refreshIntervalMs: LOCK_REFRESH_INTERVAL_MS,
        lockTtlMs: BRAIN_REGISTRY_TTL_MS,
      },
      "startup.lock_renewal_too_slow (LOCK_REFRESH_INTERVAL_MS x 2 must fit inside "
      + "BRAIN_REGISTRY_TTL_MS, or two copies of one turn can run at once)",
    );
  }

  // A lease is the row's evidence that this pod is still here, and the evidence
  // is only as good as the number of chances it gets to arrive. Below three
  // renewals per lease a single slow API call expires the lease of a healthy
  // run, and the reaper on the other side closes it. The API checks the rest of
  // this ordering at its own startup; this half is the only one visible here,
  // because these two values can be overridden on this deployment alone.
  if (RUN_LEASE_HEARTBEAT_MS * RUN_LEASE_HEARTBEATS_PER_TTL > RUN_LEASE_TTL_MS) {
    logger.error(
      {
        heartbeatMs: RUN_LEASE_HEARTBEAT_MS,
        leaseTtlMs: RUN_LEASE_TTL_MS,
        renewalsPerLease: RUN_LEASE_HEARTBEATS_PER_TTL,
      },
      "startup.run_lease_ratio_too_tight (RUN_LEASE_TTL_MS must cover "
      + "RUN_LEASE_HEARTBEAT_MS x 3, or a slow renewal reads as a dead worker)",
    );
  }

  // The delivery heartbeat is the whole of what stands between a queued or
  // running task and ack_wait expiring underneath it, and unlike the lease it
  // has no second chance: a redelivered task spends one of the few deliveries
  // it gets, and running out of them is what the poison guard writes off. Same
  // three-chances rule as above, checked here because ack_wait is fixed in the
  // consumer definition while this side is an env var anyone can widen.
  if (DELIVERY_HEARTBEAT_MS * DELIVERY_HEARTBEATS_PER_ACK_WAIT > TASK_CONSUMER_ACK_WAIT_MS) {
    logger.error(
      {
        heartbeatMs: DELIVERY_HEARTBEAT_MS,
        ackWaitMs: TASK_CONSUMER_ACK_WAIT_MS,
        beatsPerAckWait: DELIVERY_HEARTBEATS_PER_ACK_WAIT,
      },
      "startup.delivery_heartbeat_too_slow (DELIVERY_HEARTBEAT_MS x 3 must fit "
      + "inside the consumer's ack_wait, or a healthy task is redelivered)",
    );
  }

  // Same reasoning as the API's copy: a value that was set and then refused
  // means the process is running on a default nobody chose.
  const refused = envSettingProblems();
  if (refused.length) {
    logger.error({ refused }, "startup.config_refused");
  }

  // One of those refusals is not survivable. CHECKPOINT_WRITE_VERSION decides
  // whether conversations are sealed or merely redacted, and a refused value
  // falls back to the default (3) -- so an operator who set 4 and typed 5, or
  // whose value arrived non-numeric, would get a pod quietly writing the
  // weaker format while their values file says otherwise. Refusing to start is
  // the only outcome that cannot be mistaken for having been obeyed.
  if (envSettingRefused("CHECKPOINT_WRITE_VERSION")) {
    logger.error(
      { refused: refused.filter((p) => p.startsWith("CHECKPOINT_WRITE_VERSION=")) },
      "startup.checkpoint_write_version_invalid (must be 3 or 4; refusing to start "
      + "rather than write a format nobody chose)",
    );
    process.exit(1);
  }
}

async function initializeInfrastructure(): Promise<JetStreamManager> {
  validateStartupConfig();
  initA2ARegistry();
  engine = await createEngine();
  emitter = new NatsEmitter();
  await emitter.init(NATS_URL);
  nc = emitter.nc;

  const js = nc.jetstream();
  const jsm = await nc.jetstreamManager();
  kv = await js.views.kv(BRAIN_REGISTRY_BUCKET, { ttl: BRAIN_REGISTRY_TTL_MS });
  kvCkpt = await js.views.kv(BRAIN_CHECKPOINTS_BUCKET, { ttl: BRAIN_CHECKPOINTS_TTL_MS });
  await initSystemEnvCache(js);
  await initDagHandles(js);
  await initBgHandleRows(js);
  bindHandsKv(kv);
  await assertReservedKeysFree(kv);
  bindTaskLockKv(kv);
  bindTaskRunnerDeps({ kv, kvCkpt, emitter, engine });
  let kvTombstones: KV | undefined;
  try {
    kvTombstones = await js.views.kv(BRAIN_TOMBSTONES_BUCKET, { bindOnly: true });
  } catch (e) {
    logger.warn(
      { err: (e as Error)?.message, bucket: BRAIN_TOMBSTONES_BUCKET },
      "startup.tombstone_bucket_unavailable",
    );
  }
  bindTaskDispatchKv(kv, kvTombstones);
  await watchVersionDrain();
  return jsm;
}

function reportConsumerDrift(info: ConsumerInfo): void {
  for (const [field, actual, expected] of taskConsumerFields(info)) {
    if (typeof actual !== "number" || actual <= expected) continue;
    logger.error(
      { taskConsumerName: TASK_CONSUMER_NAME, field, actual, expected },
      "brain.consumer.config_above_expected",
    );
  }
}

async function startTaskDelivery(jsm: JetStreamManager): Promise<DeliveryResidency> {
  const taskSub = taskSubject();
  const taskConsumerInfo = await awaitTaskConsumer(jsm);
  reportConsumerDrift(taskConsumerInfo);
  setParkHooks({
    park: () => taskExecutionGate.park(),
    unpark: (hadSlot) => taskExecutionGate.unpark(hadSlot),
  });

  const js = nc.jetstream();
  const consumer = await js.consumers.get(TASK_STREAM_NAME, TASK_CONSUMER_NAME);
  logger.info(
    { taskSub, taskConsumerName: TASK_CONSUMER_NAME, brainId: BRAIN_ID,
      maxConcurrent: MAX_CONCURRENT, maxResident: MAX_RESIDENT, brainVersion: BRAIN_VERSION },
    "brain.consumer.started",
  );
  const iter = await consumer.consume({ max_messages: MAX_RESIDENT });
  consumerIter = iter;
  if (drainState.draining) {
    logger.info({ brainVersion: BRAIN_VERSION }, "brain.drain.consuming_while_drained");
  }

  const deliveryResidency = new DeliveryResidency(MAX_RESIDENT + MAX_CONCURRENT);
  const deliveryDeps: DeliveryDeps = {
    keepAlive: (m) => keepDeliveryAlive(m as any),
    gate: taskExecutionGate,
    residency: deliveryResidency,
    canRefuse: (deliveries) =>
      deliveries <= SURPLUS_REFUSALS && deliveries < TASK_POISON_DELIVERY_COUNT - 1,
    surplusNakMs: (deliveries) => lockContentionNakMs(deliveries),
    isDraining,
    isWakeup(msg) {
      try {
        return isRunDoorbell(JSON.parse(sc.decode(msg.data)) as unknown);
      } catch {
        return false;
      }
    },
    handle: (m) => handleTask(m),
    onError: (err) => logger.error({ err }, "task.unhandled"),
    onRefuse: (kind) => {
      metrics.onDeliveryRefused(kind);
      logger.info(
        {
          kind,
          inflight: taskExecutionGate.inflight,
          queued: taskExecutionGate.queued,
          parked: taskExecutionGate.parkedRuns,
          held: deliveryResidency.holding,
        },
        "task.delivery_refused",
      );
    },
  };

  (async () => {
    for await (const msg of iter) {
      void runDelivery(msg as any, deliveryDeps);
    }
  })();

  startClaimNextLoop({
    enabled: Boolean(INTERNAL_BACKEND_URL),
    idleMs: CLAIM_NEXT_IDLE_MS,
    isDraining,
    isShuttingDown,
    gate: taskExecutionGate,
    claimNext: claimNextRun,
    handle: handleClaimedRequest,
    onError: (err) => logger.error({ err }, "run.claim_next.loop_error"),
  });
  return deliveryResidency;
}

function installInterruptSubscriber(): void {
  const intSub = nc.subscribe("interrupt.*");
  (async () => {
    for await (const msg of intSub) {
      const parts = msg.subject.split(".");
      const address = parts[parts.length - 1];
      for (const lockKey of resolveAbortTargets(address)) {
        const ctrl = activeAbort.get(lockKey);
        if (!ctrl) continue;
        ctrl.abort();
        logger.info({ address, lockKey }, "task.interrupted");
        // The SDK may not propagate abort through an in-flight tool RPC.
        setTimeout(() => {
          if (activeAbort.get(lockKey) !== ctrl) return;
          logger.error({ address, lockKey }, "task.interrupt_force_release");
          activeAbort.delete(lockKey);
          releaseTaskLock(lockKey).catch(() => {});
        }, 30_000).unref();
      }
    }
  })();
}

async function cleanupSession(sid: string, payload: Uint8Array): Promise<void> {
  markSessionDeleted(sid);
  const lockKeys = resolveAbortTargets(sid);
  for (const lockKey of lockKeys) {
    const ctrl = activeAbort.get(lockKey);
    if (!ctrl) continue;
    ctrl.abort();
    activeAbort.delete(lockKey);
    logger.info({ sessionId: sid, lockKey }, "session.cleanup_aborted_task");
  }
  for (const lockKey of lockKeys.length ? lockKeys : [sid]) {
    await releaseTaskLock(lockKey);
  }

  const platformKey = decodeCleanupPayload(payload.length ? sc.decode(payload) : "").platformKey
    || (await readSessionPlatformKey(sid));
  let complete = false;
  let failureReason: SessionCleanupIncompleteReason | undefined;
  try {
    const destroyed: SessionDestroyResult = multiNodeAvailable()
      ? await getMultiNodeProvider().destroyForSession(sid, { platformKey })
      : { complete: true, found: 0, deleted: 0 };
    complete = destroyed.complete;
    failureReason = destroyed.reason;
    if (complete) await destroyHands(sid);
    logger.info(
      { sessionId: sid, clustersDeleted: destroyed.deleted, complete },
      "session.cleanup_done",
    );
  } catch (err) {
    complete = false;
    failureReason = "threw";
    logger.error({ err, sessionId: sid }, "session.cleanup_failed");
  } finally {
    releaseLocalHandsState(sid);
    if (!complete) {
      await parkForIdleReclaim(sid);
      metrics.onSessionCleanupIncomplete(failureReason ?? "unknown");
      logger.error(
        { sessionId: sid, reason: failureReason },
        "session.cleanup_incomplete_parked",
      );
    }
  }
}

function installCleanupSubscriber(): void {
  const clnSub = nc.subscribe("cleanup.*");
  (async () => {
    for await (const msg of clnSub) {
      const parts = msg.subject.split(".");
      const sid = parts[parts.length - 1];
      await cleanupSession(sid, msg.data);
    }
  })();
}

async function startBackgroundRuntime(): Promise<void> {
  startWatchdog();
  const capacity = validateKeepaliveCapacity({
    bgShellEnabled: BG_SHELL_ENABLED,
    keepaliveIntervalSec: SANDBOX_KEEPALIVE_INTERVAL_SEC,
    targetCeiling: SANDBOX_KEEPALIVE_TARGET_CEILING,
    reconcileReserve: SANDBOX_KEEPALIVE_RECONCILE_RESERVE,
    idleDeadlineSec: SANDBOX_KEEPALIVE_IDLE_DEADLINE_SEC,
    pingsPerSweep: keepalivePingsPerSweep(),
    pingPhaseCeilingSec: keepaliveSweepCeilingSec(),
    sweepSpanSec: SANDBOX_KEEPALIVE_SWEEP_SPAN_SEC,
    provisioningCeilingSec: Math.floor(SANDBOX_PENDING_TIMEOUT_MS / 1000),
  });
  if (capacity.ceiling > 0) {
    logger.info(
      { ceiling: capacity.ceiling, deferrals: capacity.deferralCount,
        activityGapSec: capacity.activityGapSec,
        reclaimHorizonMs: capacity.reclaimHorizonMs },
      "keepalive.capacity_proven",
    );
  }
  await bindAdmission(kv, capacity);
  await startSandboxKeepalive({ kv, ...rosterDeps(kv, capacity) });
  startSandboxSweeper();
  startMultiNodeSweeper();
}

function healthSnapshot(deliveryResidency: DeliveryResidency): Record<string, unknown> {
  return {
    status: "ok",
    service: "brain",
    engine: LLM_API_STYLE,
    brainId: BRAIN_ID,
    brainVersion: BRAIN_VERSION,
    draining: drainState.draining,
    drainReason: drainState.reason,
    bgShellEnabled: BG_SHELL_ENABLED,
    bashForegroundMaxSec: toolTimeoutCeilingSec("bash"),
    activeTasks: activeAbort.size,
    maxConcurrent: MAX_CONCURRENT,
    maxResident: MAX_RESIDENT,
    runningTasks: taskExecutionGate.inflight,
    queuedTasks: taskExecutionGate.queued,
    parkedRuns: taskExecutionGate.parkedRuns,
    heldDeliveries: deliveryResidency.holding,
    maxHeldDeliveries: MAX_RESIDENT + MAX_CONCURRENT,
  };
}

async function startHttpServer(deliveryResidency: DeliveryResidency): Promise<void> {
  const app = Fastify({ logger: false });
  app.get("/health", async () => healthSnapshot(deliveryResidency));
  app.get("/metrics", async (_req, reply) => {
    metrics.setDeliveryGauges({
      inflight: taskExecutionGate.inflight,
      queued: taskExecutionGate.queued,
      parked: taskExecutionGate.parkedRuns,
      held: deliveryResidency.holding,
    });
    reply.type(metricsRegistry.contentType);
    return metricsRegistry.metrics();
  });

  await registerAdminCheckpointRoutes(app, {
    workspaceSyncSemaphore,
    workspaceSigtermSyncSemaphore,
    kv,
    kvCkpt,
    decode: (buf: Uint8Array) => sc.decode(buf),
  });

  app.get(
    "/internal/assets/hands-binary",
    async (req, reply) => {
      const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      if (!auth) {
        metrics.onHandsBinaryDownload("unauthorized");
        return reply.status(401).send("Unauthorized");
      }
      if (!(await isValidHandsToken(auth))) {
        metrics.onHandsBinaryDownload("forbidden");
        return reply.status(403).send("Forbidden");
      }
      if (!existsSync(BRAIN_BUNDLED_HANDS_BINARY)) {
        metrics.onHandsBinaryDownload("not_available");
        return reply.status(503).send("Hands binary not available in this image");
      }
      const t0 = Date.now();
      let bytes = 0;
      const stream = createReadStream(BRAIN_BUNDLED_HANDS_BINARY);
      stream.on("data", (chunk) => { bytes += chunk.length; });
      stream.on("end",  () => metrics.onHandsBinaryDownload("ok", bytes, (Date.now() - t0) / 1000));
      stream.on("error", () => { /* aborted mid-stream — counted on next call */ });
      reply.header("Content-Type", "application/octet-stream");
      return reply.send(stream);
    },
  );
  await app.listen({ host: EXECUTOR_HOST, port: EXECUTOR_PORT });
  logger.info({ host: EXECUTOR_HOST, port: EXECUTOR_PORT, engine: LLM_API_STYLE }, "brain.ready");
}

async function main(): Promise<void> {
  const jsm = await initializeInfrastructure();
  const deliveryResidency = await startTaskDelivery(jsm);
  installSignalHandlers();
  installInterruptSubscriber();
  installCleanupSubscriber();
  await startBackgroundRuntime();
  await startHttpServer(deliveryResidency);
}

main().catch((err) => { logger.fatal({ err }, "brain.startup_failed"); process.exit(1); });
