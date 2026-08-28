// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Waiting for a background shell without burning a turn per poll.
 *
 * The foreground timeout ceiling exists so that a run handed to another Brain
 * replica has no command from the previous owner still mid-write. That is an
 * argument about commands that do something; a wait does nothing, so
 * abandoning one costs nothing and it does not need to share the ceiling.
 *
 * Without that distinction the ceiling is unusable: the only way to await a
 * background job would be to poll, at one LLM turn per interval, which for a
 * long training run is hundreds of turns spent asking whether it is done.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";

process.env.WORKSPACE_PATH = tmpdir();
process.env.BG_SHELL_ENABLED = "true";
// Production keeps a finished shell readable for a minute after it exits. Here
// that would only leak one test's shells into the next.
process.env.BG_SHELL_REAP_DELAY_MS = "10";
// Read after the env is set: the flag is resolved at module load.
const { spawnBackground, waitForShellExit, shutdownAllShells } =
  await import("../src/tools/shell/bg-manager.js");

// Without this the run sits until the longest sleep below finishes on its own.
after(() => shutdownAllShells(50));

const promised = (v: ReturnType<typeof waitForShellExit>) => {
  assert.ok(v instanceof Promise, "expected a wait, got a refusal");
  return v;
};

test("the wait ends when the shell does, not when the timeout does", async () => {
  spawnBackground("owner-a", "run-a", "sleep 0.3; exit 7", "quick");
  const startedAt = Date.now();
  const shell = await promised(waitForShellExit("owner-a", "quick", 30_000));
  const elapsed = Date.now() - startedAt;

  assert.equal(shell?.exitCode, 7, "the exit code is readable by the time the wait resolves");
  assert.equal(shell?.status, "exited");
  assert.ok(elapsed < 5_000, `returned promptly at exit, took ${elapsed}ms`);
});

test("a wait that runs out reports the shell is still going, and does not kill it", async () => {
  spawnBackground("owner-b", "run-b", "sleep 20", "slow");
  const result = await promised(waitForShellExit("owner-b", "slow", 150));

  assert.equal(result, null, "null is how the caller learns to say 'still running'");
});

test("waiting on a shell that already finished returns at once", async () => {
  spawnBackground("owner-c", "run-c", "exit 0", "done");
  await promised(waitForShellExit("owner-c", "done", 30_000));

  const startedAt = Date.now();
  const again = await promised(waitForShellExit("owner-c", "done", 30_000));
  assert.equal(again?.status, "exited");
  assert.ok(Date.now() - startedAt < 100, "no second wait for an exit that already happened");
});

test("waiting in slices does not pile up listeners on the shell", async () => {
  // Waiting in slices is the documented way to sit on a long job, so a
  // twelve-hour run is a couple of dozen waits on the same process. Each one
  // registers an exit listener, and a timeout that resolved without removing its
  // own left them all attached: Node warns at eleven with a
  // MaxListenersExceededWarning, which reads as a leak and is the last thing
  // anybody wants to be diagnosing mid-training-run.
  const shell = spawnBackground("owner-g", "run-g", "sleep 20", "sliced");
  const before = shell.process.listenerCount("exit");

  for (let i = 0; i < 12; i++) {
    assert.equal(await promised(waitForShellExit("owner-g", "sliced", 5)), null);
  }

  assert.equal(
    shell.process.listenerCount("exit"),
    before,
    "a wait that ran out leaves nothing of itself behind",
  );
});

test("a wait cannot reach another owner's shell", async () => {
  // Same reasoning as the rest of the registry: a sandbox gets handed to a new
  // run, and the next occupant must not be able to block on -- or learn the
  // existence of -- the previous one's processes.
  spawnBackground("owner-d", "run-d", "sleep 20", "private");
  const refused = waitForShellExit("owner-e", "private", 100);

  assert.ok(!(refused instanceof Promise));
  assert.match((refused as { error: string }).error, /not found/);
});

test("an unknown shell is refused rather than waited on", async () => {
  const refused = waitForShellExit("owner-f", "never-existed", 100);
  assert.ok(!(refused instanceof Promise));
  assert.match((refused as { error: string }).error, /not found/);
});
