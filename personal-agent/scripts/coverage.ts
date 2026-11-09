// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Runs the whole suite once under c8, then holds each package to its own floor on lines, statements, functions and
 * branches. `--all` counts a source file no test loads as uncovered, so a module without tests lowers its package's
 * numbers instead of vanishing from them; only files with no runtime at all are left out (scripts/type-only.ts).
 *
 *   node --import tsx scripts/coverage.ts [--names <file>]
 *
 * `--names <file>` also writes the names of the tests that ran (scripts/test-names-reporter.ts) for the ported-tests
 * check, so the suite runs once in CI.
 */
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SOURCE_EXTENSIONS, typeOnlyFiles } from "./type-only.js";

/** Each package's floor, in percent. Lowering one is a change to this file that review sees. */
export const FLOORS: Readonly<Record<string, number>> = { core: 90, runtime: 85, teams: 85 };

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = path.join(root, ".c8-tmp");
const c8 = path.join(root, "node_modules", ".bin", "c8");
const TESTS = ["packages/*/test/**/*.test.ts", "test-support/**/*.test.ts", "test/**/*.test.ts"];

function run(args: readonly string[]): number {
  return spawnSync(c8, args, { cwd: root, stdio: "inherit" }).status ?? 1;
}

function reporters(names: string | undefined): string[] {
  if (names === undefined) return [];
  return [
    "--test-reporter=spec",
    "--test-reporter-destination=stdout",
    "--test-reporter=./scripts/test-names-reporter.ts",
    `--test-reporter-destination=${names}`,
  ];
}

function checkPackage(pkg: string, floor: number): boolean {
  const src = path.join("packages", pkg, "src");
  const excluded = typeOnlyFiles(path.join(root, src), root);
  console.log(`\n== ${pkg}: floor ${String(floor)}% (lines, statements, functions, branches)`);
  console.log(`   type-only, not counted: ${excluded.length === 0 ? "none" : excluded.join(", ")}`);
  const status = run([
    "report",
    "--temp-directory",
    temp,
    "--all",
    "--src",
    src,
    "--include",
    `${src}/**/*.{${SOURCE_EXTENSIONS.map((e) => e.slice(1)).join(",")}}`,
    ...excluded.flatMap((file) => ["--exclude", file]),
    "--reporter=text",
    "--check-coverage",
    ...["lines", "statements", "functions", "branches"].map((metric) => `--${metric}=${String(floor)}`),
  ]);
  if (status !== 0) console.error(`coverage: ${pkg} is below its floor of ${String(floor)}%`);
  return status === 0;
}

function main(argv: readonly string[]): number {
  const at = argv.indexOf("--names");
  const names = at === -1 ? undefined : argv[at + 1];
  rmSync(temp, { recursive: true, force: true });
  const tests = run([
    "--temp-directory",
    temp,
    "--reporter=none",
    "node",
    "--import",
    "tsx",
    "--test",
    "--test-concurrency=2",
    ...reporters(names),
    ...TESTS,
  ]);
  if (tests !== 0) {
    console.error(`coverage: the test run failed (exit ${String(tests)})`);
    return tests;
  }
  const results = Object.entries(FLOORS).map(([pkg, floor]) => checkPackage(pkg, floor));
  rmSync(temp, { recursive: true, force: true });
  return results.every(Boolean) ? 0 : 1;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
