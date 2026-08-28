// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// tasks/resume-outcome.ts
//
// Plan Y v2 §5.6: derive the LLM hint message + frontend toast reason
// from the resume decision so the two channels can never disagree.
//
// Extracted from brain/src/index.ts so unit tests can import the
// classifier without pulling in main() (index.ts has a top-level
// main() invocation that connects to NATS on import).

import type { Message } from "@claw/protocol";

// Minimal shape needed by classifyResumeOutcome. Defined locally so
// this module does not import the full TaskCheckpoint interface from
// index.ts (which would create a circular dep and break unit tests
// by triggering index.ts main()).
export interface CheckpointSnapshotLike {
  has_workspace_sync?: boolean;
}

export type ResumeMode =
  | "sandbox_reuse"
  | "workspace_restore"
  | "no_data_turn0"
  | "skip_no_ckpt";

export type ResumeToastReason =
  | "checkpoint_lost"
  | "resume_workspace_restored"
  | "workspace_restore_failed"
  | "resumed_partial_response";

export interface ResumeOutcome {
  hint: Message | null;
  toastReason: ResumeToastReason | null;
}

/**
 * Build a resume hint as a role:"user" message with the "[system-notice]:"
 * prefix (Plan Y v2 §5.6 NP0-1). The Anthropic Messages API rejects
 * role:"system" inside the messages array — `system` is a top-level
 * parameter passed separately by the SDK caller. The prefix lets
 * agent-loop.filterResumeNotices identify these messages for de-
 * duplication before each LLM call (§5.4.1 NP1-2).
 */
export function buildResumeHint(text: string): Message {
  return { role: "user", content: `[system-notice]: ${text}` };
}

/**
 * Map (resumeMode, ckpt, partial-tail, deliveryCount) to a hint
 * message + toast reason. The classification table follows the §5.6
 * sub-case rules verbatim. Returns nulls for both when the resume
 * was clean (sandbox_reuse) so callers can short-circuit cheaply.
 */
export function classifyResumeOutcome(
  resumeMode: ResumeMode,
  ckpt: CheckpointSnapshotLike | null,
  isPartialAssistantTail: boolean,
  deliveryCount: number,
): ResumeOutcome {
  if (resumeMode === "sandbox_reuse") {
    return { hint: null, toastReason: null };
  }
  if (resumeMode === "skip_no_ckpt" && deliveryCount > 1) {
    return { hint: null, toastReason: "checkpoint_lost" };
  }
  if (resumeMode === "workspace_restore") {
    return {
      hint: buildResumeHint(
        "/workspace files are restored from checkpoint but .git index and "
        + "node_modules are not preserved (ignore list). Re-stage / re-commit "
        + "local changes or run npm install if needed.",
      ),
      toastReason: "resume_workspace_restored",
    };
  }
  if (resumeMode === "no_data_turn0" && ckpt?.has_workspace_sync) {
    return {
      hint: buildResumeHint(
        "The /workspace directory could NOT be restored after sandbox restart. "
        + "Previously created files are not present; re-create them if needed.",
      ),
      toastReason: "workspace_restore_failed",
    };
  }
  if (resumeMode === "no_data_turn0") {
    return {
      hint: buildResumeHint(
        "Previous attempt's progress was lost; starting from turn 0. "
        + "/workspace may contain partial artifacts from prior attempts.",
      ),
      toastReason: null,
    };
  }
  if (isPartialAssistantTail) {
    return { hint: null, toastReason: "resumed_partial_response" };
  }
  return { hint: null, toastReason: null };
}
