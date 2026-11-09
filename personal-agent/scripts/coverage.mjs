// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// Runs the whole suite once under c8, then holds each package to its own floor. `--all` counts a source file no test
// loads as uncovered, so a module without tests lowers its package's numbers instead of vanishing from them.
// Lines, statements, functions and branches are each held to the floor.
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Each package's floor, in percent. Lowering one is a change to this file that review sees. */
export const FLOORS = { core: 90, runtime: 85, teams: 85 };

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const temp = join(root, ".c8-tmp");
const c8 = join(root, "node_modules", ".bin", "c8");

function run(args) {
  const result = spawnSync(c8, args, { cwd: root, stdio: "inherit" });
  return result.status ?? 1;
}

rmSync(temp, { recursive: true, force: true });
const testArgs = JSON.parse(process.env.PERSONAL_AGENT_TEST_GLOBS ?? "null") ?? [
  "packages/*/test/**/*.test.ts",
  "test-support/**/*.test.ts",
  "test/**/*.test.ts",
];
// `--names <file>`: also write the names of the tests that ran (scripts/test-names-reporter.ts), for the ported-tests
// check, so the suite runs once in CI.
const namesAt = process.argv.indexOf("--names");
const names = namesAt === -1 ? undefined : process.argv[namesAt + 1];
const reporters =
  names === undefined
    ? []
    : [
        "--test-reporter=spec",
        "--test-reporter-destination=stdout",
        "--test-reporter=./scripts/test-names-reporter.ts",
        `--test-reporter-destination=${names}`,
      ];
const tests = run([
  "--temp-directory",
  temp,
  "--reporter=none",
  "node",
  "--import",
  "tsx",
  "--test",
  "--test-concurrency=2",
  ...reporters,
  ...testArgs,
]);
if (tests !== 0) {
  console.error(`coverage: the test run failed (exit ${String(tests)})`);
  process.exit(tests);
}

let failed = false;
for (const [pkg, floor] of Object.entries(FLOORS)) {
  console.log(`\n== ${pkg}: floor ${String(floor)}% (lines, statements, functions, branches)`);
  const status = run([
    "report",
    "--temp-directory",
    temp,
    "--all",
    "--src",
    join("packages", pkg, "src"),
    "--include",
    `packages/${pkg}/src/**/*.ts`,
    "--reporter=text",
    "--check-coverage",
    `--lines=${String(floor)}`,
    `--statements=${String(floor)}`,
    `--functions=${String(floor)}`,
    `--branches=${String(floor)}`,
  ]);
  if (status !== 0) {
    console.error(`coverage: ${pkg} is below its floor of ${String(floor)}%`);
    failed = true;
  }
}
rmSync(temp, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
