// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// Prometheus metrics for Claw Brain. Mirrors the surface V1
// exposed via app/metrics.py (sandbox start/stop/recover outcomes) and
// adds Brain-specific task-handling counters.
//
// ⚠ Discipline: every prom-client object MUST be constructed with
// `registers: [registry]`. Missing this binding causes the metric to
// silently land in prom-client's global default registry, which is
// NOT exposed by the /metrics route below — the metric just disappears.
// CI lint guard `claw/scripts/lint-metrics-must-register.sh` enforces
// this; see checkpoint-architecture-redesign §12.1.1.

import { Registry, collectDefaultMetrics, Counter, Gauge, Histogram } from "prom-client";
import type { SessionDestroyResult } from "../sandbox/multi-node/types.js";
// Type-only, so this stays a leaf module: container-probe imports it at runtime.
import type { ContainerProbeReason, ContainerProbeVerdict } from "../sandbox/container-probe.js";
import type { HandsRecoveryAction } from "../agent/index.js";

/**
 * Label domain of claw_brain_sandbox_recovery_decision_total: what the recovery
 * did, plus the two outcomes no action describes -- the attempt itself throwing,
 * and the budget refusing to make one. Derived from the action union so a new
 * action cannot quietly go uncounted.
 */
export type SandboxRecoveryDecision = HandsRecoveryAction | "failed" | "exhausted";

export const registry = new Registry();
registry.setDefaultLabels({ service: "claw-brain" });
collectDefaultMetrics({ register: registry });

const sandboxStartTotal = new Counter({
  name: "claw_sandbox_start_total",
  help: "Hands sandbox creation attempts by outcome.",
  labelNames: ["outcome"] as const,
  registers: [registry],
});
const sandboxStartDuration = new Histogram({
  name: "claw_sandbox_start_duration_seconds",
  help: "Wall-clock time to create a Hands sandbox and reach /health OK.",
  labelNames: ["outcome"] as const,
  buckets: [1, 5, 10, 30, 60, 120, 300, 600],
  registers: [registry],
});
const sandboxStopTotal = new Counter({
  name: "claw_sandbox_stop_total",
  help: "Hands sandbox teardown attempts by outcome.",
  labelNames: ["outcome"] as const,
  registers: [registry],
});
const sandboxSweeperEvicted = new Counter({
  name: "claw_sandbox_sweeper_evicted_total",
  help: "Stale Hands KV entries evicted by the background sweeper.",
  registers: [registry],
});
const taskTotal = new Counter({
  name: "claw_brain_task_total",
  help: "Brain task consumption by outcome.",
  labelNames: ["outcome"] as const,
  registers: [registry],
});
const taskDuration = new Histogram({
  name: "claw_brain_task_duration_seconds",
  help: "Wall-clock time to complete a Brain task (incl. sandbox ensure).",
  labelNames: ["outcome"] as const,
  buckets: [1, 5, 15, 30, 60, 120, 300, 600, 1800],
  registers: [registry],
});

// Hands-binary HTTP fallback (sandbox bootstrap downloads).
const handsBinaryDownloadTotal = new Counter({
  name: "claw_brain_hands_binary_download_total",
  help: "GET /internal/assets/hands-binary by outcome.",
  labelNames: ["outcome"] as const, // ok | unauthorized | forbidden | not_available
  registers: [registry],
});
const handsBinaryDownloadBytes = new Counter({
  name: "claw_brain_hands_binary_download_bytes_total",
  help: "Bytes streamed by /internal/assets/hands-binary on successful downloads.",
  registers: [registry],
});
const handsBinaryDownloadDuration = new Histogram({
  name: "claw_brain_hands_binary_download_duration_seconds",
  help: "Wall-clock time to stream the hands-binary on successful downloads.",
  buckets: [0.5, 1, 2, 5, 10, 30, 60],
  registers: [registry],
});

// INV-13 health (checkpoint-architecture-redesign §18.3.1): counts every
// time releaseSessionLock detected that the local pod is no longer the
// rightful holder of a NATS KV lock and therefore skipped the delete.
// Steady-state value MUST be 0; any non-zero rate signals competing
// brain pods or post-pause holder mismatch and warrants investigation.
const lockReleaseSkippedTotal = new Counter({
  name: "claw_brain_lock_release_skipped_total",
  help: "Session-lock release calls that detected we are no longer the holder (INV-13 protection fired).",
  labelNames: ["reason"] as const, // "not_holder" | "cas_lost" | "legacy_format"
  registers: [registry],
});

// ═══════════════════════════════════════════════════════════════════════
// Plan Y v2 checkpoint metrics (checkpoint-architecture-redesign §12.1).
// Names + label values MUST match §12.1.2 (closed enum, no dynamic
// interpolation); see CI guard lint-metrics-must-register.sh.
// ═══════════════════════════════════════════════════════════════════════

// ─── Checkpoint writes / reads ────────────────────────────────────────
const checkpointWritesTotal = new Counter({
  name: "claw_brain_checkpoint_writes_total",
  help: "NATS KV checkpoint writes by source path and outcome.",
  labelNames: ["kind", "result"] as const,
  // kind: "turn" | "sigterm" | "post_sync"
  // result: "success" | "failure"
  registers: [registry],
});

const checkpointResumeTotal = new Counter({
  name: "claw_brain_checkpoint_resume_total",
  help: "Resume attempts categorized by KV checkpoint readback outcome.",
  labelNames: ["result"] as const,
  // result: "hit" | "miss_first_delivery" | "miss_redelivery"
  //       | "skip_expired" | "skip_invalid_version" | "miss_unexpected"
  registers: [registry],
});

const checkpointWriteDurationSeconds = new Histogram({
  name: "claw_brain_checkpoint_write_duration_seconds",
  help: "End-to-end duration of a NATS KV checkpoint write (excludes serialize).",
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 5],
  labelNames: ["kind"] as const, // "turn" | "sigterm" | "post_sync"
  registers: [registry],
});

const checkpointSerializeDurationSeconds = new Histogram({
  name: "claw_brain_checkpoint_serialize_duration_seconds",
  help: "Time to JSON.stringify a checkpoint payload before NATS KV put.",
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.2, 0.5, 1],
  registers: [registry],
});

const checkpointPayloadBytes = new Histogram({
  name: "claw_brain_checkpoint_payload_bytes",
  help: "Size of serialized NATS KV checkpoint payload at write time.",
  buckets: [10_000, 50_000, 200_000, 1_000_000, 5_000_000, 16_000_000],
  registers: [registry],
});

// ─── SIGTERM grace-window timing ──────────────────────────────────────
const sigtermCheckpointDurationSeconds = new Histogram({
  name: "claw_brain_sigterm_checkpoint_duration_seconds",
  help: "Wall-clock spent in the SIGTERM checkpoint catch block.",
  buckets: [0.1, 0.5, 1, 5, 10, 30, 60, 120, 180, 300],
  labelNames: ["sync_result"] as const,
  // sync_result: "success" | "timeout" | "error" | "skipped"
  registers: [registry],
});

// ─── Workspace sync (configured shared filesystem) ────────────────────
const workspaceSyncBytes = new Histogram({
  name: "claw_brain_workspace_sync_bytes",
  help: "Size of .claw/workspaces/<sid>/current/ recorded after each sync.",
  buckets: [1e6, 1e7, 1e8, 1e9, 5e9, 1e10],
  registers: [registry],
});

const workspaceSyncDurationSeconds = new Histogram({
  name: "claw_brain_workspace_sync_duration_seconds",
  help: "End-to-end duration of one syncWorkspace() RPC measured brain-side.",
  buckets: [0.1, 0.5, 1, 5, 10, 30, 60, 120],
  labelNames: ["kind"] as const, // "normal" | "sigterm"
  registers: [registry],
});

const workspaceSyncFailuresTotal = new Counter({
  name: "claw_brain_workspace_sync_failures_total",
  help: "syncWorkspace failures by path and reason.",
  labelNames: ["kind", "reason"] as const,
  // kind: "normal" | "sigterm"
  // reason: "timeout" | "rsync_error" | "meta_write_error" | "hands_unreachable"
  registers: [registry],
});

const pendingSyncInflight = new Gauge({
  name: "claw_brain_pending_sync_inflight",
  help: "Active workspace syncs running in this brain pod across sessions.",
  labelNames: ["kind"] as const, // "normal" | "sigterm"
  registers: [registry],
});

const pendingSyncQueued = new Gauge({
  name: "claw_brain_pending_sync_queued",
  help: "Workspace syncs parked on the global semaphore.",
  labelNames: ["kind"] as const, // "normal" | "sigterm"
  registers: [registry],
});

// ─── Resume notice dedup (NP1-2) ──────────────────────────────────────
// agent-loop.filterResumeNotices drops accumulated "[system-notice]:"
// messages older than the most recent RESUME_NOTICE_KEEP_RECENT (=3)
// so a session that survives many rolling deploys does not pollute
// every subsequent LLM call with stale resume hints. This counter
// ticks once per filter pass that actually dropped at least one
// notice; the rate(...)[1h] over it is the chaos-test signal in
// checkpoint-architecture-redesign §13.3 NP1-2 row.
const resumeNoticeFilteredTotal = new Counter({
  name: "claw_brain_resume_notice_filtered_total",
  help: "filterResumeNotices passes that dropped at least one [system-notice]: message.",
  registers: [registry],
});

// ─── Prompt cache ─────────────────────────────────────────────────────
// Brain had no token or cache metric at all, which is why a 0% cache hit
// rate ran for two years and was found by reading a bill. The only place
// these numbers landed was the terminal ResultMessage, and a babysitter
// session that runs for twelve hours never reaches one.
//
// The counter that matters is the pair: markers going out and reads coming
// back. `breakpoints_sent > 0 && rate(cache_read) == 0` is the fingerprint
// of this incident and of any future prefix invalidation, and neither half
// says it alone.
const llmTokensTotal = new Counter({
  name: "claw_brain_llm_tokens_total",
  help: "Prompt tokens by how they were billed. Absent kinds mean the provider cannot report them, not zero.",
  labelNames: ["kind"],
  registers: [registry],
});
const llmCacheTurnsTotal = new Counter({
  name: "claw_brain_llm_cache_turns_total",
  help: "LLM turns by prompt-cache outcome.",
  labelNames: ["state"],
  registers: [registry],
});
const llmCacheBreakpointsSent = new Histogram({
  name: "claw_brain_llm_cache_breakpoints_sent",
  help: "cache_control markers counted off the request body actually sent.",
  buckets: [0, 1, 2, 3, 4],
  registers: [registry],
});
// Which lifetime the write actually got.
//
// A gateway that quietly answers a 1h marker with a 5m entry is a 200 OK
// failure: the request succeeds, the cache works, and the entry expires under
// the sleep it was chosen to outlast -- the same shape as the incident this
// whole change exists to prevent, and invisible in every other number here.
// `ttl="unreported"` means the gateway sent no breakdown, which is not the
// same as a zero and must not be read as one.
const llmCacheWriteTokensTotal = new Counter({
  name: "claw_brain_llm_cache_write_tokens_total",
  help: "Cache-write tokens by the lifetime the gateway actually granted.",
  labelNames: ["ttl"],
  registers: [registry],
});
const llmCacheDisabledTotal = new Counter({
  name: "claw_brain_llm_cache_disabled_total",
  help: "Sessions that stopped sending cache markers after the gateway rejected them.",
  registers: [registry],
});
// Turns whose prompt size nobody could measure.
//
// Compaction is the only context-size guard here and it needs a number to
// compare. A provider that reports no usage leaves the run with that guard
// silently absent, which is indistinguishable from a healthy run until the
// context window rejects a request. Rising here means some route is flying
// blind.
const promptSizeUnknownTotal = new Counter({
  name: "claw_brain_prompt_size_unknown_total",
  help: "Turns where no provider reported a prompt size, leaving compaction with nothing to compare.",
  registers: [registry],
});
const compactionTotal = new Counter({
  name: "claw_brain_compaction_total",
  help: "Auto-compaction attempts by result.",
  labelNames: ["result"],
  registers: [registry],
});

// ─── Resume path classification ───────────────────────────────────────
const sandboxProbeTotal = new Counter({
  name: "claw_brain_sandbox_probe_total",
  help: "Sandbox liveness probe results during resume.",
  labelNames: ["result"] as const,
  // result: "alive" | "alive_no_kv" | "dead" | "no_hands"
  registers: [registry],
});

// ─── In-flight sandbox recovery: the destroy decision ─────────────────
// Recovery takes one of a few actions per attempt, and until these existed
// none of them were visible: a fleet where every attempt only renews the
// transport because the container is alive, and one where every attempt is
// stalling on an unreachable control plane, both showed up only as sessions
// that stopped making progress. The probe counter says what the data plane
// answered; the decision counter says what was done about it.
const sandboxContainerProbeTotal = new Counter({
  name: "claw_brain_sandbox_container_probe_total",
  help: "Data-plane exec probes of a sandbox container, by verdict and evidence.",
  // The reason is on the counter because "unknown" alone does not say what to
  // fix: an unreadable KV bucket, a Router throwing and a probe that timed out
  // are three different outages behind one verdict. Both label domains are
  // closed unions in sandbox/container-probe.ts, so this is ~30 series at most.
  labelNames: ["verdict", "reason"] as const,
  registers: [registry],
});

const sandboxContainerProbeDuration = new Histogram({
  name: "claw_brain_sandbox_container_probe_duration_seconds",
  help: "Wall-clock of one container probe, including the control-plane call.",
  // Bucketed around the probe's own 8s ceiling: the interesting question is how
  // much of a tool batch the probe is eating, and the tail is capped by design.
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 4, 8],
  labelNames: ["verdict"] as const,
  registers: [registry],
});

const sandboxRecoveryDecisionTotal = new Counter({
  name: "claw_brain_sandbox_recovery_decision_total",
  help: "What in-flight sandbox recovery did once the probe answered.",
  labelNames: ["decision"] as const,
  registers: [registry],
});

const resumeWorkspaceModeTotal = new Counter({
  name: "claw_brain_resume_workspace_mode_total",
  help: "Resume path distribution; SLO-1a/b are derived from this counter.",
  labelNames: ["mode"] as const,
  // mode: "sandbox_reuse" | "workspace_restore" | "no_data_turn0" | "skip_no_ckpt"
  registers: [registry],
});

const taskRedeliveryTotal = new Counter({
  name: "claw_brain_task_redelivery_total",
  help: "NATS task redeliveries observed by this brain pod.",
  labelNames: ["has_checkpoint"] as const, // "true" | "false"
  registers: [registry],
});

// ─── Event-loop / pod-health (NP0-3) ──────────────────────────────────
// Updated by brain/src/infra/watchdog.ts via its own setInterval(1s) tick;
// fully decoupled from any session keepalive so a single healthy session
// cannot mask a stuck pod (the v2.8 design flaw this metric was renamed
// to fix). Healthy steady state oscillates 0–2. > 10 = event-loop lag;
// > 60 = pod hung, INV-13 NATS lock at imminent risk of expiry.
const watchdogLastTickAgeSeconds = new Gauge({
  name: "claw_brain_watchdog_last_tick_age_seconds",
  help: "Seconds since the pod-level watchdog setInterval(1s) tick fired. "
      + "Healthy: 0–2. >10: event loop lag. >60: pod hang (INV-13 broken).",
  registers: [registry],
});

// The brain's own poison guard firing, one delivery before NATS would have
// dropped the task. Split by reason because the two demand opposite responses:
// "max_retries_exceeded" is a task that keeps failing and wants a root cause,
// while "lock_contention_exhausted" is a healthy task killed by a queue --
// its siblings are holding locks longer than the redelivery budget can
// outlast, and the fix is capacity or lock granularity, not the task.
const taskPoisonDiscardedTotal = new Counter({
  name: "claw_brain_task_poison_discarded_total",
  help: "Tasks resolved and discarded by the brain's poison guard, by reason.",
  labelNames: ["reason"] as const, // TerminalRefusalReason
  registers: [registry],
});

// The guard declining to resolve a task it cannot prove is poisoned. Counted
// because the causes are otherwise invisible and mean different things:
// "unknown_holder" is a pre-seq lock during a rolling upgrade and must fall to
// zero once the old pods are gone, "probe_failed" is the lock read itself
// failing and points at NATS rather than at any task, and
// "already_running_final" is a message deliberately left unsettled on its last
// delivery -- correct, since the running handler owns the ack, but the one
// case where a handler dying takes the task with it and nothing else notices.
const taskPoisonDeferredTotal = new Counter({
  name: "claw_brain_task_poison_deferred_total",
  help: "Deliveries the poison guard declined to resolve, by cause.",
  labelNames: ["cause"] as const,
  registers: [registry],
});

// The guard reached its last delivery and still could not hand the task off,
// so the message was terminated with the session left marked running. This is
// the residual silent drop -- the guard cannot resolve a task when the
// resolution path is what is broken -- and the only signal that it happened.
// Any increment is a stuck session needing manual closure, and points at the
// emitter or the task callback rather than at the task.
const taskPoisonUnresolvedTotal = new Counter({
  name: "claw_brain_task_poison_unresolved_total",
  help: "Tasks the poison guard abandoned because the terminal handoff kept failing.",
  labelNames: ["reason"] as const, // TerminalRefusalReason
  registers: [registry],
});

const deliveryRefusedTotal = new Counter({
  name: "claw_brain_delivery_refused_total",
  help: "Deliveries this pod handed back without running, by reason.",
  labelNames: ["reason"] as const, // "surplus" | "drain"
  registers: [registry],
});

const gateInflight = new Gauge({
  name: "claw_brain_gate_inflight",
  help: "Tasks holding an execution slot on this pod.",
  registers: [registry],
});

const gateQueued = new Gauge({
  name: "claw_brain_gate_queued",
  help: "Deliveries on this pod waiting for an execution slot.",
  registers: [registry],
});

const gateParked = new Gauge({
  name: "claw_brain_gate_parked",
  help: "Runs on this pod waiting on something external, holding a sandbox and no slot.",
  registers: [registry],
});

const deliveriesHeld = new Gauge({
  name: "claw_brain_deliveries_held",
  help: "Deliveries this pod has taken responsibility for and not yet settled.",
  registers: [registry],
});

/**
 * Why a task was resolved without ever running it.
 *
 * Shared with task-runner so the metric label and the failure recorded on the
 * row cannot describe different things. `workspace_unbound` differs from the
 * other two in kind: they mean the task was tried and kept failing, this one
 * means it was never eligible to be tried.
 */
export type TerminalRefusalReason =
  | "max_retries_exceeded"
  | "lock_contention_exhausted"
  | "workspace_unbound";

/**
 * Label domain of claw_brain_session_cleanup_incomplete_total.
 *
 * The teardown's own reasons, plus the two only the caller can produce: `threw`
 * for an exception on the way through, `unknown` for an incomplete result that
 * named none. Derived from the destroy union rather than restated, so a reason
 * added there reaches this metric instead of quietly going unlabelled, and a
 * typo cannot invent a series nobody is scraping. NonNullable because `reason`
 * is optional there, and `undefined` would widen to an empty label here.
 */
export type SessionCleanupIncompleteReason =
  | NonNullable<SessionDestroyResult["reason"]>
  | "threw"
  | "unknown";

// A session teardown that could not confirm it removed everything, and so
// handed the session to the idle-reclaim path instead. Not a leak on its own --
// the sweeper reclaims the clusters on its next pass and the control-plane's
// idle GC takes the pod -- but it means a delete did not do its job directly.
// Steady state is 0; a sustained rate points at SaFE trouble.
const sessionCleanupIncompleteTotal = new Counter({
  name: "claw_brain_session_cleanup_incomplete_total",
  help: "Session teardowns left to the idle-reclaim path, by reason.",
  labelNames: ["reason"] as const,
  registers: [registry],
});

export const metrics = {
  /**
   * One LLM turn's cache accounting.
   *
   * `reported` says which numbers this provider can actually speak to. A kind
   * it cannot report emits NO series rather than a zero one: an absent series
   * reads as "we cannot see this", while a series pinned at 0 is a lie a
   * dashboard averages. The OpenAI path never assigns cache_create, and that
   * structural zero presented as an observation is precisely the shape of the
   * failure this whole metric exists to catch.
   */
  onLlmTurnCache(input: {
    inputTokens: number;
    outputTokens: number;
    cacheRead: number;
    cacheCreate: number;
    breakpointsSent: number;
    enabled: boolean;
    reported: ReadonlyArray<"cache_read" | "cache_create">;
    createdEphemeral5m?: number;
    createdEphemeral1h?: number;
  }): void {
    llmTokensTotal.inc({ kind: "input" }, input.inputTokens);
    llmTokensTotal.inc({ kind: "output" }, input.outputTokens);
    if (input.reported.includes("cache_read")) {
      llmTokensTotal.inc({ kind: "cache_read" }, input.cacheRead);
    }
    if (input.reported.includes("cache_create")) {
      llmTokensTotal.inc({ kind: "cache_create" }, input.cacheCreate);
    }
    // Split the write by lifetime when the gateway said; otherwise record it
    // as unreported rather than inventing a bucket for it.
    if (input.createdEphemeral5m !== undefined || input.createdEphemeral1h !== undefined) {
      if (input.createdEphemeral5m) llmCacheWriteTokensTotal.inc({ ttl: "5m" }, input.createdEphemeral5m);
      if (input.createdEphemeral1h) llmCacheWriteTokensTotal.inc({ ttl: "1h" }, input.createdEphemeral1h);
    } else if (input.cacheCreate > 0 && input.reported.includes("cache_create")) {
      llmCacheWriteTokensTotal.inc({ ttl: "unreported" }, input.cacheCreate);
    }
    llmCacheBreakpointsSent.observe(input.breakpointsSent);
    // Observed behaviour first, our configuration second. A backend that
    // caches on its own -- genuine OpenAI does -- serves a hit on a turn where
    // we sent no markers, and calling that "off" while the same turn
    // increments cache_read said two contradictory things about one request.
    // "off" now means only "we sent nothing and nothing came back".
    const state = input.cacheRead > 0
      ? "hit"
      : input.cacheCreate > 0
        ? "write"
        : input.enabled
          ? "miss"
          : "off";
    llmCacheTurnsTotal.inc({ state });
  },
  onPromptSizeUnknown(): void {
    promptSizeUnknownTotal.inc();
  },
  onLlmCacheDisabled(): void {
    llmCacheDisabledTotal.inc();
  },
  /** Whether compaction still fires. Moving its trigger without this is a
   *  behaviour change nobody can see. */
  onCompaction(result: "compacted" | "noop" | "failed"): void {
    compactionTotal.inc({ result });
  },
  onSandboxStart(outcome: "ok" | "error", elapsedSec: number): void {
    sandboxStartTotal.inc({ outcome });
    sandboxStartDuration.observe({ outcome }, elapsedSec);
  },
  onSandboxStop(outcome: "ok" | "error"): void {
    sandboxStopTotal.inc({ outcome });
  },
  onSandboxSweeperEvict(n: number): void {
    if (n > 0) sandboxSweeperEvicted.inc(n);
  },
  onTask(outcome: "ok" | "retryable" | "failed", elapsedSec: number): void {
    taskTotal.inc({ outcome });
    taskDuration.observe({ outcome }, elapsedSec);
  },
  onHandsBinaryDownload(
    outcome: "ok" | "unauthorized" | "forbidden" | "not_available",
    bytes = 0,
    elapsedSec = 0,
  ): void {
    handsBinaryDownloadTotal.inc({ outcome });
    if (outcome === "ok") {
      handsBinaryDownloadBytes.inc(bytes);
      handsBinaryDownloadDuration.observe(elapsedSec);
    }
  },
  onLockReleaseSkipped(reason: "not_holder" | "cas_lost" | "legacy_format"): void {
    lockReleaseSkippedTotal.inc({ reason });
  },
  /**
   * A session delete could not confirm everything was removed, so the session
   * was handed to the idle-reclaim path. `reason` carries what stopped it.
   */
  onSessionCleanupIncomplete(reason: SessionCleanupIncompleteReason): void {
    sessionCleanupIncompleteTotal.inc({ reason });
  },

  // ─── Plan Y v2 checkpoint helpers ────────────────────────────────
  onCheckpointWrite(
    kind: "turn" | "sigterm" | "post_sync",
    result: "success" | "failure",
    durationSec: number,
    payloadBytes?: number,
    serializeSec?: number,
  ): void {
    checkpointWritesTotal.inc({ kind, result });
    checkpointWriteDurationSeconds.observe({ kind }, durationSec);
    if (typeof payloadBytes === "number" && payloadBytes >= 0) {
      checkpointPayloadBytes.observe(payloadBytes);
    }
    if (typeof serializeSec === "number" && serializeSec >= 0) {
      checkpointSerializeDurationSeconds.observe(serializeSec);
    }
  },
  onCheckpointResume(
    result: "hit" | "miss_first_delivery" | "miss_redelivery"
          | "skip_expired" | "skip_invalid_version" | "miss_unexpected",
  ): void {
    checkpointResumeTotal.inc({ result });
  },
  onSigtermCheckpoint(
    durationSec: number,
    sync_result: "success" | "timeout" | "error" | "skipped",
  ): void {
    sigtermCheckpointDurationSeconds.observe({ sync_result }, durationSec);
  },
  onWorkspaceSync(
    kind: "normal" | "sigterm",
    sizeBytes: number,
    durationSec: number,
  ): void {
    workspaceSyncBytes.observe(sizeBytes);
    workspaceSyncDurationSeconds.observe({ kind }, durationSec);
  },
  onWorkspaceSyncFailure(
    kind: "normal" | "sigterm",
    reason: "timeout" | "rsync_error" | "meta_write_error" | "hands_unreachable"
      | "config_error" | "empty_workspace",
  ): void {
    workspaceSyncFailuresTotal.inc({ kind, reason });
  },
  setPendingSyncGauges(
    kind: "normal" | "sigterm",
    inflight: number,
    queued: number,
  ): void {
    pendingSyncInflight.set({ kind }, inflight);
    pendingSyncQueued.set({ kind }, queued);
  },
  onSandboxProbe(result: "alive" | "alive_no_kv" | "dead" | "no_hands"): void {
    sandboxProbeTotal.inc({ result });
  },
  onSandboxContainerProbe(
    verdict: ContainerProbeVerdict,
    reason: ContainerProbeReason,
    durationSec: number,
  ): void {
    sandboxContainerProbeTotal.inc({ verdict, reason });
    // Duration by verdict only: what this answers is how much of a tool batch
    // the probe is eating, and splitting it by reason as well would leave every
    // bucket too sparse to read.
    sandboxContainerProbeDuration.observe({ verdict }, durationSec);
  },
  onSandboxRecoveryDecision(decision: SandboxRecoveryDecision): void {
    sandboxRecoveryDecisionTotal.inc({ decision });
  },
  onResumeWorkspaceMode(
    mode: "sandbox_reuse" | "workspace_restore" | "no_data_turn0" | "skip_no_ckpt",
  ): void {
    resumeWorkspaceModeTotal.inc({ mode });
  },
  onTaskRedelivery(has_checkpoint: "true" | "false"): void {
    taskRedeliveryTotal.inc({ has_checkpoint });
  },
  onResumeNoticeFiltered(): void {
    resumeNoticeFilteredTotal.inc();
  },
  onTaskPoisonDiscarded(reason: TerminalRefusalReason): void {
    taskPoisonDiscardedTotal.inc({ reason });
  },
  onTaskPoisonUnresolved(reason: TerminalRefusalReason): void {
    taskPoisonUnresolvedTotal.inc({ reason });
  },
  onTaskPoisonDeferred(
    cause: "already_running" | "already_running_final" | "unknown_holder" | "probe_failed",
  ): void {
    taskPoisonDeferredTotal.inc({ cause });
  },
  onDeliveryRefused(reason: "surplus" | "drain"): void {
    deliveryRefusedTotal.inc({ reason });
  },
  setDeliveryGauges(state: {
    inflight: number;
    queued: number;
    parked: number;
    held: number;
  }): void {
    gateInflight.set(state.inflight);
    gateQueued.set(state.queued);
    gateParked.set(state.parked);
    deliveriesHeld.set(state.held);
  },
};

// ─── Intentionally NOT implemented (design Gap-1, NP1-1) ─────────────
//
// Plan Y v2 §12.1/§13.1's `claw_brain_session_state_dropped_total` counter
// and `trackSessionStateSize` helper assumed a long-lived per-session state
// cache to evict; brain is actually stateless (no such cache), so both are
// intentionally omitted here — add them back if a future refactor
// introduces one.

// Direct gauge handle for the watchdog timer (brain/src/infra/watchdog.ts).
// Exported separately so the watchdog module does not need to go through
// the helper object and can update the gauge from inside a setInterval
// callback without an extra layer of indirection.
export { watchdogLastTickAgeSeconds };
