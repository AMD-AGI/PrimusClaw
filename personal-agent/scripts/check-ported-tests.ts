// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Checks the ported-tests ledgers (ported-tests/<line>.txt) against the tests that really ran.
 *
 * A ledger says where each Python test of the worker went:
 *
 *   python-baseline: <the internal commit the port follows>
 *   <python nodeid> -> <ts file>::<test name>          ported
 *   <python nodeid> -> MERGED <ts file>::<test name>   folded into a TS test that covers it with others
 *   <python nodeid> -> INTERNAL                        tests only an internal artefact or plugin
 *   <python nodeid> -> DROPPED: <reason>               no longer applies; the reason says why
 *
 * Blank lines and lines starting with "#" are comments. Every TS test a ledger names must have run AND passed in the
 * run whose names are given (scripts/test-names-reporter.ts output): a skipped, todo or missing test fails the check,
 * and so does a malformed line or a Python id listed twice.
 *
 *   node --import tsx scripts/check-ported-tests.ts --names names.jsonl [--ledgers ported-tests]
 */
import fs from "node:fs";
import path from "node:path";
import type { TestName } from "./test-names-reporter.js";

export type Destination =
  | { readonly kind: "ported" | "merged"; readonly file: string; readonly name: string }
  | { readonly kind: "internal" }
  | { readonly kind: "dropped"; readonly reason: string };

export interface Ledger {
  readonly source: string;
  readonly baseline: string;
  readonly entries: readonly { readonly line: number; readonly python: string; readonly to: Destination }[];
}

export interface Report {
  readonly errors: readonly string[];
  readonly counts: Readonly<Record<string, Readonly<Record<Destination["kind"], number>>>>;
}

const BASELINE = /^python-baseline:\s*([0-9a-f]{7,40})$/;
const ENTRY = /^(\S+\.py::\S.*?)\s+->\s+(.+)$/;
const TS_TEST = /^(\S+\.test\.ts)::(.+)$/;

function destination(text: string): Destination | string {
  if (text === "INTERNAL") return { kind: "internal" };
  if (text.startsWith("DROPPED:")) {
    const reason = text.slice("DROPPED:".length).trim();
    return reason ? { kind: "dropped", reason } : "DROPPED needs a reason";
  }
  const merged = text.startsWith("MERGED ");
  const m = TS_TEST.exec(merged ? text.slice("MERGED ".length).trim() : text);
  if (m?.[1] === undefined || m[2] === undefined) return `not a destination: "${text}"`;
  return { kind: merged ? "merged" : "ported", file: m[1], name: m[2].trim() };
}

/** Reads one ledger; what is wrong with it goes to `errors`, prefixed with where. */
export function parseLedger(source: string, text: string, errors: string[]): Ledger {
  const entries: Ledger["entries"][number][] = [];
  let baseline = "";
  text.split("\n").forEach((raw, index) => {
    const line = raw.trim();
    const where = `${source}:${String(index + 1)}`;
    if (line === "" || line.startsWith("#")) return;
    if (baseline === "") {
      const b = BASELINE.exec(line);
      if (b?.[1] === undefined) errors.push(`${where}: the first line must be "python-baseline: <sha>"`);
      else baseline = b[1];
      return;
    }
    const m = ENTRY.exec(line);
    const to = m?.[2] === undefined ? "not an entry" : destination(m[2].trim());
    if (m?.[1] === undefined || typeof to === "string") errors.push(`${where}: ${typeof to === "string" ? to : ""}`);
    else entries.push({ line: index + 1, python: m[1], to });
  });
  if (baseline === "") errors.push(`${source}: no python-baseline line`);
  return { source, baseline, entries };
}

function countKinds(ledger: Ledger): Record<Destination["kind"], number> {
  const counts = { ported: 0, merged: 0, internal: 0, dropped: 0 };
  for (const e of ledger.entries) counts[e.to.kind]++;
  return counts;
}

/** Checks the ledgers against the tests that ran. */
export function check(ledgers: readonly Ledger[], ran: readonly TestName[]): Report {
  const errors: string[] = [];
  const status = new Map(ran.map((t) => [`${t.file}::${t.name}`, t.status]));
  const seen = new Map<string, string>();
  for (const ledger of ledgers) {
    for (const { line, python, to } of ledger.entries) {
      const where = `${ledger.source}:${String(line)}`;
      const first = seen.get(python);
      if (first !== undefined) errors.push(`${where}: ${python} is already listed at ${first}`);
      else seen.set(python, where);
      if (to.kind !== "ported" && to.kind !== "merged") continue;
      const got = status.get(`${to.file}::${to.name}`);
      if (got === undefined) errors.push(`${where}: ${to.file}::${to.name} did not run`);
      else if (got !== "pass") errors.push(`${where}: ${to.file}::${to.name} did not pass (${got})`);
    }
  }
  return { errors, counts: Object.fromEntries(ledgers.map((l) => [l.source, countKinds(l)])) };
}

function readNames(file: string): TestName[] {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as TestName);
}

function main(argv: readonly string[]): number {
  const arg = (flag: string): string | undefined => argv[argv.indexOf(flag) + 1];
  const namesFile = argv.includes("--names") ? arg("--names") : undefined;
  const dir = (argv.includes("--ledgers") ? arg("--ledgers") : undefined) ?? "ported-tests";
  if (namesFile === undefined) {
    console.error("usage: check-ported-tests.ts --names <names.jsonl> [--ledgers <dir>]");
    return 2;
  }
  const ran = readNames(namesFile);
  if (ran.length === 0) {
    console.error(`${namesFile} lists no test: refusing to check the ledgers against an empty run`);
    return 1;
  }
  const errors: string[] = [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".txt"));
  const ledgers = files.map((f) => parseLedger(path.join(dir, f), fs.readFileSync(path.join(dir, f), "utf8"), errors));
  const report = check(ledgers, ran);
  for (const [source, c] of Object.entries(report.counts)) {
    console.log(
      `${source}: ported ${String(c.ported)}, merged ${String(c.merged)}, internal ${String(c.internal)}, dropped ${String(c.dropped)}`,
    );
  }
  const all = [...errors, ...report.errors];
  for (const e of all) console.error(e);
  console.log(
    `ported-tests: ${String(ledgers.length)} ledgers, ${String(ran.length)} tests ran, ${String(all.length)} errors`,
  );
  return all.length === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  process.exit(main(process.argv.slice(2)));
}
