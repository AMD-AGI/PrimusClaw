// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { InvariantError } from "../errors.js";
import { FIELDS } from "./security-fields.js";

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

/** What the log of security events is called (the Python worker's logger name, which SIEM rules select on). */
export const SECURITY_LOGGER = "clawy.security";

/**
 * The record of one security event. `event` must be one of SECURITY_EVENTS (anything else is a bug: InvariantError). A
 * field whose value is null or undefined is left out. A field whose value does not fit its shape is dropped and its
 * name listed in `dropped`; a field that is not one of FIELDS is listed as `<unknown_field>` (its name could be text).
 */
export function securityEventRecord(
  event: SecurityEventName,
  fields: Readonly<Record<string, unknown>> = {},
): SecurityEventRecord {
  if (!Object.hasOwn(SECURITY_EVENTS, event)) throw new InvariantError("unknown security event");
  const record: Record<string, unknown> = { event };
  const dropped = new Set<string>();
  for (const [name, value] of Object.entries(fields)) {
    if (value === null || value === undefined) continue;
    const check = Object.hasOwn(FIELDS, name) ? FIELDS[name] : undefined;
    const safe = check?.(value);
    if (safe === undefined) {
      dropped.add(check ? name : "<unknown_field>");
      continue;
    }
    record[name] = safe;
  }
  if (dropped.size > 0) record["dropped"] = [...dropped].sort();
  return record as SecurityEventRecord;
}
