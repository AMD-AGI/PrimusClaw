// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the gate reads before anything destroys a container.
 *
 * The count comes from the durable records over the container-exec channel,
 * never from an HTTP call to Hands -- this runs on exactly the path where Hands
 * is what is down. The properties that matter are the ones that refuse: a
 * sandbox filing no records, an unreadable subtree, a record that will not
 * parse, and an exec that never answered must each be `unknown` and never a
 * count of zero, because zero is what licenses the destroy.
 */
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { bindContainerProbeEffects } from "../src/sandbox/container-probe.js";
import { countLiveWork } from "../src/sandbox/live-work-gate.js";
import type { SandboxInstance } from "../src/sandbox/provider.js";

const INST: SandboxInstance = {
  provider: "agent-sandbox",
  id: "s-1",
  sandboxName: "sb-1",
  namespace: "ns",
  handsBaseUrl: "",
};
const STATE_DIR = "/tmp/.claw-hands";

let restore: (() => void) | null = null;
afterEach(() => { restore?.(); restore = null; });

/** A sandbox whose exec answers with this stdout, or throws. */
function sandboxAnswering(stdout: string | Error): void {
  restore = bindContainerProbeEffects({
    exec: async () => {
      if (stdout instanceof Error) throw stdout;
      return { stdout, stderr: "", exitCode: 0 } as never;
    },
  });
}

const MARKER = { epoch: "e1", bearer: { pid: 7, startToken: "t7" } };

function transcript(lines: {
  marker?: unknown;
  subtree?: string;
  records?: unknown[];
  pids?: number[];
}): string {
  const out = [`MARKER ${lines.marker === undefined ? "none" : JSON.stringify(lines.marker)}`];
  out.push(`SUBTREE ${lines.subtree ?? "ok"}`);
  for (const record of lines.records ?? []) out.push(`RECORD ${JSON.stringify(record)}`);
  out.push(`PROCS ${(lines.pids ?? []).join(" ")}`);
  return out.join("\n");
}

const running = (over: Record<string, unknown> = {}) => ({
  owner_scope: "sess-1",
  run_identity: "run-1",
  shell_id: "bg-1",
  command_digest: "d",
  kind: "background",
  claimed_at: "2026-01-01T00:00:00.000Z",
  hands_epoch: "e1",
  process_identity: { pid: 42, startToken: "t42" },
  ...over,
});

test("a live shell under a current epoch protects the container", async () => {
  // Coarser than the in-sandbox view on purpose: the in-process registry is not
  // exec-visible, so a row that would read `running` there reads
  // `unverified_running` here. No row moves from blocking to non-blocking,
  // which is the direction that matters.
  sandboxAnswering(transcript({ marker: MARKER, records: [running()], pids: [7, 42] }));
  const answer = await countLiveWork(INST, STATE_DIR);
  assert.equal(answer.verdict, "protected");
  assert.equal(answer.classes.unverified_running, 1);
});

test("a sandbox with no records left is the only answer that permits a destroy", async () => {
  sandboxAnswering(transcript({ marker: MARKER, records: [], pids: [7] }));
  assert.equal((await countLiveWork(INST, STATE_DIR)).verdict, "clear");
});

test("a sandbox filing no records is unknown, never a count of zero", async () => {
  // A process minting no epoch marker is pre-scheme: its shells are
  // registry-only and invisible to any record count, so an empty read there
  // says nothing at all about what is running.
  sandboxAnswering(transcript({ marker: undefined, records: [], pids: [1] }));
  const answer = await countLiveWork(INST, STATE_DIR);
  assert.equal(answer.verdict, "unknown");
  assert.equal(answer.reason, "no_epoch_marker");
});

test("an unreadable subtree is unknown, and so is a missing one", async () => {
  for (const subtree of ["empty", "missing"]) {
    sandboxAnswering(transcript({ marker: MARKER, subtree, pids: [7] }));
    assert.equal((await countLiveWork(INST, STATE_DIR)).verdict, "unknown", subtree);
    restore?.();
    restore = null;
  }
});

test("a record that will not parse refuses the whole answer", async () => {
  // Dropping it lets the count come back a determinate zero, which is the
  // sandbox being destroyed on the strength of a file nobody could read.
  sandboxAnswering(`MARKER ${JSON.stringify(MARKER)}\nSUBTREE ok\nRECORD {not json\nPROCS 7`);
  assert.equal((await countLiveWork(INST, STATE_DIR)).verdict, "unknown");
});

test("an exec that never answered is unknown, and names why", async () => {
  sandboxAnswering(new Error("exec timed out"));
  const answer = await countLiveWork(INST, STATE_DIR);
  assert.equal(answer.verdict, "unknown");
  assert.match(answer.reason, /exec_unanswered/);
});

test("a stale epoch with a live process is lost, and still protects", async () => {
  // Nobody can collect its exit status any more, which is a reason to report it
  // honestly and not a reason to stop protecting it.
  sandboxAnswering(transcript({
    marker: { epoch: "e2", bearer: { pid: 9, startToken: "t9" } },
    records: [running()],
    pids: [9, 42],
  }));
  const answer = await countLiveWork(INST, STATE_DIR);
  assert.equal(answer.classes.lost, 1);
  assert.equal(answer.verdict, "protected");
});

test("a marker whose bearer is gone is stale, not current", async () => {
  // Equality with the marker proves only that no newer Hands has started: a
  // crashed one leaves its marker exactly as it wrote it.
  sandboxAnswering(transcript({ marker: MARKER, records: [running()], pids: [42] }));
  const answer = await countLiveWork(INST, STATE_DIR);
  assert.equal(answer.classes.lost, 1, "the bearer is absent, so the epoch is stale");
});

test("a terminated process under a stale epoch does not hold the container open", async () => {
  // The one exclusion: a terminated process has no work left to protect, and
  // counting its lingering record would hold sandboxes open indefinitely.
  sandboxAnswering(transcript({
    marker: { epoch: "e2", bearer: { pid: 9, startToken: "t9" } },
    records: [running()],
    pids: [9],
  }));
  const answer = await countLiveWork(INST, STATE_DIR);
  assert.equal(answer.classes.ended_unreaped, 1);
  assert.equal(answer.verdict, "clear");
});

test("a claim that never became a process protects, under any epoch", async () => {
  for (const marker of [MARKER, { epoch: "e9", bearer: { pid: 9, startToken: "t9" } }]) {
    sandboxAnswering(transcript({
      marker,
      records: [running({ process_identity: undefined })],
      pids: [7, 9],
    }));
    const answer = await countLiveWork(INST, STATE_DIR);
    assert.equal(answer.classes.spawn_indeterminate, 1);
    assert.equal(answer.verdict, "protected");
    restore?.();
    restore = null;
  }
});

test("a committed outcome is not live work", async () => {
  sandboxAnswering(transcript({
    marker: MARKER,
    records: [running({ status: "exited", exit_code: 0 })],
    pids: [7],
  }));
  const answer = await countLiveWork(INST, STATE_DIR);
  assert.equal(answer.classes.finished, 1);
  assert.equal(answer.verdict, "clear");
});
