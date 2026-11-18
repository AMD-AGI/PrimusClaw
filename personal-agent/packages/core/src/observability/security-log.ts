// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Security events: one structured log line per security-relevant decision, for SIEM detection rules, counted into the
 * metrics as well. The line's message is the record as compact JSON whose first key is `event` (the same line the Python
 * worker wrote), on the logger named SECURITY_LOGGER.
 */
import type { Logger } from "../ports/logger.js";
import type { MetricsPort } from "../ports/metrics.js";
import { activityIdOf, noRequestScope, type RequestScope } from "../ports/request-scope.js";
import {
  SECURITY_EVENTS,
  SECURITY_LOGGER,
  securityEventRecord,
  type SecurityEventName,
  type SecurityEventRecord,
} from "./security-events.js";

export class SecurityLog {
  private readonly log: Logger;

  constructor(
    logger: Logger,
    private readonly metrics: MetricsPort,
    private readonly scope: RequestScope = noRequestScope,
  ) {
    this.log = logger.child({ logger: SECURITY_LOGGER });
  }

  /**
   * Logs and counts one security event; the record that was logged (see `securityEventRecord`). A caller that names no
   * `activity_id` gets the activity being handled, after its own fields; one that names it, even as null, keeps its own
   * (Python guardrails.audit).
   */
  event(event: SecurityEventName, fields: Readonly<Record<string, unknown>> = {}): SecurityEventRecord {
    const named = Object.hasOwn(fields, "activity_id");
    const record = securityEventRecord(
      event,
      named ? fields : { ...fields, activity_id: activityIdOf(this.scope) || null },
    );
    this.log[SECURITY_EVENTS[event]](JSON.stringify(record));
    this.metrics.securityEvent(record);
    return record;
  }
}
