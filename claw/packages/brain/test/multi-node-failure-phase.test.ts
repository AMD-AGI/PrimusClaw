// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// The `phase` a failed multi-node ensure() reports.
//
// It is the field monitoring groups these failures by, and it used to be derived
// by matching on the error's wording, which meant rewording a message silently
// relabelled the failure. Each branch is pinned here, the catch-all included:
// that one is reached only by failures nobody predicted, so no other test can
// exercise it, and an unpinned default is how a whole class of failure ends up
// filed under the wrong label.

import test from "node:test";
import assert from "node:assert/strict";

process.env.SAFE_API_URL = "http://safe.test";
const { multiNodeFailurePhase } = await import("../src/sandbox/multi-node/safe-provider.js");
const { SandboxProvisionTerminalError } = await import("../src/sandbox/errors.js");

test("a terminal SaFE phase is reported as terminal", () => {
  // These two say the cluster reached a state it will not leave, which is a
  // different thing to report than one that never came up.
  for (const reason of ["sandbox_workload_terminal", "sandbox_timed_out"]) {
    assert.equal(
      multiNodeFailurePhase(new SandboxProvisionTerminalError(reason, "entered terminal phase=failed")),
      "terminal",
      `${reason} is a terminal phase`,
    );
  }
});

test("every other way the wait ends reads as wait", () => {
  // An unreadable status, a workload that has gone, a queue ceiling and a pod
  // that exited are all "the cluster did not come up", and are deliberately not
  // split further: the reason travels on the error for anyone who needs it.
  for (const reason of [
    "sandbox_status_unreadable",
    "sandbox_gone",
    "sandbox_pending_timeout",
    "sandbox_exited_before_ready",
  ]) {
    assert.equal(
      multiNodeFailurePhase(new SandboxProvisionTerminalError(reason, "gave up")),
      "wait",
      `${reason} is a failure to come up`,
    );
  }
});

test("a create that was refused reads as create", () => {
  assert.equal(
    multiNodeFailurePhase(new Error("multi-node workload create failed: HTTP 403 forbidden")),
    "create",
  );
  // The no-id case is a create failure too: the POST landed and answered without
  // naming the cluster it may have started.
  assert.equal(
    multiNodeFailurePhase(new Error('multi-node workload create failed: no workloadId in {"ok":true}')),
    "create",
  );
});

test("anything else falls to config rather than to a create it never attempted", () => {
  // The bucket that matters: a body the deployment cannot build, an assertion in
  // the builders, a bug. Filing these as `create` would tell an operator a
  // cluster may be running when none was ever asked for.
  assert.equal(multiNodeFailurePhase(new Error("nodes must be >= 1, got 0")), "config");
  assert.equal(multiNodeFailurePhase(new Error("infera workload requires a derived SSH keypair")), "config");
  assert.equal(multiNodeFailurePhase(new TypeError("x is not a function")), "config");
  // Not every throw is an Error, and a non-Error must not crash the classifier
  // on the path whose whole job is reporting a failure.
  assert.equal(multiNodeFailurePhase("plain string"), "config");
  assert.equal(multiNodeFailurePhase(undefined), "config");
});
