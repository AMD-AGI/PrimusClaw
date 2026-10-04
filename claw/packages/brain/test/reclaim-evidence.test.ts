// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// What a run of destructive jobs-probe readings is bound to. Each reading only
// adds to a streak about the same idle period and, for a replacement, the same
// new identity; anything else starts a new run.

import test from "node:test";
import assert from "node:assert/strict";
import {
  applyObservation, reclaimDecision,
  type ReclaimEvidenceFields, type ReclaimStreak,
} from "../src/sandbox/reclaim-evidence.js";

const SPACING = 30_000;
const SWEEP = 60_000;
const CFG = { sweeps: 3, quietMs: 300_000 };
const T0 = 10_000_000;

function streak(patch: Partial<ReclaimStreak>): ReclaimStreak {
  return {
    reason: "idle_empty",
    identity: "id-1",
    idleEpoch: 1,
    count: 2,
    firstAt: T0 - SWEEP,
    lastAt: T0,
    counts: [0, 0],
    ...patch,
  };
}

test("a reading in a new idle period starts a new run", () => {
  const prev: ReclaimEvidenceFields = { reclaimStreak: streak({ idleEpoch: 1 }) };
  const now = T0 + SWEEP;
  const next = applyObservation(prev, { kind: "count", count: 0 }, {
    identity: "id-1", idleEpoch: 2, now, spacingMs: SPACING,
  });
  assert.equal(next.reclaimStreak?.count, 1, "two zeros from the old idle period must not carry over");
  assert.equal(next.reclaimStreak?.idleEpoch, 2);
  assert.deepEqual(
    reclaimDecision(next, "idle_empty", { identity: "id-1", idleEpoch: 2, now }, CFG),
    { allowed: false, hold: "awaiting_confirmation" },
  );
});

test("a reading in the same idle period continues the run", () => {
  const prev: ReclaimEvidenceFields = { reclaimStreak: streak({ idleEpoch: 1 }) };
  const next = applyObservation(prev, { kind: "count", count: 0 }, {
    identity: "id-1", idleEpoch: 1, now: T0 + SWEEP, spacingMs: SPACING,
  });
  assert.equal(next.reclaimStreak?.count, 3, "sanity: the binding is what separates the two");
});

for (const [field, value, prevPatch] of [
  ["instanceIdAfter", "envd-3", { podUidAfter: "pod-1", instanceIdAfter: "envd-2" }],
  ["podUidAfter", "pod-3", { podUidAfter: "pod-2", instanceIdAfter: "envd-1" }],
] as const) {
  test(`a replaced reading from a different ${field} starts a new run`, () => {
    const prev: ReclaimEvidenceFields = {
      reclaimStreak: streak({ reason: "instance_replaced", ...prevPatch }),
    };
    const obs = { kind: "replaced" as const, count: 0, ...prevPatch, [field]: value };
    const now = T0 + SWEEP;
    const next = applyObservation(prev, obs, { identity: "id-1", idleEpoch: 1, now, spacingMs: SPACING });
    assert.equal(next.reclaimStreak?.count, 1, "a run about another identity must not carry over");
    assert.equal(next.reclaimStreak?.[field], value);
    assert.deepEqual(
      reclaimDecision(next, "instance_replaced", { identity: "id-1", idleEpoch: 1, now }, CFG),
      { allowed: false, hold: "awaiting_confirmation" },
    );

    const same = applyObservation(prev, { kind: "replaced", count: 0, ...prevPatch }, {
      identity: "id-1", idleEpoch: 1, now, spacingMs: SPACING,
    });
    assert.equal(same.reclaimStreak?.count, 3, "sanity: the same identity continues the run");
  });
}

test("a replaced reading with live processes ends the run and opens the quiet window", () => {
  const prev: ReclaimEvidenceFields = {
    reclaimStreak: streak({ reason: "instance_replaced", instanceIdAfter: "envd-2" }),
  };
  const now = T0 + SWEEP;
  const next = applyObservation(prev, { kind: "replaced", count: 250, instanceIdAfter: "envd-2" }, {
    identity: "id-1", idleEpoch: 1, now, spacingMs: SPACING,
  });
  assert.equal(next.reclaimStreak, undefined);
  assert.equal(next.lastPositiveCountAt, now);
});

test("a replaced reading with no processes still counts toward confirmation", () => {
  const prev: ReclaimEvidenceFields = {
    reclaimStreak: streak({ reason: "instance_replaced", instanceIdAfter: "envd-2" }),
  };
  const now = T0 + SWEEP;
  const next = applyObservation(prev, { kind: "replaced", count: 0, instanceIdAfter: "envd-2" }, {
    identity: "id-1", idleEpoch: 1, now, spacingMs: SPACING,
  });
  assert.equal(next.reclaimStreak?.count, 3);
  assert.deepEqual(
    reclaimDecision(next, "instance_replaced", { identity: "id-1", idleEpoch: 1, now }, CFG),
    { allowed: true },
  );
});
