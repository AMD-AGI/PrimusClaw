// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Shutdown reaches the shells only the records know about.
 *
 * A background child is detached so it outlives the request that started it,
 * which means it outlives the Hands process too. After a restart its registry
 * entry is gone and its record is all that remains -- and `runningShellCount`
 * reads records for exactly that reason, so it went on reporting the shell
 * while `kill_shell` answered "nothing was signalled" and `shutdownAllShells`
 * examined an empty map. The count and the kill have to look in the same place.
 *
 * The restart is simulated rather than performed: a process is spawned outside
 * the manager and a record is filed for it, which is the state a restart
 * leaves behind, without needing a second process to leave it.
 */

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";

import { isolatingSandbox } from "./support/sandbox-isolation.js";

isolatingSandbox();

process.env.WORKSPACE_PATH = tmpdir();
process.env.BG_SHELL_ENABLED = "true";

const records = await import("../src/runtime/shell-records.js");
const { shutdownAllShells, runningShellCount, spawnBackground } =
  await import("../src/tools/shell/bg-manager.js");

// The epoch a running Hands has minted for itself. Without it `filesRecords()`
// is false and the durable path is off entirely, which is a different world
// from the one this test is about.
records.mintEpoch({ pid: process.pid, startToken: records.processStartToken(process.pid) });

const OWNER = "session-orphan";
const RUN = "ktsk_orphan";

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

afterEach(async () => { await shutdownAllShells(200); });

test("a live shell that only its record names is still shut down", async () => {
  // One registry entry so the owner is known to the sweep, and one detached
  // process that is not in the registry at all -- the survivor.
  const registered = spawnBackground(OWNER, RUN, "sleep 30", `registered-${process.pid}`).shell!;
  assert.equal(registered.status, "running", "sanity: the registered one is up");

  const orphan = spawn("/bin/sh", ["-c", "sleep 30"], { detached: true, stdio: "ignore" });
  orphan.unref();
  await settle(100);
  assert.ok(orphan.pid && alive(orphan.pid), "sanity: the survivor is up");

  const claimed = records.claimRecord({
    owner_scope: OWNER,
    run_identity: RUN,
    shell_id: `orphan-${orphan.pid}`,
    hands_epoch: records.currentEpoch() ?? undefined,
    process_identity: {
      pid: orphan.pid!,
      startToken: records.processStartToken(orphan.pid!),
    },
  } as Parameters<typeof records.claimRecord>[0]);
  assert.ok(claimed, "sanity: the record was filed");

  assert.ok(
    (runningShellCount(OWNER) ?? 0) >= 2,
    "the survivor counts as work, which is what made its unkillability a defect",
  );

  await shutdownAllShells(200);
  await settle(300);

  assert.ok(
    !alive(orphan.pid!),
    "shutdown signalled the shell its records named, not only the ones its map did",
  );
});

test("a spawn that fails after returning closes its claim instead of stranding it", async () => {
  // The claim is durable and exclusive before anything is spawned, so a start
  // that fails without recording an outcome leaves a record at
  // `spawn_indeterminate`: protected work that no reap can stop, and an id that
  // can never be used again. The asynchronous shape -- a missing cwd, EAGAIN --
  // emits `error` and then `close`, never the `exit` this file listened for.
  //
  // The failure is injected on the process object rather than provoked from a
  // real spawn: `/bin/sh -c` does not fail to exist, and the alternative is to
  // corrupt the sandbox's workspace path for every other test in the file. What
  // is exercised is the handler that was missing.
  const id = `failing-${process.pid}`;
  const started = spawnBackground(OWNER, RUN, "sleep 30", id);
  const shell = started.shell!;

  shell.process.emit("error", Object.assign(new Error("spawn EAGAIN"), { code: "EAGAIN" }));
  await settle(50);

  const record = records
    .listRecordsForOwner(OWNER)
    .find((r) => r.shell_id === id);
  assert.ok(record, "the claim is still filed, which is what makes settling it necessary");
  assert.equal(
    record.status, "failed",
    "and it carries a terminal status, so it is not protected work for a process that never ran",
  );
  assert.equal(
    runningShellCount(OWNER), 0,
    "a claim that failed to start holds no slot",
  );
});
