// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A test file for tmp-dirs.test.ts to run as a child process: one test makes a directory with tmp-dirs.ts, writes its
 * path to the file FIXTURE_REPORT names (not stdout, which a test runner may hold until the test ends) and then
 * passes, fails, calls process.exit or waits to be signalled, as FIXTURE_MODE says.
 */
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { tmpDir } from "../../utils/test/tmp-dirs.js";

const mode = process.env.FIXTURE_MODE ?? "pass";

test(`a test that makes a directory and then: ${mode}`, async () => {
  const dir = tmpDir("tmp-dirs-fixture-");
  writeFileSync(join(dir, "file"), "x");
  const report = process.env.FIXTURE_REPORT!;
  // Whole or absent: the parent reads it as soon as it exists.
  writeFileSync(`${report}.part`, dir);
  renameSync(`${report}.part`, report);
  if (mode === "fail") throw new Error("fails on purpose");
  if (mode === "exit") process.exit(3);
  if (mode === "signal") await new Promise((resolve) => setTimeout(resolve, 60_000));
});
