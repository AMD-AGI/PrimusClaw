// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The concurrency limit counts a group, not the leader that started it.
 *
 * `sleep 30 & exit 0` returns its leader at once and leaves the sleep in the
 * group. Once that leader is collected it has no `/proc` entry at all, so a
 * count that asks only what became of the leader reads `ended_unreaped` -- a
 * class deliberately excluded from the protected set, because a terminated
 * process has no work left to protect. That is true of the leader and false of
 * the shell: the group is still holding the sandbox's CPU.
 *
 * The orphan sweep already asks the right question (`groupHasMember`, with the
 * token fallback a reaped leader needs). The sandbox-wide count did not, so a
 * restart admitted a fresh full allowance beside the groups that survived it.
 *
 * The restart is simulated the way the sibling limit test simulates it: a
 * process is spawned outside the manager and a record is filed for it.
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
const STATE_ROOT_FOR_CLEANUP = mkdtempSync(join(tmpdir(), "bg-shell-limit-reaped-leader-"));
process.env.HANDS_STATE_DIR = STATE_ROOT_FOR_CLEANUP;
process.env.BG_SHELL_ENABLED = "true";
process.env.BG_SHELL_MAX_CONCURRENT = "1";

const records = await import("../src/runtime/shell-records.js");
const liveness = await import("../src/runtime/shell-liveness.js");
const { spawnBackground, shutdownAllShells } = await import("../src/tools/shell/bg-manager.js");

records.mintEpoch({ pid: process.pid, startToken: records.processStartToken(process.pid) });

const OWNER = "session-reaped";
const RUN = "ktsk_reaped";

// Its own group, so the surviving `sleep` is a group member and not merely a
// descendant of this test process.
const leader = spawn("/bin/sh", ["-c", "sleep 30 & exit 0"], {
  detached: true, stdio: "ignore",
});
const leaderPid = leader.pid!;
// Read while the leader is still on the process table. Taken after it exits
// this is null, and a record carrying no token cannot tell the fix from the
// bug it replaces -- both drop it.
const leaderToken = records.processStartToken(leaderPid);

after(async () => {
  await shutdownAllShells(200);
  try { process.kill(-leaderPid, "SIGKILL"); } catch { /* already gone */ }
});

test("a group whose leader was reaped still holds its slot", async () => {
  await new Promise<void>((resolve) => leader.once("exit", () => resolve()));
  // The leader is collected; the group is not.
  await until(() => liveness.groupHasMember(leaderPid), `group ${leaderPid} to have a member`);

  assert.ok(leaderToken, "sanity: the leader's start token was read before it exited");
  assert.equal(
    liveness.groupHasMember(leaderPid), true,
    "sanity: the sleep is still a member of the reaped leader's group",
  );

  const claimed = records.claimRecord({
    owner_scope: OWNER,
    run_identity: RUN,
    shell_id: `reaped-leader-${leaderPid}`,
    hands_epoch: records.currentEpoch() ?? undefined,
    process_identity: { pid: leaderPid, startToken: leaderToken },
  } as Parameters<typeof records.claimRecord>[0]);
  assert.ok(claimed, "sanity: the survivor's record is filed");

  assert.throws(
    () => spawnBackground(OWNER, RUN, "sleep 30", `new-${process.pid}`),
    /limit reached/,
    "the surviving group holds the sandbox's only slot, whatever became of its leader",
  );
});

after(() => {
  try {
    rmSync(STATE_ROOT_FOR_CLEANUP, { recursive: true, force: true });
  } catch { /* the test's own cleanup is not worth failing a green run over */ }
});
