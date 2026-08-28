// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { test } from "node:test";
import assert from "node:assert/strict";

import { isRunDoorbell, RUN_DOORBELL_KIND } from "../src/run-doorbell.js";

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
