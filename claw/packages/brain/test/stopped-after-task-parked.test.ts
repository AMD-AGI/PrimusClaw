// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `keepalive.stopped_after_task` has to report the park that happened, not the
 * one that was asked for.
 *
 * `markHandsIdle` is fire-and-forget, and writes nothing for a handle that is
 * gone, still provisioning, or now naming a different sandbox -- and a turn
 * under BRAIN_LAZY_SANDBOX answered from context alone never built a sandbox to
 * park at all. A line that says `parked` because the call was made is at its
 * least true exactly when it is being read: a handle nobody parked is pinged by
 * the whole fleet until the workload's absolute deadline, and this is the line
 * an operator looks at to find out whether it was put away.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const fixture = fileURLToPath(
  new URL("./fixtures/stopped-after-task-parked.ts", import.meta.url),
);

interface Line {
  parked: boolean;
  outcome: string;
  sessionId: string;
}

async function parkLines(): Promise<Map<string, Line>> {
  const { stdout } = await run(process.execPath, [
    fileURLToPath(new URL("../../../node_modules/tsx/dist/cli.mjs", import.meta.url)),
    fixture,
  ], {
    // The three scenarios turn on whether a sandbox was built, so the run must
    // not also be deciding that for itself.
    env: { ...process.env, BRAIN_LAZY_SANDBOX: "0" },
    timeout: 60_000,
  });

  const lines = new Map<string, Line>();
  for (const raw of stdout.split("\n")) {
    if (!raw.includes("keepalive.stopped_after_task")) continue;
    const parsed = JSON.parse(raw) as Line;
    lines.set(parsed.sessionId, parsed);
  }
  assert.equal(lines.size, 3, `every run reports once. stdout:\n${stdout}`);
  return lines;
}

test("the line reports the park that happened, not the one that was attempted", async () => {
  const lines = await parkLines();

  assert.deepEqual(
    { parked: lines.get("sess-parked")!.parked, outcome: lines.get("sess-parked")!.outcome },
    { parked: true, outcome: "parked" },
    "a handle that was written is the one case that is a park",
  );

  assert.deepEqual(
    { parked: lines.get("sess-refused")!.parked, outcome: lines.get("sess-refused")!.outcome },
    { parked: false, outcome: "skipped" },
    "markHandsIdle refused the handle and wrote nothing, so nothing was parked",
  );

  assert.deepEqual(
    {
      parked: lines.get("sess-no-sandbox")!.parked,
      outcome: lines.get("sess-no-sandbox")!.outcome,
    },
    { parked: false, outcome: "no_sandbox" },
    "a turn that never built a sandbox had no handle to put away",
  );
});
