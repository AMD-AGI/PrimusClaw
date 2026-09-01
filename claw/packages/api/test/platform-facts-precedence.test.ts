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
 *   R3 a brain_timeout the platform said nothing about still reports deadline
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

test("R3 with nothing from the platform, brain_timeout still means deadline", () => {
  // The demotion must not become a deletion: a run that really did stop
  // reporting, on a node that is fine, still has to come back as a kill we
  // performed rather than an unexplained failure.
  assert.deepEqual(
    terminalFacts({ status: "failed", failure_reason: "brain_timeout" }),
    { class: "killed", kill_reason: "deadline", exit_code: 0, signal: "" },
  );
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
