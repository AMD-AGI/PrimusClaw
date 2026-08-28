// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// resume-outcome.test.ts
//
// §5.6 resume outcome classifier contract. Verifies every documented
// branch maps to the exact (hint, toastReason) pair the design
// specifies, including the NP0-1 fix (hints always role:"user" with
// "[system-notice]:" prefix — never role:"system", which the
// Anthropic Messages API rejects).

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyResumeOutcome,
  buildResumeHint,
  type ResumeMode,
} from "../src/tasks/resume-outcome.js";

function expectHintShape(hint: { role: string; content: unknown } | null): void {
  assert.ok(hint, "hint must be present");
  assert.equal(hint!.role, "user", "hint role MUST be 'user' (NP0-1)");
  assert.equal(typeof hint!.content, "string", "hint content must be a string");
  assert.ok(
    (hint!.content as string).startsWith("[system-notice]:"),
    `hint content must start with [system-notice]:; got ${String(hint!.content).slice(0, 40)}`,
  );
}

test("sandbox_reuse → no hint, no toast", () => {
  const r = classifyResumeOutcome("sandbox_reuse", { has_workspace_sync: true }, false, 2);
  assert.equal(r.hint, null);
  assert.equal(r.toastReason, null);
});

test("skip_no_ckpt + deliveryCount=1 → no toast (expected first-delivery miss)", () => {
  const r = classifyResumeOutcome("skip_no_ckpt", null, false, 1);
  assert.equal(r.hint, null);
  assert.equal(r.toastReason, null);
});

test("skip_no_ckpt + deliveryCount>1 → checkpoint_lost toast, no hint", () => {
  const r = classifyResumeOutcome("skip_no_ckpt", null, false, 2);
  assert.equal(r.hint, null);
  assert.equal(r.toastReason, "checkpoint_lost");
});

test("workspace_restore → hint about .git/index + node_modules + resume_workspace_restored toast", () => {
  const r = classifyResumeOutcome("workspace_restore", { has_workspace_sync: true }, false, 2);
  expectHintShape(r.hint as any);
  const text = (r.hint!.content as string);
  assert.match(text, /\.git index/);
  assert.match(text, /node_modules/);
  assert.equal(r.toastReason, "resume_workspace_restored");
});

test("no_data_turn0 + has_workspace_sync=true → workspace_restore_failed toast + explicit hint", () => {
  const r = classifyResumeOutcome("no_data_turn0", { has_workspace_sync: true }, false, 2);
  expectHintShape(r.hint as any);
  assert.match(r.hint!.content as string, /could NOT be restored/);
  assert.equal(r.toastReason, "workspace_restore_failed");
});

test("no_data_turn0 + has_workspace_sync=false → no toast, hint about turn-0 rerun", () => {
  const r = classifyResumeOutcome("no_data_turn0", { has_workspace_sync: false }, false, 2);
  expectHintShape(r.hint as any);
  assert.match(r.hint!.content as string, /starting from turn 0/);
  assert.equal(r.toastReason, null);
});

test("no_data_turn0 + null ckpt → same as has_workspace_sync=false branch", () => {
  const r = classifyResumeOutcome("no_data_turn0", null, false, 2);
  expectHintShape(r.hint as any);
  assert.match(r.hint!.content as string, /starting from turn 0/);
  assert.equal(r.toastReason, null);
});

test("isPartialAssistantTail overrides default toast for sandbox_reuse?", () => {
  // sandbox_reuse takes priority over partial-tail per §5.6 ordering;
  // partial-tail toast only fires when no other classification did.
  const r = classifyResumeOutcome("sandbox_reuse", null, true, 2);
  assert.equal(r.toastReason, null);
});

test("buildResumeHint always returns role:'user' with [system-notice]: prefix", () => {
  const h = buildResumeHint("test body");
  assert.equal(h.role, "user");
  assert.equal(h.content, "[system-notice]: test body");
});

test("every documented ResumeMode is covered by classifyResumeOutcome (exhaustiveness)", () => {
  // If a new mode is added to ResumeMode the for-loop below will type-
  // check it, and the runtime call confirms classify does not throw on
  // any documented value. Exhaustiveness is enforced by the TS literal-
  // union; this test catches missing handlers at runtime in case a
  // future mode is added without a switch arm.
  const modes: ResumeMode[] = [
    "sandbox_reuse",
    "workspace_restore",
    "no_data_turn0",
    "skip_no_ckpt",
  ];
  for (const m of modes) {
    assert.doesNotThrow(() => classifyResumeOutcome(m, null, false, 1));
  }
});
