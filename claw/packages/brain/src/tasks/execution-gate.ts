// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// tasks/execution-gate.ts
//
// How many tasks one brain pod runs at a time.
//
// Nothing enforced that before this. MAX_CONCURRENT was passed to
// `consume({ max_messages })`, which is a prefetch window: it bounds what the
// pod has asked the server for, and it refills when a message *arrives* rather
// than when one finishes. The delivery loop then handed each message to
// handleTask without awaiting it, so the window refilled immediately and a pod
// would accept as many tasks as the server was willing to deliver — each one
// provisioning its own sandbox. The only ceiling was the durable's fleet-wide
// max_ack_pending, which is shared with tasks nak'd and waiting on locks, so
// it bounds the fleet loosely and a single pod not at all.
//
// The gate makes MAX_CONCURRENT mean what its name says. It is deliberately a
// gate on the delivery loop rather than a queue inside handleTask: parking a
// task after it holds the distributed lock would let ack_wait lapse while it
// waits, turning overload into a redelivery storm against a lock the pod itself
// is holding. Holding the loop instead leaves the surplus where it already is —
// unacked in the server's view — and the prefetch window bounds how many that
// can be.
//
// ── Parking ──────────────────────────────────────────────────────────────
//
// A slot was held for the whole of a run, including the parts where the run
// was not running: waiting for a user to approve a tool call, or for a
// background command that has two hours left in it. A pod with MAX_CONCURRENT
// of four and four runs waiting on approvals is idle and full at the same
// time, and the queue behind it does not move until a human comes back from
// lunch.
//
// `park()` hands the slot back for the duration of a wait and `unpark()` takes
// one again afterwards. What it does not hand back is the sandbox: the run is
// suspended in the sense of not consuming the pod's execution budget, but its
// pod, its files and its memory are all still there, because resuming mid-turn
// from a checkpoint is not something the checkpoint can do yet. So parked runs
// need a ceiling of their own, and `residentMax` is it -- the number of runs
// that may exist on this pod at once, executing or parked. Without it, a
// stream of runs that all stop for approval would admit work until the node
// ran out of memory, which is a worse failure than a queue that does not move.
//
// Resuming outranks admitting. A parked run already holds a sandbox and a
// workspace, and making it queue behind fresh deliveries would mean those
// resources sit idle for as long as the backlog takes to drain -- and, with
// every new arrival also able to park, a pod that never lets any of its
// parked runs finish.

import { MAX_CONCURRENT, MAX_RESIDENT } from "../config.js";

class ExecutionGate {
  private active = 0;
  private parked = 0;
  /** Fresh deliveries, FIFO so a waiting one cannot be starved by a later one. */
  private readonly waiters: Array<() => void> = [];
  /** Runs coming back from a wait. Served before any fresh delivery. */
  private readonly resuming: Array<() => void> = [];

  constructor(private readonly max: number, private readonly residentMax = max) {
    if (max <= 0) throw new Error(`ExecutionGate max must be > 0, got ${max}`);
    if (residentMax < max) {
      throw new Error(`ExecutionGate residentMax must be >= max, got ${residentMax} < ${max}`);
    }
  }

  /** Resolves once a slot is free. Every acquire needs exactly one release. */
  async acquire(): Promise<void> {
    if (this.admissible()) {
      this.active++;
      return;
    }
    // Not counted here: `wake` counts the slot as it hands it over, for the
    // reason documented there.
    await new Promise<void>((resolve) => { this.waiters.push(resolve); });
  }

  release(): void {
    if (this.active === 0) return;
    this.active--;
    this.wake();
  }

  /**
   * Give the slot back for the duration of an external wait.
   *
   * The run stays resident -- it keeps its sandbox and will want a slot again
   * -- so it moves from one count to the other rather than leaving entirely.
   *
   * @returns whether a slot was actually handed back, which is what the
   *          matching `unpark` needs to know. A caller that parks while holding
   *          nothing gets nothing back, and must not return holding a slot the
   *          pod will never see released -- one fewer for everything else, for
   *          the life of the process.
   */
  park(): boolean {
    if (this.active === 0) return false;
    this.active--;
    this.parked++;
    this.wake();
    return true;
  }

  /**
   * Take a slot again after a wait, ahead of anything queued.
   *
   * Not subject to the resident ceiling: this run is already resident, and
   * checking it here could only refuse a run that has nowhere else to go.
   *
   * @param hadSlot what the matching `park` returned.
   */
  async unpark(hadSlot = true): Promise<void> {
    if (!hadSlot) return;
    if (this.parked === 0) {
      // Nothing was parked, so this is a stray unpark and the safe reading is
      // that the caller still needs a slot.
      await this.acquire();
      return;
    }
    this.parked--;
    if (this.active < this.max) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => { this.resuming.push(resolve); });
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  /** A fresh delivery may start when it fits under both ceilings. */
  admissible(): boolean {
    return this.active < this.max && this.active + this.parked < this.residentMax;
  }

  /**
   * Hand the free slot to whoever is next in line, and count it as handed over.
   *
   * Counting it here rather than in the continuation that receives it is the
   * whole point. Resolving a promise only queues that continuation, so counting
   * it there leaves a window where the slot is promised to one caller and still
   * reads as free -- and `unpark`'s fast path is synchronous, so a run coming
   * back from a short wait reads `active` inside that window and takes the same
   * slot a second time. Every park-and-return that happened while a delivery
   * was queued admitted one run too many, until the resident ceiling stopped
   * it, which made a pod execute up to `residentMax` rather than `max`.
   */
  private wake(): void {
    const resume = this.active < this.max ? this.resuming.shift() : undefined;
    if (resume) {
      this.active++;
      resume();
      return;
    }
    const next = this.admissible() ? this.waiters.shift() : undefined;
    if (next) {
      this.active++;
      next();
    }
  }

  /** Tasks holding a slot right now. */
  get inflight(): number {
    return this.active;
  }

  /** Runs on this pod that are waiting on something external. */
  get parkedRuns(): number {
    return this.parked;
  }

  /** Deliveries parked waiting for a slot. */
  get queued(): number {
    return this.waiters.length;
  }

  get capacity(): number {
    return this.max;
  }

  get residentCapacity(): number {
    return this.residentMax;
  }
}

export const taskExecutionGate = new ExecutionGate(MAX_CONCURRENT, MAX_RESIDENT);

// Exported so tests can drive an isolated gate instead of the process-wide one.
export { ExecutionGate };
