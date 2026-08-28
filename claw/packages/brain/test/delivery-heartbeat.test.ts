// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// Telling the server a delivery is still being worked on.
//
// This is what let ack_wait come down from ten minutes to two. Before it, the
// only thing stopping a redelivery was ack_wait being longer than anything
// that could happen to a held message -- including a message queueing behind
// three long runs for a slot it had not been given yet. Two copies of one task
// then race for the same lock, and the loser burns a delivery from a budget
// that exists to catch genuinely stuck work.
//
// Coverage:
//   H1 beats until stopped
//   H2 stopping is final, and stopping twice is not an error
//   H3 a throw from a settled message does not kill the interval or the caller
//   H4 the timer does not hold the process open
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { keepDeliveryAlive } from "../src/delivery/heartbeat.js";

/**
 * Take the heartbeat's timer over, so the test decides when it beats.
 *
 * What is worth asserting here is a count of beats, and counting them over a
 * wall-clock wait makes every one of these a race against the machine:
 * millisecond intervals slip whenever the suite shares a host with anything
 * else, and the failure then reads as a heartbeat that stopped rather than as a
 * host that was busy. Firing by hand keeps the subject the heartbeat. The tests
 * that use it stay synchronous, so the interception never spans an await and no
 * timer but this one can be caught by it.
 */
function captureTimer() {
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const seen = { everyMs: undefined as number | undefined, unrefd: false, cleared: false };
  const handle = { unref: () => { seen.unrefd = true; return handle; } };
  let beat: (() => void) | undefined;
  globalThis.setInterval = ((fn: () => void, ms?: number) => {
    beat = fn;
    seen.everyMs = ms;
    return handle;
  }) as unknown as typeof globalThis.setInterval;
  globalThis.clearInterval = ((timer: unknown) => {
    if (timer === handle) seen.cleared = true;
  }) as unknown as typeof globalThis.clearInterval;
  return {
    seen,
    fire(times: number): void {
      for (let i = 0; i < times; i++) {
        if (!beat) throw new Error("the heartbeat registered no interval to fire");
        beat();
      }
    },
    restore(): void {
      globalThis.setInterval = realSetInterval;
      globalThis.clearInterval = realClearInterval;
    },
  };
}

describe("keepDeliveryAlive", () => {
  it("H1 keeps telling the server the message is in progress", () => {
    const timer = captureTimer();
    try {
      let beats = 0;
      keepDeliveryAlive({ working: () => { beats++; } }, 5);
      timer.fire(3);
      assert.equal(beats, 3, "every beat has to reach the message");
      assert.equal(timer.seen.everyMs, 5, "and at the interval the caller asked for");
    } finally {
      timer.restore();
    }
  });

  it("H2 stops when told, and tolerates being told twice", () => {
    const timer = captureTimer();
    try {
      const stop = keepDeliveryAlive({ working: () => {} }, 5);
      stop();
      assert.equal(
        timer.seen.cleared, true,
        "a stopped heartbeat must not keep extending the ack deadline",
      );
      stop();
    } finally {
      timer.restore();
    }
  });

  it("H3 survives a message that has already been settled", () => {
    // Acking and then extending is a race the caller cannot fully close: the
    // run finishes on one turn of the loop and the interval fires on the
    // next. The library throws there, and an unhandled throw inside a timer
    // takes the pod down with it -- so the throw has to stay inside the beat,
    // which is what firing by hand asserts: `fire` would rethrow it here.
    const timer = captureTimer();
    try {
      let beats = 0;
      keepDeliveryAlive({
        working: () => { beats++; throw new Error("message already acked"); },
      }, 5);
      timer.fire(2);
      assert.equal(beats, 2, "the interval must survive the first throw to fire again");
    } finally {
      timer.restore();
    }
  });

  it("H4 does not keep the process alive on its own", () => {
    // A leaked heartbeat that also pinned the event loop would turn a missing
    // stop() into a pod that never exits, which is a worse symptom than the
    // redelivery it was preventing -- and on shutdown it would hold the
    // drain open past the grace period.
    const timer = captureTimer();
    try {
      keepDeliveryAlive({ working: () => {} }, 5)();
    } finally {
      timer.restore();
    }
    assert.equal(timer.seen.unrefd, true);
  });
});
