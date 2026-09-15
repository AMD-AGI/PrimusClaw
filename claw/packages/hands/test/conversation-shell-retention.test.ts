// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A conversation shell does not inherit the deadline of the turn that started it.
 *
 * It is filed under no run identity precisely because it is shared with the
 * turns that follow -- that is what `run_in_background` on a conversation shell
 * means. Its claim still carries the originating turn's deadline, so an outcome
 * written after that deadline arrived already expired: the next poll or wait
 * answered "shell not found" for a shell whose output was still buffered and
 * whose own record said `output_available`.
 *
 * A run-scoped shell keeps the retention, which is the control: the exemption
 * is about the shell that outlives its turn, not about retention in general.
 */

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { isolatingSandbox } from "./support/sandbox-isolation.js";

isolatingSandbox();
process.env.WORKSPACE_PATH = tmpdir();
// Its own record subtree, for the same two reasons its siblings have one: these
// files write records and read them back by walking the whole tree, so sharing a
// root lets a parallel file see this one's shells -- and the default root is
// `/var/lib/claw-hands`, which only a privileged process can create. Left to the
// default this passes as root and fails the CI runner on EACCES.
const STATE_ROOT_FOR_CLEANUP = mkdtempSync(join(tmpdir(), "conversation-shell-retention-"));
process.env.HANDS_STATE_DIR = STATE_ROOT_FOR_CLEANUP;

const records = await import("../src/runtime/shell-records.js");

const filed = (run: string | null, id: string, deadline: string) => {
  assert.ok(records.claimRecord({
    owner_scope: "session-retention",
    run_identity: run,
    shell_id: id,
    deadline_at: deadline,
    hands_epoch: records.currentEpoch() ?? undefined,
  } as Parameters<typeof records.claimRecord>[0]), `sanity: ${id} is filed`);
  records.recordOutcome("session-retention", run, id, {
    status: "exited", exitCode: 0, signal: null,
  });
  return records
    .listRecordsForOwner("session-retention")
    .find((r) => r.shell_id === id);
};

test("a shell filed under no run keeps its output past the turn's deadline", () => {
  records.mintEpoch({ pid: process.pid, startToken: records.processStartToken(process.pid) });
  const past = new Date(Date.now() - 60_000).toISOString();

  const conversation = filed(null, `conv-${process.pid}`, past);
  assert.ok(conversation, "the record is there");
  assert.equal(
    conversation.retain_until, undefined,
    "no retention from a turn this shell was made to outlive",
  );

  const runScoped = filed("ktsk_scoped", `scoped-${process.pid}`, past);
  assert.ok(runScoped, "the control record is there");
  assert.equal(
    runScoped.retain_until, past,
    "a run-scoped shell still expires with its run, which is what makes this an exemption",
  );
});

// The isolated root goes with the run that made it. Left behind, each run adds
// another directory of record files under the system temp dir.
after(() => {
  try {
    rmSync(STATE_ROOT_FOR_CLEANUP, { recursive: true, force: true });
  } catch { /* the test's own cleanup is not worth failing a green run over */ }
});
