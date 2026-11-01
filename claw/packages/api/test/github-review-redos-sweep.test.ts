// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * No regular expression in the GitHub review module costs more than its input is long.
 *
 * `github-review-redos.test.ts` times the rule pack on lines written to hurt the patterns somebody thought of. That is how three patterns
 * were fixed and a fourth, next to them, was not. This reads every regular expression literal in the module's own sources instead, so a
 * pattern added later is timed too, whoever forgot to name it.
 *
 *   S1  the reader of the sources finds the literals it should and none of the divisions, strings and comments around them
 *   S2  the timing sees what it is for: the patterns that were super-linear (copied as they were) are over the bound
 *   S3  every regular expression literal in `src/github-review` is under it, on lines of 8000 characters
 *   S4  the entry points that read a repository's own text (`.github/clawy.yml`, a `package.json` change) cost a bounded amount on the
 *       lines that were slow, and read what they read before
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { assessRisk, parseClawyConfig, type RiskFile } from "../src/github-review/risk.js";
import { regexLiterals, sampleStrings, worstCost } from "./support/regex-sweep.js";

const SOURCES = new URL("../src/github-review/", import.meta.url);
/** Healthy cost on a line this long is a fraction of a millisecond; the patterns that were slow took about sixty. */
const LENGTH = 8000;
const BOUND_MS = 10;

test("S1 the reader finds regular expression literals and not the divisions, strings, templates and comments around them", () => {
  const src = [
    'const a = /^x\\/y[/]+$/i;            // a literal, with an escaped slash and a slash in a class',
    "const b = total / count / 2;       // divisions",
    'const c = "/not/a/regex/";          // a string',
    "const d = `${x / 2}/also/not/`;     // a template",
    "/* /in/a/comment/ */ const e = [/a|b/, /c+/g];",
    "const f = s.replace(/\\s+/g, \" \"); const g = ok && /h$/.test(s);",
    "function h() { return /i{2,3}/; }",
  ].join("\n");
  assert.deepEqual(regexLiterals(src).map((r) => r.source), ["^x\\/y[/]+$", "a|b", "c+", "\\s+", "h$", "i{2,3}"]);
  assert.deepEqual(regexLiterals(src).map((r) => r.flags), ["i", "", "g", "g", "", ""]);

  const files = readdirSync(SOURCES).filter((f) => f.endsWith(".ts"));
  const found = files.flatMap((f) => regexLiterals(readFileSync(new URL(f, SOURCES), "utf8")).map((r) => ({ f, ...r })));
  assert.ok(found.length > 120, `${found.length} literals in ${files.length} files`);
  for (const r of found) assert.doesNotThrow(() => new RegExp(r.source, r.flags), `${r.f}:${r.line} /${r.source}/`);
  // The files the rule pack is made of are all read: the sweep has not gone blind to one of them.
  for (const name of ["risk.ts", "risk-signals.ts", "diff.ts", "github.ts", "settings.ts"]) assert.ok(found.some((r) => r.f === name), name);
});

test("S2 the timing flags the patterns that were super-linear, written as they were, and the strings it makes are ones the pattern matches", () => {
  // [pattern as it was, what it read, line length]: the bound scales with the length, since a linear pattern costs in proportion to it. The first
  // four were slow at the head this was written against, the one that was missed and the three beside it; the last is one of the three that
  // the review before it named, made linear since (a Go function), at a length where it already costs a second.
  const formerly: Array<[string, string, number]> = [
    ['^\\s*"[^"]+"\\s*,?\\s*$', "a manifest's string entry", LENGTH],
    ['^\\s+-\\s+["\']?([^"\'\\s][^"\']*?)["\']?\\s*$', "a list item of the repository's own config", LENGTH],
    ["\\s+#.*$", "a trailing comment of the repository's own config", LENGTH],
    ["\\/+$", "trailing slashes of a URL", LENGTH],
    ["^func\\s+(?:\\(\\s*\\w*\\s*\\*?\\s*(\\w+)(?:\\[[^\\]]*\\])?\\s*\\)\\s*)?([A-Z]\\w*)\\s*[[(]", "a Go function", 600],
  ];
  for (const [source, what, length] of formerly) {
    const bound = (BOUND_MS * length) / LENGTH;
    const { ms, line } = worstCost(source, "", length, bound);
    assert.ok(ms > bound, `${what}: ${ms.toFixed(1)} ms is not over the bound of ${bound} ms (${line})`);
    const re = new RegExp(source);
    const samples = sampleStrings(source);
    assert.ok(samples.some((x) => re.test(x)), `none of ${JSON.stringify(samples.slice(0, 3))} matches /${source}/`);
  }
});

test("S3 every regular expression literal in the module costs under the bound on lines of 8000 characters", () => {
  const slow: string[] = [];
  let timed = 0;
  for (const f of readdirSync(SOURCES).filter((n) => n.endsWith(".ts"))) {
    for (const r of regexLiterals(readFileSync(new URL(f, SOURCES), "utf8"))) {
      const { ms, line } = worstCost(r.source, r.flags, LENGTH);
      timed += 1;
      if (ms > BOUND_MS) slow.push(`${f}:${r.line} /${r.source}/ ${ms.toFixed(1)} ms on ${line}`);
    }
  }
  assert.ok(timed > 120, `${timed} patterns timed`);
  assert.deepEqual(slow, []);
});

const manifestPatch = (lines: string[], context = '   "workspaces": ['): string => `@@ -1,3 +1,${lines.length + 3} @@\n${context}\n${lines.map((l) => `+${l}`).join("\n")}\n   ]`;
const rawFile = (path: string, patch: string): RiskFile => ({ path, status: "modified", additions: 1, deletions: 0, patch });
const assess = (files: RiskFile[]): { ms: number; reasons: string[] } => {
  const started = performance.now();
  const r = assessRisk({
    files, changedFiles: files.length, filesComplete: true, additions: files.length, deletions: 0,
    fork: false, authorAssociation: "MEMBER", baseRef: "main", defaultBranch: "main", repoConfig: null,
  });
  return { ms: performance.now() - started, reasons: r.reasons };
};

test("S4 a package.json that adds string entries of whitespace, with and without the workspaces key in the diff, costs a bounded amount and still reads as before", () => {
  // The line that cost 37 ms at 4000 characters: a quoted word, a long run of whitespace, and a character that is neither a comma nor the end.
  const crafted = `    "x"${" ".repeat(3990)}!`;
  const lines = Array.from({ length: 400 }, () => crafted);
  for (const [what, patch] of [
    ["with the key as context", manifestPatch(lines)],
    ["without the key", manifestPatch(lines, '   "files": [')],
    ["the key on a line the diff adds", manifestPatch(['  "workspaces": [', ...lines])],
  ] as const) {
    const { ms } = assess([rawFile("package.json", patch)]);
    assert.ok(ms < 400, `${what}: ${Math.round(ms)} ms`);
  }
  // Still what it was: a workspace glob added under a `workspaces` key that is only context is a layering change, with the commas and the
  // whitespace the line may have, and a list of anything else is not.
  const layering = /workspace, layering or module-boundary rules changed \(package\.json\)/;
  for (const entry of ['    "pkg/a",', '    "pkg/a"', '\t"pkg/a" ,', '"pkg/a"  ,  ']) {
    assert.match(assess([rawFile("package.json", manifestPatch([entry]))]).reasons.join("\n"), layering, JSON.stringify(entry));
    assert.doesNotMatch(assess([rawFile("package.json", manifestPatch([entry], '   "files": ['))]).reasons.join("\n"), layering, JSON.stringify(entry));
  }
  for (const other of ['    "pkg/a": 1,', '    pkg/a,', '    "",', '    "a" "b",', '    "a",,']) {
    assert.doesNotMatch(assess([rawFile("package.json", manifestPatch([other]))]).reasons.join("\n"), layering, JSON.stringify(other));
  }
});

test("S4b the repository's own config is read in time on a line that is very long, and reads what it read before", () => {
  const cost = (text: string): number => { const t0 = performance.now(); parseClawyConfig(text); return performance.now() - t0; };
  const long = 200_000;
  const assertFast = (what: string, text: string): void => { const ms = cost(text); assert.ok(ms < 400, `${what}: ${Math.round(ms)} ms`); };
  assertFast("whitespace that no comment ends", `confirm_merge: risk${" \t".repeat(long / 2)}x`);
  assertFast("whitespace and hashes, then a line break inside the line", `confirm_merge: risk${" #".repeat(long / 2)}\u2028`);
  assertFast("a list item of whitespace and a quote", `high_risk_paths:\n  - a${" ".repeat(long)}b"c`);
  assertFast("a list item of whitespace, then a character that ends nothing", `high_risk_paths:\n  - "${" ".repeat(long)}x`);

  const good = (text: string) => parseClawyConfig(text);
  assert.deepEqual(good('confirm_merge: always # every merge\nhigh_risk_paths:\n  - "docs/legal/**"  # legal\n  - \'infra/*\'\n  - plain/path\n  -   spaced/path  \n'),
    { confirmMerge: "always", highRiskPaths: ["docs/legal/**", "infra/*", "plain/path", "spaced/path"] });
  assert.deepEqual(good("# a comment\n\nconfirm_merge: risk\n"), { confirmMerge: "risk", highRiskPaths: [] });
  for (const bad of ['high_risk_paths:\n  - ""\n', 'high_risk_paths:\n  - "a"b"\n', 'high_risk_paths:\n  - " a"\n', "high_risk_paths:\n  -\n", "confirm_merge: always # x\u2028 y\n", "confirm_merge: sometimes\n", "other: 1\n", "  - orphan\n"]) {
    assert.equal(good(bad), "invalid", JSON.stringify(bad));
  }
});
