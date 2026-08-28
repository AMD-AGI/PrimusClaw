// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Soft vs hard admission, by run-tree root, with zero meaning unlimited.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  decideFromUsage,
  hardExceededByUsage,
  type AdmissionAsk,
  type AdmissionUsage,
  type AdmitLimits,
} from "../src/tasks/admission.js";

const UNLIMITED: AdmitLimits = {
  softRuns: 0, hardRuns: 0,
  softSandboxes: 0, hardSandboxes: 0,
  softGpuNodes: 0, hardGpuNodes: 0,
  treeMaxNodes: 0, treeMaxDepth: 0,
};

const ASK: AdmissionAsk = { origin: "chat", wantsSandbox: false, gpuNodes: 0 };
const EMPTY: AdmissionUsage = {
  runRoots: 0, executingRoots: 0,
  sandboxes: 0, executingSandboxes: 0,
  gpuNodes: 0, executingGpuNodes: 0,
};

test("a zero ceiling does not queue or refuse", () => {
  const busy: AdmissionUsage = {
    runRoots: 99, executingRoots: 99,
    sandboxes: 99, executingSandboxes: 99,
    gpuNodes: 99, executingGpuNodes: 99,
  };
  assert.deepEqual(decideFromUsage(busy, ASK, 0, UNLIMITED), { kind: "admit" });
});

test("a soft ceiling queues when executing roots are at the limit", () => {
  const usage: AdmissionUsage = { ...EMPTY, executingRoots: 2 };
  assert.deepEqual(
    decideFromUsage(usage, ASK, 4, { ...UNLIMITED, softRuns: 2 }),
    { kind: "queue", position: 5 },
  );
});

test("a hard ceiling refuses rather than queueing", () => {
  const usage: AdmissionUsage = { ...EMPTY, runRoots: 2 };
  assert.deepEqual(
    decideFromUsage(usage, ASK, 0, { ...UNLIMITED, hardRuns: 2 }),
    { kind: "reject", reason: "runs_hard_limit" },
  );
});

test("hard refuses before soft queues", () => {
  const usage: AdmissionUsage = { ...EMPTY, runRoots: 2, executingRoots: 2 };
  assert.equal(
    decideFromUsage(usage, ASK, 0, { ...UNLIMITED, softRuns: 1, hardRuns: 2 }).kind,
    "reject",
  );
});

test("a tree that is too wide is refused without looking at fleet usage", () => {
  assert.deepEqual(
    decideFromUsage(EMPTY, { ...ASK, treeNodeCount: 9 }, 0, { ...UNLIMITED, treeMaxNodes: 8 }),
    { kind: "reject", reason: "tree_nodes_exceeded" },
  );
});

test("sandbox and gpu ceilings are ignored when the run does not ask for them", () => {
  const usage: AdmissionUsage = { ...EMPTY, sandboxes: 10, gpuNodes: 10 };
  assert.deepEqual(
    decideFromUsage(usage, ASK, 0, {
      ...UNLIMITED, softSandboxes: 1, hardSandboxes: 1, softGpuNodes: 1, hardGpuNodes: 1,
    }),
    { kind: "admit" },
  );
});

test("a sandbox run is queued when the sandbox soft ceiling is full", () => {
  // Soft ceilings count sandboxes that are executing; a queued run's sandbox
  // is committed but not yet occupied, and making a run wait behind one is
  // how a queue stops draining. Both halves are set here because a sandbox
  // that is executing is also occupying.
  const usage: AdmissionUsage = { ...EMPTY, sandboxes: 1, executingSandboxes: 1 };
  assert.deepEqual(
    decideFromUsage(usage, { ...ASK, wantsSandbox: true }, 0, { ...UNLIMITED, softSandboxes: 1 }),
    { kind: "queue", position: 1 },
  );
});

test("a sandbox hard ceiling refuses rather than queues", () => {
  const usage: AdmissionUsage = { ...EMPTY, sandboxes: 1 };
  assert.deepEqual(
    decideFromUsage(usage, { ...ASK, wantsSandbox: true }, 0, { ...UNLIMITED, hardSandboxes: 1 }),
    { kind: "reject", reason: "sandboxes_hard_limit" },
  );
});

test("gpu ceilings only apply when the run asks for nodes", () => {
  assert.deepEqual(
    decideFromUsage(
      { ...EMPTY, gpuNodes: 8 },
      { ...ASK, gpuNodes: 2 },
      0,
      { ...UNLIMITED, hardGpuNodes: 9 },
    ),
    { kind: "reject", reason: "gpu_nodes_hard_limit" },
  );
  assert.deepEqual(
    decideFromUsage(
      { ...EMPTY, gpuNodes: 2, executingGpuNodes: 2 },
      { ...ASK, gpuNodes: 1 },
      7,
      { ...UNLIMITED, softGpuNodes: 2 },
    ),
    { kind: "queue", position: 8 },
  );
});

test("a tree that is too deep is refused without looking at fleet usage", () => {
  assert.deepEqual(
    decideFromUsage(
      {
        runRoots: 99, executingRoots: 99,
        sandboxes: 99, executingSandboxes: 99,
        gpuNodes: 99, executingGpuNodes: 99,
      },
      { ...ASK, treeDepth: 5 },
      0,
      { ...UNLIMITED, treeMaxDepth: 4 },
    ),
    { kind: "reject", reason: "tree_depth_exceeded" },
  );
});

test("queue position is the number already waiting, plus this run", () => {
  assert.deepEqual(
    decideFromUsage(
      { ...EMPTY, executingRoots: 1 },
      ASK,
      0,
      { ...UNLIMITED, softRuns: 1 },
    ),
    { kind: "queue", position: 1 },
  );
});

test("usage that already includes this row is over a hard ceiling, not at it", () => {
  const over: AdmissionUsage = { ...EMPTY, runRoots: 3 };
  assert.equal(
    hardExceededByUsage(over, ASK, { ...UNLIMITED, hardRuns: 2 }),
    "runs_hard_limit",
  );
  assert.equal(
    hardExceededByUsage({ ...EMPTY, runRoots: 2 }, ASK, { ...UNLIMITED, hardRuns: 2 }),
    null,
  );
  assert.equal(hardExceededByUsage(over, ASK, UNLIMITED), null);
});

test("post-insert sandbox and gpu hard ceilings ignore runs that did not ask for them", () => {
  const usage: AdmissionUsage = { ...EMPTY, sandboxes: 2, gpuNodes: 8 };
  assert.equal(
    hardExceededByUsage(usage, ASK, {
      ...UNLIMITED, hardSandboxes: 1, hardGpuNodes: 1,
    }),
    null,
  );
  assert.equal(
    hardExceededByUsage(usage, { ...ASK, wantsSandbox: true }, { ...UNLIMITED, hardSandboxes: 1 }),
    "sandboxes_hard_limit",
  );
  assert.equal(
    hardExceededByUsage(usage, { ...ASK, gpuNodes: 1 }, { ...UNLIMITED, hardGpuNodes: 4 }),
    "gpu_nodes_hard_limit",
  );
});

test("a hard sandbox ceiling counts a queued run's sandbox, a soft one does not", () => {
  // The pair that makes the post-insert recheck able to see the row it just
  // wrote. One queued sandbox run and nothing executing: the hard ceiling is
  // committed to it, the soft ceiling is not.
  const usage: AdmissionUsage = { ...EMPTY, sandboxes: 1, executingSandboxes: 0 };
  assert.deepEqual(
    decideFromUsage(usage, { ...ASK, wantsSandbox: true }, 0, { ...UNLIMITED, hardSandboxes: 1 }),
    { kind: "reject", reason: "sandboxes_hard_limit" },
  );
  assert.deepEqual(
    decideFromUsage(usage, { ...ASK, wantsSandbox: true }, 0, { ...UNLIMITED, softSandboxes: 1 }),
    { kind: "admit" },
  );
});

test("the post-insert recheck sees this row on every dimension, not just runs", () => {
  // hardExceededByUsage adds nothing, because the insert already happened. It
  // used to read sandbox and GPU counts that excluded `queued` rows, so the
  // row it was called about could not appear in them and the check could only
  // ever agree with the pre-insert one.
  const afterInsert: AdmissionUsage = {
    ...EMPTY, runRoots: 1, sandboxes: 1, gpuNodes: 4,
  };
  assert.equal(
    hardExceededByUsage(afterInsert, { ...ASK, wantsSandbox: true }, { ...UNLIMITED, hardSandboxes: 1 }),
    null,
    "at the ceiling is not past it",
  );
  const twoRacedIn: AdmissionUsage = { ...afterInsert, sandboxes: 2, gpuNodes: 8 };
  assert.equal(
    hardExceededByUsage(twoRacedIn, { ...ASK, wantsSandbox: true }, { ...UNLIMITED, hardSandboxes: 1 }),
    "sandboxes_hard_limit",
  );
  assert.equal(
    hardExceededByUsage(twoRacedIn, { ...ASK, gpuNodes: 4 }, { ...UNLIMITED, hardGpuNodes: 4 }),
    "gpu_nodes_hard_limit",
  );
});
