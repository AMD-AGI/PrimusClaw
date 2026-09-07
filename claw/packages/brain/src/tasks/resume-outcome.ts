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
 * What to tell the model about the background starts a resume could not
 * complete, or null where there is nothing to say.
 *
 * The two readings lead opposite ways and must not be collapsed: a start whose
 * claim demonstrably never landed did not run, so re-issuing it is correct,
 * while one nothing could decide may have run and re-issuing it is the
 * duplicate execution the whole scheme exists to avoid.
 *
 * Said as a notice rather than as a tool result, because the tool use this
 * answers is not in the transcript -- a step identity that does not appear in
 * the restored conversation is exactly what identifies these calls -- so there
 * is no tool-use id a result could be addressed to.
 */
export function buildOutstandingStartHint(
  settled: { released: string[]; unresolved: string[] },
): Message | null {
  const parts: string[] = [];
  if (settled.released.length) {
    parts.push(
      `background ${plural(settled.released, "shell")} `
      + `${list(settled.released)} never started -- the request was interrupted `
      + "before it reached the sandbox and nothing ran, so the command can be "
      + "issued again if it is still wanted",
    );
  }
  if (settled.unresolved.length) {
    parts.push(
      `whether background ${plural(settled.unresolved, "shell")} `
      + `${list(settled.unresolved)} started cannot be determined -- check `
      + "before running the command again, since it may already be running",
    );
  }
  return parts.length ? buildResumeHint(`${parts.join("; and ")}.`) : null;
}

const list = (ids: string[]): string => ids.join(", ");
const plural = (ids: string[], word: string): string =>
  (ids.length === 1 ? word : `${word}s`);

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
