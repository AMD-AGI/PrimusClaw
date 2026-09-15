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

import test, { after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
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
const STATE_ROOT_FOR_CLEANUP = mkdtempSync(join(tmpdir(), "bg-shell-orphan-shutdown-"));
process.env.HANDS_STATE_DIR = STATE_ROOT_FOR_CLEANUP;
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
  // No registry entry at all, which is the state a restart leaves and the one
  // the first version of this test failed to create: it registered a shell so
  // the owner would be "known", and the sweep under test derived its owners
  // from the registry -- so the test supplied the very thing production does
  // not have, and passed against a sweep that examined nothing.
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
    (runningShellCount(OWNER) ?? 0) >= 1,
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

// The isolated root goes with the run that made it. Left behind, each run adds
// another directory of epoch and record files under the system temp dir.
after(() => {
  try {
    rmSync(STATE_ROOT_FOR_CLEANUP, { recursive: true, force: true });
  } catch { /* the test's own cleanup is not worth failing a green run over */ }
});

test("a group whose leader was reaped is still escalated against", async () => {
  // SIGTERM kills the leader and the kernel reaps it, so its /proc entry -- and
  // with it the start token -- is gone by the time the grace expires. Requiring
  // the token at escalation therefore skipped exactly the groups this sweep
  // exists for: the survivors of the signal it had just sent. The fallback is
  // the question that is still answerable, group membership, and a pid number
  // stays reserved while its group has one.
  // The child must ignore SIGTERM *itself* -- `trap` in a subshell does not
  // protect the `sleep` it then execs, and an earlier version of this test
  // died to the SIGTERM before the escalation it meant to exercise ever ran.
  // A shell that traps and then waits keeps the group open through SIGTERM.
  const leader = spawn(
    "/bin/sh",
    ["-c", '/bin/sh -c \'trap "" TERM; while :; do sleep 1; done\' & exit 0'],
    { detached: true, stdio: "ignore" },
  );
  leader.unref();
  await settle(200);

  // A token that was real when the record was written and cannot be read now.
  // The leader exits immediately, so reading its token here would give "" --
  // and "" equals the "" a reaped pid yields, which makes the old
  // token-required implementation behave identically to the new one. An
  // earlier version of this test did exactly that and could not tell them
  // apart. A non-empty token is what makes the distinction observable, and it
  // is also what production records hold: the token is taken at spawn, while
  // the leader is alive.
  const id = `reaped-leader-${leader.pid}`;
  assert.ok(records.claimRecord({
    owner_scope: OWNER,
    run_identity: RUN,
    shell_id: id,
    hands_epoch: records.currentEpoch() ?? undefined,
    process_identity: { pid: leader.pid!, startToken: "42" },
  } as Parameters<typeof records.claimRecord>[0]), "sanity: the record is filed");

  assert.ok(
    !records.processStartToken(leader.pid!),
    "sanity: the leader is gone, so its token cannot be read now",
  );

  await shutdownAllShells(300);
  await settle(400);

  const survivors = spawnSync("/bin/sh", [
    "-c", `ps -eo pgid= | tr -d ' ' | grep -c '^${leader.pid}$' || true`,
  ], { encoding: "utf8" }).stdout.trim();
  assert.equal(survivors, "0", "the surviving group was escalated against, not skipped");
});
