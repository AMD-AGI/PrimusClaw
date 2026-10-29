// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { IdentityUnavailableError } from "./errors.js";
import type { IdentityDeps, IdentityOp, UpstreamOutcome } from "./types.js";

/**
 * Time one upstream call and report how it ended, whichever way it ended.
 * `run` names its own success outcome; a failure is reported as its reason.
 */
export async function observe<T>(
  deps: IdentityDeps,
  op: IdentityOp,
  run: () => Promise<{ value: T; outcome: UpstreamOutcome }>,
): Promise<T> {
  const started = deps.now();
  const seconds = (): number => Math.max(0, deps.now() - started) / 1000;
  try {
    const { value, outcome } = await run();
    deps.metrics.onUpstream(op, outcome, seconds());
    return value;
  } catch (err) {
    // Anything else is this client's own defect; it is counted as the upstream
    // having sent something unusable, which is how it would look from outside.
    deps.metrics.onUpstream(op, err instanceof IdentityUnavailableError ? err.reason : "bad_response", seconds());
    throw err;
  }
}

export interface RefreshingOptions<T> {
  op: IdentityOp;
  /** Fetch a new copy. Records its own upstream metrics. */
  load: () => Promise<T>;
  /** How long a loaded copy is fresh. */
  refreshMs: number;
  /**
   * How much longer past freshness the held copy may be served when a reload
   * cannot be made. Zero means never: an expired copy is simply an error.
   */
  staleIfErrorMs: number;
  /**
   * After a failed reload, how long the held copy is served without trying
   * again. Without it every request in an outage would wait out a full timeout.
   */
  retryAfterFailureMs: number;
}

/**
 * One document fetched from the upstream and kept: fresh for `refreshMs`,
 * reloaded by whoever arrives first after that while everyone else waits on the
 * same call, and kept serving when the reload fails for a bounded time. Discovery
 * and the key set are both this.
 */
export class RefreshingResource<T> {
  private value: T | undefined;
  private freshUntil = 0;
  private retryAt = 0;
  private loadedAtMs = -Infinity;
  private inflight: Promise<T> | undefined;

  constructor(private readonly opts: RefreshingOptions<T>, private readonly deps: IdentityDeps) {}

  /** When the held copy was fetched; minus infinity before the first load. */
  get loadedAt(): number {
    return this.loadedAtMs;
  }

  async get(): Promise<T> {
    const now = this.deps.now();
    if (this.value !== undefined && now < this.freshUntil) {
      this.deps.metrics.onCache(this.opts.op, "hit");
      return this.value;
    }
    const canServeStale = this.value !== undefined && now < this.freshUntil + this.opts.staleIfErrorMs;
    if (canServeStale && now < this.retryAt) {
      this.deps.metrics.onStaleServed(this.opts.op);
      return this.value as T;
    }
    let flight = this.inflight;
    if (flight) {
      this.deps.metrics.onCache(this.opts.op, "coalesced");
    } else {
      this.deps.metrics.onCache(this.opts.op, "miss");
      flight = this.start();
    }
    try {
      return await flight;
    } catch (err) {
      if (canServeStale && err instanceof IdentityUnavailableError) {
        this.deps.metrics.onStaleServed(this.opts.op);
        this.deps.logger.warn(
          { op: this.opts.op, reason: err.reason, status: err.status },
          "identity.stale_if_error",
        );
        return this.value as T;
      }
      throw err;
    }
  }

  /**
   * Fetch now, whatever freshness says. A failure leaves the held copy in place
   * and resolves undefined: the caller asked for an improvement, not for the copy.
   */
  async reload(): Promise<T | undefined> {
    try {
      return await (this.inflight ?? this.start());
    } catch {
      return undefined;
    }
  }

  private start(): Promise<T> {
    const flight: Promise<T> = this.opts.load().then(
      (value) => {
        this.value = value;
        this.loadedAtMs = this.deps.now();
        this.freshUntil = this.deps.now() + this.opts.refreshMs;
        this.retryAt = 0;
        return value;
      },
      (err: unknown) => {
        this.retryAt = this.deps.now() + this.opts.retryAfterFailureMs;
        throw err;
      },
    ).finally(() => {
      if (this.inflight === flight) this.inflight = undefined;
    });
    this.inflight = flight;
    return flight;
  }
}
