// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * How far a run had got, in the one line that says so when its budget runs out.
 *
 * `armDeadline`'s timer reads the resume checkpoint when it fires. For the case
 * the line exists to report -- a redelivery of a run whose budget expired while
 * it was queued -- the delay is zero, so armed from the top of `run()` the
 * timer lands before `pendingResumeCkpt` is assigned and the line reports a
 * resumed run as having completed no turns.
 *
 * Not assertable in-process, twice over. The value goes only to pino, which
 * writes to fd 1 through sonic-boom: neither stubbing `process.stdout.write`
 * nor `fs.writeSync` sees it. And the ordering that produces the bug cannot
 * occur against the suite's fakes at all, because they settle on microtasks and
 * the timer never gets a timers-phase turn -- so an in-process test would pass
 * against the broken arrangement too, which is worse than no test. The fixture
 * gives the checkpoint read a real timer, and this reads the child's stdout.
 *
 * Same shape as retry-sleep-ref.test.ts, for the same kind of reason.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const fixture = fileURLToPath(new URL("./fixtures/deadline-log-turns.ts", import.meta.url));

test("the budget's own log line counts the turns the whole run took", async () => {
  const { stdout } = await run(process.execPath, [
    fileURLToPath(new URL("../../../node_modules/tsx/dist/cli.mjs", import.meta.url)),
    fixture,
  ], { timeout: 60_000 });

  const line = stdout.split("\n").find((l) => l.includes("task.deadline_exceeded"));
  assert.ok(line, `the budget must say something when it fires. stdout:\n${stdout}`);
  assert.match(
    line!,
    /"turns":4/,
    "a deadline is spent across resumes, so the count beside it is the run's and not "
    + "this attempt's; 0 here means the timer read the checkpoint before it was there",
  );
});
