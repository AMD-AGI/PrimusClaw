// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// metrics-labels.test.ts
//
// §12.1.2 label-cardinality contract enforcer. For every metric helper
// in brain/src/infra/metrics.ts we exhaustively call it with every value
// from the closed enum spelled out in the design doc. This proves:
//   (a) the helper signature accepts the documented enum (compile-time
//       guarantee via TS literal-union types), AND
//   (b) calling each label combination at runtime does not throw
//       (prom-client checks labelNames at register time, so a wrong
//       enum-to-labelNames mapping would surface here as an
//       "InvalidLabelValueError"-style runtime error).
//
// If the enum is ever widened in infra/metrics.ts without updating this
// file the new value will be missing from the for-loop and the
// dashboard / alert that filters on it will silently lose points.
// Conversely if a value is removed, this file will fail to compile.

import { test } from "node:test";
import assert from "node:assert/strict";
import { metrics } from "../src/infra/metrics.js";

const CHECKPOINT_WRITE_KINDS = ["turn", "sigterm", "post_sync"] as const;
const CHECKPOINT_WRITE_RESULTS = ["success", "failure"] as const;

const CHECKPOINT_RESUME_RESULTS = [
  "hit",
  "miss_first_delivery",
  "miss_redelivery",
  "skip_expired",
  "skip_invalid_version",
  "miss_unexpected",
] as const;

const SIGTERM_SYNC_RESULTS = ["success", "timeout", "error", "skipped"] as const;

const WORKSPACE_SYNC_KINDS = ["normal", "sigterm"] as const;
const WORKSPACE_SYNC_FAILURE_REASONS = [
  "timeout",
  "rsync_error",
  "meta_write_error",
  "hands_unreachable",
] as const;

const SANDBOX_PROBE_RESULTS = ["alive", "alive_no_kv", "dead", "no_hands"] as const;
const RESUME_MODE_VALUES = [
  "sandbox_reuse",
  "workspace_restore",
  "no_data_turn0",
  "skip_no_ckpt",
] as const;

const CONTAINER_PROBE_VERDICTS = ["alive", "dead", "unknown"] as const;
const CONTAINER_PROBE_REASONS = [
  "exec_ok",
  "exec_nonzero",
  "exec_no_exit_code",
  "exec_sandbox_gone",
  "exec_unreachable",
  "exec_deadline",
  "kv_unreachable",
  "no_kv_entry",
  "entry_unusable",
  "entry_corrupt",
  "aborted",
] as const;

const SANDBOX_RECOVERY_DECISIONS = [
  "rebuilt",
  "reconnected",
  "hands_restarted",
  "left_alone",
  "failed",
  "exhausted",
] as const;

const REDELIVERY_HAS_CHECKPOINT = ["true", "false"] as const;
const LOCK_RELEASE_SKIP_REASONS = ["not_holder", "cas_lost", "legacy_format"] as const;

test("checkpoint_writes_total: kind × result enum closed", () => {
  for (const kind of CHECKPOINT_WRITE_KINDS) {
    for (const result of CHECKPOINT_WRITE_RESULTS) {
      assert.doesNotThrow(() =>
        metrics.onCheckpointWrite(kind, result, 0.01, 1024, 0.001),
      );
    }
  }
});

test("checkpoint_resume_total: result enum closed at 6 values", () => {
  for (const result of CHECKPOINT_RESUME_RESULTS) {
    assert.doesNotThrow(() => metrics.onCheckpointResume(result));
  }
});

test("sigterm_checkpoint_duration_seconds: sync_result enum closed", () => {
  for (const r of SIGTERM_SYNC_RESULTS) {
    assert.doesNotThrow(() => metrics.onSigtermCheckpoint(1, r));
  }
});

test("workspace_sync: kind enum closed", () => {
  for (const kind of WORKSPACE_SYNC_KINDS) {
    assert.doesNotThrow(() => metrics.onWorkspaceSync(kind, 1024, 0.5));
  }
});

test("workspace_sync_failures: kind × reason enum closed", () => {
  for (const kind of WORKSPACE_SYNC_KINDS) {
    for (const reason of WORKSPACE_SYNC_FAILURE_REASONS) {
      assert.doesNotThrow(() => metrics.onWorkspaceSyncFailure(kind, reason));
    }
  }
});

test("pending_sync gauges: kind enum closed", () => {
  for (const kind of WORKSPACE_SYNC_KINDS) {
    assert.doesNotThrow(() => metrics.setPendingSyncGauges(kind, 0, 0));
    assert.doesNotThrow(() => metrics.setPendingSyncGauges(kind, 4, 12));
  }
});

test("sandbox_probe_total: result enum closed at 4 values", () => {
  for (const r of SANDBOX_PROBE_RESULTS) {
    assert.doesNotThrow(() => metrics.onSandboxProbe(r));
  }
});

test("sandbox_container_probe_total: verdict × reason enum closed at 3 × 11", () => {
  for (const verdict of CONTAINER_PROBE_VERDICTS) {
    for (const reason of CONTAINER_PROBE_REASONS) {
      assert.doesNotThrow(() => metrics.onSandboxContainerProbe(verdict, reason, 0.25));
    }
  }
});

test("sandbox_recovery_decision_total: decision enum closed at 6 values", () => {
  // Four of these come from HandsRecoveryAction (what the recovery actually
  // did) and two are loop-side terminal states, so a widened action union has
  // to be reflected here too.
  for (const d of SANDBOX_RECOVERY_DECISIONS) {
    assert.doesNotThrow(() => metrics.onSandboxRecoveryDecision(d));
  }
});

test("resume_workspace_mode_total: mode enum closed at 4 values", () => {
  for (const m of RESUME_MODE_VALUES) {
    assert.doesNotThrow(() => metrics.onResumeWorkspaceMode(m));
  }
});

test("task_redelivery_total: has_checkpoint enum closed at 2 values", () => {
  for (const v of REDELIVERY_HAS_CHECKPOINT) {
    assert.doesNotThrow(() => metrics.onTaskRedelivery(v));
  }
});

test("lock_release_skipped_total: reason enum closed at 3 values", () => {
  for (const r of LOCK_RELEASE_SKIP_REASONS) {
    assert.doesNotThrow(() => metrics.onLockReleaseSkipped(r));
  }
});

test("resume_notice_filtered_total: counter helper callable (NP1-2)", () => {
  // Smoke check: the helper exists and does not throw. The actual
  // increment behavior is exercised end-to-end by
  // agent-loop-filter.test.ts via filterResumeNotices, which calls
  // this helper whenever a pass drops a notice.
  assert.doesNotThrow(() => metrics.onResumeNoticeFiltered());
});
