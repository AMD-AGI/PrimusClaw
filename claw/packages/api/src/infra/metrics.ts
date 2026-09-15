// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// Two rules `claw/scripts/lint-metrics-must-register.sh` enforces, because the
// code cannot: every prom-client object carries `registers: [registry]`, or the
// metric lands in the global default registry that /metrics does not expose and
// simply disappears; and no label may be one a scrape supplies or rewrites --
// `service`, `pod`, `instance`, `namespace`, `node`.

import { Registry, collectDefaultMetrics, Counter, Gauge, Histogram } from "prom-client";
import type { RunFailClaimReason, RunUnclaimReason } from "@claw/protocol";
// Type-only, so this stays a leaf module: the emitting modules import it at runtime.
import type { AdmissionAsk, AdmissionRejectReason } from "../tasks/admission.js";
import type { ExhaustedClaim } from "../tasks/run-claim.js";
import type { HandOffResult } from "../tasks/run-dispatch.js";

export type AdmissionOrigin = AdmissionAsk["origin"];

export type AdmissionDecisionLabel = "admit" | "queue" | "reject" | "error";

export type AdmissionStage = "pre_insert" | "post_insert";

/** Taken from the producing module: a second copy could drift into an unlabelled reason. */
export type AdmissionRejectReasonLabel = AdmissionRejectReason;

export const ADMISSION_DIMENSIONS = [
  "soft_runs", "hard_runs",
  "soft_sandboxes", "hard_sandboxes",
  "soft_gpu_nodes", "hard_gpu_nodes",
  "tree_max_nodes", "tree_max_depth",
] as const;
export type AdmissionDimension = (typeof ADMISSION_DIMENSIONS)[number];

export type DispatchPath = "chat" | "pending";

export type DispatchOutcome = HandOffResult["kind"] | "error";

export type DispatchHeldCause =
  | "hard_limit_exceeded"
  | "hard_limit_recheck_threw"
  | "doorbell_publish_failed";

/** `by_id` is the doorbell wakeup route, `next` the pull loop. */
export type ClaimMode = "by_id" | "next";

export type ClaimOutcome =
  | "claimed" | "empty" | "all_skipped" | "retry_limit"
  | "missing" | "busy" | "unclaimable" | "deferred" | "exhausted" | "error";

/** `missing` and `busy` share `raced`; only the persistent causes can mean a stuck queue. */
export type ClaimSkipCause = "raced" | "unclaimable" | "deferred" | "exhausted" | "error";

export type ClaimExhaustionReason = ExhaustedClaim["reason"];

/** `unspecified` exists only here: a body carrying it is refused, and it reports version skew. */
export type UnclaimReasonLabel = RunUnclaimReason | "unspecified";

export type HolderVerdict = "accepted" | "not_holder" | "error";

export type QueueEntryCause = "admission" | "direct" | "requeue";

export type QueueExitOutcome =
  | "claimed" | "timed_out" | "budget_exhausted" | "duplicate_closed"
  | "dispatch_failed" | "chat_closed" | "cancelled";

/** The exits that can read the `metadata.queued_since` marker. */
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
  labelNames: ["outcome"] as const,
  registers: [registry],
});
const sessionDeletedTotal = new Counter({
  name: "claw_api_session_deleted_total",
  help: "Session soft-deletes by outcome.",
  labelNames: ["outcome"] as const,
  registers: [registry],
});
const messageDispatchedTotal = new Counter({
  name: "claw_api_message_dispatched_total",
  help: "Messages dispatched to Brain via NATS task stream.",
  labelNames: ["outcome"] as const,
  registers: [registry],
});
const eventPersistedTotal = new Counter({
  name: "claw_api_event_persisted_total",
  help: "Events persisted by the durable event consumer.",
  labelNames: ["outcome"] as const,
  registers: [registry],
});

// `error` keeps a throw out of loadUsage or queueLength in the denominator;
// without it a partial outage makes every rollout ratio read healthier.
const admissionDecisionTotal = new Counter({
  name: "claw_api_admission_decision_total",
  help: "Terminal answers of decideAdmission, including throws.",
  labelNames: ["origin", "decision"] as const,
  registers: [registry],
});
const admissionRejectedTotal = new Counter({
  name: "claw_api_admission_rejected_total",
  help: "Admission refusals by reason and by the stage that refused.",
  labelNames: ["origin", "stage", "reason"] as const,
  registers: [registry],
});
// Enablement rather than the ceiling: re-tuning capacity would orphan the series.
const admissionEnforced = new Gauge({
  name: "claw_api_admission_enforced",
  help: "1 when this dimension's ceiling is non-zero in this process, else 0.",
  labelNames: ["dimension"] as const,
  registers: [registry],
});

const doorbellDispatchEnabled = new Gauge({
  name: "claw_api_doorbell_dispatch_enabled",
  help: "1 when RUN_DOORBELL_DISPATCH is true in this process, set once at startup.",
  registers: [registry],
});

const runDispatchTotal = new Counter({
  name: "claw_api_run_dispatch_total",
  help: "handOffAssembledRun results by caller, including throws.",
  labelNames: ["path", "outcome"] as const,
  registers: [registry],
});
// Its own counter: the hand-off really is `dispatched`, so folding the two
// would hide the anomaly inside the honest answer.
const runDispatchHeldTotal = new Counter({
  name: "claw_api_run_dispatch_held_total",
  help: "Compensations declined because a worker already held the row.",
  labelNames: ["cause"] as const,
  registers: [registry],
});

const runClaimTotal = new Counter({
  name: "claw_api_run_claim_total",
  help: "Claim requests by route and outcome.",
  labelNames: ["mode", "outcome"] as const,
  registers: [registry],
});
const runClaimSkippedTotal = new Counter({
  name: "claw_api_run_claim_skipped_total",
  help: "Candidate rows claim-next passed over, one per row.",
  labelNames: ["cause"] as const,
  registers: [registry],
});
const runClaimExhaustedTotal = new Counter({
  name: "claw_api_run_claim_exhausted_total",
  help: "Rows the poison guard closed during a claim, by route and cause.",
  labelNames: ["mode", "reason"] as const,
  registers: [registry],
});
// A failed unclaim leaves the row `running` under a holder that has given up,
// recoverable only at lease expiry; the requeue counter reports that recovery.
const runUnclaimTotal = new Counter({
  name: "claw_api_run_unclaim_total",
  help: "Unclaim requests by declared reason and holder verdict.",
  labelNames: ["reason", "outcome"] as const,
  registers: [registry],
});
const runFailClaimTotal = new Counter({
  name: "claw_api_run_fail_claim_total",
  help: "Terminal fail-claim requests by reason and holder verdict.",
  labelNames: ["reason", "outcome"] as const,
  registers: [registry],
});

const runQueueEnteredTotal = new Counter({
  name: "claw_api_run_queue_entered_total",
  help: "Rows reaching status queued, by what put them there.",
  labelNames: ["cause"] as const,
  registers: [registry],
});
const runQueueExitedTotal = new Counter({
  name: "claw_api_run_queue_exited_total",
  help: "Rows leaving status queued, counted by the write that moved them.",
  labelNames: ["outcome"] as const,
  registers: [registry],
});
// Last finite bucket is RUN_QUEUE_MAX_SEC's two-hour default, so a timed-out
// sojourn lands in it rather than in the overflow.
const runQueueWaitSeconds = new Histogram({
  name: "claw_api_run_queue_wait_seconds",
  help: "Length of one queue sojourn, measured from the metadata.queued_since marker.",
  labelNames: ["origin", "outcome"] as const,
  buckets: [1, 5, 15, 30, 60, 300, 900, 1800, 3600, 7200],
  registers: [registry],
});
const runQueueTimeoutTotal = new Counter({
  name: "claw_api_run_queue_timeout_total",
  help: "Queued rows closed by the reaper, split by whether a worker ever held them.",
  labelNames: ["ever_held"] as const,
  registers: [registry],
});
const doorbellLeaseRequeuedTotal = new Counter({
  name: "claw_api_doorbell_lease_requeued_total",
  help: "Rows requeued by requeueLostDoorbellLeases.",
  registers: [registry],
});

// A marker ahead of the clock is pod skew, not a negative wait, so it clamps
// to zero rather than entering the first bucket as a measurement nobody took.
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
  /** A row that never waited carries no marker, and must contribute no wait rather than a zero. */
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
