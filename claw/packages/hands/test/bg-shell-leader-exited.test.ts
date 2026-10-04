// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A command that returned while the processes it started kept running.
 *
 * An install script that ends with `ray start` (or any `daemon &`) exits 0 and
 * leaves its daemons in the shell's process group. The shell rightly stays
 * `running` -- the group is what "running" means, and the counts that protect
 * live work read it -- but the caller was shown nothing else: bash_output and a
 * timed-out wait both said "running", so the agent never learned that the
 * command it asked for had finished, nor with what exit code.
 *
 * The leader's outcome is now reported beside the status, never instead of it.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";

import { isolatingSandbox } from "./support/sandbox-isolation.js";
import { until } from "./support/group-settled.js";

isolatingSandbox();

process.env.WORKSPACE_PATH = tmpdir();
process.env.BG_SHELL_ENABLED = "true";
process.env.BG_SHELL_REAP_DELAY_MS = "10";
const { spawnBackground, pollOutput, shutdownAllShells, runningShellCount } =
  await import("../src/tools/shell/bg-manager.js");
const { wait } = await import("../src/tools/shell/wait.js");
const { bash_output } = await import("../src/tools/shell/bash-output.js");
const { withCaller } = await import("../src/runtime/owner-context.js");

after(() => shutdownAllShells(50));

/** Start `command` and return once its leader is gone and its group is not. */
async function leaderGoneGroupAlive(owner: string, run: string, id: string, command: string) {
  const shell = spawnBackground(owner, run, command, id).shell!;
  await until(() => shell.leaderExitedAt !== undefined, "the leader to exit with its group alive");
  return shell;
}

test("bash_output says the command exited, with its code, while the shell stays running", async () => {
  const shell = await leaderGoneGroupAlive("o-1", "r-1", "daemonised",
    "echo installed; sleep 30 & exit 3");
  // Not a terminal status: the group is still there, and saying otherwise
  // would drop it from every count that keeps the sandbox for it.
  assert.equal(shell.status, "running");

  const answer = withCaller({ owner: "o-1", run: "r-1" },
    () => bash_output.execute({ shell_id: "daemonised" }));
  const result = await answer;
  const s = result.structuredContent as Record<string, unknown>;
  assert.equal(s.shell_class, "running");
  assert.equal(s.status, undefined, "no terminal status is claimed");
  assert.equal(s.leader_exited, true);
  assert.equal(s.leader_exit_code, 3, "the command's own exit code, not a placeholder");
  assert.equal(s.leader_signal, null);
  const text = result.content[0].text;
  assert.match(text, /Command exited \(exit_code=3\); processes it started are still running/);
  assert.match(text, /installed/, "and the command's output is still returned");
});

test("a shell whose leader is still running reports no leader exit", async () => {
  spawnBackground("o-2", "r-2", "sleep 30", "busy");
  // Long enough that an exit event, were there one, would have been handled.
  await new Promise((r) => setTimeout(r, 200));
  const answer = pollOutput("o-2", "r-2", "busy");
  assert.equal(answer.structured.leader_exited, undefined);
  assert.doesNotMatch(answer.text, /Command exited/);
});

test("a wait that times out on such a shell says the command already exited", async () => {
  await leaderGoneGroupAlive("o-3", "r-3", "daemon-wait", "sleep 30 & exit 0");

  const result = await withCaller({ owner: "o-3", run: "r-3" },
    () => wait.execute({ shell_id: "daemon-wait", timeout_sec: 0.3 }));
  const s = result.structuredContent as Record<string, unknown>;
  // Still not finished: the wait is for the group, and the group is alive.
  assert.equal(s.finished, false);
  assert.equal(s.status, "running");
  assert.equal(s.leader_exited, true);
  assert.equal(s.leader_exit_code, 0);
  assert.match(result.content[0].text, /its command has exited \(exit_code=0\)/);
});

test("the leader's exit does not take the shell out of the live-work count", async () => {
  // Deliberately unchanged: a group whose leader returned can be daemons the
  // command left behind, or the real work (`nohup train.py &`). The count
  // cannot tell them apart, and the cost of guessing wrong is a reclaimed
  // sandbox under a running job.
  await leaderGoneGroupAlive("o-4", "r-4", "counted", "sleep 30 & exit 0");
  assert.equal(runningShellCount("o-4"), 1);
});
