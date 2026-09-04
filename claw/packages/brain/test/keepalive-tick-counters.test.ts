// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// A stalled reclaim loop has to look different from a quiet one.
//
// Every branch of the background-work decision was logged except the one a
// stalled fleet sits in. `unknown` -> keep emitted nothing, so a run of ticks
// that reclaimed nothing -- idle sandboxes pinned with nothing bounding them but
// the CR's absolute deadline -- produced the same logs as a healthy idle fleet,
// and the cause could only be found by shipping a debug build with tracing in
// it.
//
// The scan line now carries per-tick counts of each branch and of where each
// verdict came from. These pin the two properties that make it usable: the
// numbers describe what the sweep actually did, and the line is still emitted
// once the fleet has nothing left to ping -- which is the successful end state,
// and was previously an early return with no log at all.

import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const fixture = fileURLToPath(new URL("./fixtures/keepalive-tick-counters.ts", import.meta.url));

type ScanLine = Record<string, number | string[] | string>;

async function scanLines(): Promise<ScanLine[]> {
  const { stdout } = await run(process.execPath, [
    fileURLToPath(new URL("../../../node_modules/tsx/dist/cli.mjs", import.meta.url)),
    fixture,
  ], { timeout: 60_000 });
  return stdout.split("\n")
    .filter((l) => l.includes("keepalive.tick_scan"))
    .map((l) => JSON.parse(l) as ScanLine);
}

test("the scan line reports what each sweep decided, including the tick that has nothing left to ping", async () => {
  const lines = await scanLines();
  assert.ok(lines.length >= 2, `expected several scan lines, got ${lines.length}`);

  // The first sweep has no verdict anywhere: nothing has probed yet. That is the
  // shape of the stall -- and the point is that it is now legible as one rather
  // than being the absence of a log line.
  const first = lines[0];
  assert.equal(first.bgUnknown, 1, "an unprobed handle answers unknown");
  assert.equal(first.fromNone, 1, "and no verdict was available from anywhere");
  assert.equal(first.expired, 0, "so nothing is reclaimed on this tick");
  assert.equal(first.probes, 1, "but a probe is started, which is what breaks the stall");

  // The reclaim, once the probe has answered.
  const reclaimed = lines.find((l) => l.expired === 1);
  assert.ok(reclaimed, `no tick reported a reclaim. lines=${JSON.stringify(lines)}`);
  assert.equal(reclaimed.bgIdle, 1, "the handle was answered idle");
  assert.ok(
    reclaimed.fromMem === 1 || reclaimed.fromHandle === 1,
    "and the answer came from somewhere real, not from a default",
  );

  // And that reclaim tick has no ping targets at all -- an expired handle is
  // deleted rather than pinged -- so it is precisely the tick the early return
  // used to swallow. Logging only when targets remain drops the record of the
  // one outcome this whole mechanism exists to produce.
  assert.equal(
    reclaimed.total, 0,
    "a handle that expires never becomes a ping target, so the tick that "
      + "reclaimed it has none; that must not be why it goes unlogged",
  );
  assert.deepEqual(reclaimed.sessions, [], "sanity: nothing left to ping");
});
