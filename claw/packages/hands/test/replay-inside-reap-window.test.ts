// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A replay that arrives while the finished shell is still registered.
 *
 * An exited shell stays in the in-process registry for one reap delay so its
 * last output remains pollable. That entry is not a running process, and
 * treating it as a collision answers a replay with "already exists" instead of
 * the resolution its record already fixes -- an answer that depends on how long
 * the reap timer happened to take rather than on anything durable.
 *
 * The reap window is held wide open here so the case is reached every run
 * rather than raced for: with the default delay the entry is usually gone
 * before a replay can arrive, which is precisely what makes the ordering easy
 * to get wrong and hard to notice.
 */
import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.WORKSPACE_PATH = tmpdir();
process.env.BG_SHELL_ENABLED = "true";
process.env.BG_SHELL_REAP_DELAY_MS = "600000";
process.env.HANDS_STATE_DIR = mkdtempSync(join(tmpdir(), "claw-replay-window-"));

const records = await import("../src/runtime/shell-records.js");
const liveness = await import("../src/runtime/shell-liveness.js");
const bg = await import("../src/tools/shell/bg-manager.js");
const { withCaller } = await import("../src/runtime/owner-context.js");
const { isolatingSandbox, releaseSandboxIsolation } =
  await import("./support/sandbox-isolation.js");

const OWNER = "sess-window";
const RUN = "ktsk_1";
const HOUR = 3_600_000;
let simulated = Date.parse("2026-01-01T00:00:00.000Z");

beforeEach(() => {
  isolatingSandbox();
  rmSync(process.env.HANDS_STATE_DIR!, { recursive: true, force: true });
  records.mintEpoch({ pid: process.pid, startToken: records.processStartToken(process.pid) });
  simulated = Date.parse("2026-01-01T00:00:00.000Z");
  liveness.bindClock(() => simulated);
});

after(async () => {
  liveness.bindClock(null);
  releaseSandboxIsolation();
  await bg.shutdownAllShells(250);
  rmSync(process.env.HANDS_STATE_DIR!, { recursive: true, force: true });
});

/** Start as a caller carrying `deadline`, then wait for the process to end. */
async function startAndFinish(deadline: string, id: string): Promise<void> {
  const started = withCaller({ owner: OWNER, run: RUN, deadline }, () =>
    bg.spawnBackground(OWNER, RUN, "exit 0", id));
  await new Promise<void>((resolve) => {
    if (started.shell!.status !== "running") return resolve();
    started.shell!.process.once("exit", () => setImmediate(resolve));
  });
  // Still registered: the delay above is far longer than this fixture runs.
  assert.equal(bg.resolveShell(OWNER, RUN, id).shell?.id, id,
    "the fixture needs the entry still present to be about anything");
}

test("a replay past the window is retry_expired even with the entry still registered", async () => {
  await startAndFinish(new Date(simulated + HOUR).toISOString(), "aged");
  simulated += 4 * HOUR;

  const replay = withCaller({ owner: OWNER, run: RUN }, () =>
    bg.spawnBackground(OWNER, RUN, "exit 0", "aged"));

  assert.equal(replay.resolution, "retry_expired",
    "the lingering entry answered instead of the record");
  assert.equal(replay.shell, undefined, "no second process was started");
});

test("a replay inside the window is refused on the record, not on the entry", async () => {
  // Still a refusal for a start carrying no intent key -- the collision is the
  // documented answer there -- but reached through the record's exclusive
  // create rather than through whatever the registry happens to still hold.
  await startAndFinish(new Date(simulated + 10 * HOUR).toISOString(), "fresh");

  assert.throws(
    () => withCaller({ owner: OWNER, run: RUN }, () =>
      bg.spawnBackground(OWNER, RUN, "exit 0", "fresh")),
    /already exists/,
  );
  // And the finished shell's own answer is untouched by the attempt.
  assert.equal(bg.resolveShell(OWNER, RUN, "fresh").cls, "finished");
});

test("a running shell is still a collision, on the entry alone", async () => {
  withCaller({ owner: OWNER, run: RUN, deadline: undefined }, () =>
    bg.spawnBackground(OWNER, RUN, "sleep 60", "live"));
  try {
    assert.throws(
      () => bg.spawnBackground(OWNER, RUN, "sleep 60", "live"),
      /already exists/,
    );
  } finally {
    bg.killShell(OWNER, RUN, "live");
  }
});
