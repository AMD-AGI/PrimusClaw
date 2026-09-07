// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Verifies identity degradation and ledger misses through emitted logs. */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const fixture = fileURLToPath(new URL("./fixtures/run-identity-logs.ts", import.meta.url));

interface Line { level?: number; msg?: string; [key: string]: unknown }

const lines: Line[] = [];
const marks: number[] = [];

test("drive the fixture", async () => {
  const { stdout } = await run(process.execPath, [
    fileURLToPath(new URL("../../../node_modules/tsx/dist/cli.mjs", import.meta.url)),
    fixture,
  ], { timeout: 120_000, maxBuffer: 32 * 1024 * 1024 });

  for (const raw of stdout.split("\n")) {
    if (raw.startsWith("FIXTURE ")) { marks.push(lines.length); lines.push({ msg: raw.trim() }); continue; }
    if (!raw.startsWith("{")) continue;
    lines.push(JSON.parse(raw) as Line);
  }
  assert.ok(marks.length >= 5, `the fixture did not run to the end:\n${stdout}`);
});

const at = (mark: string) => lines.findIndex((l) => l.msg === `FIXTURE ${mark}`);
const between = (from: string, to: string, msg: string) =>
  lines.slice(at(from), at(to)).filter((l) => l.msg === msg);
const find = (msg: string) => lines.filter((l) => l.msg === msg);

test("P4 a lookup that misses the ledger says so", () => {
  const miss = lines.slice(0, at("miss-returned-the-work")).filter((l) => l.msg === "run_phase.ledger_miss");
  assert.equal(miss.length, 1, "a miss must not stay indistinguishable from a run that never waited");
  assert.equal(miss[0].reason, "background_command");
  assert.equal(miss[0].mode, "timed");
});

test("T3.2 a sub-agent forwarded its parent's identity, so nothing missed", () => {
  assert.deepEqual(between("subagent-start", "subagent-end", "run_phase.ledger_miss"), [],
    "the sub-agent path used to pass no key at all");
});

test("T5.7 the engine reports a missing identity instead of resolving a second one", () => {
  const missing = find("engine.run_identity_missing");
  assert.equal(missing.length, 1);
  assert.equal(missing[0].level, 50, "a violated producer contract is an error, not a note");
  assert.match(String(missing[0].runIdentityKey), /^unknown\.unthreaded\./,
    "the sentinel names the shape of the bug; a task_id here would mean a second resolution");
});

test("T4.6 an unrecognised lease URL is reported at the runner, and is its own event", () => {
  const shapeMiss = find("run_identity.lease_shape_miss");
  assert.equal(shapeMiss.length, 1);
  assert.equal(shapeMiss[0].level, 40);
  assert.ok(!find("run_identity.unknown").some((l) => l.messageId === "m-lease"),
    "a shape miss must not read as an ordinary degradation");
});

test("T4.2 a run with no identity to resolve is degraded observably", () => {
  const degraded = find("run_identity.unknown");
  assert.equal(degraded.length, 1);
  assert.match(String(degraded[0].runIdentityKey), /^unknown\./);
});
