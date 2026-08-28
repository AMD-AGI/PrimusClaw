// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Who a background shell belongs to, and what happens to it when Hands stops.
 *
 * The registry is process-global and outlives any single request, while a
 * sandbox can be handed to a different run. Keyed by shell id alone, that meant
 * whoever came next could read the previous occupant's output and kill its
 * processes, and a caller-chosen `shell_id` collided across runs. Separately,
 * background children are detached and unref'd, so before there was a shutdown
 * handler a SIGTERM ended Hands and left them running with nothing left that
 * knew their pids.
 *
 * Real processes are spawned here: the properties under test are about signals
 * and process groups, which a fake cannot have.
 */
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";

process.env.WORKSPACE_PATH = tmpdir();
process.env.BG_SHELL_ENABLED = "true";
// Production keeps a finished shell around for a minute so its last output is
// still pollable. Here it only makes one test's leftovers visible to the next.
process.env.BG_SHELL_REAP_DELAY_MS = "10";
// Static imports are evaluated before the file body, and both the workspace and
// the feature flag are read at module load, so the module has to come in after.
const {
  spawnBackground, pollOutput, killShell, listRunningShells, shutdownAllShells, shutdownRunShells,
} = await import("../src/tools/shell/bg-manager.js");

const ALICE = "run-alice";
const BOB = "run-bob";
// The owner is the addressing scope (a DAG root or a session); the run is one
// execution inside it, so several runs share one owner.
const RUN_1 = "ktsk_1";
const RUN_2 = "ktsk_2";

/** Wait for a predicate, polling, so tests do not race a real process. */
async function until(fn: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return fn();
}

afterEach(async () => {
  await shutdownAllShells(200);
  await until(() => listRunningShells(ALICE).length === 0 && listRunningShells(BOB).length === 0);
});

test("one owner cannot read another owner's output", async () => {
  const shell = spawnBackground(ALICE, RUN_1, "echo secret; sleep 30");
  assert.ok(await until(() => pollOutput(ALICE, shell.id).includes("secret")));

  const seenByBob = pollOutput(BOB, shell.id);
  assert.match(seenByBob, /not found/,
    "a sandbox handed to the next run must not come with the last run's output");
  assert.doesNotMatch(seenByBob, /secret/);

  killShell(ALICE, shell.id);
});

test("one owner cannot kill another owner's shell", async () => {
  const shell = spawnBackground(ALICE, RUN_1, "sleep 30");

  assert.match(killShell(BOB, shell.id), /not found/);
  assert.deepEqual(listRunningShells(ALICE), [shell.id],
    "the shell survives a kill it was never addressed by");

  killShell(ALICE, shell.id);
  assert.ok(await until(() => shell.status !== "running"), "its own owner can stop it");
});

test("the same shell name under two owners is two shells", async () => {
  const mine = spawnBackground(ALICE, RUN_1, "sleep 30", "server");
  const theirs = spawnBackground(BOB, RUN_1, "sleep 30", "server");

  assert.notEqual(mine.pid, theirs.pid,
    "'server' is the obvious name, so two runs will both pick it");
  assert.deepEqual(listRunningShells(ALICE), ["server"]);
  assert.deepEqual(listRunningShells(BOB), ["server"]);

  killShell(ALICE, "server");
  assert.ok(await until(() => mine.status !== "running"));
  assert.equal(theirs.status, "running", "killing one must not reach the other");

  killShell(BOB, "server");
});

test("the same owner reusing a live shell name is still an error", () => {
  const shell = spawnBackground(ALICE, RUN_1, "sleep 30", "dup");
  assert.throws(() => spawnBackground(ALICE, RUN_1, "sleep 30", "dup"), /already exists/,
    "silently attaching to an unrelated process would be worse than refusing");
  killShell(ALICE, shell.id);
});

test("a shell started in one turn is still readable in the next", async () => {
  // Owner is the conversation (or the DAG), not one run in it: a server started
  // to be polled later would be useless if it vanished with that run.
  const shell = spawnBackground(ALICE, RUN_1, "echo up; sleep 30", "long-lived");
  assert.ok(await until(() => pollOutput(ALICE, shell.id).includes("up")));

  assert.match(pollOutput(ALICE, "long-lived"), /Status: running/);
  killShell(ALICE, "long-lived");
});

test("polling returns only what is new since the last poll", async () => {
  const shell = spawnBackground(ALICE, RUN_1, "echo first; sleep 30");
  assert.ok(await until(() => pollOutput(ALICE, shell.id).includes("first")));

  assert.match(pollOutput(ALICE, shell.id), /no new output/,
    "re-reading the same bytes would make the model believe the work repeated");
  killShell(ALICE, shell.id);
});

test("shutdown stops every owner's shells, not just the last one's", async () => {
  const a = spawnBackground(ALICE, RUN_1, "sleep 60");
  const b = spawnBackground(BOB, RUN_1, "sleep 60");

  const stopped = await shutdownAllShells(200);
  assert.equal(stopped, 2);
  assert.ok(await until(() => a.status !== "running" && b.status !== "running"),
    "a detached child outlives Node unless it is signalled on the way out");
});

test("shutdown with nothing running is not an error", async () => {
  assert.equal(await shutdownAllShells(10), 0);
});

test("a finished run takes its own shells and leaves its neighbour's", async () => {
  // A batch node ending is the whole point: its dev server has no one left to
  // read it, and it is holding CPU in a sandbox the workspace shares. The other
  // run under the same owner has not ended, so its shells are not its business.
  const mine = spawnBackground(ALICE, RUN_1, "sleep 60", "mine");
  const sibling = spawnBackground(ALICE, RUN_2, "sleep 60", "sibling");

  assert.equal(await shutdownRunShells(RUN_1, 200), 1);
  assert.ok(await until(() => mine.status !== "running"));
  assert.equal(sibling.status, "running",
    "shells are reaped by run, so an unrelated run under the same owner survives");

  killShell(ALICE, "sibling");
});

test("reaping a run that started nothing is not an error", async () => {
  // Most runs never spawn a shell, and Brain reaps unconditionally at the end of
  // every one rather than tracking which ones did.
  assert.equal(await shutdownRunShells("ktsk_never_spawned", 10), 0);
});

test("an unclaimed shell is not reaped by every run that ends", async () => {
  // An older Brain sends no run header, so its shells are filed under no run.
  // Matching them against the empty run would let the next run that ends kill
  // processes it never started.
  const orphan = spawnBackground(ALICE, "", "sleep 60", "orphan");

  assert.equal(await shutdownRunShells("", 10), 0);
  assert.equal(orphan.status, "running", "only shutdown may take an unclaimed shell");

  killShell(ALICE, "orphan");
});

test("with background shells on, the foreground ceiling is the tight one and points at them", async () => {
  // The pairing, from the enabled side: 120s is the ceiling that keeps a
  // handover between replicas clean, and it is affordable only because long work
  // has this feature to go to -- which is why the timeout message names it. The
  // disabled side is in bg-shell-disabled and foreground-ceiling.
  const { bash } = await import("../src/tools/shell/bash.js");
  assert.match(bash.zodSchema.timeout.description!, /capped at 120/);

  const res = await bash.execute({ command: "sleep 5", timeout: 1 });
  assert.match(res.content[0]!.text!, /run_in_background=true/);
});
