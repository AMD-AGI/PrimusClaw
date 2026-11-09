// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The card catalog: every feature's entries. A line that ports a feature's cards adds its module here and takes its ids off
 * `PENDING` (snapshots whose builders are not ported yet, with the line that ports them).
 */
import { APPROVAL_CARDS } from "./approval.js";
import type { CatalogEntry } from "./catalog.js";

export const CATALOG: readonly CatalogEntry[] = [...APPROVAL_CARDS];

const BY_LINE = {
  W4: ["binding", "link", "onboarding", "repo"],
  W4b: ["changes", "error_note", "inactive_note", "session", "show_here_note"],
  W5: [
    "answered",
    "approval_decided",
    "approval_expired",
    "approval_item",
    "approval_proactive",
    "assistant_action",
    "assistant_confirm",
    "board",
    "board_asked",
    "delivery",
    "digest",
    "question_item",
    "run_completed",
    "run_failed",
    "work_done",
    "work_question",
    "work_result",
    "work_stopped",
  ],
  W6b: [
    "remote_agents",
    "remote_disconnect",
    "remote_permission",
    "remote_sessions",
    "remote_sessions_shared",
    "remote_sessions_waiting",
    "remote_sessions_watch",
    "remote_status",
  ],
  W3: ["remote_window", "remote_window_en"],
  W7: ["github_connect", "review_confirm_merge", "review_confirm_post", "review_end", "review_mode", "review_start"],
  W8: ["feedback_offer", "report", "thumb_comment", "thumbs"],
} as const;

/** Snapshot ids whose builders are not ported yet. Each line removes its own as it registers them. */
export const PENDING: ReadonlySet<string> = new Set<string>(Object.values(BY_LINE).flat());
