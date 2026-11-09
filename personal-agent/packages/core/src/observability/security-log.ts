// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Security events: one structured log line per security-relevant decision, for SIEM detection rules, counted into the
 * metrics as well. The line's message is the record as compact JSON whose first key is `event` (the same line the Python
 * worker wrote), on the logger named SECURITY_LOGGER.
 */
import type { Logger } from "../ports/logger.js";
import type { MetricsPort } from "../ports/metrics.js";
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
  ) {
    this.log = logger.child({ logger: SECURITY_LOGGER });
  }

  /** Logs and counts one security event; the record that was logged (see `securityEventRecord`). */
  event(event: SecurityEventName, fields: Readonly<Record<string, unknown>> = {}): SecurityEventRecord {
    const record = securityEventRecord(event, fields);
    this.log[SECURITY_EVENTS[event]](JSON.stringify(record));
    this.metrics.securityEvent(record);
    return record;
  }
}
