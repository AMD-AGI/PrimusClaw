// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The time limits and retry budget of direct delivery: the production values, and how a caller overrides them. */

export interface ConnectorLimits {
  /** One request's timeout. */
  readonly requestTimeoutMs: number;
  /** A typing indicator is cosmetic and holds up the messages behind it: its request and its whole send. */
  readonly typingTimeoutMs: number;
  /** One send and up to three retries on 429, 5xx and network errors. */
  readonly maxAttempts: number;
  /** The first backoff, doubled after every failure. */
  readonly backoffMs: number;
  /** A longer Retry-After is not waited for: the queue takes the message instead. */
  readonly maxRetryAfterMs: number;
  /** Everything one send does (token, requests, waits) together, enforced, not just checked. */
  readonly sendDeadlineMs: number;
  /** A new 1:1 conversation: one try and one retry (a person waits for the card behind it). */
  readonly openAttempts: number;
  readonly openRequestTimeoutMs: number;
  /** Everything one createConversation does together. */
  readonly openDeadlineMs: number;
  /** A conversation stays on the queue until it has been quiet this long (the relay's cold start was 15-44 s). */
  readonly queueStickyMs: number;
}

export const DEFAULT_LIMITS: ConnectorLimits = {
  requestTimeoutMs: 10_000,
  typingTimeoutMs: 5_000,
  maxAttempts: 4,
  backoffMs: 500,
  maxRetryAfterMs: 10_000,
  sendDeadlineMs: 30_000,
  openAttempts: 2,
  openRequestTimeoutMs: 8_000,
  openDeadlineMs: 12_000,
  queueStickyMs: 60_000,
};
