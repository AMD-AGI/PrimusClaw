// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// metrics-labels.test.ts
//
// Label-cardinality contract enforcer for api/src/infra/metrics.ts, modelled
// on the Brain file of the same name. Every closed enum in the design's label
// table is spelled out here as an `as const` array and every value -- every
// combination, for a multi-label metric -- is passed to its helper. That
// proves both halves of the contract:
//   (a) the helper signature accepts exactly the documented enum, which is a
//       compile error to violate, since the arrays are `as const`; and
//   (b) the call does not throw at runtime, which is where prom-client reports
//       a labelNames list that disagrees with the helper.
//
// Widening an enum in infra/metrics.ts without widening it here leaves the new
// value untested and the dashboard filtering on it silently short of points;
// removing one stops this file compiling.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RUN_FAIL_CLAIM_REASONS, RUN_UNCLAIM_REASONS,
  type RunFailClaimReason, type RunUnclaimReason,
} from "@claw/protocol";
import { heldClaimReasonFrom } from "../src/tasks/run-claim.js";
import {
  ADMISSION_DIMENSIONS, metrics, registry,
  type AdmissionDecisionLabel, type AdmissionOrigin, type AdmissionRejectReasonLabel,
  type AdmissionStage, type ClaimExhaustionReason, type ClaimMode, type ClaimOutcome,
  type ClaimSkipCause, type DispatchHeldCause, type DispatchOutcome, type DispatchPath,
  type EverHeld, type HolderVerdict, type QueueEntryCause, type QueueExitOutcome,
  type UnclaimReasonLabel,
} from "../src/infra/metrics.js";

const OUTCOMES = ["ok", "error"] as const;

// Every value the ask can carry, a2a included: a list narrower than the union
// leaves a live label domain unasserted, which is the cardinality this file
// exists to bound.
const ADMISSION_ORIGINS = [
  "chat", "task", "dag_node", "a2a",
] as const satisfies readonly AdmissionOrigin[];
const ADMISSION_DECISIONS = [
  "admit", "queue", "reject", "error",
] as const satisfies readonly AdmissionDecisionLabel[];
const ADMISSION_STAGES = ["pre_insert", "post_insert"] as const satisfies readonly AdmissionStage[];
const ADMISSION_REJECT_REASONS = [
  "runs_hard_limit", "sandboxes_hard_limit", "gpu_nodes_hard_limit",
  "tree_nodes_exceeded", "tree_depth_exceeded",
] as const satisfies readonly AdmissionRejectReasonLabel[];

const DISPATCH_PATHS = ["chat", "pending"] as const satisfies readonly DispatchPath[];
const DISPATCH_OUTCOMES = [
  "dispatched", "queued", "rejected", "open_failed", "error",
] as const satisfies readonly DispatchOutcome[];
const DISPATCH_HELD_CAUSES = [
  "hard_limit_exceeded", "hard_limit_recheck_threw", "doorbell_publish_failed",
] as const satisfies readonly DispatchHeldCause[];

const CLAIM_MODES = ["by_id", "next"] as const satisfies readonly ClaimMode[];
const CLAIM_OUTCOMES = [
  "claimed", "empty", "all_skipped", "retry_limit",
  "missing", "busy", "unclaimable", "deferred", "exhausted", "error",
] as const satisfies readonly ClaimOutcome[];
const CLAIM_SKIP_CAUSES = [
  "raced", "unclaimable", "deferred", "exhausted", "error",
] as const satisfies readonly ClaimSkipCause[];
const CLAIM_EXHAUSTION_REASONS = [
  "lock_contention_exhausted", "max_retries_exceeded",
] as const satisfies readonly ClaimExhaustionReason[];
const UNCLAIM_REASONS = [
  "lock_contention", "retry", "drain", "hydrate_failed", "unspecified",
] as const satisfies readonly UnclaimReasonLabel[];
const FAIL_CLAIM_REASONS = [
  "session_deleted", "claim_abandoned", "workspace_unbound",
] as const satisfies readonly RunFailClaimReason[];
const HOLDER_VERDICTS = [
  "accepted", "not_holder", "error",
] as const satisfies readonly HolderVerdict[];

const QUEUE_ENTRY_CAUSES = [
  "admission", "direct", "requeue",
] as const satisfies readonly QueueEntryCause[];
const QUEUE_EXIT_OUTCOMES = [
  "claimed", "timed_out", "budget_exhausted", "duplicate_closed",
  "dispatch_failed", "chat_closed", "cancelled",
] as const satisfies readonly QueueExitOutcome[];
const EVER_HELD = ["true", "false"] as const satisfies readonly EverHeld[];

/** Every §4.2 family, in the order the catalogue lists them. */
const FAMILIES = {
  claw_api_session_created_total: "counter",
  claw_api_session_deleted_total: "counter",
  claw_api_message_dispatched_total: "counter",
  claw_api_event_persisted_total: "counter",
  claw_api_admission_decision_total: "counter",
  claw_api_admission_rejected_total: "counter",
  claw_api_admission_enforced: "gauge",
  claw_api_doorbell_dispatch_enabled: "gauge",
  claw_api_run_dispatch_total: "counter",
  claw_api_run_dispatch_held_total: "counter",
  claw_api_run_claim_total: "counter",
  claw_api_run_claim_skipped_total: "counter",
  claw_api_run_claim_exhausted_total: "counter",
  claw_api_run_unclaim_total: "counter",
  claw_api_run_fail_claim_total: "counter",
  claw_api_run_queue_entered_total: "counter",
  claw_api_run_queue_exited_total: "counter",
  claw_api_run_queue_wait_seconds: "histogram",
  claw_api_run_queue_timeout_total: "counter",
  claw_api_doorbell_lease_requeued_total: "counter",
} as const;

test("existing outcome counters: outcome enum closed at 2 values", () => {
  for (const outcome of OUTCOMES) {
    assert.doesNotThrow(() => metrics.onSessionCreated(outcome));
    assert.doesNotThrow(() => metrics.onSessionDeleted(outcome));
    assert.doesNotThrow(() => metrics.onMessageDispatched(outcome));
    assert.doesNotThrow(() => metrics.onEventPersisted(outcome));
  }
});

test("admission_decision_total: origin × decision enum closed at 4 × 4", () => {
  for (const origin of ADMISSION_ORIGINS) {
    for (const decision of ADMISSION_DECISIONS) {
      assert.doesNotThrow(() => metrics.onAdmissionDecision(origin, decision));
    }
  }
});

test("admission_rejected_total: origin × stage × reason enum closed at 4 × 2 × 5", () => {
  for (const origin of ADMISSION_ORIGINS) {
    for (const stage of ADMISSION_STAGES) {
      for (const reason of ADMISSION_REJECT_REASONS) {
        assert.doesNotThrow(() => metrics.onAdmissionRejected(origin, stage, reason));
      }
    }
  }
});

test("admission_enforced: dimension enum closed at 8 values, both states", () => {
  for (const dimension of ADMISSION_DIMENSIONS) {
    assert.doesNotThrow(() => metrics.setAdmissionEnforced(dimension, true));
    assert.doesNotThrow(() => metrics.setAdmissionEnforced(dimension, false));
  }
});

test("doorbell_dispatch_enabled: both states", () => {
  assert.doesNotThrow(() => metrics.setDoorbellDispatchEnabled(false));
  assert.doesNotThrow(() => metrics.setDoorbellDispatchEnabled(true));
});

test("run_dispatch_total: path × outcome enum closed at 2 × 5", () => {
  for (const path of DISPATCH_PATHS) {
    for (const outcome of DISPATCH_OUTCOMES) {
      assert.doesNotThrow(() => metrics.onRunDispatch(path, outcome));
    }
  }
});

test("run_dispatch_held_total: cause enum closed at 3 values", () => {
  for (const cause of DISPATCH_HELD_CAUSES) {
    assert.doesNotThrow(() => metrics.onRunDispatchHeld(cause));
  }
});

test("run_claim_total: mode × outcome enum closed at 2 × 10", () => {
  for (const mode of CLAIM_MODES) {
    for (const outcome of CLAIM_OUTCOMES) {
      assert.doesNotThrow(() => metrics.onRunClaim(mode, outcome));
    }
  }
});

test("run_claim_skipped_total: cause enum closed at 5 values", () => {
  for (const cause of CLAIM_SKIP_CAUSES) {
    assert.doesNotThrow(() => metrics.onRunClaimSkipped(cause));
  }
});

test("run_claim_exhausted_total: mode × reason enum closed at 2 × 2", () => {
  for (const mode of CLAIM_MODES) {
    for (const reason of CLAIM_EXHAUSTION_REASONS) {
      assert.doesNotThrow(() => metrics.onRunClaimExhausted(mode, reason));
    }
  }
});

test("run_unclaim_total: reason × outcome enum closed at 5 × 3", () => {
  for (const reason of UNCLAIM_REASONS) {
    for (const outcome of HOLDER_VERDICTS) {
      assert.doesNotThrow(() => metrics.onRunUnclaim(reason, outcome));
    }
  }
});

test("run_fail_claim_total: reason × outcome enum closed at 3 × 3", () => {
  for (const reason of FAIL_CLAIM_REASONS) {
    for (const outcome of HOLDER_VERDICTS) {
      assert.doesNotThrow(() => metrics.onRunFailClaim(reason, outcome));
    }
  }
});

test("run_queue_entered_total: cause enum closed at 3 values", () => {
  for (const cause of QUEUE_ENTRY_CAUSES) {
    assert.doesNotThrow(() => metrics.onQueueEntered(cause));
  }
});

test("run_queue_exited_total and the wait histogram: every exit, every origin", () => {
  const marker = new Date(Date.now() - 30_000).toISOString();
  for (const origin of ADMISSION_ORIGINS) {
    for (const outcome of QUEUE_EXIT_OUTCOMES) {
      assert.doesNotThrow(() => metrics.observeQueueExit(origin, marker, outcome));
    }
  }
});

test("run_queue_timeout_total: ever_held enum closed at 2 values", () => {
  for (const everHeld of EVER_HELD) {
    assert.doesNotThrow(() => metrics.onQueueTimeout(everHeld));
  }
});

test("doorbell_lease_requeued_total: unlabelled counter callable", () => {
  assert.doesNotThrow(() => metrics.onDoorbellLeaseRequeued(3));
});

test("every catalogued metric is on the local registry, exactly once", async () => {
  for (const name of Object.keys(FAMILIES)) {
    assert.ok(
      registry.getSingleMetric(name),
      `${name} is not on the api registry -- it landed in prom-client's global default registry`,
    );
  }
  const json = await registry.getMetricsAsJSON();
  const seen = new Map<string, number>();
  for (const family of json) seen.set(family.name, (seen.get(family.name) ?? 0) + 1);
  for (const [name, type] of Object.entries(FAMILIES)) {
    assert.equal(seen.get(name), 1, `${name} should appear exactly once in the exposition`);
    assert.equal(json.find((f) => f.name === name)?.type, type);
  }
});

test("the rendered exposition carries one HELP and one TYPE line per family", async () => {
  const text = await registry.metrics();
  const lines = text.split("\n");
  for (const name of Object.keys(FAMILIES)) {
    assert.equal(
      lines.filter((l) => l.startsWith(`# HELP ${name} `)).length, 1,
      `${name} should have exactly one # HELP line`,
    );
    assert.equal(
      lines.filter((l) => l.startsWith(`# TYPE ${name} `)).length, 1,
      `${name} should have exactly one # TYPE line`,
    );
  }
});

test("sample suffixes match the metric type", async () => {
  const text = await registry.metrics();
  const sampleNames = new Set(
    text.split("\n")
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => l.split(/[{ ]/)[0]),
  );
  for (const [name, type] of Object.entries(FAMILIES)) {
    const suffixed = [...sampleNames].filter((s) => s === name || s.startsWith(`${name}_`));
    if (type === "histogram") {
      assert.deepEqual(
        suffixed.sort(),
        [`${name}_bucket`, `${name}_count`, `${name}_sum`],
        `${name} should expose only the three histogram sample families`,
      );
    } else {
      assert.deepEqual(suffixed, [name], `${name} should expose no suffixed samples`);
    }
  }
});

test("unspecified is a metric label value and not a protocol reason", () => {
  const unclaim: readonly string[] = UNCLAIM_REASONS;
  assert.ok(unclaim.includes("unspecified"));
  assert.ok(!(RUN_UNCLAIM_REASONS as readonly string[]).includes("unspecified"));
  for (const reason of RUN_UNCLAIM_REASONS) {
    assert.ok(
      unclaim.includes(reason),
      `${reason} is a protocol unclaim reason with no metric label value`,
    );
  }
  assert.equal(UNCLAIM_REASONS.length, RUN_UNCLAIM_REASONS.length + 1);
});

test("every protocol fail-claim reason is accepted by heldClaimReasonFrom", () => {
  for (const reason of RUN_FAIL_CLAIM_REASONS) {
    const resolved: RunFailClaimReason | "invalid" = heldClaimReasonFrom({ reason });
    assert.notEqual(resolved, "invalid");
    assert.equal(resolved, reason);
  }
  const labels: readonly string[] = FAIL_CLAIM_REASONS;
  for (const reason of RUN_FAIL_CLAIM_REASONS) assert.ok(labels.includes(reason));
});

test("every protocol unclaim reason has a label value of the same spelling", () => {
  // The API-side half of the reconciliation. releaseReasonFrom is module-local
  // to routes/internal-runs.ts, so the label domain is checked against the
  // protocol array the route builds RELEASE_REASONS from.
  const declared: readonly RunUnclaimReason[] = RUN_UNCLAIM_REASONS;
  for (const reason of declared) {
    assert.doesNotThrow(() => metrics.onRunUnclaim(reason, "accepted"));
  }
});
