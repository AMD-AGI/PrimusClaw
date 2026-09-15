// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A run holds several shells, and nothing about it may be true only for one.
 *
 * Every fixture here starts at least two shells for one run identity -- a
 * primary and a monitor -- so a 1:1 assumption cannot pass by accident. That is
 * the shape the registry, the reap, the classification and the record subtree
 * all have to hold at, and a suite built on a single shell per run cannot tell
 * a per-run answer from a per-shell one.
 *
 * The negative half is asserted over whole surfaces rather than named fields:
 * what another scope must not learn is not a list of forbidden keys, it is
 * everything, so the scan is of every byte a caller can see.
 */
import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.WORKSPACE_PATH = tmpdir();
process.env.BG_SHELL_ENABLED = "true";
process.env.BG_SHELL_REAP_DELAY_MS = "60000";
process.env.HANDS_STATE_DIR = mkdtempSync(join(tmpdir(), "claw-n-shells-"));

const records = await import("../src/runtime/shell-records.js");
const bg = await import("../src/tools/shell/bg-manager.js");
const { isolatingSandbox, releaseSandboxIsolation } =
  await import("./support/sandbox-isolation.js");

const OWNER = "sess-n";
const RUN = "ktsk_primary";
const SIBLING_RUN = "ktsk_sibling";

beforeEach(() => {
  isolatingSandbox();
  rmSync(process.env.HANDS_STATE_DIR!, { recursive: true, force: true });
  records.mintEpoch({ pid: process.pid, startToken: records.processStartToken(process.pid) });
});

after(async () => {
  releaseSandboxIsolation();
  await bg.shutdownAllShells(250);
  rmSync(process.env.HANDS_STATE_DIR!, { recursive: true, force: true });
});

const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));
const classOf = (owner: string, run: string, id: string) =>
  bg.pollOutput(owner, run, id).structured.shell_class;

test("a run's primary and monitor are addressed individually, in either order", async () => {
  bg.spawnBackground(OWNER, RUN, "echo primary-out; sleep 60", "primary");
  bg.spawnBackground(OWNER, RUN, "echo monitor-out; sleep 60", "monitor", "monitor");
  await settle();

  // Each returns its own output, not the other's.
  assert.match(bg.pollOutput(OWNER, RUN, "primary").text, /primary-out/);
  assert.doesNotMatch(bg.pollOutput(OWNER, RUN, "monitor").text, /primary-out/);

  // Killed in an order differing from the start order, and killing one leaves
  // the other running and pollable.
  bg.killShell(OWNER, RUN, "monitor");
  await settle();
  assert.equal(classOf(OWNER, RUN, "monitor"), "finished");
  assert.equal(classOf(OWNER, RUN, "primary"), "running", "a sibling's kill ended the wrong shell");
  assert.match(bg.pollOutput(OWNER, RUN, "primary").text, /no new output/);

  // And a wait behaves per shell: the finished one resolves at once, the live
  // one is the only class a wait blocks on.
  const finished = bg.waitForShellExit(OWNER, RUN, "monitor", 20_000);
  assert.ok(!(finished instanceof Promise));
  const live = bg.waitForShellExit(OWNER, RUN, "primary", 20);
  assert.ok(live instanceof Promise);
  assert.equal(await live, null);

  bg.killShell(OWNER, RUN, "primary");
});

test("a run ending takes all of its shells and leaves another run's", async () => {
  bg.spawnBackground(OWNER, RUN, "sleep 60", "job");
  bg.spawnBackground(OWNER, RUN, "sleep 60", "watch", "monitor");
  bg.spawnBackground(OWNER, SIBLING_RUN, "sleep 60", "neighbour");
  await settle();

  const report = await bg.shutdownRunShells(OWNER, RUN, 250);
  assert.equal(report.shells.length, 2, "a reap that takes one of two leaves work nobody will read");
  assert.deepEqual(
    report.shells.map((s) => s.shell_id).sort(),
    ["job", "watch"],
    "both of the run's shells were addressed",
  );

  await settle();
  assert.equal(classOf(OWNER, SIBLING_RUN, "neighbour"), "running",
    "another run's work went with it");
  bg.killShell(OWNER, SIBLING_RUN, "neighbour");
});

test("siblings classify independently, one finished beside one running", async () => {
  bg.spawnBackground(OWNER, RUN, "exit 0", "early");
  bg.spawnBackground(OWNER, RUN, "sleep 60", "late");
  await settle(300);

  assert.equal(classOf(OWNER, RUN, "early"), "finished");
  assert.equal(classOf(OWNER, RUN, "late"), "running");
  assert.equal(bg.runningShellCount(OWNER), 1, "a finished sibling does not inflate the count");
  bg.killShell(OWNER, RUN, "late");
});

test("holding one of a run's ids confers no reach to its siblings", async () => {
  // A foreign caller that legitimately learned one id -- from a transcript, a
  // log, a shared plan -- must gain nothing from it about the rest.
  for (const id of ["alpha", "beta", "gamma"]) {
    bg.spawnBackground(OWNER, RUN, "sleep 60", id);
  }
  await settle();

  const refusals = ["alpha", "beta", "gamma", "never-issued"].map(
    (id) => bg.pollOutput("other-owner", "other-run", id),
  );
  for (const refusal of refusals) assert.deepEqual(refusal, refusals[0]);
  assert.equal(refusals[0].structured.shell_class, "unknown");

  // Nor does any surface say how many another scope holds.
  assert.equal(bg.runningShellCount("other-owner"), 0);
  for (const id of ["alpha", "beta", "gamma"]) bg.killShell(OWNER, RUN, id);
});

test("no caller-visible byte names another scope's work, at N greater than one", async () => {
  // Scanned whole rather than field by field, and for tokens planted in the
  // commands: a leak through a field nobody thought to check reads the same as
  // no leak at all under a per-field assertion. Two shells, because a scan over
  // one cannot see a leak that names a sibling.
  const TOKENS = ["planted-9q8w7e", "planted-4r5t6y"];
  const started = [
    bg.spawnBackground(OWNER, RUN, `echo ${TOKENS[0]}; sleep 60`, "secretive"),
    bg.spawnBackground(OWNER, RUN, `echo ${TOKENS[1]}; sleep 60`, "secretive-monitor", "monitor"),
  ];
  await settle();

  // The real process identities of the shells being hidden, not this runner's.
  const theirPids = started.map((s) => String(s.shell!.pid));
  assert.ok(theirPids.every((pid) => pid !== String(process.pid)),
    "the fixture has to hide real spawned processes, not the test runner");

  const visible = [
    ...["secretive", "secretive-monitor", "anything"].flatMap((id) => [
      JSON.stringify(bg.pollOutput("intruder", "intruder-run", id)),
      JSON.stringify(bg.killShell("intruder", "intruder-run", id)),
      JSON.stringify(bg.waitForShellExit("intruder", "intruder-run", id, 10)),
    ]),
  ].join("\n");

  const forbidden = [...TOKENS, ...theirPids, OWNER, RUN, "secretive", "monitor", "scopes/"];
  for (const needle of forbidden) {
    assert.doesNotMatch(visible, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      `a caller-visible answer named ${needle}`);
  }

  // The record subtree holds no raw command either -- only the digest, and the
  // two siblings' digests differ.
  const digests = ["secretive", "secretive-monitor"].map((id) => {
    const record = records.readRecord(OWNER, RUN, id);
    assert.ok(record, id);
    for (const token of TOKENS) assert.doesNotMatch(JSON.stringify(record), new RegExp(token));
    return record.command_digest;
  });
  assert.notEqual(digests[0], digests[1], "two commands digest to one value");

  for (const id of ["secretive", "secretive-monitor"]) bg.killShell(OWNER, RUN, id);
});

test("concurrent starts under one run each get a record, and none is lost", async () => {
  // Several at once, wider than two, so a lost update has somewhere to hide.
  const ids = Array.from({ length: 6 }, (_, i) => `concurrent-${i}`);
  await Promise.all(ids.map(async (id) => bg.spawnBackground(OWNER, RUN, "sleep 60", id)));
  await settle();

  for (const id of ids) {
    assert.ok(records.readRecord(OWNER, RUN, id), `${id} has no record`);
    assert.equal(classOf(OWNER, RUN, id), "running");
  }
  assert.equal(records.listRecordsForOwner(OWNER).length, ids.length);
  for (const id of ids) bg.killShell(OWNER, RUN, id);
});

test("the same shell id under two run identities is two shells, neither reachable from the other", async () => {
  bg.spawnBackground(OWNER, RUN, "echo mine; sleep 60", "shared-name");
  bg.spawnBackground(OWNER, SIBLING_RUN, "echo theirs; sleep 60", "shared-name");
  await settle();

  assert.match(bg.pollOutput(OWNER, RUN, "shared-name").text, /mine/);
  assert.match(bg.pollOutput(OWNER, SIBLING_RUN, "shared-name").text, /theirs/);

  // Two records, neither overwriting the other.
  assert.notDeepEqual(
    records.readRecord(OWNER, RUN, "shared-name"),
    records.readRecord(OWNER, SIBLING_RUN, "shared-name"),
  );

  bg.killShell(OWNER, RUN, "shared-name");
  await settle();
  assert.equal(classOf(OWNER, SIBLING_RUN, "shared-name"), "running",
    "killing one run's shell ended the other run's");
  bg.killShell(OWNER, SIBLING_RUN, "shared-name");
});

test("siblings finishing at the same moment both persist their outcome", async () => {
  const ids = ["together-a", "together-b", "together-c"];
  for (const id of ids) bg.spawnBackground(OWNER, RUN, "exit 0", id);
  await settle(400);

  for (const id of ids) {
    const record = records.readRecord(OWNER, RUN, id);
    assert.equal(record?.status, "exited", `${id} lost its outcome to a sibling's write`);
    assert.equal(classOf(OWNER, RUN, id), "finished");
  }
});
