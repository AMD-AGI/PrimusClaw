// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * An exited shell must not keep a sandbox alive.
 *
 * The keepalive sweep asks `runningShellCount` before it treats an idle handle
 * as free, so whatever this counts is what holds a pod open. A finished shell
 * stays in the registry for a while after it exits -- deliberately, so its last
 * output is still pollable in the next turn -- and counting those would pin the
 * sandbox to work that ended, which is exactly the reclaim the idle window
 * exists to allow.
 *
 * Its own file because the retention delay is read once at module load, and the
 * window between "exited" and "reaped from the registry" is the thing under
 * test: bg-shell-ownership shortens that delay to 10ms so its own leftovers do
 * not leak between tests, which closes this window before it can be observed.
 */
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";

process.env.WORKSPACE_PATH = tmpdir();
process.env.BG_SHELL_ENABLED = "true";
// Long enough that an exited shell is still in the registry when it is counted.
// The production default is 60s; this only has to outlast the assertions.
process.env.BG_SHELL_REAP_DELAY_MS = "60000";
const {
  spawnBackground, pollOutput, killShell, runningShellCount, shutdownAllShells,
} = await import("../src/tools/shell/bg-manager.js");

const OWNER = "session-abc";
const RUN = "ktsk_1";

async function until(fn: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return fn();
}

// Only running shells are terminated here; the exited ones stay in the registry
// for the full retention delay, which is the point of this file. So each test
// uses its own shell ids rather than relying on a clean registry.
afterEach(async () => { await shutdownAllShells(200); });

test("a shell that has exited is still readable but no longer counts as work", async () => {
  const quick = spawnBackground(OWNER, RUN, "echo done", "quick");
  assert.ok(await until(() => quick.status !== "running"), "sanity: it ends on its own");

  // Still in the registry -- this is the window the production delay keeps open,
  // and the reason counting registry entries rather than running ones is wrong.
  assert.match(pollOutput(OWNER, "quick"), /done/,
    "sanity: a finished shell is retained so its output survives into the next turn");

  assert.equal(runningShellCount(OWNER), 0,
    "a retained-but-exited shell must not hold the sandbox open for work that is over");
});

test("an exited shell does not mask a running one, or inflate the count beside it", async () => {
  const quick = spawnBackground(OWNER, RUN, "echo done", "quick2");
  const long = spawnBackground(OWNER, RUN, "sleep 60", "long2");

  assert.ok(await until(() => quick.status !== "running"));
  assert.match(pollOutput(OWNER, "quick2"), /done/, "sanity: still retained");

  assert.equal(runningShellCount(OWNER), 1,
    "exactly the running one: the exited neighbour is retained, not counted");

  killShell(OWNER, "long2");
  assert.ok(await until(() => long.status !== "running"));
  assert.equal(runningShellCount(OWNER), 0,
    "with the last running shell gone the handle is free, whatever is still retained");
});
