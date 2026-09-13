// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The concurrency limit counts the shells a restart left behind.
 *
 * A background child is detached so it outlives the request that started it,
 * which means it outlives the Hands process too. After a restart the registry
 * is empty and the children are not -- so a limit read from the registry alone
 * admitted a whole fresh allowance beside work that was already running, and
 * again after the next restart.
 *
 * The restart is simulated the way `bg-shell-orphan-shutdown` simulates it: a
 * process is spawned outside the manager and a record is filed for it, which is
 * the state a restart leaves without needing a second process to leave it.
 */

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { isolatingSandbox } from "./support/sandbox-isolation.js";

isolatingSandbox();

process.env.WORKSPACE_PATH = tmpdir();
// Its own record subtree. These files write records and read them back by
// walking the whole tree, so sharing a root with another test file running in
// parallel makes each one see the other's shells -- the suite passed serially
// and failed at random under the default concurrency.
const STATE_ROOT_FOR_CLEANUP = mkdtempSync(join(tmpdir(), "bg-shell-limit-across-restart-"));
process.env.HANDS_STATE_DIR = STATE_ROOT_FOR_CLEANUP;
process.env.BG_SHELL_ENABLED = "true";
process.env.BG_SHELL_MAX_CONCURRENT = "1";

const records = await import("../src/runtime/shell-records.js");
const { spawnBackground, shutdownAllShells } = await import("../src/tools/shell/bg-manager.js");

records.mintEpoch({ pid: process.pid, startToken: records.processStartToken(process.pid) });

const OWNER = "session-limit";
const RUN = "ktsk_limit";
const orphan = spawn("/bin/sh", ["-c", "sleep 30"], { detached: true, stdio: "ignore" });
orphan.unref();

after(async () => {
  await shutdownAllShells(200);
  try { process.kill(-orphan.pid!, "SIGKILL"); } catch { /* already gone */ }
});

test("a shell that only its record names still holds its slot", async () => {
  await new Promise((r) => setTimeout(r, 100));
  const claimed = records.claimRecord({
    owner_scope: OWNER,
    run_identity: RUN,
    shell_id: `restart-survivor-${orphan.pid}`,
    hands_epoch: records.currentEpoch() ?? undefined,
    process_identity: {
      pid: orphan.pid!,
      startToken: records.processStartToken(orphan.pid!),
    },
  } as Parameters<typeof records.claimRecord>[0]);
  assert.ok(claimed, "sanity: the survivor's record is filed");

  // The registry is empty, so a count taken from it alone reads zero and the
  // limit of one admits. The record is what says the slot is taken.
  assert.throws(
    () => spawnBackground(OWNER, RUN, "sleep 30", `new-${process.pid}`),
    /limit reached/,
    "the sandbox is already at its limit, whoever is holding it",
  );
});

// The isolated root goes with the run that made it. Left behind, each run adds
// another directory of epoch and record files under the system temp dir.
after(() => {
  try {
    rmSync(STATE_ROOT_FOR_CLEANUP, { recursive: true, force: true });
  } catch { /* the test's own cleanup is not worth failing a green run over */ }
});
