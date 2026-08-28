// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A doorbell is a wakeup, not the work. These pin whether it becomes a claim,
 * and that the claim is keyed by task id rather than the payload's host.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { RUN_DOORBELL_KIND } from "@claw/protocol";
import { intakeDoorbell } from "../src/delivery/doorbell-intake.js";

const DOORBELL = {
  kind: RUN_DOORBELL_KIND,
  task_id: "ktsk_1",
  session_id: "sess-doorbell",
  claim_url: "http://evil.example/v1/internal/tasks/ktsk_1/claim",
};

test("a doorbell for a deleted session is dropped without claiming", async () => {
  const claimed: string[] = [];
  const intake = await intakeDoorbell(DOORBELL, {
    sessionDeleted: async () => true,
    claim: async (taskId) => {
      claimed.push(taskId);
      return { request: { session_id: "s", prompt: "hi" }, claimCount: 1 };
    },
  });
  assert.equal(intake.kind, "drop");
  assert.deepEqual(claimed, []);
});

test("a doorbell claims by task id, not the payload host", async () => {
  const claimed: string[] = [];
  const request = { session_id: "sess-doorbell", prompt: "hi", task_id: "ktsk_1" };
  const intake = await intakeDoorbell(DOORBELL, {
    sessionDeleted: async () => false,
    claim: async (taskId) => {
      claimed.push(taskId);
      return { request, claimCount: 3 };
    },
  });
  // The count rides along with the request: it is what the contention backoff
  // uses in place of a JetStream delivery count.
  assert.deepEqual(intake, { kind: "claimed", request, claimCount: 3 });
  assert.deepEqual(claimed, ["ktsk_1"]);
});

test("a lost claim race is a miss", async () => {
  const intake = await intakeDoorbell(DOORBELL, {
    sessionDeleted: async () => false,
    claim: async () => null,
  });
  assert.equal(intake.kind, "miss");
});

test("a claim transport failure is retried", async () => {
  const intake = await intakeDoorbell(DOORBELL, {
    sessionDeleted: async () => false,
    claim: async () => { throw new Error("api down"); },
  });
  assert.equal(intake.kind, "retry");
  assert.equal(intake.kind === "retry" ? (intake.err as Error).message : "", "api down");
});
