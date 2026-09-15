// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Which answer each state of the evidence earns.
 *
 * The three traps this exists for. A terminated process whose parent has not
 * collected its status keeps a process-table entry, so presence there proves
 * nothing and a finished-but-unreaped process needs a class of its own. The
 * registry's status is set at spawn and changed only when the exit event
 * arrives, so it still reads running through that whole window. And epoch
 * equality proves only that no newer Hands has started -- a crashed one leaves
 * its marker exactly as it wrote it -- so a bearer whose liveness cannot be
 * observed is a third answer rather than a tie broken either way.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  PROTECTED_CLASSES, callerVisibleClass, classifyShellRecord,
  type EpochFreshness, type ProcessView, type RegistryView,
} from "../src/runtime/shell-classify.js";
import type { ShellRecord } from "../src/runtime/shell-records.js";

const BASE: ShellRecord = {
  owner_scope: "sess", run_identity: "run", shell_id: "bg-1",
  command_digest: "d", kind: "background",
  claimed_at: "2026-01-01T00:00:00.000Z", hands_epoch: "e1",
};
const ATTACHED: ShellRecord = {
  ...BASE, process_identity: { pid: 7, startToken: "1" }, spawned_at: BASE.claimed_at,
};

const classify = (
  record: ShellRecord, epoch: EpochFreshness, registry: RegistryView, process: ProcessView,
) => classifyShellRecord({ record, epoch, registry, process });

test("only the parent reap produces finished", () => {
  const done: ShellRecord = { ...ATTACHED, status: "exited", exit_code: 0, ended_at: BASE.claimed_at };
  assert.equal(classify(done, "stale", "absent", "terminated"), "finished",
    "the outcome is durable, so a later reader does not have to re-derive it");
  assert.equal(classify(ATTACHED, "current", "running", "present"), "running");
  assert.notEqual(classify(ATTACHED, "stale", "absent", "terminated"), "finished",
    "losing the collecting process loses the exit code permanently; no code is "
      + "synthesised across a restart");
});

test("a terminated process is never reported running, whatever the registry says", () => {
  // The window between termination and the exit event's delivery, where the
  // registry entry still reads running and a caller told so waits for output
  // that will never come.
  assert.equal(classify(ATTACHED, "current", "running", "terminated"), "ended_unreaped");
});

test("evidence nobody could obtain is its own answer, not the convenient one", () => {
  assert.equal(classify(ATTACHED, "indeterminate", "running", "present"), "unverified_running");
  assert.equal(classify(ATTACHED, "current", "unreadable", "present"), "unverified_running");
  assert.equal(classify(ATTACHED, "current", "running", "unreadable"), "unverified_running");
  assert.notEqual(classify(ATTACHED, "indeterminate", "absent", "terminated"), "ended_unreaped",
    "an indeterminate epoch is not a stale one, and reading it as one converts "
      + "unresolved live work into a class that unblocks a destroy");
});

test("a stale epoch with no termination evidence is lost, not ended", () => {
  assert.equal(classify(ATTACHED, "stale", "absent", "present"), "lost");
  assert.equal(classify(ATTACHED, "stale", "absent", "terminated"), "ended_unreaped");
});

test("a claim with no attachment blocks a destroy under any epoch", () => {
  for (const epoch of ["current", "stale", "indeterminate"] as EpochFreshness[]) {
    assert.equal(classify(BASE, epoch, "absent", "unreadable"), "spawn_indeterminate", epoch);
  }
  assert.ok(PROTECTED_CLASSES.includes("spawn_indeterminate"));
});

test("ended_unreaped does not block a destroy, and everything unresolved does", () => {
  // A terminated process has no work left to protect, and holding a sandbox for
  // its lingering entry is how sandboxes are kept open indefinitely.
  assert.ok(!PROTECTED_CLASSES.includes("ended_unreaped"));
  assert.ok(!PROTECTED_CLASSES.includes("finished"));
  for (const cls of ["running", "unverified_running", "spawn_indeterminate", "lost"] as const) {
    assert.ok(PROTECTED_CLASSES.includes(cls), cls);
  }
});

test("an internally inconsistent record is reported as itself, and softened for a caller", () => {
  assert.equal(classify(ATTACHED, "current", "absent", "present"), "inconsistent");
  assert.equal(callerVisibleClass("inconsistent"), "unknown");
  assert.ok(PROTECTED_CLASSES.includes("inconsistent"), "and it still blocks a destroy");
});
