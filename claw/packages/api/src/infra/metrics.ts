// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// Prometheus metrics for Claw API server. Session and dispatch outcomes,
// event-consumer throughput, and the doorbell rollout surface: admission
// decisions, run hand-off, claim/unclaim and queue sojourn. Sandbox metrics
// live in the Brain process (see packages/brain/src/infra/metrics.ts).
//
// ⚠ Discipline: every prom-client object MUST be constructed with
// `registers: [registry]`. Missing this binding causes the metric to
// silently land in prom-client's global default registry, which is
// NOT exposed by the /metrics route — the metric just disappears.
// CI lint guard `claw/scripts/lint-metrics-must-register.sh` enforces this.
//
// No metric here is identified by a label a scrape supplies or overwrites:
// `service` (a ServiceMonitor rewrites it), `pod`, `instance`, `namespace`,
// `node`. Every label domain below is a closed literal union, so TypeScript
// is the cardinality guard at each call site.

import { Registry, collectDefaultMetrics, Counter, Gauge, Histogram } from "prom-client";
import type { RunFailClaimReason, RunUnclaimReason } from "@claw/protocol";
// Type-only, so this stays a leaf module: the emitting modules import it at runtime.
import type { AdmissionAsk } from "../tasks/admission.js";
import type { ExhaustedClaim } from "../tasks/run-claim.js";
import type { HandOffResult } from "../tasks/run-dispatch.js";

export type AdmissionOrigin = AdmissionAsk["origin"];

/** Terminal answers of `decideAdmission`; `error` is a throw out of it. */
export type AdmissionDecisionLabel = "admit" | "queue" | "reject" | "error";

/** Whether the refusal came from the pre-insert decision or the post-insert recheck. */
export type AdmissionStage = "pre_insert" | "post_insert";

/**
 * Refusal vocabulary of `decideAdmission`.
 *
 * Stated structurally because `admission.ts` does not yet declare
 * `ADMISSION_REJECT_REASONS`; replace with a type-only import of
 * `AdmissionRejectReason` once it does, rather than growing a second enum here.
 */
export type AdmissionRejectReasonLabel =
  | "runs_hard_limit"
  | "sandboxes_hard_limit"
  | "gpu_nodes_hard_limit"
  | "tree_nodes_exceeded"
  | "tree_depth_exceeded";

export const ADMISSION_DIMENSIONS = [
  "soft_runs", "hard_runs",
  "soft_sandboxes", "hard_sandboxes",
  "soft_gpu_nodes", "hard_gpu_nodes",
  "tree_max_nodes", "tree_max_depth",
] as const;
export type AdmissionDimension = (typeof ADMISSION_DIMENSIONS)[number];

/** Which caller handed the run off. */
export type DispatchPath = "chat" | "pending";

export type DispatchOutcome = HandOffResult["kind"] | "error";

/** Why a compensation was declined because a worker already held the row. */
export type DispatchHeldCause =
  | "hard_limit_exceeded"
  | "hard_limit_recheck_threw"
  | "doorbell_publish_failed";

/** `by_id` is the doorbell wakeup route, `next` the pull loop. */
export type ClaimMode = "by_id" | "next";

export type ClaimOutcome =
  | "claimed" | "empty" | "all_skipped" | "retry_limit"
  | "missing" | "busy" | "unclaimable" | "exhausted" | "error";

/**
 * Why one candidate row was passed over.
 *
 * `missing` and `busy` share `raced`: both mean another pod moved the row, and
 * only the persistent causes below them can mean a stuck queue.
 */
export type ClaimSkipCause = "raced" | "unclaimable" | "exhausted" | "error";

export type ClaimExhaustionReason = ExhaustedClaim["reason"];

/**
 * `unspecified` exists only in the metric: a request body carrying it is still
 * refused by `RELEASE_REASONS`, and folding it into `retry` would hide the
 * version skew it reports.
 */
export type UnclaimReasonLabel = RunUnclaimReason | "unspecified";

/** What the holder generation guard answered; `error` is the route-level catch. */
export type HolderVerdict = "accepted" | "not_holder" | "error";

export type QueueEntryCause = "admission" | "direct" | "requeue";

export type QueueExitOutcome =
  | "claimed" | "timed_out" | "budget_exhausted" | "duplicate_closed"
  | "dispatch_failed" | "chat_closed" | "cancelled";

/** The two exits that can read the §4.8 `metadata.queued_since` marker. */
export type QueueWaitOutcome = Extract<QueueExitOutcome, "claimed" | "timed_out">;

function isQueueWaitOutcome(outcome: QueueExitOutcome): outcome is QueueWaitOutcome {
  return outcome === "claimed" || outcome === "timed_out";
}

export type EverHeld = "true" | "false";

export const registry = new Registry();
registry.setDefaultLabels({ service: "claw-api" });
collectDefaultMetrics({ register: registry });

const sessionCreatedTotal = new Counter({
  name: "claw_api_session_created_total",
  help: "Session creations by outcome.",
  labelNames: ["outcome"] as const, // ok | error
  registers: [registry],
});
const sessionDeletedTotal = new Counter({
  name: "claw_api_session_deleted_total",
  help: "Session soft-deletes by outcome.",
  labelNames: ["outcome"] as const, // ok | error
  registers: [registry],
});
const messageDispatchedTotal = new Counter({
  name: "claw_api_message_dispatched_total",
  help: "Messages dispatched to Brain via NATS task stream.",
  labelNames: ["outcome"] as const, // ok | error
  registers: [registry],
});
const eventPersistedTotal = new Counter({
  name: "claw_api_event_persisted_total",
  help: "Events persisted by the durable event consumer.",
  labelNames: ["outcome"] as const, // ok | error
  registers: [registry],
});

// ─── Admission ────────────────────────────────────────────────────────
// `decision="error"` is not decoration: loadUsage and queueLength are
// unguarded db.query calls, so without it a partial database outage would
// drop failed creates out of every rollout ratio's denominator while the
// successful ones kept counting, and the fleet would read healthier the
// worse it got.
const admissionDecisionTotal = new Counter({
  name: "claw_api_admission_decision_total",
  help: "Terminal answers of decideAdmission, including throws.",
  labelNames: ["origin", "decision"] as const,
  // origin: chat | task | dag_node
  // decision: admit | queue | reject | error
  registers: [registry],
});
const admissionRejectedTotal = new Counter({
  name: "claw_api_admission_rejected_total",
  help: "Admission refusals by reason and by the stage that refused.",
  labelNames: ["origin", "stage", "reason"] as const,
  // stage: pre_insert | post_insert
  // reason: runs_hard_limit | sandboxes_hard_limit | gpu_nodes_hard_limit
  //       | tree_nodes_exceeded | tree_depth_exceeded
  registers: [registry],
});
// Enablement, not the ceiling: the value is deployment capacity, and re-tuning
// it would orphan the old series. 0/1 answers the only question the rollout
// asks -- has this replica picked the config up yet.
const admissionEnforced = new Gauge({
  name: "claw_api_admission_enforced",
  help: "1 when this dimension's ceiling is non-zero in this process, else 0.",
  labelNames: ["dimension"] as const,
  // dimension: soft_runs | hard_runs | soft_sandboxes | hard_sandboxes
  //          | soft_gpu_nodes | hard_gpu_nodes | tree_max_nodes | tree_max_depth
  registers: [registry],
});

// ─── Doorbell state ───────────────────────────────────────────────────
const doorbellDispatchEnabled = new Gauge({
  name: "claw_api_doorbell_dispatch_enabled",
  help: "1 when RUN_DOORBELL_DISPATCH is true in this process, set once at startup.",
  registers: [registry],
});

// ─── Dispatch hand-off ────────────────────────────────────────────────
const runDispatchTotal = new Counter({
  name: "claw_api_run_dispatch_total",
  help: "handOffAssembledRun results by caller, including throws.",
  labelNames: ["path", "outcome"] as const,
  // path: chat | pending
  // outcome: dispatched | queued | rejected | open_failed | error
  registers: [registry],
});
// A run that executed despite a refusal or a failed publish. Its own counter
// rather than a dispatch outcome, because the hand-off result really is
// `dispatched` and folding the two would make the honest answer and the
// anomaly indistinguishable.
const runDispatchHeldTotal = new Counter({
  name: "claw_api_run_dispatch_held_total",
  help: "Compensations declined because a worker already held the row.",
  labelNames: ["cause"] as const,
  // cause: hard_limit_exceeded | hard_limit_recheck_threw | doorbell_publish_failed
  registers: [registry],
});

// ─── Claim / unclaim ──────────────────────────────────────────────────
const runClaimTotal = new Counter({
  name: "claw_api_run_claim_total",
  help: "Claim requests by route and outcome.",
  labelNames: ["mode", "outcome"] as const,
  // mode: by_id | next
  // outcome: claimed | empty | all_skipped | retry_limit | missing | busy
  //        | unclaimable | exhausted | error
  registers: [registry],
});
const runClaimSkippedTotal = new Counter({
  name: "claw_api_run_claim_skipped_total",
  help: "Candidate rows claim-next passed over, one per row.",
  labelNames: ["cause"] as const, // raced | unclaimable | exhausted | error
  registers: [registry],
});
const runClaimExhaustedTotal = new Counter({
  name: "claw_api_run_claim_exhausted_total",
  help: "Rows the poison guard closed during a claim, by route and cause.",
  labelNames: ["mode", "reason"] as const,
  // reason: lock_contention_exhausted | max_retries_exceeded
  registers: [registry],
});
// `outcome="error"` covers an unguarded db.query fault becoming Fastify's 500.
// A failed unclaim leaves the row `running` under a holder that has given up,
// recoverable only once the lease expires, so the fault needs its own count --
// doorbell_lease_requeued_total reports the recovery, not the fault.
const runUnclaimTotal = new Counter({
  name: "claw_api_run_unclaim_total",
  help: "Unclaim requests by declared reason and holder verdict.",
  labelNames: ["reason", "outcome"] as const,
  // reason: lock_contention | retry | drain | hydrate_failed | unspecified
  // outcome: accepted | not_holder | error
  registers: [registry],
});
const runFailClaimTotal = new Counter({
  name: "claw_api_run_fail_claim_total",
  help: "Terminal fail-claim requests by reason and holder verdict.",
  labelNames: ["reason", "outcome"] as const,
  // reason: session_deleted | claim_abandoned | workspace_unbound
  // outcome: accepted | not_holder | error
  registers: [registry],
});

// ─── Queue behaviour ──────────────────────────────────────────────────
const runQueueEnteredTotal = new Counter({
  name: "claw_api_run_queue_entered_total",
  help: "Rows reaching status queued, by what put them there.",
  labelNames: ["cause"] as const, // admission | direct | requeue
  registers: [registry],
});
const runQueueExitedTotal = new Counter({
  name: "claw_api_run_queue_exited_total",
  help: "Rows leaving status queued, counted by the write that moved them.",
  labelNames: ["outcome"] as const,
  // outcome: claimed | timed_out | budget_exhausted | duplicate_closed
  //        | dispatch_failed | chat_closed | cancelled
  registers: [registry],
});
// The last finite bucket is RUN_QUEUE_MAX_SEC's shipped two-hour default, so a
// sojourn that reached the timeout is the top bucket rather than the overflow.
const runQueueWaitSeconds = new Histogram({
  name: "claw_api_run_queue_wait_seconds",
  help: "Length of one queue sojourn, measured from the metadata.queued_since marker.",
  labelNames: ["origin", "outcome"] as const,
  // origin: chat | task | dag_node
  // outcome: claimed | timed_out
  buckets: [1, 5, 15, 30, 60, 300, 900, 1800, 3600, 7200],
  registers: [registry],
});
const runQueueTimeoutTotal = new Counter({
  name: "claw_api_run_queue_timeout_total",
  help: "Queued rows closed by the reaper, split by whether a worker ever held them.",
  labelNames: ["ever_held"] as const, // true | false
  registers: [registry],
});
const doorbellLeaseRequeuedTotal = new Counter({
  name: "claw_api_doorbell_lease_requeued_total",
  help: "Rows requeued by requeueLostDoorbellLeases.",
  registers: [registry],
});

/**
 * Seconds between a queue-sojourn marker and now, or null when unreadable.
 *
 * A marker ahead of the clock is skew between the writing and reading pod, not
 * a negative wait, so it reads as zero rather than falling into the first bucket
 * as a measurement nobody took.
 */
function sojournSeconds(markerIso: string | null | undefined): number | null {
  if (!markerIso) return null;
  const started = Date.parse(markerIso);
  if (Number.isNaN(started)) return null;
  return Math.max(0, (Date.now() - started) / 1000);
}

export const metrics = {
  onSessionCreated(outcome: "ok" | "error"): void {
    sessionCreatedTotal.inc({ outcome });
  },
  onSessionDeleted(outcome: "ok" | "error"): void {
    sessionDeletedTotal.inc({ outcome });
  },
  onMessageDispatched(outcome: "ok" | "error"): void {
    messageDispatchedTotal.inc({ outcome });
  },
  onEventPersisted(outcome: "ok" | "error"): void {
    eventPersistedTotal.inc({ outcome });
  },

  onAdmissionDecision(origin: AdmissionOrigin, decision: AdmissionDecisionLabel): void {
    admissionDecisionTotal.inc({ origin, decision });
  },
  onAdmissionRejected(
    origin: AdmissionOrigin,
    stage: AdmissionStage,
    reason: AdmissionRejectReasonLabel,
  ): void {
    admissionRejectedTotal.inc({ origin, stage, reason });
  },
  setAdmissionEnforced(dimension: AdmissionDimension, enforced: boolean): void {
    admissionEnforced.set({ dimension }, enforced ? 1 : 0);
  },
  setDoorbellDispatchEnabled(enabled: boolean): void {
    doorbellDispatchEnabled.set(enabled ? 1 : 0);
  },

  onRunDispatch(path: DispatchPath, outcome: DispatchOutcome): void {
    runDispatchTotal.inc({ path, outcome });
  },
  onRunDispatchHeld(cause: DispatchHeldCause): void {
    runDispatchHeldTotal.inc({ cause });
  },

  onRunClaim(mode: ClaimMode, outcome: ClaimOutcome): void {
    runClaimTotal.inc({ mode, outcome });
  },
  onRunClaimSkipped(cause: ClaimSkipCause): void {
    runClaimSkippedTotal.inc({ cause });
  },
  onRunClaimExhausted(mode: ClaimMode, reason: ClaimExhaustionReason): void {
    runClaimExhaustedTotal.inc({ mode, reason });
  },
  onRunUnclaim(reason: UnclaimReasonLabel, outcome: HolderVerdict): void {
    runUnclaimTotal.inc({ reason, outcome });
  },
  onRunFailClaim(reason: RunFailClaimReason, outcome: HolderVerdict): void {
    runFailClaimTotal.inc({ reason, outcome });
  },

  onQueueEntered(cause: QueueEntryCause, rows = 1): void {
    if (rows > 0) runQueueEnteredTotal.inc({ cause }, rows);
  },
  onQueueExited(outcome: QueueExitOutcome, rows = 1): void {
    if (rows > 0) runQueueExitedTotal.inc({ outcome }, rows);
  },
  /**
   * One row leaving `queued`, with its sojourn when the exit can measure one.
   *
   * The counter always moves; the histogram only for the two outcomes that read
   * the marker and only when the row carries one, so a row that never waited
   * behind a soft ceiling contributes no wait rather than a zero.
   */
  observeQueueExit(
    origin: AdmissionOrigin,
    markerIso: string | null | undefined,
    outcome: QueueExitOutcome,
  ): void {
    metrics.onQueueExited(outcome);
    if (!isQueueWaitOutcome(outcome)) return;
    const waited = sojournSeconds(markerIso);
    if (waited === null) return;
    runQueueWaitSeconds.observe({ origin, outcome }, waited);
  },
  onQueueTimeout(everHeld: EverHeld): void {
    runQueueTimeoutTotal.inc({ ever_held: everHeld });
  },
  onDoorbellLeaseRequeued(rows: number): void {
    if (rows > 0) doorbellLeaseRequeuedTotal.inc(rows);
  },
};
