// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { Clock } from "../ports/clock.js";
import type { Logger } from "../ports/logger.js";
import { noMetrics, type MetricsPort } from "../ports/metrics.js";

/** One `inbound_stats` line per this many seconds (when anything happened). */
export const STATS_INTERVAL_SECONDS = 60;

/** What one `inbound_stats` line says. */
export interface InboundSnapshot {
  readonly event: "inbound_stats";
  readonly interval_seconds: number;
  readonly handled: number;
  readonly failed: number;
  readonly lag_max_ms: number;
  readonly lag_avg_ms: number;
  readonly handle_max_ms: number;
  readonly handle_avg_ms: number;
  readonly rate_limited: number;
  readonly concurrency_limited: number;
}

interface Counts {
  handled: number;
  failed: number;
  lagTotalMs: number;
  lagMaxMs: number;
  handleTotalMs: number;
  handleMaxMs: number;
  rateLimited: number;
  concurrencyLimited: number;
}

const zero = (): Counts => ({
  handled: 0,
  failed: 0,
  lagTotalMs: 0,
  lagMaxMs: 0,
  handleTotalMs: 0,
  handleMaxMs: 0,
  rateLimited: 0,
  concurrencyLimited: 0,
});

/**
 * Counters for the inbound path, logged as one `inbound_stats` line per interval in which anything happened: messages
 * handled, the longest and average time a message waited in the queue (lag), the longest and average handling time,
 * failures, and refusals by a limit. Each message and refusal is also counted in `metrics`, for /metrics.
 */
export class InboundStats {
  private counts = zero();
  private since: number;

  constructor(
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly metrics: MetricsPort = noMetrics,
    private readonly intervalSeconds = STATS_INTERVAL_SECONDS,
  ) {
    this.since = this.now();
  }

  private now(): number {
    return this.clock.monotonicMs() / 1000;
  }

  /** Messages handled since the last line. */
  get handled(): number {
    return this.counts.handled;
  }

  processed(lagMs: number | null, handleMs: number, ok: boolean): void {
    this.metrics.processed(lagMs, handleMs, ok);
    const c = this.counts;
    c.handled += 1;
    if (!ok) c.failed += 1;
    if (lagMs !== null) {
      const lag = Math.max(lagMs, 0);
      c.lagTotalMs += lag;
      c.lagMaxMs = Math.max(c.lagMaxMs, lag);
    }
    c.handleTotalMs += handleMs;
    c.handleMaxMs = Math.max(c.handleMaxMs, handleMs);
    this.flushDue();
  }

  limited(reason: string): void {
    this.metrics.limited(reason);
    if (reason === "concurrency_limit") this.counts.concurrencyLimited += 1;
    else this.counts.rateLimited += 1;
  }

  /** Files a person sent that did not reach Claw, counted for /metrics only. */
  filesDropped(path: string, count: number): void {
    this.metrics.filesDropped(path, count);
  }

  snapshot(): InboundSnapshot {
    const c = this.counts;
    const avg = (total: number): number => (c.handled ? Math.floor(total / c.handled) : 0);
    return {
      event: "inbound_stats",
      interval_seconds: Math.trunc(this.now() - this.since),
      handled: c.handled,
      failed: c.failed,
      lag_max_ms: c.lagMaxMs,
      lag_avg_ms: avg(c.lagTotalMs),
      handle_max_ms: c.handleMaxMs,
      handle_avg_ms: avg(c.handleTotalMs),
      rate_limited: c.rateLimited,
      concurrency_limited: c.concurrencyLimited,
    };
  }

  flushDue(): void {
    if (this.now() - this.since >= this.intervalSeconds) this.flush();
  }

  flush(): void {
    const c = this.counts;
    if (c.handled || c.rateLimited || c.concurrencyLimited) {
      const { event, ...fields } = this.snapshot();
      this.logger.info(event, fields);
    }
    this.since = this.now();
    this.counts = zero();
  }
}
