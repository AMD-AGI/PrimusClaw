// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The concurrency cap counts work, not registry entries.
 *
 * An exited shell stays in the registry for one reap delay so its final output
 * is still pollable in the next turn. Counting those against the cap made a
 * sandbox that had finished every command refuse the next one for the length of
 * that window -- with the production defaults, sixteen completed commands lock
 * a sandbox out for a minute with nothing running in it.
 *
 * Its own file: both the cap and the retention delay are read once at module
 * load, and this needs a small cap and a delay long enough that the exited
 * shells are provably still in the registry when the next start is admitted.
 */
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";

process.env.WORKSPACE_PATH = tmpdir();
process.env.BG_SHELL_ENABLED = "true";
process.env.BG_SHELL_MAX_CONCURRENT = "2";
// Far longer than the test: the exited entries must still be present, or the
// bug this pins could not reproduce even with the fix reverted.
process.env.BG_SHELL_REAP_DELAY_MS = "60000";
const { spawnBackground, listRunningShells, runningShellCount, shutdownAllShells } =
  await import("../src/tools/shell/bg-manager.js");

const OWNER = "session-cap";
const RUN = "ktsk_1";

async function until(fn: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return fn();
}

afterEach(async () => { await shutdownAllShells(200); });

test("a finished shell does not hold a slot for its retention window", async () => {
  const first = spawnBackground(OWNER, RUN, "echo one", "cap-a").shell!;
  const second = spawnBackground(OWNER, RUN, "echo two", "cap-b").shell!;

  assert.ok(await until(() => first.status !== "running" && second.status !== "running"),
    "both shells should have exited");
  assert.equal(runningShellCount(OWNER), 0, "sanity: no work is left");
  assert.deepEqual(listRunningShells(OWNER), []);

  // The cap is 2 and both entries are still in the registry, unreaped.
  const third = spawnBackground(OWNER, RUN, "echo three", "cap-c");

  assert.equal(third.shell!.id, "cap-c",
    "a sandbox with nothing running refused a start for the retention window");
});

test("the cap still refuses a start while the work is actually running", async () => {
  spawnBackground(OWNER, RUN, "sleep 30", "busy-a");
  spawnBackground(OWNER, RUN, "sleep 30", "busy-b");

  assert.ok(await until(() => runningShellCount(OWNER) === 2), "sanity: both are running");

  assert.throws(() => spawnBackground(OWNER, RUN, "sleep 30", "busy-c"),
    /Background shell limit reached \(max 2\)/,
    "the cap must still bind when the slots hold live work");
});
