// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// How many tasks one pod runs at a time.
//
// MAX_CONCURRENT used to reach only `consume({ max_messages })`, a prefetch
// window that refills on arrival rather than on completion, and the delivery
// loop dispatched without awaiting — so a pod accepted as many tasks as the
// server offered and built a sandbox for each. These pin the properties the
// gate has to hold for that not to happen: a hard ceiling, FIFO so a waiting
// delivery is not starved by a later one, and a slot that comes back even when
// the task it was holding threw.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ExecutionGate } from "../src/tasks/execution-gate.js";

/** A promise plus its resolver, so a test can decide when a task finishes. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

/** Drain the microtask queue. Admitting a waiter takes several turns — release
 *  resolves its promise, and the continuation then re-enters acquire — so
 *  counting a single `await` would be counting the scheduler, not the gate. */
function settle(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

test("the gate never runs more than its capacity at once", async () => {
  const gate = new ExecutionGate(2);
  const gates = [deferred(), deferred(), deferred()];
  let started = 0;
  let peak = 0;

  const runs = gates.map((g) => gate.run(async () => {
    started++;
    peak = Math.max(peak, gate.inflight);
    await g.promise;
  }));

  await settle();
  assert.equal(started, 2, "the third task must wait for a slot");
  assert.equal(gate.queued, 1);

  gates[0]!.resolve();
  await runs[0];
  await settle();
  assert.equal(started, 3, "finishing one task must admit the one that was waiting");

  gates[1]!.resolve();
  gates[2]!.resolve();
  await Promise.all(runs);

  assert.equal(peak, 2, "capacity must be a ceiling, not an average");
  assert.equal(gate.inflight, 0);
  assert.equal(gate.queued, 0);
});

test("waiting deliveries are admitted in arrival order", async () => {
  const gate = new ExecutionGate(1);
  const first = deferred();
  const order: number[] = [];

  const held = gate.run(async () => { order.push(0); await first.promise; });
  const queued = [1, 2, 3].map((n) => gate.run(async () => { order.push(n); }));

  first.resolve();
  await held;
  await Promise.all(queued);

  assert.deepEqual(order, [0, 1, 2, 3],
    "a delivery that has been waiting must not be overtaken by a later one");
});

test("a task that throws still gives its slot back", async () => {
  const gate = new ExecutionGate(1);

  await assert.rejects(gate.run(async () => { throw new Error("task blew up"); }));
  assert.equal(gate.inflight, 0, "a failed task must not leak the slot it held");

  // The gate is still usable, which is what leaking would have broken.
  await gate.run(async () => {});
  assert.equal(gate.inflight, 0);
});

test("acquire and release compose for callers that dispatch without awaiting", async () => {
  // This is how the delivery loop uses it: acquire, hand the task off, release
  // when it settles. run() cannot express that without holding the loop open.
  const gate = new ExecutionGate(1);
  await gate.acquire();
  assert.equal(gate.inflight, 1);

  let admitted = false;
  const waiting = gate.acquire().then(() => { admitted = true; });
  await settle();
  assert.equal(admitted, false, "the second acquire must block while the slot is taken");

  gate.release();
  await waiting;
  assert.equal(admitted, true);
  gate.release();
  assert.equal(gate.inflight, 0);
});

test("a gate with no capacity is rejected rather than silently serialising", () => {
  assert.throws(() => new ExecutionGate(0));
  assert.throws(() => new ExecutionGate(-1));
});

// ── Parking ────────────────────────────────────────────────────────────────
//
// A run waiting for a person to approve a tool call is not using the slot it
// holds, and a pod full of them is idle and full at once. Parking hands the
// slot back for the duration -- but not the sandbox, which is why a parked run
// still counts against a second, larger ceiling.

test("a parked run frees its slot for someone else", async () => {
  const gate = new ExecutionGate(1, 4);
  await gate.acquire();

  let admitted = false;
  const waiting = gate.acquire().then(() => { admitted = true; });
  await settle();
  assert.equal(admitted, false);

  gate.park();
  await waiting;
  assert.equal(admitted, true, "the queue moves while the first run waits");
  assert.equal(gate.inflight, 1);
  assert.equal(gate.parkedRuns, 1, "the parked run is still on this pod, holding a sandbox");
});

test("the resident ceiling bounds runs that are waiting, not just running", async () => {
  // Without this, a stream of runs that all stop for approval admits work
  // until the node runs out of memory -- a worse failure than a slow queue.
  const gate = new ExecutionGate(1, 2);
  await gate.acquire();
  gate.park();
  await gate.acquire();
  gate.park();

  let admitted = false;
  void gate.acquire().then(() => { admitted = true; });
  await settle();
  assert.equal(admitted, false, "two parked runs fill a pod that may hold two");
  assert.equal(gate.parkedRuns, 2);

  await gate.unpark();
  gate.release();
  await settle();
  assert.equal(admitted, true, "a parked run finishing makes room again");
});

test("a run coming back from a wait is served before any fresh delivery", async () => {
  // The parked run already holds a sandbox and a workspace. Making it queue
  // behind new arrivals leaves those idle for as long as the backlog takes,
  // and since new arrivals can park too, possibly forever.
  const gate = new ExecutionGate(1, 4);
  await gate.acquire();
  gate.park();

  await gate.acquire();
  const order: string[] = [];
  const fresh = gate.acquire().then(() => { order.push("fresh"); });
  const resumed = gate.unpark().then(() => { order.push("resumed"); });
  await settle();
  assert.deepEqual(order, [], "both are waiting on the one busy slot");

  gate.release();
  await resumed;
  gate.release();
  await fresh;
  assert.deepEqual(order, ["resumed", "fresh"]);
});

test("unparking is not refused by the resident ceiling", async () => {
  // The run is already resident. Refusing it here could only strand a run
  // that has nowhere else to go, since nothing else will free the space.
  const gate = new ExecutionGate(2, 2);
  await gate.acquire();
  await gate.acquire();
  gate.park();
  gate.park();

  await gate.unpark();
  await gate.unpark();
  assert.equal(gate.inflight, 2);
  assert.equal(gate.parkedRuns, 0);
});

test("a run coming back from a wait cannot take a slot already given away", async () => {
  // The ceiling and the parking are each easy to check on their own; this is
  // the seam between them, and the seam is where it broke. Parking hands the
  // slot to a queued delivery, and the returning run then has to queue like
  // anything else -- reading `active` before the delivery it woke has counted
  // its slot would let one pod execute past MAX_CONCURRENT, once per wait.
  const gate = new ExecutionGate(2, 4);
  await gate.acquire();
  await gate.acquire();

  let admitted = false;
  const fresh = gate.acquire().then(() => { admitted = true; });
  gate.park();
  const resumed = gate.unpark();
  await settle();

  assert.equal(admitted, true, "parking hands the slot to the queued delivery");
  assert.equal(gate.inflight, 2, "and that is the whole capacity: the returning run waits");

  gate.release();
  await Promise.all([fresh, resumed]);
  assert.equal(gate.inflight, 2, "the returning run takes the slot that was freed, not a third");
  assert.equal(gate.parkedRuns, 0);
});

test("repeated waits do not each admit an extra run", async () => {
  // One run doing several short waits with a backlog behind it was the shape
  // that accumulated: every cycle leaked one more slot, so the pod drifted
  // from MAX_CONCURRENT up to the resident ceiling.
  const gate = new ExecutionGate(2, 16);
  await gate.acquire();
  await gate.acquire();

  const pending = Array.from({ length: 5 }, () => gate.acquire());
  let peak = gate.inflight;
  for (const fresh of pending) {
    gate.park();
    const resumed = gate.unpark();
    await fresh;
    peak = Math.max(peak, gate.inflight);
    gate.release();
    await resumed;
    peak = Math.max(peak, gate.inflight);
  }

  assert.equal(peak, 2, "capacity has to hold across waits, not just across arrivals");
});

test("a stray unpark still leaves the caller holding a slot", async () => {
  // Parking and unparking are paired by a try/finally several layers up. If
  // the pairing is ever broken, the safe reading of an unpark with nothing
  // parked is that this run wants to execute -- not that it may execute
  // without being counted.
  const gate = new ExecutionGate(1, 2);
  await gate.unpark();
  assert.equal(gate.inflight, 1);
  assert.equal(gate.parkedRuns, 0);
});

test("parking without a slot is answered, and returning takes nothing back", async () => {
  // park() can only hand back a slot the caller holds, so a caller that holds
  // none is told so. Returning as though it had parked would take a slot that
  // nothing will ever release -- the pod runs one fewer task from then on, with
  // no symptom beyond gradually worse throughput.
  const gate = new ExecutionGate(2, 4);

  assert.equal(gate.park(), false, "there was nothing to give back");
  assert.equal(gate.parkedRuns, 0);

  await gate.unpark(false);
  assert.equal(gate.inflight, 0, "and so there is nothing to take back either");

  await gate.acquire();
  assert.equal(gate.park(), true, "a real slot is still handed back the same way");
});

test("a resident ceiling below the execution one is rejected", () => {
  // It would mean a pod allowed to run more than it is allowed to hold.
  assert.throws(() => new ExecutionGate(4, 2));
});

test("admissible is false when every slot is taken, even if residency has room", async () => {
  // Delivery refuses on this, not on a residency ceiling well above it. A pod
  // running MAX_CONCURRENT long jobs is full for new work, and saying otherwise
  // is how one replica held the queue while the others sat idle.
  const gate = new ExecutionGate(2, 20);
  assert.equal(gate.admissible(), true);
  await gate.acquire();
  assert.equal(gate.admissible(), true);
  await gate.acquire();
  assert.equal(gate.admissible(), false);
  gate.release();
  assert.equal(gate.admissible(), true);
});
