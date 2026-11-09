// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The failures of a direct send to the Bot Connector, as classes: what a token source, the request builder and the retry
 * loop throw. Their messages are reasons (a status, an error code, an error kind), never a body, a text or a token.
 */

/** The bot's token could not be had. `transient`: worth another try (busy or unreachable), as opposed to a refusal. */
export class TokenError extends Error {
  override name = "TokenError";
  constructor(
    message: string,
    readonly transient = false,
  ) {
    super(message);
  }
}

/** An envelope that cannot be addressed, or a serviceUrl the bot's token may not be sent to (Python's ValueError). */
export class UnaddressableError extends Error {
  override name = "UnaddressableError";
}

/** This send did not reach Teams: the reason (never the text), how many requests were made, what Teams answered. */
export class UndeliverableError extends Error {
  override name = "UndeliverableError";
  /** The number of requests made. */
  readonly attempts: number;
  /** The HTTP status Teams answered with (0: none, a network or token failure). */
  readonly status: number;
  /** The Connector's error code, never its message. */
  readonly code: string;
  constructor(reason: string, details: { attempts?: number; status?: number; code?: string; cause?: unknown } = {}) {
    super(reason, details.cause === undefined ? undefined : { cause: details.cause });
    this.attempts = details.attempts ?? 1;
    this.status = details.status ?? 0;
    this.code = details.code ?? "";
  }
}

/** The overall deadline of one operation passed (the `signal.reason` of a deadline, and what a raced wait rejects with). */
export class DeadlineError extends Error {
  override name = "TimeoutError";
}
