// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a caller is told about a shell whose leader has gone but whose group has
 * not, and why the two surfaces have to say the same thing.
 *
 * `sleep 120 & exit 0` returns its leader at once and leaves the sleep in the
 * group. The exit handler defers the terminal status until the group drains, so
 * the registry still reads `running` -- correctly. Classification then asked
 * `processView`, which is about the leader alone, got `terminated`, and
 * answered `ended_unreaped`, because that branch is tested before the registry
 * is consulted at all.
 *
 * The result was two tool surfaces contradicting each other over the same
 * shell in the same second: `wait` said "still running", `bash_output` said
 * `ended_unreaped`. A model reading the second stops waiting for work that is
 * still going.
 */

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { existsSync } from "node:fs";
import { isolatingSandbox } from "./support/sandbox-isolation.js";
import { until } from "./support/group-settled.js";

isolatingSandbox();

process.env.WORKSPACE_PATH = tmpdir();
const STATE_ROOT_FOR_CLEANUP = mkdtempSync(join(tmpdir(), "shell-class-live-group-"));
process.env.HANDS_STATE_DIR = STATE_ROOT_FOR_CLEANUP;
process.env.BG_SHELL_ENABLED = "true";
process.env.BG_SHELL_REAP_DELAY_MS = "60000";

const records = await import("../src/runtime/shell-records.js");
const { spawnBackground, resolveShell, shutdownAllShells } =
  await import("../src/tools/shell/bg-manager.js");

records.mintEpoch({ pid: process.pid, startToken: records.processStartToken(process.pid) });

const OWNER = "session-live-group";
const RUN = "ktsk_live_group";

after(async () => { await shutdownAllShells(200); });

test("a shell whose group outlived its leader still reads as running", async () => {
  const { shell } = spawnBackground(OWNER, RUN, "sleep 120 & exit 0", "leader-gone");
  await new Promise<void>((resolve) => {
    if (shell.process.exitCode !== null) return resolve();
    shell.process.once("exit", () => resolve());
  });
  // Waited for rather than slept through: the leader is collected some unbounded
  // moment after its exit event, and a fixed sleep is a bet on machine load.
  await until(
    () => !existsSync(`/proc/${shell.pid}`),
    `leader ${shell.pid} to be collected`,
  );

  assert.equal(
    shell.status, "running",
    "sanity: the exit handler defers the terminal status while the group lives",
  );

  const resolved = resolveShell(OWNER, RUN, "leader-gone");
  assert.equal(
    resolved.cls, "running",
    `the group is what "still running" means, and both surfaces read this class; got ${resolved.cls}`,
  );
});

after(() => {
  try {
    rmSync(STATE_ROOT_FOR_CLEANUP, { recursive: true, force: true });
  } catch { /* the test's own cleanup is not worth failing a green run over */ }
});
