// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A test file for tmp-dirs.test.ts to run as a child process: one test makes a directory with tmp-dirs.ts, prints it
 * and then passes, fails, calls process.exit or waits to be signalled, as FIXTURE_MODE says.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { tmpDir } from "./tmp-dirs.js";

const mode = process.env.FIXTURE_MODE ?? "pass";

test(`a test that makes a directory and then: ${mode}`, async () => {
  const dir = tmpDir("tmp-dirs-fixture-");
  writeFileSync(join(dir, "file"), "x");
  process.stdout.write(`DIR=${dir}\n`);
  if (mode === "fail") throw new Error("fails on purpose");
  if (mode === "exit") process.exit(3);
  if (mode === "signal") await new Promise((resolve) => setTimeout(resolve, 60_000));
});
