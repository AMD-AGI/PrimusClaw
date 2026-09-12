// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a preempted run looks like once the platform has been asked.
 *
 * `brain_timeout` is the sweeper's wording for "this run stopped reporting", and
 * a node reclaim is the main way a run does that: the sandbox and the Brain
 * worker watching it are on the same node and go together, so no callback is
 * ever sent. Ranking it with the real deadlines made every preemption come back
 * `killed/deadline` -- a confident wrong answer, and worse than an empty one,
 * because the dispatcher above Claw uses `deadline` to hold the model
 * responsible for what was the cluster's decision.
 *
 * Coverage:
 *   R1 a preempted run swept as brain_timeout reports preempted, not deadline
 *   R2 an OOM likewise, from the container's own reason
 *   R3 liveness failures without platform facts remain unexplained
 *   R4 our own budget still outranks whatever the pod said on the way down
 */
import test from "node:test";
import assert from "node:assert/strict";

import { terminalFacts } from "../src/runs/platform-terminal.js";

test("R1 a preempted run swept as brain_timeout is not a deadline", () => {
  assert.deepEqual(
    terminalFacts({
      status: "failed",
      failure_reason: "brain_timeout",
      pod_failed_message: "Preempted, the pod was preempted by a higher priority pod",
      exit_code: 137,
    }),
    { class: "killed", kill_reason: "preempted", exit_code: 137, signal: "SIGKILL" },
  );
});

test("R2 an OOM under the same sweep reports oom", () => {
  assert.deepEqual(
    terminalFacts({
      status: "failed",
      failure_reason: "brain_timeout",
      pod_failed_message: "",
      container_reason: "OOMKilled",
      exit_code: 137,
    }),
    { class: "killed", kill_reason: "oom", exit_code: 137, signal: "SIGKILL" },
  );
});

test("R3 an expired lease or missing worker does not establish a deadline", () => {
  for (const failure_reason of ["brain_timeout", "worker_lost"]) {
    assert.deepEqual(
      terminalFacts({ status: "failed", failure_reason }),
      { class: "failed", kill_reason: "", exit_code: null, signal: "" },
    );
  }
});

test("R4 our own budget still outranks the pod's account", () => {
  // Unchanged, and it is the other half of the ordering: when Claw stopped the
  // run, the pod describing itself as terminated is describing us doing it.
  assert.deepEqual(
    terminalFacts({
      status: "failed",
      failure_reason: "run_budget_exhausted",
      pod_failed_message: "Evicted, the node was low on resource: memory",
      exit_code: 137,
    }),
    { class: "killed", kill_reason: "deadline", exit_code: 137, signal: "SIGKILL" },
  );
});

test("a Pending sandbox queue ceiling is an enforced deadline", () => {
  assert.deepEqual(
    terminalFacts({
      status: "failed", failure_reason: "sandbox_pending_timeout",
      pod_failed_message: "Evicted, stopped after the queue deadline",
    }),
    { class: "killed", kill_reason: "deadline", exit_code: null, signal: "" },
  );
});

test("a workload timeout message yields to explicit pod termination facts", () => {
  assert.equal(terminalFacts({ status: "failed", failure_reason: "sandbox_timed_out" })?.kill_reason, "deadline");
  assert.equal(terminalFacts({
    status: "failed", failure_reason: "sandbox_timed_out", pod_failed_message: "Preempted, reclaimed",
  })?.kill_reason, "preempted");
});

for (const failure_reason of ["worker_lost", "sandbox_workload_terminal"]) {
  test(`${failure_reason} uses measured pod and container reasons`, () => {
    for (const [pod_failed_message, container_reason, expected] of [
      ["Preempted, reclaimed", "Error", "preempted"],
      ["NodeLost, unreachable", "", "node_lost"],
      ["", "OOMKilled", "oom"],
      ["", "", ""],
    ]) {
      assert.equal(terminalFacts({
        status: "failed", failure_reason, pod_failed_message, container_reason,
      })?.kill_reason, expected);
    }
  });
}

test("session deletion is a user cancellation including a tombstoned delivery", () => {
  for (const status of ["cancelled", "failed"]) {
    assert.deepEqual(
      terminalFacts({ status, failure_reason: "session_deleted", pod_failed_message: "Preempted" }),
      { class: "cancelled", kill_reason: "user", exit_code: null, signal: "" },
    );
  }
});

test("agent and dispatch failures stay failures without platform evidence", () => {
  for (const failure_reason of ["agent_error", "dispatch_failed"]) {
    assert.deepEqual(
      terminalFacts({ status: "failed", failure_reason }),
      { class: "failed", kill_reason: "", exit_code: null, signal: "" },
    );
  }
});
