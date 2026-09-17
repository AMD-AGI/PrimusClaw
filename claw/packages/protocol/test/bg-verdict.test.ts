// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * One definition of what a background-work verdict is, and when it may be
 * believed.
 *
 * Two services read this now: Brain's keepalive sweep, which decides whether to
 * keep pinging an idle sandbox, and the API's orphan-handle sweep, which
 * decides whether to stop a workload whose DAG is over. They reach opposite
 * actions from the same bytes, so a second copy of the rule that drifted from
 * the first would not read as a disagreement -- it would read as one service
 * stopping a sandbox the other is deliberately holding, which is precisely the
 * defect the shared reader exists to prevent. A third party writes the fields:
 * `applyRunEndedIdleFields`, which opens a new idle period and has to clear the
 * whole verdict.
 *
 * Coverage:
 *   V1 a verdict measured in this idle period is believed, with its count
 *   V2 a verdict from the previous idle period is not
 *   V3 nor is an idle one whose witness revision belongs to another period
 *   V4 nor one older than the verdict lifetime
 *   V5 an entry with no idle period open on it can carry no usable verdict
 *   V6 opening a new idle period destroys the verdict outright
 *   V7 neither reader carries a private copy of the rule
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  applyRunEndedIdleFields, BG_VERDICT_TTL_MS, SHARED_VERDICT_FIELDS, usableSharedVerdict,
  type SharedVerdictFields,
} from "../src/index.js";

const NOW = 1_700_000_000_000;
const IDLE_SINCE = NOW - 60_000;

/** A parked handle carrying a verdict measured inside its own idle period. */
function entry(over: Partial<SharedVerdictFields> = {}): SharedVerdictFields {
  return {
    idleSince: IDLE_SINCE,
    idleEpoch: IDLE_SINCE,
    idleRev: 7,
    bgCheckedAt: NOW - 1_000,
    bgRunning: 2,
    bgEpoch: IDLE_SINCE,
    bgIdleSince: IDLE_SINCE,
    bgIdleRev: 7,
    bgRev: 6,
    ...over,
  };
}

test("V1 a verdict measured in this idle period is believed, with its count", () => {
  assert.deepEqual(
    usableSharedVerdict(entry(), NOW),
    { at: NOW - 1_000, state: "running", running: 2 },
    "the shell count travels with the verdict: a caller holding a sandbox open "
    + "should be able to say how many processes it is holding it for",
  );
});

test("V2 a verdict from the previous idle period is not", () => {
  // The sandbox was taken for another task and idled again. `bgRunning` still
  // says 2, and 2 is a fact about a period that has ended.
  const reopened = entry({ idleSince: NOW - 10, idleEpoch: NOW - 10, idleRev: 9 });
  assert.equal(usableSharedVerdict(reopened, NOW), null);
});

test("V3 nor is an idle one whose witness revision belongs to another period", () => {
  // Two idle periods can share a millisecond; they cannot share a revision. The
  // strict both-witness test guards the `idle` answer, because that is the only
  // one that licenses destroying anything -- an idle verdict believed about the
  // wrong period is a sandbox stopped with shells in it.
  const sameMs = entry({ bgRunning: 0, idleRev: 9 });
  assert.equal(usableSharedVerdict(sameMs, NOW), null);

  // `running` deliberately keeps the older, weaker rule (`at` at or after the
  // stamp): believing a stale `running` costs a ping, or here a deferred reap,
  // and disbelieving a current one costs a sandbox. The asymmetry is the point,
  // not an oversight, so it is asserted rather than left to drift.
  assert.equal(usableSharedVerdict(entry({ idleRev: 9 }), NOW)?.state, "running");
});

test("V4 nor one older than the verdict lifetime", () => {
  const stale = entry({ bgCheckedAt: NOW - BG_VERDICT_TTL_MS });
  assert.equal(usableSharedVerdict(stale, NOW), null);
  const inside = entry({ bgCheckedAt: NOW - BG_VERDICT_TTL_MS + 1 });
  assert.equal(usableSharedVerdict(inside, NOW)?.state, "running");
});

test("V5 an entry with no idle period open on it can carry no usable verdict", () => {
  // Load bearing beyond this function: it is why the API's sweep does not wait
  // for a verdict on such an entry. Waiting would be waiting for something this
  // rule rejects by its first line, however long it waited.
  const neverParked = entry({ idleSince: undefined });
  assert.equal(usableSharedVerdict(neverParked, NOW), null);
});

test("V6 opening a new idle period destroys the verdict outright", () => {
  // The writer and the reader share the field list rather than each keeping
  // their own. A field left behind here is a measurement of the period that
  // just ended, republished as if it were about the one just opened.
  // Pinned literally rather than by iterating the list the writer uses, so
  // that dropping a field from the list fails here instead of quietly
  // shortening what both sides check.
  assert.deepEqual(
    [...SHARED_VERDICT_FIELDS].sort(),
    ["bgCheckedAt", "bgEpoch", "bgIdleRev", "bgIdleSince", "bgRev", "bgRunning"],
    "a verdict is these six fields; a writer that clears fewer republishes one",
  );
  const info: Record<string, unknown> = { ...entry() };
  applyRunEndedIdleFields(info, NOW, 11);

  for (const field of SHARED_VERDICT_FIELDS) {
    assert.equal(info[field], undefined, `${field} survived the new idle period`);
  }
  assert.equal(
    usableSharedVerdict(info as SharedVerdictFields, NOW), null,
    "and nothing about the entry is readable as a verdict afterwards",
  );
});

test("V7 neither reader carries a private copy of the rule", () => {
  // Not a style check. The two readers act in opposite directions on the same
  // answer, so a private copy in either is a sandbox one service stops while
  // the other is holding it -- and nothing about two definitions that agree
  // today reports the day they stop agreeing.
  const here = fileURLToPath(new URL(".", import.meta.url));
  for (const rel of [
    "../../brain/src/sandbox/keepalive.ts",
    "../../api/src/tasks/sandbox-stopper.ts",
  ]) {
    const src = readFileSync(here + rel, "utf8");
    assert.match(
      src, /usableSharedVerdict/,
      `${rel} should be reading the shared verdict`,
    );
    assert.doesNotMatch(
      src, /function\s+usableSharedVerdict/,
      `${rel} defines its own usableSharedVerdict; import it from @claw/protocol instead`,
    );
    assert.match(
      src, /from "@claw\/protocol"/,
      `${rel} should import the rule rather than restate it`,
    );
  }
});
