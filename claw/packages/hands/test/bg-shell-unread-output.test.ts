// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A finished shell's output stays readable until someone reads it.
 *
 * The turn that reads a background shell is often not the one that started it:
 * a session woken because the shell finished, or a person asking later, polls
 * minutes after the exit. The entry used to be dropped one reap delay after the
 * exit whatever had been read, so that poll answered with the outcome and none
 * of what the command printed. The reap delay here is milliseconds so the
 * "later" poll is past it many times over.
 */
import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.WORKSPACE_PATH = tmpdir();
process.env.BG_SHELL_ENABLED = "true";
process.env.BG_SHELL_REAP_DELAY_MS = "10";
process.env.BG_SHELL_MAX_UNREAD_RETAINED = "2";
process.env.HANDS_STATE_DIR = mkdtempSync(join(tmpdir(), "claw-unread-"));

const records = await import("../src/runtime/shell-records.js");
const bg = await import("../src/tools/shell/bg-manager.js");
const { isolatingSandbox, releaseSandboxIsolation } =
  await import("./support/sandbox-isolation.js");

const OWNER = "sess-unread";
const RUN = "run-1";

let n = 0;
const fresh = (base: string) => `${base}-${++n}`;

beforeEach(() => {
  isolatingSandbox();
  rmSync(process.env.HANDS_STATE_DIR!, { recursive: true, force: true });
  records.mintEpoch({ pid: process.pid, startToken: records.processStartToken(process.pid) });
});

after(async () => {
  releaseSandboxIsolation();
  await bg.shutdownAllShells(200);
  rmSync(process.env.HANDS_STATE_DIR!, { recursive: true, force: true });
});

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("output nobody read is still there long after the reap delay", async () => {
  const id = fresh("late-reader");
  bg.spawnBackground(OWNER, RUN, "echo BGDONE-late; echo err-late 1>&2", id);
  await settle(500);

  const answer = bg.pollOutput(OWNER, RUN, id);
  assert.equal(answer.structured.shell_class, "finished");
  assert.equal(answer.structured.output_available, true);
  assert.match(answer.text, /Outcome: exited \(exit_code=0\)/);
  assert.match(answer.text, /BGDONE-late/, "the poll after the reap delay lost the shell's stdout");
  assert.match(answer.text, /err-late/, "the poll after the reap delay lost the shell's stderr");
});

test("once read, the finished entry is dropped after the reap delay as before", async () => {
  const id = fresh("read-once");
  bg.spawnBackground(OWNER, RUN, "echo BGDONE-read", id);
  await settle(200);
  assert.match(bg.pollOutput(OWNER, RUN, id).text, /BGDONE-read/);

  await settle(200);
  const again = bg.pollOutput(OWNER, RUN, id);
  assert.equal(again.structured.shell_class, "finished", "the outcome is still answered");
  assert.equal(again.structured.output_available, false, "the read buffer was released");
  assert.doesNotMatch(again.text, /BGDONE-read/, "read output is not handed out twice");
});

test("unread output is kept for the newest finished shells only", async () => {
  const ids = [fresh("oldest"), fresh("middle"), fresh("newest")];
  for (const id of ids) {
    bg.spawnBackground(OWNER, RUN, `echo OUT-${id}`, id);
    await settle(80);
  }
  await settle(300);

  const [oldest, middle, newest] = ids.map((id) => bg.pollOutput(OWNER, RUN, id));
  assert.equal(oldest.structured.output_available, false, "past the bound, the oldest buffer goes");
  assert.doesNotMatch(oldest.text, /OUT-/);
  assert.match(middle.text, new RegExp(`OUT-${ids[1]}`));
  assert.match(newest.text, new RegExp(`OUT-${ids[2]}`));
});
