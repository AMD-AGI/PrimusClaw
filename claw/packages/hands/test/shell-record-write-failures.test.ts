// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A durable phase that could not be written is never reported as one that was.
 *
 * The record's phases are what every later reader classifies from: a claim with
 * no attachment is `spawn_indeterminate` for the rest of the sandbox's life, and
 * a terminal outcome that never lands leaves the exit code held only by the
 * process that collected it. Swallowing either write's failure turns a disk
 * fault into a start reported as made and a shell reported as finished, with
 * nothing on disk agreeing.
 *
 * The failure is injected at the staging directory every amend writes through,
 * which is what a read-only or full filesystem looks like from here.
 */
import test, { after, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.WORKSPACE_PATH = tmpdir();
process.env.BG_SHELL_ENABLED = "true";
process.env.BG_SHELL_REAP_DELAY_MS = "10";
process.env.HANDS_STATE_DIR = mkdtempSync(join(tmpdir(), "claw-write-fail-"));

const records = await import("../src/runtime/shell-records.js");
const bg = await import("../src/tools/shell/bg-manager.js");
const { isolatingSandbox, releaseSandboxIsolation } =
  await import("./support/sandbox-isolation.js");

const OWNER = "sess-writes";
const RUN = "ktsk_1";
const STAGING = join(process.env.HANDS_STATE_DIR!, "staging");

/** Every amend stages through this directory, so a file in its place fails them all. */
function breakDurableWrites(): void {
  rmSync(STAGING, { recursive: true, force: true });
  writeFileSync(STAGING, "not a directory");
}

/** Structured lifecycle logs go to stdout; this is how a test reads them. */
function capturingLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const real = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  return { lines, restore: () => { console.log = real; } };
}

beforeEach(() => {
  isolatingSandbox();
  rmSync(process.env.HANDS_STATE_DIR!, { recursive: true, force: true });
  records.mintEpoch({ pid: process.pid, startToken: records.processStartToken(process.pid) });
});

afterEach(async () => {
  await bg.shutdownAllShells(200);
});

after(() => {
  releaseSandboxIsolation();
  rmSync(process.env.HANDS_STATE_DIR!, { recursive: true, force: true });
});

test("an attachment that cannot be written fails the start rather than reporting one", async () => {
  breakDurableWrites();
  const logs = capturingLogs();
  try {
    assert.throws(
      () => bg.spawnBackground(OWNER, RUN, "sleep 5", "attach-fails"),
      bg.ShellStartNotDurable,
      "a start whose record stays claim-only must not be reported as made",
    );
  } finally {
    logs.restore();
  }
  assert.ok(logs.lines.some((l) => l.includes("shell.attachment_not_durable")),
    "and it is said out loud, since the record itself could not say it");
});

test("a terminal outcome that cannot be written is reported, and its entry kept", async () => {
  // The exit code exists only in the entry once the write has failed, so the
  // reap that ordinarily tidies it away is the loss itself.
  const logs = capturingLogs();
  let started: { shell?: { id: string } };
  try {
    started = bg.spawnBackground(OWNER, RUN, "exit 3", "outcome-fails");
    breakDurableWrites();
    await new Promise((r) => setTimeout(r, 400));
  } finally {
    logs.restore();
  }

  assert.ok(logs.lines.some((l) => l.includes("shell.outcome_not_durable")),
    "the failed outcome write is surfaced rather than discarded");
  const resolved = bg.resolveShell(OWNER, RUN, started.shell!.id);
  assert.ok(resolved.shell, "the entry holding the only copy of the outcome is kept");
  assert.equal(resolved.shell!.exitCode, 3);
});

test("both writes landing leaves the ordinary path exactly as it was", async () => {
  const started = bg.spawnBackground(OWNER, RUN, "exit 0", "both-land");
  await new Promise((r) => setTimeout(r, 400));

  const record = records.readRecord(OWNER, RUN, started.shell!.id);
  assert.equal(record?.status, "exited");
  assert.equal(record?.exit_code, 0);
});
