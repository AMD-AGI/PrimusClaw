// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Two questions, two grains, and the line between them.
 *
 * Reuse across the tasks of a session is a feature: the next message takes the
 * sandbox the last one left warm. Attribution is a different question -- whose
 * ending does this container's death explain -- and answering it from
 * session-grained or task-grained storage is what produced a run of defects on
 * this branch, each found only when it broke.
 *
 * The fix records who HOLDS the sandbox, re-stamped when it changes hands. The
 * failure mode that makes the distinction worth a file of its own is the
 * opposite one: record the MINTER instead, and a task that legitimately reused
 * another's container can no longer report its own ending.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { attributionOf, needsRestamp } from "../src/sandbox/attribution.js";

const A = { taskId: "task-a", attemptId: "attempt-a1" };
const B = { taskId: "task-b", attemptId: "attempt-b1" };

test("a run reports the sandbox it holds", () => {
  assert.equal(attributionOf({ taskId: A.taskId, attemptId: A.attemptId }, A), "mine");
});

test("a reuser holds it once it changes hands, and reports its own ending", () => {
  // The case that rules out recording the minter. Task A mints the container;
  // task B of the same session reuses it; the container dies under B. That
  // death is B's ending, and B must be able to say so.
  const entry = { taskId: A.taskId, attemptId: A.attemptId };
  assert.equal(attributionOf(entry, B), "other", "before the hand-over it is A's");
  assert.equal(needsRestamp(entry, B), true, "so taking it on has to re-stamp it");

  const afterTakeover = { taskId: B.taskId, attemptId: B.attemptId };
  assert.equal(attributionOf(afterTakeover, B), "mine",
    "and afterwards B reports the container it is actually using");
  assert.equal(attributionOf(afterTakeover, A), "other",
    "while A, which no longer holds it, does not");
});

test("a redelivery does not inherit its predecessor's ending", () => {
  // Same task, different attempt -- the case a task id alone cannot see, and
  // the one a timestamp saw wrongly whenever two replicas' clocks disagreed.
  const previous = { taskId: "task-a", attemptId: "attempt-a1" };
  const redelivery = { taskId: "task-a", attemptId: "attempt-a2" };
  assert.equal(attributionOf(previous, redelivery), "other");
  assert.equal(needsRestamp(previous, redelivery), true);
});

test("an entry from a build that recorded nothing is nobody's to claim", () => {
  // Not "probably mine". No caller can show it is theirs, so none may report
  // it -- the direction that loses a reclaim rather than inventing an ending.
  assert.equal(attributionOf({}, A), "unattributed");
});

test("a caller that names nothing is making no claim", () => {
  // Distinct from `unattributed`: here it is the READER that cannot identify
  // itself, which answers nothing about the entry either way.
  assert.equal(attributionOf({ taskId: A.taskId, attemptId: A.attemptId },
    { taskId: null, attemptId: null }), "unasked");
  assert.equal(needsRestamp({ taskId: A.taskId, attemptId: A.attemptId },
    { taskId: null, attemptId: null }), false,
    "and it must not stamp its own emptiness over a real identity");
});

test("a task id alone can refuse but never confirm", () => {
  // The weaker half, kept honest. Two attempts of one task share a task id, so
  // matching on it cannot establish `mine` -- only mismatching can establish
  // `other`.
  assert.equal(attributionOf({ taskId: "task-b" }, A), "other");
  assert.equal(attributionOf({ taskId: "task-a" }, A), "unattributed",
    "a shared task id is not evidence of the same delivery");
});
