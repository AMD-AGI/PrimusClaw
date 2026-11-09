// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { UserLimits } from "../config/settings.js";

/** TEAMS_USER_MESSAGE_LIMIT: messages per window and person. */
export const DEFAULT_MESSAGE_LIMIT = 20;
/** TEAMS_USER_MESSAGE_WINDOW_SECONDS. */
export const DEFAULT_MESSAGE_WINDOW_SECONDS = 60;
/**
 * TEAMS_USER_MAX_CONCURRENT_TASKS. A review request starts up to 10 pull requests at once, each a task; the default
 * leaves room for that beside the person's 1:1 chat and a group.
 */
export const DEFAULT_MAX_CONCURRENT_TASKS = 12;
/**
 * A message to the assistant may start a work item, which shows on the board only once the assistant decided to make
 * one: until then (or for this long, when it starts none) it holds one task slot.
 */
export const ASSISTANT_PENDING_SECONDS = 90;

export const DEFAULT_USER_LIMITS: UserLimits = {
  messageLimit: DEFAULT_MESSAGE_LIMIT,
  messageWindowSeconds: DEFAULT_MESSAGE_WINDOW_SECONDS,
  maxConcurrentTasks: DEFAULT_MAX_CONCURRENT_TASKS,
};

const FIELDS = [
  ["messageLimit", "message_limit"],
  ["messageWindowSeconds", "message_window_seconds"],
  ["maxConcurrentTasks", "max_concurrent_tasks"],
] as const;

/** `limits`, or a RangeError naming the first field that is not a positive whole number (they cannot be turned off). */
export function userLimits(limits: UserLimits = DEFAULT_USER_LIMITS): UserLimits {
  for (const [field, name] of FIELDS) {
    const value = limits[field];
    if (!Number.isInteger(value) || value < 1) {
      throw new RangeError(`${name} must be a positive integer, not ${String(value)}`);
    }
  }
  return limits;
}
