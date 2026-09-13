// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A shell that has ended does not hold a slot, whatever has its pid now.
 *
 * The sandbox-wide count reaches a reaped leader's group by asking the process
 * table, and that branch answers ahead of classification. Ahead of it means
 * ahead of the one exclusion classification makes before any other: a record
 * carrying an outcome is over, because the outcome phase is the only thing that
 * writes one.
 *
 * Skipping that exclusion, a finished record whose pid had since been reused
 * was counted as live work -- so a shell that ended hours ago held a slot
 * against the live shell that inherited its number, and starts were refused
 * below the actual limit.
 */

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { isolatingSandbox } from "./support/sandbox-isolation.js";
import { until } from "./support/group-settled.js";

isolatingSandbox();

process.env.WORKSPACE_PATH = tmpdir();
const STATE_ROOT_FOR_CLEANUP = mkdtempSync(join(tmpdir(), "bg-shell-limit-finished-"));
process.env.HANDS_STATE_DIR = STATE_ROOT_FOR_CLEANUP;
process.env.BG_SHELL_ENABLED = "true";
process.env.BG_SHELL_MAX_CONCURRENT = "1";

const records = await import("../src/runtime/shell-records.js");
const liveness = await import("../src/runtime/shell-liveness.js");
const { spawnBackground, shutdownAllShells } = await import("../src/tools/shell/bg-manager.js");

records.mintEpoch({ pid: process.pid, startToken: records.processStartToken(process.pid) });

const OWNER = "session-finished";
const RUN = "ktsk_finished";

// A live group whose leader has been collected: what a reused pid looks like.
const leader = spawn("/bin/sh", ["-c", "sleep 60 & exit 0"], { detached: true, stdio: "ignore" });
const leaderPid = leader.pid!;
const leaderToken = records.processStartToken(leaderPid);

after(async () => {
  await shutdownAllShells(200);
  try { process.kill(-leaderPid, "SIGKILL"); } catch { /* already gone */ }
  try { rmSync(STATE_ROOT_FOR_CLEANUP, { recursive: true, force: true }); } catch { /* ignore */ }
});

test("a finished record does not hold a slot against whatever has its pid now", async () => {
  await new Promise<void>((resolve) => leader.once("exit", () => resolve()));
  await until(() => liveness.groupHasMember(leaderPid), `group ${leaderPid} to have a member`);

  assert.equal(
    liveness.groupHasMember(leaderPid), true,
    "sanity: a live group sits under that pid, which is what makes this the hard case",
  );

  const shellId = `ended-${leaderPid}`;
  const claimed = records.claimRecord({
    owner_scope: OWNER,
    run_identity: RUN,
    shell_id: shellId,
    hands_epoch: records.currentEpoch() ?? undefined,
    process_identity: { pid: leaderPid, startToken: leaderToken },
  } as Parameters<typeof records.claimRecord>[0]);
  assert.ok(claimed, "sanity: the record is filed");
  records.attachRecord(OWNER, RUN, shellId, { pid: leaderPid, startToken: leaderToken });
  // The outcome phase, which is the only thing that ends a shell.
  records.recordOutcome(OWNER, RUN, shellId, { status: "exited", exitCode: 0, signal: null });

  const started = spawnBackground(OWNER, RUN, "sleep 30", `fresh-${process.pid}`);
  assert.ok(
    started.shell,
    "the only shell this owner has is finished, so the one free slot is free",
  );
});
