// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// Handing the execution slot back while a run waits.
//
// The ledger in tasks/run-phase.ts is what knows a run has stopped executing, so it
// is also what tells the gate. These pin the pairing, because the failure
// modes are silent and opposite: a park without an unpark leaks a slot until
// the pod is restarted, and an unpark without a park inflates the count until
// the pod runs more than its ceiling allows.
//
// Coverage:
//   P1 an ordinary wait parks and unparks exactly once
//   P2 nested waits are one stretch, so the slot changes hands once
//   P3 a wait that throws still gives the slot back
//   P4 an untracked run parks nothing
//   P5 reacquisition is awaited before the caller continues
//   P6 time spent reacquiring counts as waiting, not as executing
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { beginRun, endRun, phaseOf, setParkHooks, whileWaiting } from "../src/tasks/run-phase.js";
import { testRunKey } from "./support/run-identity.js";

const RUN_1 = testRunKey("run-1");
const NEVER_BEGAN = testRunKey("never-began");

interface Recorder {
  events: string[];
  release?: () => void;
  /** What the park reported, as the unpark was told it. */
  unparkedWith?: boolean;
}

/** Hooks that record what they were asked to do, optionally stalling unpark. */
function recordingHooks(stallUnpark = false, hadSlot = true): Recorder {
  const rec: Recorder = { events: [] };
  setParkHooks({
    park: () => { rec.events.push("park"); return hadSlot; },
    unpark: async (gaveSlotBack) => {
      rec.unparkedWith = gaveSlotBack;
      rec.events.push("unpark");
      if (!stallUnpark) return;
      await new Promise<void>((resolve) => { rec.release = resolve; });
      rec.events.push("unparked");
    },
  });
  return rec;
}

afterEach(() => { setParkHooks(null); });

describe("parking while a run waits", () => {
  it("P1 parks for the wait and takes a slot again afterwards", async () => {
    const rec = recordingHooks();
    beginRun(RUN_1);
    try {
      const seen = await whileWaiting(RUN_1, "approval", "timed+park", async () => {
        assert.deepEqual(rec.events, ["park"], "the slot is gone before the wait begins");
        return "approved";
      });
      assert.equal(seen, "approved");
      assert.deepEqual(rec.events, ["park", "unpark"]);
    } finally {
      endRun(RUN_1);
    }
  });

  it("P2 treats nested waits as one stretch of not executing", async () => {
    // An approval requested while a background command is outstanding is one
    // period of the run not running. Parking twice would decrement the pod's
    // count twice for a single run.
    const rec = recordingHooks();
    beginRun(RUN_1);
    try {
      await whileWaiting(RUN_1, "background_command", "timed+park", async () => {
        await whileWaiting(RUN_1, "approval", "timed+park", async () => {});
        assert.deepEqual(rec.events, ["park"], "the inner wait is already parked");
      });
      assert.deepEqual(rec.events, ["park", "unpark"]);
    } finally {
      endRun(RUN_1);
    }
  });

  it("P3 gives the slot back when the wait fails", async () => {
    // An approval that is denied, a background command that errors, an abort
    // mid-wait: all of them leave through the same throw.
    const rec = recordingHooks();
    beginRun(RUN_1);
    try {
      await assert.rejects(whileWaiting(RUN_1, "approval", "timed+park", async () => {
        throw new Error("denied");
      }));
      assert.deepEqual(rec.events, ["park", "unpark"]);
      assert.equal(phaseOf(RUN_1).phase, "executing");
    } finally {
      endRun(RUN_1);
    }
  });

  it("P4 parks nothing for a run nobody is tracking", async () => {
    // A key the ledger does not hold still runs the work and still parks
    // nothing. What it no longer does is pass unremarked: the miss is logged,
    // which run-identity-logs.test.ts asserts from a child process because
    // pino writes past every in-process seam.
    const rec = recordingHooks();
    await whileWaiting(NEVER_BEGAN, "approval", "timed+park", async () => {});
    await whileWaiting(undefined, "approval", "timed+park", async () => {});
    assert.deepEqual(rec.events, []);
  });

  it("P7 comes back holding exactly what it gave up", async () => {
    // A run that parks while holding no slot is given nothing back, so it must
    // not return holding one: that slot is never released, and the pod runs one
    // fewer task for the rest of its life. Not reachable today -- only the
    // delivery loop binds these hooks -- but it is invisible if it ever is.
    const rec = recordingHooks(false, false);
    beginRun(RUN_1);
    try {
      await whileWaiting(RUN_1, "approval", "timed+park", async () => {});
      assert.deepEqual(rec.events, ["park", "unpark"]);
      assert.equal(rec.unparkedWith, false,
        "the return has to know what the park managed, or it guesses in the costly direction");
    } finally {
      endRun(RUN_1);
    }
  });

  it("P5 does not continue until it holds a slot again", async () => {
    // The pod may have given the slot away during the wait, so coming back
    // can queue. Continuing anyway would put the pod over its ceiling, which
    // is the thing the gate exists to prevent.
    const rec = recordingHooks(true);
    beginRun(RUN_1);
    let resumed = false;
    const call = whileWaiting(RUN_1, "approval", "timed+park", async () => {}).then(() => { resumed = true; });

    await new Promise((r) => setImmediate(r));
    assert.equal(resumed, false, "still queueing for a slot");
    assert.deepEqual(rec.events, ["park", "unpark"]);

    rec.release?.();
    await call;
    assert.equal(resumed, true);
    endRun(RUN_1);
  });

  it("P6 counts the queue for a slot as waiting", async () => {
    // Otherwise a pod under load would report its runs as executing during
    // the very stretches they spend queueing, which inflates the fraction the
    // capacity decision is based on.
    const rec = recordingHooks(true);
    beginRun(RUN_1);
    const call = whileWaiting(RUN_1, "approval", "timed+park", async () => {});

    await new Promise((r) => setTimeout(r, 20));
    const during = phaseOf(RUN_1);
    assert.equal(during.phase, "waiting");
    assert.equal(during.waitReason, "approval");
    assert.ok(during.waitedMs >= 15, `expected the wait to be counted, got ${during.waitedMs}ms`);

    rec.release?.();
    await call;
    const after = phaseOf(RUN_1);
    assert.equal(after.phase, "executing");
    assert.equal(after.waits, 1, "one stretch of waiting, however long it took to come back");
    endRun(RUN_1);
  });
});
