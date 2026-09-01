// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Reading a dead workload's platform account.
 *
 * The wait loop already fetches this payload and keeps only `phase`. What it drops
 * is the one place a preemption is visible, and without it a reclaimed node and a
 * crashed agent are indistinguishable everywhere above.
 *
 * Coverage:
 *   E1 the pod's own reason is carried verbatim
 *   E2 the failed pod decides, not the first one listed
 *   E3 a detail with no pod account yields nothing, rather than "no reason"
 */
import test from "node:test";
import assert from "node:assert/strict";

import { platformFactsFromWorkloadDetail } from "@claw/protocol";

test("E1 the pod's reason, node and exit code are carried", () => {
  const facts = platformFactsFromWorkloadDetail({
    phase: "Failed",
    pods: [
      {
        phase: "Failed",
        failedMessage: "Evicted, The node was low on resource: memory",
        adminNodeName: "node-17",
        endTime: "2026-09-01T10:00:00Z",
        containers: [{ name: "main", exitCode: 137, message: "" }],
      },
    ],
  });
  assert.equal(facts?.message, "Evicted, The node was low on resource: memory");
  assert.equal(facts?.node, "node-17");
  assert.equal(facts?.exitCode, 137);
});

test("E2 the failed pod decides, not whichever was listed first", () => {
  // A multi-pod workload can lose one pod to a reclaim while the others exit
  // cleanly on the way down.
  const facts = platformFactsFromWorkloadDetail({
    pods: [
      { phase: "Succeeded", adminNodeName: "node-1", endTime: "2026-09-01T10:00:00Z" },
      {
        phase: "Failed",
        failedMessage: "Preempted",
        adminNodeName: "node-2",
        endTime: "2026-09-01T10:00:01Z",
      },
    ],
  });
  assert.equal(facts?.message, "Preempted");
  assert.equal(facts?.node, "node-2");
});

test("E2b among several failed pods the last to end wins", () => {
  const facts = platformFactsFromWorkloadDetail({
    pods: [
      { phase: "Failed", failedMessage: "Error", endTime: "2026-09-01T10:00:00Z" },
      { phase: "Failed", failedMessage: "NodeLost", endTime: "2026-09-01T10:05:00Z" },
    ],
  });
  assert.equal(facts?.message, "NodeLost");
});

test("E3 a detail with no pod account yields nothing", () => {
  // Distinct from an ending with nothing to say: a caller must not record "no
  // reason" as a fact it read.
  assert.equal(platformFactsFromWorkloadDetail({ phase: "Failed", pods: [] }), null);
  assert.equal(platformFactsFromWorkloadDetail({ phase: "Failed" }), null);
  assert.equal(platformFactsFromWorkloadDetail(null), null);
  assert.equal(
    platformFactsFromWorkloadDetail({ pods: [{ phase: "Failed" }] }),
    null,
    "a pod row with nothing in it is not an account",
  );
});
