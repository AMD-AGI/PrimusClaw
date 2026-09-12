// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DOORBELL_SEMANTICS_MAX,
  DOORBELL_SEMANTICS_VERSION,
  doorbellDedupId,
  doorbellSemanticsOf,
  isRunDoorbell,
  RUN_DOORBELL_KIND,
  RUN_FAIL_CLAIM_REASONS,
  RUN_UNCLAIM_REASONS,
} from "../src/run-doorbell.js";

test("a doorbell is recognised by kind, task id, and claim url", () => {
  assert.equal(isRunDoorbell({
    kind: RUN_DOORBELL_KIND,
    task_id: "ktsk_1",
    session_id: "s-1",
    claim_url: "http://api/v1/internal/tasks/ktsk_1/claim",
  }), true);
});

test("a fat execute request is not a doorbell", () => {
  assert.equal(isRunDoorbell({
    session_id: "s-1",
    message_id: "claw-1",
    prompt: "hello",
    llm_api_key: "sk-secret",
  }), false);
});

test("a doorbell missing the claim url is not one", () => {
  assert.equal(isRunDoorbell({
    kind: RUN_DOORBELL_KIND,
    task_id: "ktsk_1",
    session_id: "s-1",
  }), false);
});

test("empty identifiers are not a doorbell", () => {
  assert.equal(isRunDoorbell({
    kind: RUN_DOORBELL_KIND,
    task_id: "",
    session_id: "s-1",
    claim_url: "http://api/claim",
  }), false);
  assert.equal(isRunDoorbell({
    kind: RUN_DOORBELL_KIND,
    task_id: "ktsk_1",
    session_id: "s-1",
    claim_url: "",
  }), false);
  assert.equal(isRunDoorbell(null), false);
  assert.equal(isRunDoorbell("run_claim"), false);
});

test("an optional message id does not change recognition", () => {
  assert.equal(isRunDoorbell({
    kind: RUN_DOORBELL_KIND,
    task_id: "ktsk_1",
    session_id: "s-1",
    message_id: "claw-1",
    claim_url: "http://api/v1/internal/tasks/ktsk_1/claim",
  }), true);
});

test("a doorbell with no semantics field is still recognised", () => {
  // The guard must keep accepting one: the stream holds doorbells published
  // before the field existed, and a doorbell that failed here would be cast to
  // an ExecuteRequest by the receiver's fall-through.
  assert.equal(isRunDoorbell({
    kind: RUN_DOORBELL_KIND,
    task_id: "ktsk_1",
    session_id: "s-1",
    claim_url: "http://api/v1/internal/tasks/ktsk_1/claim",
  }), true);
  assert.equal(isRunDoorbell({
    kind: RUN_DOORBELL_KIND,
    task_id: "ktsk_1",
    session_id: "s-1",
    claim_url: "http://api/v1/internal/tasks/ktsk_1/claim",
    semantics: DOORBELL_SEMANTICS_VERSION,
  }), true);
});

test("an absent semantics field resolves to version 1", () => {
  assert.equal(doorbellSemanticsOf({}), 1);
  assert.equal(doorbellSemanticsOf({ semantics: undefined }), 1);
});

test("a bounded integer semantics field resolves to itself", () => {
  assert.equal(doorbellSemanticsOf({ semantics: 1 }), 1);
  assert.equal(doorbellSemanticsOf({ semantics: DOORBELL_SEMANTICS_MAX }), DOORBELL_SEMANTICS_MAX);
});

test("a present but malformed semantics field is rejected, never defaulted", () => {
  for (const semantics of [
    "2", null, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY,
    DOORBELL_SEMANTICS_MAX + 1, {}, [],
  ]) {
    assert.equal(
      doorbellSemanticsOf({ semantics } as { semantics?: number }),
      "rejected",
      `expected ${String(semantics)} to be rejected`,
    );
  }
});

test("the dedup id separates the session from the message", () => {
  // Concatenated, ("ab","c") and ("a","bc") are one string; a stream-wide
  // duplicate window would then drop one of the two turns.
  assert.notEqual(doorbellDedupId("ab", "c"), doorbellDedupId("a", "bc"));
});

test("the dedup id is stable, hex, and fixed width", () => {
  const id = doorbellDedupId("s-1", "claw-1");
  assert.equal(id, doorbellDedupId("s-1", "claw-1"));
  assert.match(id, /^[0-9a-f]{64}$/);
  assert.equal(doorbellDedupId("s-1", "claw-1").length, doorbellDedupId("s-".repeat(80), "claw-1").length);
});

test("two sessions sharing a message id get different dedup ids", () => {
  assert.notEqual(doorbellDedupId("s-1", "claw-1"), doorbellDedupId("s-2", "claw-1"));
});

test("the unclaim and fail-claim reason sets are the shared vocabulary", () => {
  assert.deepEqual([...RUN_UNCLAIM_REASONS], ["lock_contention", "retry", "drain", "hydrate_failed"]);
  assert.deepEqual([...RUN_FAIL_CLAIM_REASONS], ["session_deleted", "claim_abandoned", "workspace_unbound"]);
});

test("the declared version is within the bound a wire value may name", () => {
  assert.ok(Number.isInteger(DOORBELL_SEMANTICS_VERSION));
  assert.ok(DOORBELL_SEMANTICS_VERSION >= 1);
  assert.ok(DOORBELL_SEMANTICS_VERSION <= DOORBELL_SEMANTICS_MAX);
});
