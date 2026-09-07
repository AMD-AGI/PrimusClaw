// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a caller is told about a shell, and what it cannot learn from the answer.
 *
 * The class comes from the durable record and is published as a field. The
 * in-process registry cannot supply it: it knows a shell for one reap delay
 * after it exits and nothing at all after a restart, so six different fates
 * collapse into one sentence there. The single absence answer carries nothing a
 * caller could difference.
 */
import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.WORKSPACE_PATH = tmpdir();
process.env.BG_SHELL_ENABLED = "true";
process.env.BG_SHELL_REAP_DELAY_MS = "10";
process.env.HANDS_STATE_DIR = mkdtempSync(join(tmpdir(), "claw-class-"));

const records = await import("../src/runtime/shell-records.js");
const bg = await import("../src/tools/shell/bg-manager.js");

const { isolatingSandbox } = await import("./support/sandbox-isolation.js");
isolatingSandbox();

const OWNER = "sess-class";
const RUN = "ktsk_1";
const strays: ChildProcess[] = [];

beforeEach(() => {
  rmSync(process.env.HANDS_STATE_DIR!, { recursive: true, force: true });
  records.mintEpoch({ pid: process.pid, startToken: records.processStartToken(process.pid) });
});

after(async () => {
  for (const child of strays) child.kill("SIGKILL");
  await bg.shutdownAllShells(200);
  rmSync(process.env.HANDS_STATE_DIR!, { recursive: true, force: true });
});

const settle = (ms = 60) => new Promise((r) => setTimeout(r, ms));

test("a running shell reads `running` on all three verbs", async () => {
  bg.spawnBackground(OWNER, RUN, "sleep 60", "live");
  try {
    assert.equal(bg.pollOutput(OWNER, RUN, "live").structured.shell_class, "running");
    const waited = bg.waitForShellExit(OWNER, RUN, "live", 20);
    assert.ok(waited instanceof Promise, "a running shell is the one class a wait blocks on");
    assert.equal(await waited, null, "it timed out rather than resolving");
    assert.equal(bg.killShell(OWNER, RUN, "live").structured.shell_class, "running");
  } finally {
    bg.killShell(OWNER, RUN, "live");
  }
});

test("a shell that exited and was reaped reads `finished`, never the possibly-lost wording", async () => {
  bg.spawnBackground(OWNER, RUN, "echo out; exit 3", "gone");
  // Past the reap delay, so the registry entry is dropped and only the record
  // is left -- which is exactly when this used to answer "possibly lost".
  await settle(250);

  const polled = bg.pollOutput(OWNER, RUN, "gone");
  assert.equal(polled.structured.shell_class, "finished");
  assert.equal(polled.structured.output_available, false);
  assert.equal(polled.isError, false);
  assert.doesNotMatch(polled.text, /possibly lost/);
  assert.equal(polled.structured.exit_code, 3);

  const waited = bg.waitForShellExit(OWNER, RUN, "gone", 20_000);
  assert.ok(!(waited instanceof Promise), "a tombstone resolves the wait without blocking");
  assert.equal((waited as { cls: string }).cls, "finished");

  assert.equal(bg.killShell(OWNER, RUN, "gone").structured.shell_class, "finished");
});

test("a shell whose process is gone under a stale epoch reads `lost`, not `finished`", () => {
  const child = spawn("/bin/sh", ["-c", "sleep 60"], { detached: true, stdio: "ignore" });
  child.unref();
  strays.push(child);
  records.claimRecord({
    owner_scope: OWNER,
    run_identity: RUN,
    shell_id: "orphan",
    command_digest: "d",
    kind: "background",
    claimed_at: new Date().toISOString(),
    hands_epoch: "an-epoch-no-longer-current",
  });
  records.attachRecord(OWNER, RUN, "orphan", {
    pid: child.pid!, startToken: records.processStartToken(child.pid!),
  });

  // Live process, stale epoch: nobody can collect its status any more, so the
  // honest answer is `lost` and never `running` on the strength of the table.
  assert.equal(bg.pollOutput(OWNER, RUN, "orphan").structured.shell_class, "lost");

  child.kill("SIGKILL");
});

test("a claim with no process identity reads `spawn_indeterminate`", () => {
  records.claimRecord({
    owner_scope: OWNER,
    run_identity: RUN,
    shell_id: "claim-only",
    command_digest: "d",
    kind: "background",
    claimed_at: new Date().toISOString(),
    hands_epoch: records.currentEpoch()!.epoch,
  });

  assert.equal(bg.pollOutput(OWNER, RUN, "claim-only").structured.shell_class, "spawn_indeterminate");
  const waited = bg.waitForShellExit(OWNER, RUN, "claim-only", 20_000);
  assert.ok(!(waited instanceof Promise), "there is no process to attach a waiter to");
  assert.equal((waited as { cls: string }).cls, "spawn_indeterminate");
});

test("every absence answers the same bytes, whichever absence it is", () => {
  // Four different absences, one answer. Differencing them is the leak: a
  // caller must not be able to tell another scope's shell from one that was
  // never issued, or either from a subtree it may not read.
  bg.spawnBackground(OWNER, RUN, "sleep 60", "not-yours");
  try {
    const answers = [
      bg.pollOutput("other-owner", RUN, "not-yours"),
      bg.pollOutput(OWNER, "other-run", "not-yours"),
      bg.pollOutput(OWNER, RUN, "never-issued"),
      bg.pollOutput("other-owner", "other-run", "also-never-issued"),
    ];
    for (const answer of answers) assert.deepEqual(answer, answers[0]);
    assert.equal(answers[0].structured.shell_class, "unknown");
    // No id, no reason, no kind: nothing that varies with what was found.
    assert.equal(answers[0].text, "Error: shell not found");
  } finally {
    bg.killShell(OWNER, RUN, "not-yours");
  }
});

test("the three verbs refuse an absence identically to one another", () => {
  const polled = bg.pollOutput(OWNER, RUN, "absent");
  const killed = bg.killShell(OWNER, RUN, "absent");
  const waited = bg.waitForShellExit(OWNER, RUN, "absent", 20_000);

  assert.deepEqual(polled, killed);
  assert.ok(!(waited instanceof Promise));
  assert.equal((waited as { cls: string }).cls, "unknown");
});

test("classifying a shell moves no read offset", async () => {
  bg.spawnBackground(OWNER, RUN, "echo first; sleep 60", "offsets");
  try {
    await settle(150);
    // Two classification reads, then one poll: the poll must still return the
    // bytes, or a preflight built on this would eat the output a wait owes.
    bg.resolveShell(OWNER, RUN, "offsets");
    bg.resolveShell(OWNER, RUN, "offsets");
    assert.match(bg.pollOutput(OWNER, RUN, "offsets").text, /first/);
    assert.match(bg.pollOutput(OWNER, RUN, "offsets").text, /no new output/);
  } finally {
    bg.killShell(OWNER, RUN, "offsets");
  }
});

test("the real classification read consumes nothing a poll would have returned", async () => {
  // The production preflight is this call, not a stand-in: a classification
  // that touched the ring buffer would delete output no later call can
  // reproduce, and the wait that follows owes those bytes to its caller.
  bg.spawnBackground(OWNER, RUN, "echo first-line; echo second-line; sleep 60", "owed");
  try {
    await settle(250);

    // Ten real classification reads, the same call the wait preflight makes.
    for (let i = 0; i < 10; i++) {
      assert.equal(bg.resolveShell(OWNER, RUN, "owed").cls, "running");
    }

    // A poll issued after them returns exactly what a poll issued instead of
    // them would have: every byte, once.
    const afterClassifying = bg.pollOutput(OWNER, RUN, "owed").text;
    assert.match(afterClassifying, /first-line/);
    assert.match(afterClassifying, /second-line/);
    assert.match(bg.pollOutput(OWNER, RUN, "owed").text, /no new output/);
  } finally {
    bg.killShell(OWNER, RUN, "owed");
  }
});

test("a wait's own output is unaffected by having been classified first", async () => {
  // The offsets the two paths leave have to agree: whichever the caller used,
  // it has seen the same bytes and the next call continues after them.
  bg.spawnBackground(OWNER, RUN, "echo shared-line; sleep 60", "plain");
  bg.spawnBackground(OWNER, RUN, "echo shared-line; sleep 60", "preflighted");
  try {
    await settle(250);

    bg.resolveShell(OWNER, RUN, "preflighted");
    const withPreflight = bg.pollOutput(OWNER, RUN, "preflighted").text;
    const without = bg.pollOutput(OWNER, RUN, "plain").text;

    assert.equal(
      withPreflight.replace(/preflighted/g, "S"),
      without.replace(/plain/g, "S"),
      "classifying first changed what the read returned",
    );
    assert.match(withPreflight, /shared-line/);
  } finally {
    for (const id of ["plain", "preflighted"]) bg.killShell(OWNER, RUN, id);
  }
});
