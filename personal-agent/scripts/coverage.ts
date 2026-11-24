// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Runs the whole suite once with V8 coverage on, then holds each package to its own floor (one c8 report each) on
 * lines, statements, functions and branches. `--all` counts a source file no test loads as uncovered, so a module
 * without tests lowers its package's numbers instead of vanishing from them; only files with no runtime at all are
 * left out (scripts/type-only.ts).
 *
 *   node --import tsx scripts/coverage.ts [--names <file>]
 *
 * `--names <file>` also writes the names of the tests that ran (scripts/test-names-reporter.ts) for the ported-tests
 * check, so the suite runs once in CI.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { availableParallelism } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { oddCaseSources, SOURCE_EXTENSIONS, sourceFiles, symlinksUnder, typeOnlyFiles } from "./type-only.js";

/**
 * Each package's floor, in percent. Lowering one is a change to this file that review sees. A package directory under
 * packages/ without a floor here fails the gate (`packagesToCheck`), so a new package cannot go uncounted.
 */
export const FLOORS: Readonly<Record<string, number>> = { core: 90, runtime: 85, teams: 85, "teams-ingress": 85 };

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
 * test/ (which src could import by a relative path). The one exception is dist/, the build of src (`npm run build`):
 * what a published package's entries name. The workspace itself never loads it (tsconfig.json's `paths` name each
 * package's src), so the floor measured on src is the floor of what is built from it.
 */
export function codeOutsideSrc(packagesDir: string, pkg: string): string[] {
  const dir = path.join(packagesDir, pkg);
  const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as Record<string, unknown>;
  const entries = ["exports", "main", "module", "browser", "bin"].flatMap((field) =>
    strings(Object.hasOwn(manifest, field) ? manifest[field] : undefined),
  );
  const src = path.join(dir, "src") + path.sep;
  const dist = path.join(dir, "dist") + path.sep;
  const badEntries = entries
    .filter((target) => !path.resolve(dir, target).startsWith(src) && !path.resolve(dir, target).startsWith(dist))
    .map((target) => `packages/${pkg}/package.json points at ${target}, outside src (the floor would not see it)`);
  const stray = readdirSync(dir, { withFileTypes: true })
    .filter((e) => !["src", "test", "node_modules", "dist"].includes(e.name))
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
    ...found.filter((p) => !Object.hasOwn(floors, p)).map((p) => `packages/${p} has no coverage floor in FLOORS`),
    ...Object.keys(floors)
      .filter((p) => !found.includes(p))
      .map((p) => `FLOORS names ${p}, which is not a package`),
    ...found.flatMap((p) => srcLinks(packagesDir, p)),
    ...found.flatMap((p) => codeOutsideSrc(packagesDir, p)),
  ];
  const packages = found.flatMap((p): [string, number][] => {
    const floor = Object.hasOwn(floors, p) ? floors[p] : undefined;
    return floor === undefined ? [] : [[p, floor]];
  });
  return { packages, errors };
}

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const temp = path.join(root, ".c8-tmp");
const c8 = path.join(root, "node_modules", ".bin", "c8");
const TESTS = ["packages/*/test/**/*.test.ts", "test-support/**/*.test.ts", "test/**/*.test.ts"];

/**
 * Runs the suite with V8 coverage written to `temp`. Not under the c8 wrapper: c8 converts the whole of `temp` to a
 * report once its child exits, even with `--reporter=none`, which took about 35 s in CI for a report nobody reads;
 * the per-package reports below are the ones the gate reads.
 */
function runTests(args: readonly string[]): number {
  mkdirSync(temp, { recursive: true });
  const env = { ...process.env, NODE_V8_COVERAGE: temp };
  return spawnSync(process.execPath, args, { cwd: root, stdio: "inherit", env }).status ?? 1;
}

/** One c8 run with its output held back, so runs side by side still print one package after another. */
function runCaptured(args: readonly string[]): Promise<{ readonly status: number; readonly output: string }> {
  return new Promise((resolve) => {
    const child = spawn(c8, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));
    // A child that does not start may never emit "close": settle here too (a second resolve is ignored).
    child.on("error", (error) => {
      chunks.push(Buffer.from(`coverage: c8 did not start: ${error.message}\n`));
      resolve({ status: 1, output: Buffer.concat(chunks).toString("utf8") });
    });
    child.on("close", (code) => {
      resolve({ status: code ?? 1, output: Buffer.concat(chunks).toString("utf8") });
    });
  });
}

/** `work` over `items`, at most `limit` at a time, the results in the order of `items`. */
export async function inPool<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const at = next++;
      results[at] = await work(items[at] as T);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
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

/**
 * One package's report and floor. Each c8 report reads and merges the whole of `temp` on one core (about 33 s each in
 * CI), so the packages run side by side; what each prints is held and printed in package order.
 */
async function checkPackage(pkg: string, floor: number): Promise<{ readonly ok: boolean; readonly output: string }> {
  const src = path.join("packages", pkg, "src");
  const excluded = typeOnlyFiles(path.join(root, src), root);
  const expected = sourceFiles(path.join(root, src))
    .map((f) => path.relative(root, f))
    .filter((f) => !excluded.includes(f));
  const reportDir = path.join(temp, "report", pkg);
  const lines = [
    `\n== ${pkg}: floor ${String(floor)}% (lines, statements, functions, branches)`,
    `   type-only, not counted: ${excluded.length === 0 ? "none" : excluded.join(", ")}`,
  ];
  const { status, output } = await runCaptured([
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
  lines.push(output.replace(/\n$/, ""));
  if (status !== 0) lines.push(`coverage: ${pkg} is below its floor of ${String(floor)}%`);
  const summary = path.join(reportDir, "coverage-summary.json");
  const missing = existsSync(summary) ? missingFromReport(expected, reportedFiles(summary), root) : expected;
  for (const file of missing) lines.push(`coverage: ${file} has runtime code but is not in c8's report`);
  return { ok: status === 0 && missing.length === 0, output: lines.join("\n") };
}

async function main(argv: readonly string[]): Promise<number> {
  const at = argv.indexOf("--names");
  const names = at === -1 ? undefined : argv[at + 1];
  const { packages, errors } = packagesToCheck(path.join(root, "packages"), FLOORS);
  for (const error of errors) console.error(`coverage: ${error}`);
  if (errors.length > 0) return 1;
  rmSync(temp, { recursive: true, force: true });
  const tests = runTests(["--import", "tsx", "--test", "--test-concurrency=2", ...reporters(names), ...TESTS]);
  if (tests !== 0) {
    console.error(`coverage: the test run failed (exit ${String(tests)})`);
    return tests;
  }
  const results = await inPool(packages, availableParallelism(), ([pkg, floor]) => checkPackage(pkg, floor));
  for (const { output } of results) console.log(output);
  rmSync(temp, { recursive: true, force: true });
  return results.every(({ ok }) => ok) ? 0 : 1;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(await main(process.argv.slice(2)));
}
