// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// workspace-sync-semaphore.test.ts
//
// Concurrency-limiter contract for brain/src/workspace/sync-semaphore.ts.
// We import the exported `Semaphore` class directly so we can construct
// isolated instances rather than mutating the shared production
// instances (`workspaceSyncSemaphore` / `workspaceSigtermSyncSemaphore`).
// Asserts:
//   - max concurrency is honoured (no over-subscription)
//   - waiters are released in FIFO order
//   - inflight / queued / capacity getters are consistent after each
//     transition (these power the §12.1 pending_sync_* gauges)

import { test } from "node:test";
import assert from "node:assert/strict";
import { Semaphore } from "../src/workspace/sync-semaphore.js";

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (v: T | PromiseLike<T>) => void;
} {
  let resolve!: (v: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

test("Semaphore enforces max concurrency", async () => {
  const sem = new Semaphore(2, "normal");
  const gates = [deferred(), deferred(), deferred()];
  let peakInflight = 0;
  const observe = () => {
    if (sem.inflight > peakInflight) peakInflight = sem.inflight;
  };

  const runs = gates.map((g, i) =>
    sem.run(async () => {
      observe();
      await g.promise;
      observe();
      return i;
    }),
  );
  // Give the event loop a tick to schedule the first two slot
  // acquisitions and park the third.
  await new Promise((r) => setImmediate(r));
  observe();
  assert.equal(sem.inflight, 2, "exactly two slots should be active");
  assert.equal(sem.queued, 1, "the third caller must be parked");

  gates[0].resolve();
  await runs[0];
  await new Promise((r) => setImmediate(r));
  observe();
  assert.equal(sem.inflight, 2, "third caller takes the freed slot");
  assert.equal(sem.queued, 0);

  gates[1].resolve();
  gates[2].resolve();
  await Promise.all(runs);
  assert.equal(peakInflight, 2, "concurrency must never exceed max");
  assert.equal(sem.inflight, 0);
});

test("Semaphore releases waiters in FIFO order", async () => {
  const sem = new Semaphore(1, "normal");
  const gates = [deferred(), deferred(), deferred(), deferred()];
  const order: number[] = [];

  const runs = gates.map((g, i) =>
    sem.run(async () => {
      order.push(i);
      await g.promise;
    }),
  );
  // Resolve gates in arrival order; the semaphore must serve waiters
  // in the same order they were parked even if other gates are ready.
  for (const g of gates) {
    await new Promise((r) => setImmediate(r));
    g.resolve();
  }
  await Promise.all(runs);
  assert.deepEqual(order, [0, 1, 2, 3]);
});

test("Semaphore capacity getter mirrors constructor arg", () => {
  const sem = new Semaphore(7, "sigterm");
  assert.equal(sem.capacity, 7);
});

test("Semaphore rejects non-positive max", () => {
  assert.throws(() => new Semaphore(0, "normal"), /must be > 0/);
  assert.throws(() => new Semaphore(-1, "sigterm"), /must be > 0/);
});

test("Semaphore inflight/queued return to zero after all releases", async () => {
  const sem = new Semaphore(2, "normal");
  await Promise.all([
    sem.run(async () => {}),
    sem.run(async () => {}),
    sem.run(async () => {}),
    sem.run(async () => {}),
  ]);
  assert.equal(sem.inflight, 0);
  assert.equal(sem.queued, 0);
});

test("Semaphore releases slot even when the user fn throws", async () => {
  const sem = new Semaphore(1, "normal");
  await assert.rejects(
    sem.run(async () => { throw new Error("boom"); }),
    /boom/,
  );
  assert.equal(sem.inflight, 0, "thrown fn must not leak the slot");
  // Subsequent runs must still acquire the slot.
  let ran = false;
  await sem.run(async () => { ran = true; });
  assert.ok(ran);
});
