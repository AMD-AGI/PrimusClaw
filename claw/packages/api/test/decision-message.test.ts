// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildAnswerMessage, buildDecisionMessage } from "../src/sessions/decision-message.js";

const ok = (ext: Record<string, unknown>) => {
  const r = buildDecisionMessage("s1", "u1", { messageType: "decision", extData: ext });
  assert.equal(r.ok, true);
  return (r as { ok: true; message: Record<string, unknown> }).message;
};

test("allow and deny map to the dispatcher's wire shape", () => {
  assert.deepEqual(ok({ tool_use_id: "t1", action: "allow" }), {
    type: "decision", session_id: "s1", user_id: "u1", action_id: "t1", decision: "allow", feedback: "",
  });
  const d = ok({ tool_use_id: "t1", action: "deny", reason: "no" });
  assert.equal(d.decision, "deny");
  assert.equal(d.feedback, "no");
});

test("always_allow is an allow that Brain remembers for the session", () => {
  const m = ok({ tool_use_id: "t1", action: "always_allow" });
  assert.equal(m.decision, "allow");
  assert.equal(m.remember, true);
});

test("edit needs the edited input", () => {
  assert.equal(buildDecisionMessage("s", "u", { extData: { tool_use_id: "t", action: "edit" } }).ok, false);
  assert.deepEqual(ok({ tool_use_id: "t", action: "edit", edited_input: { a: 1 } }).edited_input, { a: 1 });
});

test("a missing id or an unknown action is refused, never defaulted to allow", () => {
  assert.equal(buildDecisionMessage("s", "u", { extData: { action: "allow" } }).ok, false);
  assert.equal(buildDecisionMessage("s", "u", { extData: { tool_use_id: "t", action: "yes" } }).ok, false);
  assert.equal(buildDecisionMessage("s", "u", {}).ok, false);
});

test("an answer maps to the dispatcher's answer shape; answers default to none and skipped to empty", () => {
  const r = buildAnswerMessage("s1", "u1", { extData: { tool_use_id: "t1", answers: { q: "yes" }, skipped: ["r"] } });
  assert.deepEqual(r, { ok: true, message: {
    type: "answer", session_id: "s1", user_id: "u1", action_id: "t1", answers: { q: "yes" }, skipped: ["r"],
  } });
  const bare = buildAnswerMessage("s1", "u1", { actionId: "t2" });
  assert.deepEqual(bare.ok && bare.message, {
    type: "answer", session_id: "s1", user_id: "u1", action_id: "t2", answers: {}, skipped: [],
  });
});

test("an answer without an id, or with answers that are not keyed by question, is refused", () => {
  assert.equal(buildAnswerMessage("s", "u", { extData: { answers: { q: "x" } } }).ok, false);
  assert.equal(buildAnswerMessage("s", "u", { extData: { tool_use_id: "t", answers: ["x"] } }).ok, false);
  assert.equal(buildAnswerMessage("s", "u", { extData: { tool_use_id: "t", answers: 5 } }).ok, false);
  assert.equal(buildAnswerMessage("s", "u", { extData: { tool_use_id: "t", skipped: "q" } }).ok, false);
});
