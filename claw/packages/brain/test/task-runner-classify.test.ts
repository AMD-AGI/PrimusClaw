// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// tasks/runner.ts failure classification and checkpoint key construction.
//
// classifyTaskFailure exists for one reason: the text it returns is written to
// final_text and shown in the user's chat. Before it existed, err.message went
// there verbatim, which put the provider's raw JSON error body in front of
// users. These tests hold that line — each asserts both the reason code and
// that no JSON punctuation survived into the displayed sentence.
//
// This file covers the pure helpers only. The lifecycle around them — which
// terminal state a failure routes to, and what NATS is told — is covered in
// task-runner-lifecycle.test.ts via the TaskRunnerDeps.sideEffects seam.

import { test } from "node:test";
import assert from "node:assert/strict";
import { __test__ } from "../src/tasks/runner.js";

const { classifyTaskFailure, classifyRetryableReason, checkpointKey, checkpointS3Prefix } = __test__;

/** The whole point of the mapping: nothing machine-shaped reaches the user. */
function assertPresentable(userText: string): void {
  for (const fragment of ['{"', '"}', '":', "overloaded_error", "rate_limit_error"]) {
    assert.ok(
      !userText.includes(fragment),
      `user-facing text still contains ${JSON.stringify(fragment)}: ${userText}`,
    );
  }
}

// ── classifyTaskFailure ──────────────────────────────────────────────────────

test("overloaded provider JSON becomes a readable sentence", () => {
  const raw = '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_vrtx_abc123"}';
  const { reason, userText } = classifyTaskFailure(raw);

  assert.equal(reason, "upstream_overloaded");
  assertPresentable(userText);
  // The vendor id is kept deliberately: it is what support traces an incident by.
  assert.match(userText, /req_vrtx_abc123/);
});

test("rate limiting is distinguished from overload", () => {
  const raw = '{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}';
  const { reason, userText } = classifyTaskFailure(raw);

  assert.equal(reason, "upstream_rate_limited");
  assertPresentable(userText);
  assert.match(userText, /rate-limited/i);
});

test("mid-stream socket drops are classified as such", () => {
  for (const raw of [
    "other side closed",
    "UND_ERR_SOCKET",
    "socket hang up",
    "read ECONNRESET",
    "terminated",
  ]) {
    assert.equal(classifyTaskFailure(raw).reason, "mid_stream_drop", `for: ${raw}`);
  }
});

test("connection failures are separated from timeouts", () => {
  assert.equal(classifyTaskFailure("All connection attempts failed").reason, "upstream_unreachable");
  assert.equal(classifyTaskFailure("APIConnectionError: nope").reason, "upstream_unreachable");
  assert.equal(classifyTaskFailure("request timeout after 60s").reason, "upstream_timeout");
  assert.equal(classifyTaskFailure("deadline exceeded").reason, "upstream_timeout");
});

test("an unrecognised error keeps its message but is capped", () => {
  const { reason, userText } = classifyTaskFailure("x".repeat(900));

  assert.equal(reason, "agent_error");
  assert.equal(userText.length, 500, "unknown errors are truncated, not passed through whole");
});

test("an empty error still produces something displayable", () => {
  const { reason, userText } = classifyTaskFailure("");

  assert.equal(reason, "agent_error");
  assert.ok(userText.length > 0, "an empty message must not render as an empty chat bubble");
});

test("classification order puts overload ahead of the generic timeout rule", () => {
  // A single upstream error often matches several patterns at once. Overload is
  // the actionable one -- "retry in a moment" rather than "your request timed
  // out" -- so it has to win regardless of what else the body mentions.
  const raw = '{"error":{"type":"overloaded_error"},"detail":"request timeout"}';
  assert.equal(classifyTaskFailure(raw).reason, "upstream_overloaded");
});

// ── classifyRetryableReason ──────────────────────────────────────────────────

test("retryable reasons name the specific failure", () => {
  assert.equal(classifyRetryableReason({ name: "APIConnectionTimeoutError" }), "llm_connection_timeout");
  assert.equal(classifyRetryableReason({ name: "APIConnectionError" }), "llm_connection_error");
  assert.equal(classifyRetryableReason(new Error("fetch failed")), "llm_connection_error");
  assert.equal(classifyRetryableReason({ status: 503 }), "http_503");
  assert.equal(classifyRetryableReason(new Error("nats: no responders")), "nats_error");
  assert.equal(classifyRetryableReason(new Error("boom")), "retryable_unknown");
});

test("retryable classification reads through to error.cause", () => {
  // undici reports the real socket failure on `cause`, so a classifier that only
  // looked at `message` would file every one of these as retryable_unknown.
  const err = Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  assert.equal(classifyRetryableReason(err), "llm_connection_error");

  const dns = Object.assign(new Error("request to host failed"), {
    cause: { code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND api.example" },
  });
  assert.equal(classifyRetryableReason(dns), "dns_error");
});

test("classifying a null or undefined error does not throw", () => {
  assert.equal(classifyRetryableReason(undefined), "retryable_unknown");
  assert.equal(classifyRetryableReason(null), "retryable_unknown");
});

// ── checkpoint addressing ────────────────────────────────────────────────────

test("checkpoint keys and prefixes are scoped so two runs cannot collide", () => {
  assert.equal(checkpointKey("sess-1", "msg-1"), "task-ckpt.sess-1.msg-1");
  assert.notEqual(checkpointKey("sess-1", "msg-1"), checkpointKey("sess-2", "msg-1"));

  // The message id has to participate. A DAG runs every parallel node under one
  // hidden session, so a session-only key had them all overwriting one entry.
  assert.notEqual(checkpointKey("sess-1", "msg-1"), checkpointKey("sess-1", "msg-2"));

  // A trailing empty token is not a legal NATS subject.
  assert.equal(checkpointKey("sess-1", ""), "task-ckpt.sess-1._nomsg");

  const prefix = checkpointS3Prefix("user-1", "sess-1", "msg-1");
  assert.equal(prefix, "checkpoints/user-1/sess-1/msg-1/");
  assert.ok(prefix.endsWith("/"), "a prefix without a trailing slash would match sibling keys");

  // Every component has to participate, or a resume can read another run's
  // checkpoint: same session, different message is a retry of a different turn.
  assert.notEqual(prefix, checkpointS3Prefix("user-2", "sess-1", "msg-1"));
  assert.notEqual(prefix, checkpointS3Prefix("user-1", "sess-2", "msg-1"));
  assert.notEqual(prefix, checkpointS3Prefix("user-1", "sess-1", "msg-2"));
});
