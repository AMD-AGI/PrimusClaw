// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The closed lists every metric label value comes from, so the number of series is fixed and no label names a person,
 * a conversation or anything a person chose.
 */

/** The category fields of a security event that become labels of `clawy_security_events_total`, in this order. */
export const SECURITY_EVENT_LABELS = ["scope", "outcome", "reason"] as const;

/** Why a message or task was refused by a per-person limit. */
export const LIMIT_REASONS = ["user_limit", "concurrency_limit"] as const;
export type LimitReason = (typeof LIMIT_REASONS)[number];

/** The event types from Claw that are labels as themselves; any other is counted as "other". */
export const DELIVERED_EVENT_TYPES = [
  "approval.requested",
  "work_item.needs_you",
  "assistant.say",
  "assistant.action",
  "run.completed",
  "run.failed",
  "other",
] as const;

/**
 * Where a file a person sent did not reach Claw: the assistant path, a session turn, a chat attached to a remote agent,
 * a review request, and a file the channel gave no way to fetch. Every one is also said to the person.
 */
export const FILES_DROPPED_PATHS = ["assistant", "session", "remote_agent", "review", "unreadable"] as const;
export type FilesDroppedPath = (typeof FILES_DROPPED_PATHS)[number];
