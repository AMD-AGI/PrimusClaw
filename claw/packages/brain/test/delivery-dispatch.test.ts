// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// What happens to a delivery a busy pod is holding but has not started.
//
// This is the population the consumer loop used to forget. The loop awaited a
// slot in its own body, so it stopped at the first message it could not start
// and the ones the client had already prefetched sat behind it: delivered,
// their ack timers running, and nothing calling `working()` on them. They came
// back every ack_wait, spent a delivery each time, and reached the poison guard
// without ever having run -- reported to the user as a failed task, or, if a
// redelivered copy ran elsewhere first, executed twice.
//
// So these tests are mostly about a delivery that is waiting rather than one
// that is running, and the property they pin is that waiting is not silent.
//
// Coverage:
//   D1 a delivery is heartbeated from before it queues, not from when it starts
//   D2 several waiting deliveries are each heartbeated, which is the regression
//   D3 the wait does not hold up the deliveries behind it
//   D4 the heartbeat stops when the delivery is settled, however it ends
//   D5 a drain refuses a delivery without taking a slot
//   D6 a drain that arrives during the wait refuses it too
//   D7 a delivery that never took a slot does not release one
//   D8 a full execution gate hands surplus back, even when residency has room
//   D9 a delivery being handed back is not heartbeated first
//   D10 repeated refusals back off, rather than spending the budget flat out
//   D10b a throw between taking the room and the try does not keep the room
//   D10c a delivery with no budget left is kept rather than refused
//   D10d every delivery reaches the handler, so none is dropped past the guard
//   D10e a kept overflow still occupies room, so surplus stays refused
//   D11 room is returned when a delivery is settled
//   D12 a refusal that throws is reported, not left as an unhandled rejection
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  runDelivery, DeliveryResidency, DRAIN_NAK_MS, type DeliveryDeps,
} from "../src/delivery/dispatch.js";
import { ExecutionGate } from "../src/tasks/execution-gate.js";

/** A JetStream delivery, reduced to what this module touches. */
function fakeMsg(): { naks: number[]; working: number } {
  return { naks: [], working: 0 };
}

const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

interface Harness {
  deps: DeliveryDeps;
  gate: ExecutionGate;
  residency: DeliveryResidency;
  /** Per-message heartbeat state, by the order the messages were dispatched. */
  beating: Map<object, boolean>;
  errors: unknown[];
  finish(msg: object): void;
  draining: boolean;
}

function harness(
  opts: { max?: number; resident?: number; hold?: number; poison?: number } = {},
): Harness {
  const gate = new ExecutionGate(opts.max ?? 1, opts.resident ?? opts.max ?? 1);
  // Deliveries the pod may hold. Defaulted wide so the cases about slots are
  // not also cases about room; the cases about room set it.
  const residency = new DeliveryResidency(opts.hold ?? 64);
  const beating = new Map<object, boolean>();
  const running = new Map<object, () => void>();
  const errors: unknown[] = [];
  const h: Harness = {
    gate,
    residency,
    beating,
    errors,
    draining: false,
    finish(msg) {
      const done = running.get(msg);
      assert.ok(done, "no run to finish for this delivery");
      running.delete(msg);
      done();
    },
    deps: {
      keepAlive: (msg) => {
        beating.set(msg as object, true);
        return () => beating.set(msg as object, false);
      },
      gate,
      residency,
      canRefuse: (deliveries) => deliveries < (opts.poison ?? 1_000),
      surplusNakMs: (deliveries) => 1_000 * deliveries,
      isDraining: () => h.draining,
      handle: (msg) => new Promise<void>((resolve) => { running.set(msg as object, resolve); }),
      onError: (err) => { errors.push(err); },
    },
  };
  return h;
}

describe("runDelivery", () => {
  it("D1 heartbeats a delivery from before it waits for a slot", async () => {
    // The order is the point. Started after the wait, the heartbeat covers only
    // the part of the delay that was never the problem. poison: 1 so this is a
    // must-keep: a refuse-able surplus is NAK'd rather than queued.
    const h = harness({ max: 1, poison: 1 });
    const first = fakeMsg();
    const queued = fakeMsg();
    void runDelivery(first as never, h.deps);
    void runDelivery(queued as never, h.deps);
    await settle();

    assert.equal(h.gate.inflight, 1, "one running");
    assert.equal(h.gate.queued, 1, "one waiting for a slot");
    assert.equal(h.beating.get(queued), true,
      "the waiting delivery is the one the server would otherwise redeliver");
  });

  it("D2 heartbeats every delivery the pod is holding, not just the front one", async () => {
    // The shipped shape: three slots, six resident, so a saturated pod holds
    // two deliveries it has not started. Under the old loop neither existed as
    // far as the heartbeat was concerned.
    const h = harness({ max: 3, resident: 6, poison: 1 });
    const msgs = [fakeMsg(), fakeMsg(), fakeMsg(), fakeMsg(), fakeMsg(), fakeMsg()];
    for (const m of msgs) void runDelivery(m as never, h.deps);
    await settle();

    assert.equal(h.gate.inflight, 3);
    assert.equal(h.gate.queued, 3);
    assert.deepEqual(msgs.map((m) => h.beating.get(m)), [true, true, true, true, true, true]);
  });

  it("D3 lets the deliveries behind a waiting one through", async () => {
    // Nothing about a full pod should stop the loop reaching the message after
    // the one it cannot start; that reach is what the heartbeat depends on.
    const h = harness({ max: 1, poison: 1 });
    const running = fakeMsg();
    const waiting = fakeMsg();
    const behind = fakeMsg();
    void runDelivery(running as never, h.deps);
    void runDelivery(waiting as never, h.deps);
    void runDelivery(behind as never, h.deps);
    await settle();

    assert.equal(h.gate.queued, 2, "both are queued, rather than one being unreached");
    h.finish(running);
    await settle();
    assert.equal(h.gate.inflight, 1);
    assert.equal(h.beating.get(behind), true);
  });

  it("D4 stops the heartbeat and hands the slot back, whether the run ends or throws", async () => {
    const h = harness({ max: 1 });
    const ok = fakeMsg();
    void runDelivery(ok as never, h.deps);
    await settle();
    h.finish(ok);
    await settle();
    assert.equal(h.beating.get(ok), false);
    assert.equal(h.gate.inflight, 0, "a slot never handed back is a slot lost for good");

    const boom = fakeMsg();
    const failing: DeliveryDeps = {
      ...h.deps,
      handle: async () => { throw new Error("run blew up"); },
    };
    await runDelivery(boom as never, failing);
    assert.equal(h.beating.get(boom), false);
    assert.equal(h.gate.inflight, 0);
    assert.equal(h.errors.length, 1, "and the failure is reported rather than swallowed");
  });

  it("D5 refuses a delivery outright while the pod is draining", async () => {
    const h = harness({ max: 1 });
    h.draining = true;
    const msg = fakeMsg();
    await runDelivery({ nak: (ms: number) => msg.naks.push(ms) } as never, h.deps);

    assert.deepEqual(msg.naks, [DRAIN_NAK_MS], "another replica can take it now");
    assert.equal(h.gate.inflight, 0);
  });

  it("D6 refuses a delivery the drain overtook while it waited", async () => {
    // The wait is a whole run long, so the answer from before it is stale.
    // Starting here means starting after the SIGTERM sweep over the abort
    // registry: the run is never told to checkpoint and is hard-killed at the
    // end of the grace period with nothing written.
    const h = harness({ max: 1, poison: 1 });
    const running = fakeMsg();
    const waiting = fakeMsg();
    const waitingMsg = { nak: (ms: number) => waiting.naks.push(ms) };
    void runDelivery(running as never, h.deps);
    void runDelivery(waitingMsg as never, h.deps);
    await settle();

    h.draining = true;
    h.finish(running);
    await settle();

    assert.deepEqual(waiting.naks, [DRAIN_NAK_MS]);
    assert.equal(h.gate.inflight, 0, "and the slot it briefly took goes back");
  });

  it("D7 does not release a slot it never took", async () => {
    // A release without an acquire decrements the count on behalf of a run that
    // is still using one, and the pod over-admits by one for the rest of its
    // life -- the kind of arithmetic error that looks like a capacity problem
    // months later.
    const h = harness({ max: 1 });
    const holder = fakeMsg();
    void runDelivery(holder as never, h.deps);
    await settle();
    assert.equal(h.gate.inflight, 1);

    const refused: DeliveryDeps = {
      ...h.deps,
      gate: {
        acquire: async () => { throw new Error("gate unavailable"); },
        release: () => h.gate.release(),
        admissible: () => h.gate.admissible(),
      },
    };
    await runDelivery(fakeMsg() as never, refused);
    assert.equal(h.gate.inflight, 1, "the running delivery still holds its slot");
  });

  it("D8 gives back a delivery the execution gate cannot start", async () => {
    // Residency used to be the refuse condition, sized at MAX_RESIDENT +
    // MAX_CONCURRENT. A pod at MAX_CONCURRENT long jobs never reached it, so
    // surplus sat on acquire() with a heartbeat and idle replicas saw nothing.
    // The gate being full is the question that matters; residency having room
    // is not a reason to keep the message.
    const h = harness({ max: 1, resident: 20, hold: 30 });
    void runDelivery(fakeMsg() as never, h.deps);
    await settle();

    const surplus = fakeMsg();
    await runDelivery({ nak: (ms: number) => surplus.naks.push(ms) } as never, h.deps);

    assert.equal(h.gate.inflight, 1, "the running delivery still holds the slot");
    assert.equal(h.gate.queued, 0, "surplus is not parked on acquire()");
    assert.equal(h.residency.holding, 1, "and is not counted as held");
    assert.equal(surplus.naks.length, 1, "it goes back to the fleet");
  });

  it("D9 does not heartbeat a delivery it is handing back", async () => {
    // Telling the server it is being worked on is a claim on it, and the point
    // of the refusal is to drop the claim. A heartbeat here would hold the
    // message for a pod that has already refused it.
    const h = harness({ max: 1, hold: 1 });
    void runDelivery(fakeMsg() as never, h.deps);
    await settle();

    const surplus = { nak: () => {} };
    await runDelivery(surplus as never, h.deps);
    assert.equal(h.beating.has(surplus), false);
  });

  it("D10 backs the refusal off, rather than spending the budget flat out", async () => {
    // A refusal spends one of the delivery budget, so a flat retry walks a
    // healthy task towards the poison guard while every pod is merely busy.
    // The curve is the one a refusal for a held lock already uses.
    const h = harness({ max: 1, hold: 1 });
    void runDelivery(fakeMsg() as never, h.deps);
    await settle();

    const delays: number[] = [];
    for (const delivery of [1, 4]) {
      await runDelivery(
        { nak: (ms: number) => delays.push(ms), info: { deliveryCount: delivery } } as never,
        h.deps,
      );
    }
    assert.ok(delays[1] > delays[0], `a repeat refusal waits longer: ${delays.join(" then ")}`);
  });

  it("D10d a delivery refused past its allowance reaches the handler anyway", async () => {
    // The poison guard lives inside the handler, past the admission check. A
    // message refused on every delivery would never reach it: the stream would
    // stop redelivering at max_deliver with no event emitted at all, and the
    // session left running forever -- which is the failure the guard exists to
    // prevent, reached by going around it. Whatever else the ceiling does, it
    // has to let every message through eventually.
    const h = harness({ max: 1, hold: 1, poison: 3 });
    const holder = fakeMsg();
    void runDelivery(holder as never, h.deps);
    await settle();

    const late = { naks: [] as number[] };
    const msg = {
      nak: (ms: number) => late.naks.push(ms),
      working: 0,
      info: { deliveryCount: 3 },
    };
    void runDelivery(msg as never, h.deps);
    await settle();
    assert.deepEqual(late.naks, [], "past the allowance it is kept, not handed back");

    h.finish(holder);
    await settle();
    assert.equal(h.gate.inflight, 1, "and it runs, which is how it reaches the guard");
  });

  it("D10c keeps a delivery that cannot afford to be handed back", async () => {
    // Refusing spends a delivery, and a message that runs out is resolved as a
    // failed task and reported to the user, having never run. On the shipped
    // budget the refusals alone reach that in about twenty minutes -- shorter
    // than one long agent turn, so a fleet where every pod is busy for the
    // length of a single turn would report healthy work as failed.
    //
    // The ceiling is about latency. Losing the work is not a price worth
    // paying for it, so the last deliveries are held over the ceiling instead.
    // `poison: 5` is the refusal cut-off, so delivery 5 is past it -- the
    // point being that the redelivery a refusal causes can never be the one
    // the guard fires on.
    const h = harness({ max: 1, hold: 1, poison: 5 });
    void runDelivery(fakeMsg() as never, h.deps);
    await settle();

    const late = { naks: [] as number[], working: 0, info: { deliveryCount: 5 } };
    void runDelivery({ ...late, nak: (ms: number) => late.naks.push(ms) } as never, h.deps);
    await settle();

    assert.deepEqual(late.naks, [], "handing this one back is what loses it");
    assert.equal(h.gate.queued, 1, "it waits for a slot on the pod that has it");
    assert.equal(h.residency.holding, 2, "and the overflow is counted, not held in secret");
  });

  it("D10e a kept overflow still occupies room, so surplus stays refused", async () => {
    // The ceiling used to count only admit-under-max. A must-keep then sat
    // outside that number, so finishing the in-ceiling run made the pod look
    // empty and surplus was taken on top of the overflow -- the stall the
    // ceiling exists to prevent, reopened on the path that is supposed to
    // close it.
    const h = harness({ max: 1, hold: 1, poison: 5 });
    const holder = fakeMsg();
    void runDelivery(holder as never, h.deps);
    await settle();

    const overflow = { naks: [] as number[], working: 0, info: { deliveryCount: 5 } };
    void runDelivery({ ...overflow, nak: (ms: number) => overflow.naks.push(ms) } as never, h.deps);
    await settle();
    assert.equal(h.residency.holding, 2);

    h.finish(holder);
    await settle();
    assert.equal(h.residency.holding, 1, "finishing the in-ceiling run does not drop the overflow");

    const surplus = fakeMsg();
    await runDelivery(
      { nak: (ms: number) => surplus.naks.push(ms), info: { deliveryCount: 1 } } as never,
      h.deps,
    );
    assert.equal(surplus.naks.length, 1, "surplus still goes to the fleet while the overflow is held");
  });

  it("D10b gives the room back even when starting the heartbeat throws", async () => {
    // The place is taken before the heartbeat is started, so this is the throw
    // that falls between them, and what makes it survivable is that both sit
    // inside the guarded region: a place held for a delivery that is gone is
    // never given back, and MAX_RESIDENT of those is a pod that accepts nothing
    // and says nothing about it.
    const h = harness({ max: 1, hold: 1 });
    const broken: DeliveryDeps = {
      ...h.deps,
      keepAlive: () => { throw new Error("timer refused"); },
    };
    await runDelivery(fakeMsg() as never, broken);
    assert.equal(h.residency.holding, 0);
    assert.equal(h.errors.length, 1, "and it is reported rather than swallowed");

    const next = fakeMsg();
    void runDelivery(next as never, h.deps);
    await settle();
    assert.equal(h.beating.get(next), true, "the pod can still take work");
  });

  it("D11 takes back the room a finished delivery was using", async () => {
    const h = harness({ max: 1, hold: 1 });
    const first = fakeMsg();
    void runDelivery(first as never, h.deps);
    await settle();
    assert.equal(h.residency.holding, 1);

    h.finish(first);
    await settle();
    assert.equal(h.residency.holding, 0, "a pod that never lets go admits nothing again");

    const next = fakeMsg();
    void runDelivery(next as never, h.deps);
    await settle();
    assert.equal(h.beating.get(next), true);
  });

  it("D12 reports a refusal that throws instead of leaving it unhandled", async () => {
    // Nobody awaits runDelivery, so a rejection out of it is an unhandled one,
    // and under Node's default that ends the process. `nak` on a connection
    // that is already closing throws exactly there -- during the drain, the one
    // moment when every run on the pod is trying to checkpoint.
    const draining = harness({ max: 1, hold: 1 });
    draining.draining = true;
    const closing = { nak: () => { throw new Error("connection closed"); } };

    await runDelivery(closing as never, draining.deps);

    assert.equal(draining.errors.length, 1, "the drain refusal has to leave through onError");
    assert.equal(draining.residency.holding, 0, "and nothing may be held on its behalf");

    // The same throw on the refusal a merely-full pod makes, which is reached
    // from a different place and used to be equally unguarded.
    const full = harness({ max: 1, hold: 1 });
    void runDelivery(fakeMsg() as never, full.deps);
    await settle();

    await runDelivery(
      { nak: () => { throw new Error("connection closed"); }, info: { deliveryCount: 1 } } as never,
      full.deps,
    );

    assert.equal(full.errors.length, 1);
    assert.equal(full.residency.holding, 1, "only the delivery that is running holds room");
  });

  it("D13 acks a doorbell when the gate is full, rather than keeping it", async () => {
    // A doorbell is a wakeup, not the work. Keeping it on a full pod is the
    // stall this path exists to close: idle replicas never see the row, and
    // the message sits heartbeating until the budget is gone. Acking it lets
    // claim-next on a neighbour take the run.
    const h = harness({ max: 1, hold: 30 });
    void runDelivery(fakeMsg() as never, h.deps);
    await settle();

    const surplus = { acks: 0, naks: 0, wakeupCalls: 0 };
    await runDelivery(
      {
        ack: () => { surplus.acks += 1; },
        nak: () => { surplus.naks += 1; },
        info: { deliveryCount: 1 },
      } as never,
      { ...h.deps, isWakeup: () => { surplus.wakeupCalls += 1; return true; } },
    );
    assert.equal(surplus.acks, 1, "the wakeup is settled so it will not be redelivered");
    assert.equal(surplus.naks, 0);
    assert.equal(surplus.wakeupCalls, 1, "the payload is inspected once, then the verdict is reused");
    assert.equal(h.gate.queued, 0, "and is not parked on acquire()");
    assert.equal(h.residency.holding, 1, "only the running delivery holds room");
  });
});
