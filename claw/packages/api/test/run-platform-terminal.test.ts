// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Telling three endings apart: the agent finished, the agent broke, the platform
 * took the machine away.
 *
 * A dispatcher above Claw cannot make this distinction itself -- nobody above the
 * platform can observe a preemption -- and today it does not get it, so a
 * reclaimed node and a crash are both counted against whichever model happened to
 * be running. At sweep scale that pollutes both the failure funnel the enablement
 * work is chosen from and the stability metric meant to show the platform
 * improving.
 *
 * Coverage:
 *   D1 the three endings the acceptance criteria name
 *   D2 a kill nobody explained is not given a cause
 *   D3 our own reasons outrank the pod's account of them
 *   D4 the pod reason is matched as a word, not searched for
 *   D5 signals are read off the exit code
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  killReasonFromPodMessage,
  phaseOf,
  signalOf,
  terminalFacts,
} from "../src/runs/platform-terminal.js";

test("D1a a run whose agent exited cleanly is `exited`", () => {
  const t = terminalFacts({ status: "completed", failure_reason: null, exit_code: 0 });
  assert.deepEqual(t, { class: "exited", kill_reason: "", exit_code: 0, signal: "" });
});

test("D1b a run killed by a node reclaim is `killed` / `preempted`", () => {
  const t = terminalFacts({
    status: "failed",
    failure_reason: "sandbox_died",
    pod_failed_message: "Evicted, The node was low on resource: memory",
  });
  assert.equal(t?.class, "killed");
  assert.equal(t?.kill_reason, "preempted");
});

test("D1c a run cut off by its deadline is `killed` / `deadline`", () => {
  const t = terminalFacts({ status: "failed", failure_reason: "run_budget_exhausted" });
  assert.equal(t?.class, "killed");
  assert.equal(t?.kill_reason, "deadline");
});

test("D1d the three are distinguishable without reading any dispatcher output", () => {
  const kinds = [
    terminalFacts({ status: "completed", failure_reason: null }),
    terminalFacts({ status: "failed", failure_reason: "sandbox_died", pod_failed_message: "Preempted" }),
    terminalFacts({ status: "failed", failure_reason: "run_budget_exhausted" }),
  ].map((t) => `${t?.class}/${t?.kill_reason}`);
  assert.deepEqual(kinds, ["exited/", "killed/preempted", "killed/deadline"]);
});

test("D2 a failure nobody explained is `failed`, not a kill with a guessed cause", () => {
  // The one-directional cost: a genuine crash recorded as a preemption is retried
  // forever without ever counting as a failure, and the model behind it never
  // reaches the enablement queue it belongs in.
  const t = terminalFacts({ status: "failed", failure_reason: "agent_error" });
  assert.equal(t?.class, "failed");
  assert.equal(t?.kill_reason, "");
});

test("D2b a pod message with no recognised reason does not invent one", () => {
  const t = terminalFacts({
    status: "failed",
    failure_reason: "sandbox_died",
    pod_failed_message: "Error, container process exited",
  });
  assert.equal(t?.class, "failed");
  assert.equal(t?.kill_reason, "");
});

test("D3a a cancellation outranks whatever the pod said on the way down", () => {
  // A pod killed *because* somebody cancelled would otherwise read as an
  // infrastructure loss, and the sweep would retry a run a person stopped.
  const t = terminalFacts({
    status: "cancelled",
    failure_reason: null,
    pod_failed_message: "Evicted, terminated",
  });
  assert.equal(t?.class, "cancelled");
  assert.equal(t?.kill_reason, "user");
});

test("D3b our own deadline outranks the pod's account of us enforcing it", () => {
  const t = terminalFacts({
    status: "failed",
    failure_reason: "run_budget_exhausted",
    pod_failed_message: "Evicted, deadline",
  });
  assert.equal(t?.kill_reason, "deadline");
});

test("D4 the pod reason is the first word, not a substring of the message", () => {
  // SaFE builds the field as `reason + ", " + message`, and the message half is
  // free text from whatever killed the pod.
  assert.equal(killReasonFromPodMessage("Evicted, low on memory"), "preempted");
  assert.equal(killReasonFromPodMessage("Error, the job was evicted from its queue"), "");
  assert.equal(killReasonFromPodMessage(""), "");
});

test("D4b every reason in the map is matched case-insensitively", () => {
  assert.equal(killReasonFromPodMessage("preempted"), "preempted");
  assert.equal(killReasonFromPodMessage("NodeLost"), "node_lost");
  assert.equal(killReasonFromPodMessage("OOMKilled"), "oom");
  assert.equal(killReasonFromPodMessage("DeadlineExceeded"), "deadline");
});

test("D7 an OOM is named from the container's reason, not guessed from 137", () => {
  // The pod-level reason describes the kills decided above the container and is
  // empty here. Exit code 137 is any SIGKILL, so reading memory pressure off it
  // would relabel every eviction and every deliberate stop.
  const t = terminalFacts({
    status: "failed",
    failure_reason: "sandbox_died",
    pod_failed_message: "",
    container_reason: "OOMKilled",
    exit_code: 137,
  });
  assert.equal(t?.class, "killed");
  assert.equal(t?.kill_reason, "oom");
  assert.equal(t?.signal, "SIGKILL");
});

test("D7b exit code 137 on its own names nothing", () => {
  const t = terminalFacts({ status: "failed", failure_reason: "sandbox_died", exit_code: 137 });
  assert.equal(t?.class, "failed");
  assert.equal(t?.kill_reason, "");
});

test("D7c the pod's reason outranks the container's", () => {
  // A container killed as part of an eviction reports an "Error" of its own, and
  // the eviction is the more useful account of what happened.
  const t = terminalFacts({
    status: "failed",
    failure_reason: "sandbox_died",
    pod_failed_message: "Evicted, the node was low on resource: memory",
    container_reason: "Error",
    exit_code: 137,
  });
  assert.equal(t?.kill_reason, "preempted");
});

test("D7d a container reason the platform does not report leaves the ending unnamed", () => {
  // Against a SaFE that predates the field. An unexplained kill is a real state.
  const t = terminalFacts({
    status: "failed",
    failure_reason: "sandbox_died",
    container_reason: "",
    exit_code: 137,
  });
  assert.equal(t?.kill_reason, "");
});

test("D5 a signal is read off the exit code", () => {
  assert.equal(signalOf(137), "SIGKILL");
  assert.equal(signalOf(143), "SIGTERM");
  assert.equal(signalOf(0), "");
  assert.equal(signalOf(1), "");
  assert.equal(signalOf(128 + 7), "SIG7");
});

test("D5b a code that encodes no signal is not given a signal's name", () => {
  // 200 is an exit status a program is free to choose. Subtracting 128 from it
  // produces 72, and no system we run on has a signal 72 -- so `SIG72` would be
  // arithmetic presented to a caller as a kernel action.
  assert.equal(signalOf(200), "");
  assert.equal(signalOf(128 + 65), "");
  assert.equal(signalOf(128 + 64), "SIG64");
  assert.equal(signalOf(128), "");
});

test("D5c an unknown exit code is null, and names no signal", () => {
  // The node went away with the worker that would have reported the code. Every
  // ending has to say so rather than borrow a 0 from nowhere: 0 is the value
  // that means the agent finished its work successfully.
  for (const t of [
    terminalFacts({ status: "completed", failure_reason: null }),
    terminalFacts({ status: "cancelled", failure_reason: null }),
    terminalFacts({ status: "failed", failure_reason: "agent_error" }),
    terminalFacts({ status: "failed", failure_reason: "sandbox_died", pod_failed_message: "Preempted" }),
    terminalFacts({ status: "failed", failure_reason: null, exit_code: null }),
  ]) {
    assert.equal(t?.exit_code, null, `${t?.class} must not invent an exit code`);
    assert.equal(t?.signal, "", `${t?.class} must not invent a signal`);
  }

  // And a code that is reported is still carried through untouched, including
  // the one value the old fallback was indistinguishable from.
  assert.equal(terminalFacts({ status: "completed", failure_reason: null, exit_code: 0 })?.exit_code, 0);
  assert.equal(terminalFacts({ status: "failed", failure_reason: "x", exit_code: 137 })?.signal, "SIGKILL");
});

test("D6 a live run has no terminal block at all", () => {
  assert.equal(terminalFacts({ status: "running", failure_reason: null }), null);
  assert.equal(phaseOf("running"), "running");
  assert.equal(phaseOf("queued"), "pending");
  assert.equal(phaseOf("cancelling"), "running");
  assert.equal(phaseOf("failed"), "terminal");
});
