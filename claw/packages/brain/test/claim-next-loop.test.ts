// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  runClaimNextCycle,
  startClaimNextLoop,
  type ClaimNextLoopDeps,
} from "../src/delivery/claim-next-loop.js";
import { ExecutionGate } from "../src/tasks/execution-gate.js";
import type { ExecuteRequest } from "@claw/protocol";

function deps(overrides: Partial<ClaimNextLoopDeps> = {}): ClaimNextLoopDeps & { handled: ExecuteRequest[] } {
  const gate = new ExecutionGate(1, 1);
  const handled: ExecuteRequest[] = [];
  const d: ClaimNextLoopDeps & { handled: ExecuteRequest[] } = {
    enabled: true,
    idleMs: 10,
    isDraining: () => false,
    isShuttingDown: () => false,
    gate,
    claimNext: async () => null,
    handle: async (req) => { handled.push(req); },
    onError: () => {},
    handled,
    ...overrides,
  };
  return d;
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

/**
 * Stands in for the loop's idle sleep so a background loop becomes steppable.
 *
 * The loop parks in `sleep` on every cycle that did not claim, so handing it a
 * promise the test resolves is the only place a test can get between two
 * iterations.
 */
function idleClock() {
  const parked: Array<() => void> = [];
  let sleeps = 0;
  return {
    get sleeps(): number {
      return sleeps;
    },
    sleep: (): Promise<void> =>
      new Promise<void>((resolve) => {
        sleeps += 1;
        parked.push(resolve);
      }),
    /** Wake every parked cycle and let it run on to its next park. */
    async step(): Promise<void> {
      for (const resume of parked.splice(0)) resume();
      // A cycle awaits the gate and the claim before parking again, so one
      // microtask drain is not enough to reach a settled state.
      for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
    },
  };
}

describe("runClaimNextCycle", () => {
  it("does not take a slot when the gate is already full", async () => {
    const d = deps();
    await d.gate.acquire();
    assert.equal(await runClaimNextCycle(d), "idle");
    let claimed = 0;
    d.claimNext = async () => { claimed += 1; return null; };
    assert.equal(await runClaimNextCycle(d), "idle");
    assert.equal(claimed, 0, "a full pod must not poll while it cannot run what it would get");
  });

  it("releases the slot when the queue is empty so a doorbell can still start", async () => {
    const d = deps();
    assert.equal(await runClaimNextCycle(d), "idle");
    assert.equal(d.gate.inflight, 0);
    assert.equal(d.gate.admissible(), true);
  });

  it("runs a claimed request while holding the slot, then hands it back", async () => {
    const d = deps();
    const req = { session_id: "s-1", task_id: "ktsk_1" } as ExecuteRequest;
    d.claimNext = async () => req;
    assert.equal(await runClaimNextCycle(d), "ran");
    await flush();
    assert.deepEqual(d.handled, [req]);
    assert.equal(d.gate.inflight, 0);
  });

  it("gives the slot back if drain starts after the acquire", async () => {
    const d = deps();
    let draining = false;
    d.isDraining = () => draining;
    const inner = d.gate;
    d.gate = {
      admissible: () => inner.admissible(),
      acquire: async () => {
        await inner.acquire();
        draining = true;
      },
      release: () => inner.release(),
    };
    d.claimNext = async () => ({ session_id: "s-1" } as ExecuteRequest);
    assert.equal(await runClaimNextCycle(d), "draining");
    assert.equal(d.handled.length, 0);
    assert.equal(inner.inflight, 0);
  });

  it("releases the slot if the claimed run throws", async () => {
    const d = deps();
    const errors: unknown[] = [];
    d.onError = (err) => { errors.push(err); };
    d.claimNext = async () => ({ session_id: "s-1", task_id: "ktsk_1" } as ExecuteRequest);
    d.handle = async () => { throw new Error("engine boom"); };
    assert.equal(await runClaimNextCycle(d), "ran");
    await flush();
    assert.match(String(errors[0]), /engine boom/);
    assert.equal(d.gate.inflight, 0);
    assert.equal(d.gate.admissible(), true);
  });

  it("starts another claim while the first run is still going", async () => {
    const gate = new ExecutionGate(2, 2);
    const started: string[] = [];
    const blockers: Array<() => void> = [];
    const d: ClaimNextLoopDeps = {
      enabled: true,
      idleMs: 10,
      isDraining: () => false,
      isShuttingDown: () => false,
      gate,
      claimNext: async () => ({
        session_id: "s-1",
        task_id: `ktsk_${started.length + 1}`,
      } as ExecuteRequest),
      handle: (req) => {
        started.push(req.task_id ?? "");
        return new Promise<void>((resolve) => { blockers.push(resolve); });
      },
      onError: () => {},
    };
    assert.equal(await runClaimNextCycle(d), "ran");
    assert.equal(started.length, 1);
    assert.equal(gate.inflight, 1);
    assert.equal(await runClaimNextCycle(d), "ran");
    assert.deepEqual(started, ["ktsk_1", "ktsk_2"]);
    assert.equal(gate.inflight, 2);
    for (const release of blockers) release();
  });
});

/**
 * The loop's exit condition is shutdown, never the combined drain predicate.
 *
 * It was the latter, from when a drain could only be entered. The version drain
 * is reversible now, and this loop is started once from main(), so a drain that
 * ended the loop ended claim-next for the life of the pod -- while deliveries,
 * which re-read the same flag per message, resumed as intended. The boot case
 * is the sharp one: watchVersionDrain() replays the KV key before the loop
 * starts, so a pod booting on the previous upgrade's tag entered `while
 * (!isDraining())` already false and never ran a single cycle.
 */
describe("startClaimNextLoop", () => {
  it("claims again once a version drain is released", async () => {
    let draining = true;
    let claims = 0;
    const clock = idleClock();
    const d = deps({
      isDraining: () => draining,
      claimNext: async () => {
        claims += 1;
        return null;
      },
      sleep: clock.sleep,
    });

    startClaimNextLoop(d);
    await clock.step();
    assert.equal(claims, 0, "a draining pod must not claim");
    assert.ok(clock.sleeps >= 1, "a drained cycle must park, not exit");

    draining = false;
    await clock.step();
    assert.ok(claims >= 1, "claim-next must resume when the drain is released");
  });

  it("never claims while shutting down", async () => {
    let claims = 0;
    const clock = idleClock();
    const d = deps({
      isShuttingDown: () => true,
      claimNext: async () => {
        claims += 1;
        return null;
      },
      sleep: clock.sleep,
    });

    startClaimNextLoop(d);
    await clock.step();
    assert.equal(claims, 0);
    assert.equal(clock.sleeps, 0, "shutdown must not even park; the loop is over");
  });

  it("ends the loop when shutdown begins between cycles", async () => {
    let shuttingDown = false;
    const clock = idleClock();
    const d = deps({ isShuttingDown: () => shuttingDown, sleep: clock.sleep });

    startClaimNextLoop(d);
    await clock.step();
    assert.ok(clock.sleeps >= 1, "precondition: the loop is parked and alive");

    shuttingDown = true;
    await clock.step();
    const settled = clock.sleeps;
    await clock.step();
    assert.equal(clock.sleeps, settled, "a shut-down loop must not park again");
  });

  it("stays out entirely when claim-next is disabled", async () => {
    const clock = idleClock();
    let claims = 0;
    const d = deps({
      enabled: false,
      claimNext: async () => {
        claims += 1;
        return null;
      },
      sleep: clock.sleep,
    });

    startClaimNextLoop(d);
    await clock.step();
    assert.equal(claims, 0);
    assert.equal(clock.sleeps, 0);
  });
});
