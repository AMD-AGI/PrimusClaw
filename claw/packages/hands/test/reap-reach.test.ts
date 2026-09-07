// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a reap reaches, and what it reports about processes rather than entries.
 *
 * Three properties that need real processes, in a file of their own so each
 * starts against an empty registry: the concurrency ceiling is shared, and a
 * fixture that meets it is one whose shell was never started.
 *
 * The reap addresses the pair the credential proved rather than the run alone;
 * it reaches a record whose process this Hands never tracked, which is every
 * shell after a restart; and it reads the process group rather than the
 * leader's exit, since a descendant that stayed in the group outlives it.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.WORKSPACE_PATH = tmpdir();
process.env.BG_SHELL_ENABLED = "true";
process.env.BG_SHELL_REAP_DELAY_MS = "60000";
process.env.HANDS_STATE_DIR = mkdtempSync(join(tmpdir(), "claw-reap-reach-"));

const records = await import("../src/runtime/shell-records.js");
const bg = await import("../src/tools/shell/bg-manager.js");
const { isolatingSandbox, releaseSandboxIsolation } =
  await import("./support/sandbox-isolation.js");
isolatingSandbox();
records.mintEpoch({ pid: process.pid, startToken: records.processStartToken(process.pid) });

const OWNER = "sess-reach";
const strays: ChildProcess[] = [];

after(async () => {
  for (const child of strays) {
    try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ }
  }
  await bg.shutdownAllShells(250);
  releaseSandboxIsolation();
  rmSync(process.env.HANDS_STATE_DIR!, { recursive: true, force: true });
});

test("a reap addresses the pair the credential proved, not the run alone", async () => {
  // Two owners each holding a run of the same id: reaping by run alone ends
  // both, though the credential proved one pair.
  bg.spawnBackground("owner-one", "ktsk_shared", "sleep 60", "theirs");
  bg.spawnBackground("owner-two", "ktsk_shared", "sleep 60", "mine");
  await new Promise((r) => setTimeout(r, 200));

  const report = await bg.shutdownRunShells("owner-two", "ktsk_shared", 250);
  assert.equal(report.shells.length, 1, "the reap reached outside the proved pair");
  assert.equal(report.shells[0].owner_scope, "owner-two");

  assert.equal(
    bg.pollOutput("owner-one", "ktsk_shared", "theirs").structured.shell_class,
    "running",
    "another owner's run of the same id was reaped with it",
  );
  bg.killShell("owner-one", "ktsk_shared", "theirs");
});

test("a record-backed process this run no longer tracks is still addressed", async () => {
  // After a restart the registry is empty for reasons that say nothing about
  // the sandbox, so a reap over live work reported an empty set and left the
  // work running with nobody able to name it.
  const child = spawn("/bin/sh", ["-c", "sleep 60"], { detached: true, stdio: "ignore" });
  child.unref();
  strays.push(child);
  records.claimRecord({
    owner_scope: OWNER,
    run_identity: "ktsk_untracked",
    shell_id: "orphan",
    command_digest: "d",
    kind: "background",
    claimed_at: new Date().toISOString(),
    hands_epoch: "an-older-epoch",
  });
  records.attachRecord(OWNER, "ktsk_untracked", "orphan", {
    pid: child.pid!, startToken: records.processStartToken(child.pid!),
  });

  const report = await bg.shutdownRunShells(OWNER, "ktsk_untracked", 250);
  assert.equal(report.shells.length, 1, "a reap over an untracked record reported nothing");
  assert.equal(report.shells[0].shell_id, "orphan");
  assert.equal(report.shells[0].owner_scope, OWNER);
  assert.notEqual(report.shells[0].outcome, "surviving",
    "the record's process was signalled and is gone, so the reap must say so");
});

test("a descendant left in the group is reported, not counted as stopped", async () => {
  // The leader takes the signal and goes; the descendant ignores it and stays
  // in the group, still holding the sandbox's CPU. Its own streams go nowhere,
  // so what is under test is group membership rather than an inherited pipe.
  bg.spawnBackground(
    OWNER, "ktsk_leftover",
    `${JSON.stringify(process.execPath)} -e "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"`
    + " >/dev/null 2>&1 </dev/null & sleep 60",
    "leader-with-descendant",
  );
  await new Promise((r) => setTimeout(r, 400));

  const report = await bg.shutdownRunShells(OWNER, "ktsk_leftover", 250);
  assert.equal(report.shells.length, 1);
  assert.notEqual(report.shells[0].outcome, "stopped",
    "the leader ended but its group did not, and the reap called that stopped");
});
