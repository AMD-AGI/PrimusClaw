// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// workspace/sync-semaphore.ts
//
// Global concurrency limiter for Plan Y v2 workspace sync (checkpoint-
// architecture-redesign §5.5.1): two independent semaphores — a shared
// pool for normal turn-driven syncs, and a reserved-capacity pool for
// SIGTERM-priority syncs so a rolling restart can't get starved behind
// routine sync traffic.

import {
  WORKSPACE_SYNC_NORMAL_SLOTS,
  WORKSPACE_SIGTERM_PRIORITY_SLOTS,
} from "../config.js";
import { metrics } from "../infra/metrics.js";

class Semaphore {
  private active = 0;
  private waiters: Array<() => void> = [];

  constructor(
    private readonly max: number,
    // Label value for the two pendingSync gauges
    // (§12.1.2 enum: "normal" | "sigterm"). The semaphore writes
    // {inflight, queued} after every state change so dashboards see a
    // monotonic view independent of any explicit polling.
    private readonly kind: "normal" | "sigterm",
  ) {
    if (max <= 0) throw new Error(`Semaphore max must be > 0, got ${max}`);
    metrics.setPendingSyncGauges(this.kind, 0, 0);
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        metrics.setPendingSyncGauges(this.kind, this.active, this.waiters.length);
      });
    }
    this.active++;
    metrics.setPendingSyncGauges(this.kind, this.active, this.waiters.length);
    try {
      return await fn();
    } finally {
      this.active--;
      const next = this.waiters.shift();
      if (next) next();
      metrics.setPendingSyncGauges(this.kind, this.active, this.waiters.length);
    }
  }

  /** Number of currently running run() invocations. */
  get inflight(): number {
    return this.active;
  }

  /** Number of run() invocations parked waiting on a slot. */
  get queued(): number {
    return this.waiters.length;
  }

  /** Maximum concurrency this semaphore was constructed with. */
  get capacity(): number {
    return this.max;
  }
}

export const workspaceSyncSemaphore = new Semaphore(
  WORKSPACE_SYNC_NORMAL_SLOTS, "normal",
);
export const workspaceSigtermSyncSemaphore = new Semaphore(
  WORKSPACE_SIGTERM_PRIORITY_SLOTS, "sigterm",
);

// Exported for test harnesses that need to instantiate isolated
// semaphores (chaos / load tests). Not used by production code.
export { Semaphore };
