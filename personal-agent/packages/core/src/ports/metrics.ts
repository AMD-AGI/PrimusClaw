// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { SecurityEventRecord } from "../observability/security-events.js";

/**
 * The counters behind the operator's alerts. Every label value comes from a closed list
 * (`../observability/metrics-catalog.ts`), so no label ever names a person, a conversation or anything a person chose;
 * a value outside its list is counted under the list's catch-all or not at all. The runtime serves them in the
 * Prometheus text format (`GET /metrics` on its own port); tests use a recording fake.
 */
export interface MetricsPort {
  /** One event from Claw reached the chat: `handleSeconds` after it was received, `sinceOccurredSeconds` after Claw says it happened (null: not said). */
  eventDelivered(eventType: string, handleSeconds: number, sinceOccurredSeconds: number | null): void;
  /** One security event as `securityEvent` logged it. */
  securityEvent(record: SecurityEventRecord): void;
  /** One inbound message handled: how long it waited in the queue (null: unknown), how long handling took, whether it succeeded. */
  processed(lagMs: number | null, handleMs: number, ok: boolean): void;
  /** A message or task refused by a per-user limit (`user_limit` | `concurrency_limit`). */
  limited(reason: string): void;
  /** `count` files a person sent did not reach Claw on `path` (assistant | session | remote_agent | review | unreadable). */
  filesDropped(path: string, count?: number): void;
}

/** Metrics that go nowhere: the default where a caller passes none. */
export const noMetrics: MetricsPort = {
  eventDelivered: () => undefined,
  securityEvent: () => undefined,
  processed: () => undefined,
  limited: () => undefined,
  filesDropped: () => undefined,
};
