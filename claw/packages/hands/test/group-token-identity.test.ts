// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Whose group is under that number.
 *
 * Reaching a reaped leader's group is what makes a shell survivable: the leader
 * of `sleep 600 &` is gone in the first instant and the work is not. The check
 * that gets there asks the process table for members of the leader's group --
 * and once the leader has been collected, its pid number is free again, so a
 * later unrelated group given the same number answers that question exactly as
 * the real one would. There is no start token left to tell them apart; that is
 * the one case the fallback exists for and the one case the number cannot
 * decide.
 *
 * The children can decide it. They inherit the spawner's environment, so a
 * member carrying the shell's own token is the shell's and one that does not is
 * somebody else's -- which is what stops a late escalation, an orphan sweep or
 * a concurrency count from addressing work it never started.
 */

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SHELL_GROUP_TOKEN_VAR } from "@claw/protocol";

import { isolatingSandbox } from "./support/sandbox-isolation.js";
import { until } from "./support/group-settled.js";

isolatingSandbox();

process.env.WORKSPACE_PATH = tmpdir();
const STATE_ROOT_FOR_CLEANUP = mkdtempSync(join(tmpdir(), "group-token-identity-"));
process.env.HANDS_STATE_DIR = STATE_ROOT_FOR_CLEANUP;
process.env.BG_SHELL_ENABLED = "true";

const liveness = await import("../src/runtime/shell-liveness.js");

/**
 * A detached group whose leader exits at once, leaving one member behind.
 *
 * `sh -c "sleep 60 & exit 0"` forks, so the leader is collected and the sleep
 * stays in the group -- the exact shape the fallback is for.
 */
function orphanedGroup(token?: string): Promise<number> {
  const child = spawn("/bin/sh", ["-c", "sleep 60 & exit 0"], {
    detached: true,
    stdio: "ignore",
    env: token === undefined
      ? { ...process.env }
      : { ...process.env, [SHELL_GROUP_TOKEN_VAR]: token },
  });
  const pid = child.pid!;
  groups.push(pid);
  return new Promise<number>((resolve) => child.once("exit", resolve))
    .then(async () => {
      // The leader has been collected; its children are what this is about.
      await until(() => liveness.groupHasMember(pid), `group ${pid} to have a member`);
      return pid;
    });
}

const groups: number[] = [];
after(() => {
  for (const pid of groups) {
    try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
  }
  try { rmSync(STATE_ROOT_FOR_CLEANUP, { recursive: true, force: true }); } catch { /* not worth failing over */ }
});

test("a group carrying the recorded token is reached", async () => {
  const token = "tok-mine";
  const pid = await orphanedGroup(token);

  assert.equal(
    liveness.groupHasMember(pid), true,
    "sanity: the leader is gone and its group still has a member",
  );
  assert.equal(
    liveness.groupAliveUnderIdentity({ pid, startToken: "", groupToken: token }), true,
    "the surviving member carries this shell's token, so the group is this shell's",
  );
});

test("a group under the same number that carries a different token is not", async () => {
  // What pid reuse looks like from here: the number answers, the token does not.
  const pid = await orphanedGroup("tok-somebody-else");

  assert.equal(
    liveness.groupHasMember(pid), true,
    "sanity: by the number alone this is indistinguishable from our own group",
  );
  assert.equal(
    liveness.groupAliveUnderIdentity({ pid, startToken: "", groupToken: "tok-mine" }), false,
    "the number was recycled; nothing in this group was started by the recorded shell",
  );
});

test("a member that dropped the marker is still live work", async () => {
  // `env -u`, `env -i`, a re-exec through sudo: ordinary things a command does
  // to its own environment, none of which stop it running. Requiring the marker
  // here reported the group dead, the shell was settled `exited`, its slot was
  // released and its waiters were told it had finished -- while the work went
  // on. The marker may refuse a group; it may never end one.
  const child = spawn("/bin/sh", ["-c", "env -u CLAW_SHELL_GROUP sleep 60 & exit 0"], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, [SHELL_GROUP_TOKEN_VAR]: "tok-mine" },
  });
  const pid = child.pid!;
  groups.push(pid);
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
  await until(() => liveness.groupHasMember(pid), `group ${pid} to have a member`);

  assert.equal(
    liveness.groupHasMember(pid), true,
    "sanity: the sleep outlived its leader and is in the group",
  );
  assert.equal(
    liveness.groupAliveUnderIdentity({ pid, startToken: "", groupToken: "tok-mine" }), true,
    "the member carries no marker at all, which establishes nothing -- and "
    + "nothing is not evidence that the work has ended",
  );
});

test("a record written before tokens existed keeps its old answer", async () => {
  // Refusing these would lose every shell a running sandbox already has on
  // disk at upgrade -- a check that did not exist when they were written must
  // not retroactively unmake them.
  const pid = await orphanedGroup(undefined);

  assert.equal(
    liveness.groupAliveUnderIdentity({ pid, startToken: "" }), true,
    "no token to check, so the number is all there is, as it always was",
  );
});
