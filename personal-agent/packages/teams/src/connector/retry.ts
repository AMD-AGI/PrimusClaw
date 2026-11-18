// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * One Bot Connector request with its retries: the bot's token, the request under its own timeout, one fresh token after
 * a 401, a retry with doubling backoff (or the server's Retry-After) on 429, 5xx, a network error or a busy token
 * source, within an attempt budget and an overall deadline. Throws UndeliverableError when Teams did not take it.
 */
import { errorName, type Clock, type Logger } from "@primusclaw/personal-agent";
import { DeadlineError, TokenError, UndeliverableError } from "./errors.js";
import type { ConnectorLimits } from "./limits.js";
import type { ConnectorRequest } from "./request.js";
import { answerId, errorCode, retryAfterMs } from "./response.js";
import { reasonOf, startTimer } from "./timer.js";
import type { TokenSource } from "./tokens/cached.js";

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export interface ClientDeps {
  readonly tokens: TokenSource;
  readonly fetch: typeof fetch;
  readonly clock: Clock;
  readonly sleep: Sleep;
  readonly logger: Logger;
  readonly limits: ConnectorLimits;
}

/** What Teams answered: the `id` of the answer, the status, the number of requests made. */
export interface Answer {
  readonly id: string | undefined;
  readonly status: number;
  readonly attempts: number;
}

export interface ExecuteOptions {
  readonly maxAttempts: number;
  readonly timeoutMs: number;
  /** A retry whose wait would end after this budget is not made. */
  readonly budgetMs: number;
  /** Ends every wait and request: the overall deadline, combined with the caller's signal. */
  readonly deadline: AbortSignal;
  /** The caller's own signal: once it aborts, the call rejects with its reason and nothing is retried. */
  readonly cancel?: AbortSignal | undefined;
  /** The number of the request in progress, readable when the deadline cuts the call off. */
  readonly progress: { attempts: number };
}

/** One request's outcome: an answer, or a network failure (the request may or may not have reached Teams). */
export type Exchange =
  { readonly status: number; readonly text: string; readonly retryAfter: string | null } | { readonly network: string };

type Outcome =
  | { readonly kind: "ok"; readonly answer: Answer }
  | { readonly kind: "refresh" }
  | { readonly kind: "retry"; readonly reason: string; readonly status: number; readonly retryAfterMs?: number };

function networkReason(error: unknown): string {
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
  return `network: ${errorName(cause)}`;
}

export class ConnectorClient {
  constructor(private readonly deps: ClientDeps) {}

  /** One request as it is, with no retry: what Teams answered, or the network failure. */
  async send(request: ConnectorRequest, token: string, timeoutMs: number, signal?: AbortSignal): Promise<Exchange> {
    const timer = startTimer(this.deps.clock, timeoutMs, "the request timed out", signal);
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (request.payload !== undefined) headers["content-type"] = "application/json";
    try {
      const response = await this.deps.fetch(request.url, {
        method: request.method,
        headers,
        body: request.payload === undefined ? null : JSON.stringify(request.payload),
        redirect: "manual",
        signal: timer.signal,
      });
      const text = await response.text();
      return { status: response.status, text, retryAfter: response.headers.get("retry-after") };
    } catch (error) {
      if (signal?.aborted) throw reasonOf(signal);
      return { network: networkReason(error) };
    } finally {
      timer.dispose();
    }
  }

  /** The request with its retries; throws UndeliverableError, or the deadline's or the caller's reason when they end it. */
  async execute(request: ConnectorRequest, options: ExecuteOptions): Promise<Answer> {
    const { clock, limits, logger } = this.deps;
    const deadlineAt = clock.monotonicMs() + options.budgetMs;
    let failures = 0;
    let refreshed = false;
    for (;;) {
      options.progress.attempts = failures + 1;
      const outcome = await this.attempt(request, options, failures + 1, refreshed);
      if (outcome.kind === "ok") return outcome.answer;
      if (outcome.kind === "refresh") {
        refreshed = true;
        continue;
      }
      failures += 1;
      const retryAfter = outcome.retryAfterMs ?? 0;
      const wait = Math.max(limits.backoffMs * 2 ** (failures - 1), retryAfter);
      if (
        failures >= options.maxAttempts ||
        retryAfter > limits.maxRetryAfterMs ||
        clock.monotonicMs() + wait > deadlineAt
      ) {
        throw new UndeliverableError(outcome.reason, { attempts: failures, status: outcome.status });
      }
      logger.info("direct request failed, retrying", { method: request.method, reason: outcome.reason, waitMs: wait });
      try {
        await this.deps.sleep(wait, options.deadline);
      } catch (error) {
        throw this.stopped(options, error);
      }
    }
  }

  private async attempt(
    request: ConnectorRequest,
    options: ExecuteOptions,
    attempts: number,
    refreshed: boolean,
  ): Promise<Outcome> {
    let token: string;
    try {
      token = await this.deps.tokens.get(options.deadline);
    } catch (error) {
      const stopped = this.stopped(options, error);
      if (!(stopped instanceof TokenError)) throw stopped;
      if (!stopped.transient) throw new UndeliverableError(`token: ${stopped.message}`, { attempts });
      return { kind: "retry", reason: `token: ${stopped.message}`, status: 0 };
    }
    const exchange = await this.send(request, token, options.timeoutMs, options.deadline).catch((error: unknown) => {
      throw this.stopped(options, error);
    });
    if ("network" in exchange) return { kind: "retry", reason: exchange.network, status: 0 };
    const { status } = exchange;
    if (status >= 200 && status < 300) return { kind: "ok", answer: { id: answerId(exchange.text), status, attempts } };
    if (status === 401 && !refreshed) {
      // the token may have been revoked or rotated: one fresh one
      this.deps.tokens.invalidate(token);
      return { kind: "refresh" };
    }
    if (status === 401) throw new UndeliverableError("status 401 with a fresh token", { attempts });
    const code = errorCode(exchange.text);
    const reason = `status ${String(status)}${code ? ` ${code}` : ""}`;
    if (status !== 429 && status < 500) throw new UndeliverableError(reason, { attempts, status, code });
    const after = retryAfterMs(exchange.retryAfter);
    return after === undefined
      ? { kind: "retry", reason, status }
      : { kind: "retry", reason, status, retryAfterMs: after };
  }

  /** The error to end the call with: the caller's reason, the deadline, or `error` itself when neither stopped it. */
  private stopped(options: ExecuteOptions, error: unknown): unknown {
    if (options.cancel?.aborted) return reasonOf(options.cancel);
    if (options.deadline.aborted) return new DeadlineError("the overall deadline passed");
    return error;
  }
}
