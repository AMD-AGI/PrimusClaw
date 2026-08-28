// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The holder-release retry has to survive being the last thing running.
 *
 * Not assertable in-process: the test runner's own handles keep the event loop
 * alive, so an unref'd backoff timer fires anyway and every assertion passes.
 * The property only shows up where the drain meets it -- a process with
 * nothing else pending -- so this runs the retry in a child and checks it got
 * to the end.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const fixture = fileURLToPath(new URL("./fixtures/retry-sleep-holds-loop.ts", import.meta.url));

test("a release that is retrying keeps the process alive until it finishes", async () => {
  const { stdout } = await run(process.execPath, [
    fileURLToPath(new URL("../../../node_modules/tsx/dist/cli.mjs", import.meta.url)),
    fixture,
  ], { timeout: 60_000 });

  assert.match(
    stdout,
    /RETRIED 500,409/,
    "the retry ran to completion; an unref'd backoff would have ended the process mid-await",
  );
});
