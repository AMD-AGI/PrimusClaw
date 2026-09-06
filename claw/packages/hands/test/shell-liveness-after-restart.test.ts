// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The crash path both designs exist to close.
 *
 * Background children are spawned detached so they survive the request that
 * started them; they survive the Hands process too. The in-process registry
 * does not. Asked that registry after a restart, a sandbox with a training run
 * still writing answers zero active shells, the keepalive sweep files it idle,
 * and the control plane reclaims the pod out from under the work -- which is
 * the exact failure `run_in_background` was moved onto this path to avoid.
 *
 * A real process is spawned here, and a restart is simulated the way one
 * actually presents: the durable records stay, a new epoch marker is minted,
 * and the registry starts empty.
 */
import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.WORKSPACE_PATH = tmpdir();
process.env.BG_SHELL_ENABLED = "true";
process.env.HANDS_STATE_DIR = mkdtempSync(join(tmpdir(), "claw-liveness-"));
const records = await import("../src/runtime/shell-records.js");
const { ownerLiveness } = await import("../src/runtime/shell-liveness.js");

const OWNER = "sess-restart";
const RUN = "ktsk_1";
const survivors: ChildProcess[] = [];

after(() => {
  for (const child of survivors) child.kill("SIGKILL");
  rmSync(process.env.HANDS_STATE_DIR!, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(process.env.HANDS_STATE_DIR!, { recursive: true, force: true });
  records.mintEpoch({ pid: process.pid, startToken: records.processStartToken(process.pid) });
});

/** A detached child, and the record the Hands that spawned it would have left. */
function spawnRecorded(shellId: string): ChildProcess {
  const child = spawn("/bin/sh", ["-c", "sleep 60"], { detached: true, stdio: "ignore" });
  child.unref();
  survivors.push(child);

  records.claimRecord({
    owner_scope: OWNER,
    run_identity: RUN,
    shell_id: shellId,
    command_digest: "d",
    kind: "background",
    claimed_at: new Date().toISOString(),
    hands_epoch: records.currentEpoch()!.epoch,
  });
  records.attachRecord(OWNER, RUN, shellId, {
    pid: child.pid!,
    startToken: records.processStartToken(child.pid!),
  });
  return child;
}

/** What a restart is, as the sandbox sees it: new epoch, empty registry. */
function restartHands(): void {
  records.mintEpoch({ pid: process.pid, startToken: records.processStartToken(process.pid) });
}

const emptyRegistry = () => false;

test("a shell that outlived the process that spawned it is still counted", async () => {
  const child = spawnRecorded("trainer");
  assert.equal(ownerLiveness(OWNER, () => true).active, 1, "sanity: counted before the restart");

  restartHands();

  const after = ownerLiveness(OWNER, emptyRegistry);
  assert.equal(after.determinate, true);
  assert.equal(after.active, 1,
    "the registry that knew this process died with it; answering zero here is "
      + "the sandbox being reclaimed out from under a live training run");
  assert.equal(after.classes.lost, 1,
    "honestly reported: nobody can collect its exit status any more, which is a "
      + "reason to say so rather than a reason to stop protecting it");

  child.kill("SIGKILL");
});

test("a shell that ended before the restart does not hold the sandbox open", async () => {
  // The other direction, and why the count cannot simply be "records exist": a
  // terminated process has no work left to protect, and counting its lingering
  // record would hold sandboxes open indefinitely.
  const child = spawnRecorded("finished");
  child.kill("SIGKILL");
  await new Promise((r) => child.once("exit", r));
  restartHands();

  const after = ownerLiveness(OWNER, emptyRegistry);
  assert.equal(after.active, 0);
  assert.equal(after.classes.ended_unreaped, 1);
});

test("a claim with no process yet still blocks reclamation after a restart", () => {
  // The crash between the claim and the spawn: nothing can say whether a
  // process exists, so the sandbox is kept rather than guessed at.
  records.claimRecord({
    owner_scope: OWNER, run_identity: RUN, shell_id: "half-started",
    command_digest: "d", kind: "background",
    claimed_at: new Date().toISOString(), hands_epoch: records.currentEpoch()!.epoch,
  });
  restartHands();

  const after = ownerLiveness(OWNER, emptyRegistry);
  assert.equal(after.active, 1);
  assert.equal(after.classes.spawn_indeterminate, 1);
});

test("an unreadable subtree is reported as such, never as an empty one", () => {
  spawnRecorded("trainer2");
  rmSync(process.env.HANDS_STATE_DIR!, { recursive: true, force: true });

  const after = ownerLiveness(OWNER, emptyRegistry);
  assert.equal(after.determinate, false,
    "the caller falls back to what it does know rather than filing the sandbox idle");
});

test("another owner's surviving work does not hold this owner's sandbox", () => {
  spawnRecorded("trainer3");
  assert.equal(ownerLiveness("sess-someone-else", emptyRegistry).active, 0);
});
