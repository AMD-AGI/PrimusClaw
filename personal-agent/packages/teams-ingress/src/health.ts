// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * How the inbound send path judges a failure, and what it reports about itself.
 *
 * A failed send is either about the connection (the AMQP connection or link under the client is gone or wedged: the
 * SDK's "Link has been permanently closed", a timeout, a socket error, a transient Service Bus code) or about the
 * message or the queue (too large, the entity missing or disabled, a quota). Only the first kind is cured by a new
 * ServiceBusClient: a client whose connection is stuck closing makes every sender opened on it wait for a disconnect
 * that never comes, so a new sender on the same client hangs as the old one did.
 *
 * Every send that ends in failure is one structured `inbound_enqueue_failed` record on the `ingress_health` logger,
 * every client thrown away one `inbound_client_reset`, and the first success after failures one
 * `inbound_enqueue_recovered`. Each carries the instance's running counters, so a log query over them is the metric
 * (alerts count the records; the counters show how long an instance has been failing). No record holds the message,
 * the error text or a setting: the error's name and Service Bus code only.
 */
import { type Clock } from "./env.js";
import { type LogSink } from "./log.js";

export const HEALTH_LOGGER = "ingress_health";

// Service Bus codes that describe the message or the queue, not the connection: a new client fails the same way.
const MESSAGE_OR_ENTITY_CODES: ReadonlySet<string> = new Set([
  "MessageSizeExceeded",
  "MessagingEntityNotFound",
  "MessagingEntityDisabled",
  "MessagingEntityAlreadyExists",
  "QuotaExceeded",
  "ServiceBusy",
  "SessionCannotBeLocked",
]);

/** The Service Bus (or Node system) error code an error carries, if it is a short identifier. */
export function errorCode(error: unknown): string | null {
  const code = error instanceof Error ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && /^[A-Za-z][A-Za-z0-9_:.-]{0,63}$/.test(code) ? code : null;
}

/** The error's class name, for a record: never its message. */
export function errorName(error: unknown): string {
  return error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name) ? error.name : "Error";
}

/**
 * Whether a failed send means the client's connection cannot be trusted any more. Everything is, but for a Service
 * Bus error whose code is about the message or the queue: an unknown failure costs a reconnect, while keeping a dead
 * connection costs every later message.
 */
export function isConnectionFailure(error: unknown): boolean {
  if (errorName(error) !== "ServiceBusError") return true;
  const code = errorCode(error);
  return code === null || !MESSAGE_OR_ENTITY_CODES.has(code);
}

/** The instance's running counts of the inbound send path. */
export interface HealthCounters {
  /** Sends (activities and delivery acks) that reached the queue. */
  readonly enqueued: number;
  /** Sends that did not, after every attempt. */
  readonly enqueueFailures: number;
  /** Single attempts that failed, retried or not. */
  readonly attemptFailures: number;
  /** Clients thrown away for a connection failure. */
  readonly clientResets: number;
  /** Failed sends since the last success. */
  readonly consecutiveFailures: number;
}

export class InboundHealth {
  private counts = { enqueued: 0, enqueueFailures: 0, attemptFailures: 0, clientResets: 0, consecutiveFailures: 0 };

  constructor(private readonly clock: Clock) {}

  get counters(): HealthCounters {
    return { ...this.counts };
  }

  attemptFailed(): void {
    this.counts.attemptFailures += 1;
  }

  clientReset(sink: LogSink, error: unknown, attempt: number): void {
    this.counts.clientResets += 1;
    emit(sink, "warning", {
      event: "inbound_client_reset",
      attempt,
      error: errorName(error),
      code: errorCode(error),
      client_resets: this.counts.clientResets,
    });
  }

  enqueued(sink: LogSink): void {
    const after = this.counts.consecutiveFailures;
    this.counts.enqueued += 1;
    this.counts.consecutiveFailures = 0;
    if (after > 0) emit(sink, "info", { event: "inbound_enqueue_recovered", after_failures: after });
  }

  /** `started` is the send's start on this.clock's monotonic clock. */
  enqueueFailed(sink: LogSink, f: { kind: string; error: unknown; attempts: number; started: number }): void {
    this.counts.enqueueFailures += 1;
    this.counts.consecutiveFailures += 1;
    emit(sink, "error", {
      event: "inbound_enqueue_failed",
      kind: f.kind,
      attempts: f.attempts,
      error: errorName(f.error),
      code: errorCode(f.error),
      elapsed_ms: Math.trunc((this.clock.monotonic() - f.started) * 1000),
      enqueue_failures: this.counts.enqueueFailures,
      consecutive_failures: this.counts.consecutiveFailures,
      client_resets: this.counts.clientResets,
    });
  }
}

function emit(sink: LogSink, level: "info" | "warning" | "error", record: Record<string, unknown>): void {
  sink({ logger: HEALTH_LOGGER, level, message: JSON.stringify(record) });
}
