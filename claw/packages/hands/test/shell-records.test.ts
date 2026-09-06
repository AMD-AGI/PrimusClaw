// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The durable record, and the states a crash between its phases leaves behind.
 *
 * The registry dies with the process, so after a restart "nothing is tracked"
 * and "nothing is running" collapse into one answer -- and an empty registry
 * then reads as licence to destroy a container with live work in it. These
 * phases are what keep the two apart: a claim with no attachment and a claim
 * with an attachment but no outcome are different facts, and each has its own
 * class.
 */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HANDS_STATE_DIR = mkdtempSync(join(tmpdir(), "claw-records-"));
const records = await import("../src/runtime/shell-records.js");
const { classifyShellRecord } = await import("../src/runtime/shell-classify.js");

const OWNER = "sess-a";
const RUN = "ktsk_1";

function claim(shellId: string, run: string | null = RUN, extra: Record<string, unknown> = {}) {
  return records.claimRecord({
    owner_scope: OWNER,
    run_identity: run,
    shell_id: shellId,
    command_digest: "d",
    kind: "background",
    claimed_at: new Date().toISOString(),
    hands_epoch: "e1",
    ...extra,
  });
}

beforeEach(() => {
  rmSync(process.env.HANDS_STATE_DIR!, { recursive: true, force: true });
  records.mintEpoch({ pid: process.pid, startToken: "t" });
});

test("the claim is an exclusive create, which is the whole arbiter", () => {
  assert.equal(claim("bg-1"), true);
  assert.equal(claim("bg-1"), false,
    "two writers racing one triple cannot both win, so no second process starts");
});

test("one id under two run identities is two records, not a collision", () => {
  assert.equal(claim("server", "ktsk_1"), true);
  assert.equal(claim("server", "ktsk_2"), true, "a sibling run's obvious name is its own");
  assert.notEqual(
    records.readRecord(OWNER, "ktsk_1", "server")!.run_identity,
    records.readRecord(OWNER, "ktsk_2", "server")!.run_identity,
  );
});

test("each phase is durable before the next begins", () => {
  claim("bg-2");
  const claimed = records.readRecord(OWNER, RUN, "bg-2")!;
  assert.equal(claimed.process_identity, undefined, "no process exists yet to identify");
  assert.equal(classifyShellRecord({
    record: claimed, epoch: "current", registry: "absent", process: "unreadable",
  }), "spawn_indeterminate", "a crash here blocks a destroy and is never respawned");

  records.attachRecord(OWNER, RUN, "bg-2", { pid: 4242, startToken: "9" });
  const attached = records.readRecord(OWNER, RUN, "bg-2")!;
  assert.deepEqual(attached.process_identity, { pid: 4242, startToken: "9" });
  assert.equal(attached.status, undefined);

  records.recordOutcome(OWNER, RUN, "bg-2", { status: "exited", exitCode: 0, signal: null });
  const done = records.readRecord(OWNER, RUN, "bg-2")!;
  assert.equal(done.status, "exited");
  assert.equal(done.output_available, true);
});

test("the buffer release is a fourth write, not a value guessed at exit", () => {
  // Exit and the release of the buffers are separated by the reap delay, so a
  // value written at exit would be stale for that whole delay and wrong after.
  claim("bg-3");
  records.attachRecord(OWNER, RUN, "bg-3", { pid: 1, startToken: "1" });
  records.recordOutcome(OWNER, RUN, "bg-3", { status: "exited", exitCode: 0, signal: null });
  assert.equal(records.readRecord(OWNER, RUN, "bg-3")!.output_available, true);

  records.releaseOutput(OWNER, RUN, "bg-3");
  const released = records.readRecord(OWNER, RUN, "bg-3")!;
  assert.equal(released.output_available, false);
  assert.equal(released.status, "exited", "and nothing else on the record moved");
});

test("retention is fixed from the run's own deadline, and an absent one never expires", () => {
  const deadline = new Date(Date.now() + 86_400_000).toISOString();
  claim("bg-4", RUN, { deadline_at: deadline });
  records.attachRecord(OWNER, RUN, "bg-4", { pid: 1, startToken: "1" });
  records.recordOutcome(OWNER, RUN, "bg-4", { status: "exited", exitCode: 0, signal: null });
  assert.equal(records.readRecord(OWNER, RUN, "bg-4")!.retain_until, deadline);

  claim("bg-5");
  records.attachRecord(OWNER, RUN, "bg-5", { pid: 1, startToken: "1" });
  records.recordOutcome(OWNER, RUN, "bg-5", { status: "exited", exitCode: 0, signal: null });
  assert.equal(records.readRecord(OWNER, RUN, "bg-5")!.retain_until, undefined,
    "a run whose budget is configured off carries no deadline, and no clock may "
      + "invent one for it");
});

test("a record hand-written into another triple's location is not read as that triple's", () => {
  claim("bg-7", "ktsk_1");
  const stolen = { ...records.readRecord(OWNER, "ktsk_1", "bg-7")!, run_identity: "ktsk_1" };
  const path = join(
    process.env.HANDS_STATE_DIR!, "scopes",
    ...["sess-a", "ktsk_2"].map((p) => p.replace(/[^A-Za-z0-9_-]/g, (c) =>
      `~${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`)),
  );
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "bg-7"), JSON.stringify(stolen));

  assert.equal(records.readRecord(OWNER, "ktsk_2", "bg-7"), null,
    "the reader re-encodes the record's own fields and rejects a mismatch");
});

test("an absent subtree is not a readable one, so an absence is never a count of zero", () => {
  assert.equal(records.subtreeReadable(), true);
  rmSync(process.env.HANDS_STATE_DIR!, { recursive: true, force: true });
  assert.equal(records.subtreeReadable(), false,
    "reading this as an empty fleet is the inference that destroys live work");
});
