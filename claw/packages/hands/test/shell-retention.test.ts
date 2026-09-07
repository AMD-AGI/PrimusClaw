// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * How long a shell's terminal outcome is kept, and what happens after.
 *
 * The window is the run's own deadline, stamped on the claim, so a run given
 * days keeps its outcomes for days and a later turn reads what happened rather
 * than an absence. A derivation from anything refreshed per turn -- the
 * checkpoint retention, say -- would be shorter than a multi-day deadline and
 * would count down from the wrong instant, so the assertions here run against a
 * simulated clock at an hours-scale offset: a minutes-scale derivation fails.
 *
 * The negative half matters as much. A record with no outcome has no expiry at
 * all, and a start whose deadline header was missing or malformed retains for
 * the sandbox's life rather than for a substituted constant.
 */
import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.WORKSPACE_PATH = tmpdir();
process.env.BG_SHELL_ENABLED = "true";
process.env.BG_SHELL_REAP_DELAY_MS = "10";
process.env.HANDS_STATE_DIR = mkdtempSync(join(tmpdir(), "claw-retention-"));

const records = await import("../src/runtime/shell-records.js");
const liveness = await import("../src/runtime/shell-liveness.js");
const bg = await import("../src/tools/shell/bg-manager.js");
const { withCaller, DEADLINE_HEADER, normalizeDeadline, MalformedDeadline } =
  await import("../src/runtime/owner-context.js");
const { isolatingSandbox, releaseSandboxIsolation } =
  await import("./support/sandbox-isolation.js");

const OWNER = "sess-retain";
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
  await bg.shutdownAllShells(200);
  rmSync(process.env.HANDS_STATE_DIR!, { recursive: true, force: true });
});

const settle = (ms = 120) => new Promise((r) => setTimeout(r, ms));

/** Start a shell as a caller carrying `deadline`, the way the route does. */
function startUnder(deadline: string | undefined, id: string, command = "exit 0"): void {
  withCaller({ owner: OWNER, run: RUN, deadline }, () => {
    bg.spawnBackground(OWNER, RUN, command, id);
  });
}

test("a tombstone still answers finished hours after the post-task window", async () => {
  // Asserted at an hours-scale offset on purpose: a window derived from the
  // idle-reuse window, or from anything refreshed per turn, is minutes long and
  // fails here.
  startUnder(new Date(simulated + 72 * HOUR).toISOString(), "long-deadline");
  await settle(200);

  simulated += 12 * HOUR;
  assert.equal(bg.pollOutput(OWNER, RUN, "long-deadline").structured.shell_class, "finished");
});

test("two runs stamped different deadlines get different windows", async () => {
  startUnder(new Date(simulated + 2 * HOUR).toISOString(), "short");
  startUnder(new Date(simulated + 48 * HOUR).toISOString(), "long");
  await settle(200);

  simulated += 6 * HOUR;
  assert.equal(bg.pollOutput(OWNER, RUN, "short").structured.shell_class, "unknown",
    "the short window is past");
  assert.equal(bg.pollOutput(OWNER, RUN, "long").structured.shell_class, "finished",
    "the long one is not, so the window tracks its source rather than a constant");
});

test("siblings share the expiry their run's deadline fixes, each from its own end", async () => {
  // The early finisher's tombstone is still readable when a long-running
  // sibling ends hours later, both expiring at the one instant the run's
  // deadline gives rather than each a fixed span after its own end.
  const deadline = new Date(simulated + 24 * HOUR).toISOString();
  startUnder(deadline, "early");
  startUnder(deadline, "late", "sleep 60");
  await settle(200);

  simulated += 8 * HOUR;
  assert.equal(bg.pollOutput(OWNER, RUN, "early").structured.shell_class, "finished");
  assert.equal(bg.pollOutput(OWNER, RUN, "late").structured.shell_class, "running");

  bg.killShell(OWNER, RUN, "late");
  await settle(200);
  assert.equal(bg.pollOutput(OWNER, RUN, "early").structured.shell_class, "finished",
    "the early finisher is not aged out by its sibling ending");
});

test("a start with no deadline retains for the sandbox's life", async () => {
  // The fallback for an absent deadline is no expiry, never a substituted
  // constant: a constant would age out a tombstone under a run still reading it.
  assert.equal(normalizeDeadline(undefined), undefined);
  assert.equal(normalizeDeadline(""), undefined);

  startUnder(undefined, "no-deadline");
  await settle(200);

  simulated += 24 * 365 * HOUR;
  assert.equal(bg.pollOutput(OWNER, RUN, "no-deadline").structured.shell_class, "finished");
});

test("a deadline that was sent and cannot be read is refused, not read as absent", () => {
  // Absent means the run states no bound, which retains forever. Reading a
  // malformed value as that substitutes the opposite policy on a run that did
  // state one, and nothing downstream could tell.
  for (const raw of ["not-a-date", "2026-13-45T99:99:99Z", "   x   ", 12345, {}]) {
    assert.throws(() => normalizeDeadline(raw), MalformedDeadline, JSON.stringify(raw));
  }
});

test("a record with no outcome never expires, however long its run is held", () => {
  records.claimRecord({
    owner_scope: OWNER,
    run_identity: RUN,
    shell_id: "still-going",
    command_digest: "d",
    kind: "background",
    claimed_at: new Date(simulated).toISOString(),
    hands_epoch: records.currentEpoch()!.epoch,
    deadline_at: new Date(simulated + HOUR).toISOString(),
  });

  simulated += 500 * HOUR;
  // A claim with no attachment, held far past any window its run gives: it
  // still answers on its own evidence rather than becoming an absence.
  assert.equal(bg.pollOutput(OWNER, RUN, "still-going").structured.shell_class, "spawn_indeterminate");
});

test("an expired tombstone answers unknown, byte for byte like an id never issued", async () => {
  startUnder(new Date(simulated + HOUR).toISOString(), "aged-out");
  await settle(200);

  simulated += 4 * HOUR;
  const expired = bg.pollOutput(OWNER, RUN, "aged-out");
  const never = bg.pollOutput(OWNER, RUN, "never-issued");
  assert.equal(expired.structured.shell_class, "unknown");
  assert.deepEqual(expired, never, "an aged-out outcome is not distinguishable from an absence");
});

test("replaying past the window is retry_expired, and starts no second process", async () => {
  startUnder(new Date(simulated + HOUR).toISOString(), "replayed");
  await settle(200);
  simulated += 4 * HOUR;

  const replay = withCaller({ owner: OWNER, run: RUN }, () =>
    bg.spawnBackground(OWNER, RUN, "exit 0", "replayed"));

  assert.equal(replay.resolution, "retry_expired", "explicitly not a first call");
  assert.equal(replay.shell, undefined, "no second process was started");

  // A start under a different id is unaffected: the protection is per record.
  const fresh = withCaller({ owner: OWNER, run: RUN }, () =>
    bg.spawnBackground(OWNER, RUN, "exit 0", "different-id"));
  assert.equal(fresh.resolution, "first_call");
});

test("the deadline reaches the claim through the header, not a constant", async () => {
  // The record is what a reader over the exec channel has, with no Brain
  // reachable, so the window has to be computable from the record alone.
  const deadline = new Date(simulated + 5 * HOUR).toISOString();
  startUnder(deadline, "stamped");
  await settle(200);

  const record = records.readRecord(OWNER, RUN, "stamped");
  assert.equal(record?.deadline_at, deadline);
  assert.equal(record?.retain_until, deadline, "the window is fixed at the outcome write");
  assert.equal(DEADLINE_HEADER, "x-claw-deadline");
});

test("tombstones do not hold a sandbox open or consume the concurrency ceiling", async () => {
  // Two batches, each within the ceiling, with the first finished before the
  // second starts: if a tombstone held a slot the second batch would be
  // refused, and a sandbox that had finished every command would admit none.
  const deadline = new Date(simulated + 100 * HOUR).toISOString();
  for (let i = 0; i < 12; i++) startUnder(deadline, `done-a-${i}`);
  await settle(400);
  for (let i = 0; i < 12; i++) startUnder(deadline, `done-b-${i}`);
  await settle(400);

  assert.equal(bg.runningShellCount(OWNER), 0, "finished work holds nothing open");
  startUnder(deadline, "still-admitted", "sleep 60");
  assert.equal(bg.pollOutput(OWNER, RUN, "still-admitted").structured.shell_class, "running");
  assert.equal(bg.runningShellCount(OWNER), 1, "and a genuinely running shell is counted");
  bg.killShell(OWNER, RUN, "still-admitted");
});
