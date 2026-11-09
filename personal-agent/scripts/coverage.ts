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
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { oddCaseSources, SOURCE_EXTENSIONS, sourceFiles, symlinksUnder, typeOnlyFiles } from "./type-only.js";

/**
 * Each package's floor, in percent. Lowering one is a change to this file that review sees. A package directory under
 * packages/ without a floor here fails the gate (`packagesToCheck`), so a new package cannot go uncounted.
 */
export const FLOORS: Readonly<Record<string, number>> = { core: 90, runtime: 85, teams: 85 };

/** Why a package's `src` cannot be judged, if it cannot: it is missing, it is itself a link, or has links inside. */
function srcLinks(packagesDir: string, pkg: string): string[] {
  const src = path.join(packagesDir, pkg, "src");
  const shown = `packages/${pkg}/src`;
  if (isLink(src)) return [`${shown} is a symbolic link (not allowed: src must be the package's own directory)`];
  if (!existsSync(src)) return [`packages/${pkg} has no src directory`];
  return symlinksUnder(src, path.dirname(packagesDir)).map((l) => `${l} is a symbolic link (not allowed in src)`);
}

function isLink(file: string): boolean {
  try {
    return lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Every string under `value` (a package.json `exports` map nests them under conditions and subpaths). */
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (typeof value === "object" && value !== null) return Object.values(value).flatMap(strings);
  return [];
}

/**
 * Why a package's runtime could load code the floor does not see, if it could: an entry point of its package.json
 * (`exports`, `main`, `module`, `browser`, `bin`) outside its src, or a source file of the package outside src/ and
 * test/ (which src could import by a relative path).
 */
export function codeOutsideSrc(packagesDir: string, pkg: string): string[] {
  const dir = path.join(packagesDir, pkg);
  const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as Record<string, unknown>;
  const entries = ["exports", "main", "module", "browser", "bin"].flatMap((field) => strings(manifest[field]));
  const src = path.join(dir, "src") + path.sep;
  const badEntries = entries
    .filter((target) => !path.resolve(dir, target).startsWith(src))
    .map((target) => `packages/${pkg}/package.json points at ${target}, outside src (the floor would not see it)`);
  const stray = readdirSync(dir, { withFileTypes: true })
    .filter((e) => !["src", "test", "node_modules"].includes(e.name))
    .flatMap((e) => (e.isDirectory() ? sourceFiles(path.join(dir, e.name)) : [path.join(dir, e.name)]))
    .filter((file) => (SOURCE_EXTENSIONS as readonly string[]).includes(path.extname(file)))
    .map((file) => `${path.relative(path.dirname(packagesDir), file)} is source outside src/ and test/`);
  const oddCase = oddCaseSources(dir).map(
    (file) => `${path.relative(path.dirname(packagesDir), file)} has a source extension in upper case (use lower case)`,
  );
  return [...badEntries, ...stray, ...oddCase];
}

/**
 * The packages to hold to a floor: every directory under `packagesDir` that has a package.json. What is wrong (a
 * package with no floor, a floor for no package, a package directory or a package's src that is a symbolic link, a
 * symbolic link inside a package's src) comes back in `errors`.
 */
export function packagesToCheck(
  packagesDir: string,
  floors: Readonly<Record<string, number>>,
): { readonly packages: readonly [string, number][]; readonly errors: readonly string[] } {
  const entries = readdirSync(packagesDir, { withFileTypes: true });
  const found = entries
    .filter((e) => e.isDirectory() && existsSync(path.join(packagesDir, e.name, "package.json")))
    .map((e) => e.name)
    .sort();
  const errors = [
    ...entries
      .filter((e) => e.isSymbolicLink())
      .map((e) => `packages/${e.name} is a symbolic link (not allowed: a package is a directory of its own)`),
    ...found.filter((p) => floors[p] === undefined).map((p) => `packages/${p} has no coverage floor in FLOORS`),
    ...Object.keys(floors)
      .filter((p) => !found.includes(p))
      .map((p) => `FLOORS names ${p}, which is not a package`),
    ...found.flatMap((p) => srcLinks(packagesDir, p)),
    ...found.flatMap((p) => codeOutsideSrc(packagesDir, p)),
  ];
  const packages = found.flatMap((p): [string, number][] => {
    const floor = floors[p];
    return floor === undefined ? [] : [[p, floor]];
  });
  return { packages, errors };
}

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

/**
 * The files the report should hold but does not: every file c8 left out on a default of its own (a name with "test",
 * a directory called test or __tests__ or node_modules, ...) is a file the floor would not see. Relative to `base`.
 */
export function missingFromReport(expected: readonly string[], reported: readonly string[], base: string): string[] {
  const seen = new Set(reported.map((f) => path.resolve(base, f)));
  return expected
    .filter((f) => !seen.has(path.resolve(base, f)))
    .map((f) => path.relative(base, path.resolve(base, f)));
}

function reportedFiles(summary: string): string[] {
  const parsed = JSON.parse(readFileSync(summary, "utf8")) as Record<string, unknown>;
  return Object.keys(parsed).filter((key) => key !== "total");
}

function checkPackage(pkg: string, floor: number): boolean {
  const src = path.join("packages", pkg, "src");
  const excluded = typeOnlyFiles(path.join(root, src), root);
  const expected = sourceFiles(path.join(root, src))
    .map((f) => path.relative(root, f))
    .filter((f) => !excluded.includes(f));
  const reportDir = path.join(temp, "report", pkg);
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
    // c8's own extension list leaves out .mts and .cts: without these, --all would not see such a file at all.
    ...SOURCE_EXTENSIONS.flatMap((extension) => ["--extension", extension]),
    // Our --exclude list replaces c8's defaults (which drop "test" names and directories): it always has an entry.
    ...[...excluded, "(no other file is excluded)"].flatMap((file) => ["--exclude", file]),
    "--exclude-node-modules=false",
    "--reporter=text",
    "--reporter=json-summary",
    "--report-dir",
    reportDir,
    "--check-coverage",
    ...["lines", "statements", "functions", "branches"].map((metric) => `--${metric}=${String(floor)}`),
  ]);
  if (status !== 0) console.error(`coverage: ${pkg} is below its floor of ${String(floor)}%`);
  const summary = path.join(reportDir, "coverage-summary.json");
  const missing = existsSync(summary) ? missingFromReport(expected, reportedFiles(summary), root) : expected;
  for (const file of missing) console.error(`coverage: ${file} has runtime code but is not in c8's report`);
  return status === 0 && missing.length === 0;
}

function main(argv: readonly string[]): number {
  const at = argv.indexOf("--names");
  const names = at === -1 ? undefined : argv[at + 1];
  const { packages, errors } = packagesToCheck(path.join(root, "packages"), FLOORS);
  for (const error of errors) console.error(`coverage: ${error}`);
  if (errors.length > 0) return 1;
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
  const results = packages.map(([pkg, floor]) => checkPackage(pkg, floor));
  rmSync(temp, { recursive: true, force: true });
  return results.every(Boolean) ? 0 : 1;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
