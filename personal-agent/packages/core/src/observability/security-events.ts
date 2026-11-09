// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The security events, their log levels (a closed list: SIEM rules match on these names). */
export const SECURITY_EVENTS = {
  link_attempt: "info",
  link_lockout: "warn",
  token_rejected: "warn",
  approval_answered: "info",
  merge_confirmed: "info",
  pr_merged: "info",
  rate_limited: "warn",
  key_unlinked: "info",
  on_behalf_message: "info",
} as const;
export type SecurityEventName = keyof typeof SECURITY_EVENTS;

/** One logged security event: `event` first, then only allow-listed, shape-checked fields, and `dropped` field names. */
export type SecurityEventRecord = Readonly<
  { event: SecurityEventName; dropped?: readonly string[] } & Record<string, unknown>
>;
