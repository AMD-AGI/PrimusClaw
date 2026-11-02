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
 *   S3  every regular expression literal in `src/github-review` is under it, on lines at the longest a changed line is read, including lines
 *       that say the opening of the pattern over and over
 *   S4  the entry points that read a repository's own text (`.github/claw-review.yml`, a `package.json` change) cost a bounded amount on the
 *       lines that were slow, and read what they read before
 *   S5  one `assessRisk` call on the most a pull request can make it read (500 lines at the cap) costs a bounded amount, whatever the lines
 *       repeat: the bound is on the call, which is what the shared API pays, and not on one `exec`
 *   S6  the three patterns that were rewritten after S5 was written read what they read before
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { assessRisk, parseRepoConfig, type RiskFile } from "../src/github-review/risk.js";
import { MAX_LINE_CHARS, MAX_READ_CHARS } from "../src/github-review/risk-signals.js";
import { regexLiterals, sampleStrings, worstCost } from "./support/regex-sweep.js";

const SOURCES = new URL("../src/github-review/", import.meta.url);
/** The longest a line is that a pattern of the rule pack reads, and the most lines of that length one change can make it read. */
const LINES_AT_CAP = MAX_READ_CHARS / MAX_LINE_CHARS;
/**
 * What one `assessRisk` call may cost on such a change whatever its lines say: the call is synchronous in the API's own process, so this is
 * how long every tenant waits for one pull request. A call on lines that no pattern has anything to say about costs a quarter of it.
 */
const CALL_BUDGET_MS = 400;
/** So the most one pattern may cost on one line at the cap: a pattern that costs more makes a call over the budget when the change repeats what it starts on. */
const EXEC_BOUND_MS = CALL_BUDGET_MS / LINES_AT_CAP;
/** The length and the bound the first sweep used, which the patterns it was written for are timed at (see S2). */
const FORMER_LENGTH = 8000;
const FORMER_BOUND_MS = 10;

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
  // [pattern as it was, flags, what it read, line length, bound]: the bound scales with the length, since a linear pattern costs in proportion
  // to it. The first four were slow at the head the first sweep was written against, the one that was missed and the three beside it; the
  // fifth is one of the three that the review before it named, made linear since (a Go function), at a length where it already costs a
  // second; the last three were slow at the head the sweep was extended against (they were not found because it never said an opening twice,
  // and the bound was on one `exec`), the pattern that reads a Rust attribute, the first route pattern and the suppression pattern.
  const former = (length: number): number => (FORMER_BOUND_MS * length) / FORMER_LENGTH;
  const atCap = (length: number): number => (EXEC_BOUND_MS * length) / MAX_LINE_CHARS;
  const formerly: Array<[string, string, string, number, number]> = [
    ['^\\s*"[^"]+"\\s*,?\\s*$', "", "a manifest's string entry", FORMER_LENGTH, former(FORMER_LENGTH)],
    ['^\\s+-\\s+["\']?([^"\'\\s][^"\']*?)["\']?\\s*$', "", "a list item of the repository's own config", FORMER_LENGTH, former(FORMER_LENGTH)],
    ["\\s+#.*$", "", "a trailing comment of the repository's own config", FORMER_LENGTH, former(FORMER_LENGTH)],
    ["\\/+$", "", "trailing slashes of a URL", FORMER_LENGTH, former(FORMER_LENGTH)],
    ["^func\\s+(?:\\(\\s*\\w*\\s*\\*?\\s*(\\w+)(?:\\[[^\\]]*\\])?\\s*\\)\\s*)?([A-Z]\\w*)\\s*[[(]", "", "a Go function", 600, former(600)],
    ['#\\[(?:arg|clap)\\([^\\]]*\\blong\\b(?:\\s*=\\s*"([\\w-]+)")?', "", "a Rust attribute that names a long flag", FORMER_LENGTH, atCap(FORMER_LENGTH)],
    ["(?<![\\w$])(?:(?:r|e|g)|\\w*(?:app|App|router|Router|fastify|server|Server|mux|Mux|routes?|Routes?|group|Group))\\.(get|post|put|patch|delete|options|head|all|route|GET|POST|PUT|PATCH|DELETE|Any)\\s*(?:<[^>]*>)?\\(\\s*[`'\"]((?:\\/|\\*)[^`'\"]*)[`'\"]", "", "an HTTP route with type arguments", FORMER_LENGTH, atCap(FORMER_LENGTH)],
    ["#nosec|\\bnosec\\b|checkov:skip|trivy:ignore|NOSONAR|pragma:\\s*allowlist|nolint:[^\\n]*gosec|noqa:\\s*S\\d|lgtm\\[|codeql\\[|eslint-disable[^\\n]*security", "i", "a comment that switches a security check off", FORMER_LENGTH, atCap(FORMER_LENGTH)],
  ];
  for (const [source, flags, what, length, bound] of formerly) {
    const { ms, line } = worstCost(source, flags, length, bound);
    assert.ok(ms > bound, `${what}: ${ms.toFixed(1)} ms is not over the bound of ${bound} ms (${line})`);
    const re = new RegExp(source, flags);
    const samples = sampleStrings(source);
    assert.ok(samples.some((x) => re.test(x)), `none of ${JSON.stringify(samples.slice(0, 3))} matches /${source}/`);
  }
});

test("S3 every regular expression literal in the module costs under the bound on a line at the longest a changed line is read, whatever the line repeats", () => {
  const slow: string[] = [];
  let timed = 0;
  for (const f of readdirSync(SOURCES).filter((n) => n.endsWith(".ts"))) {
    for (const r of regexLiterals(readFileSync(new URL(f, SOURCES), "utf8"))) {
      const { ms, line } = worstCost(r.source, r.flags, MAX_LINE_CHARS);
      timed += 1;
      if (ms > EXEC_BOUND_MS) slow.push(`${f}:${r.line} /${r.source}/ ${ms.toFixed(2)} ms on ${line}`);
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
  const cost = (text: string): number => { const t0 = performance.now(); parseRepoConfig(text); return performance.now() - t0; };
  const long = 200_000;
  const assertFast = (what: string, text: string): void => { const ms = cost(text); assert.ok(ms < 400, `${what}: ${Math.round(ms)} ms`); };
  assertFast("whitespace that no comment ends", `confirm_merge: risk${" \t".repeat(long / 2)}x`);
  assertFast("whitespace and hashes, then a line break inside the line", `confirm_merge: risk${" #".repeat(long / 2)}\u2028`);
  assertFast("a list item of whitespace and a quote", `high_risk_paths:\n  - a${" ".repeat(long)}b"c`);
  assertFast("a list item of whitespace, then a character that ends nothing", `high_risk_paths:\n  - "${" ".repeat(long)}x`);

  const good = (text: string) => parseRepoConfig(text);
  assert.deepEqual(good('confirm_merge: always # every merge\nhigh_risk_paths:\n  - "docs/legal/**"  # legal\n  - \'infra/*\'\n  - plain/path\n  -   spaced/path  \n'),
    { confirmMerge: "always", highRiskPaths: ["docs/legal/**", "infra/*", "plain/path", "spaced/path"] });
  assert.deepEqual(good("# a comment\n\nconfirm_merge: risk\n"), { confirmMerge: "risk", highRiskPaths: [] });
  for (const bad of ['high_risk_paths:\n  - ""\n', 'high_risk_paths:\n  - "a"b"\n', 'high_risk_paths:\n  - " a"\n', "high_risk_paths:\n  -\n", "confirm_merge: always # x\u2028 y\n", "confirm_merge: sometimes\n", "other: 1\n", "  - orphan\n"]) {
    assert.equal(good(bad), "invalid", JSON.stringify(bad));
  }
});

// ---------------------------------------------------------------------------------------------------------------------- per call

/** A change of one source file that adds these lines. A path of a kind the module has no comment syntax for, so no line of it is dropped as a comment. */
const addedLines = (lines: string[], path = "src/line.xyz"): RiskFile[] => [
  { path, status: "added", additions: lines.length, deletions: 0, patch: `@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}` },
];
const assessLines = (lines: string[], path?: string): { ms: number; reasons: string[] } => assess(addedLines(lines, path));

test("S5 one assessRisk call on the most a pull request can make it read costs a bounded amount, whatever the lines repeat", () => {
  // Every line is MAX_LINE_CHARS long and there are as many of them as the budget allows: the call reads all of them and a single
  // synchronous pattern that scans on to the end of the line from every copy of its opening makes the call take seconds. One line of
  // each opening that a pattern of the rule pack starts with and cannot finish; the sweep (S3) finds a pattern by what it costs, this finds
  // what it costs the caller, and asks for the call, not the `exec`, to be bounded.
  const openings = ["#[arg(", "#[clap(", "r.get<", "app.PUT<", "r.get<x>(", "nolint:", "eslint-disable", "/*", "function ", "export ", "import("];
  const worst: Array<[string, number]> = [];
  for (const opening of openings) {
    const line = opening.repeat(Math.ceil(MAX_LINE_CHARS / opening.length)).slice(0, MAX_LINE_CHARS);
    const lines = Array.from({ length: LINES_AT_CAP }, () => line);
    let ms = assessLines(lines).ms;
    if (ms > CALL_BUDGET_MS) ms = Math.min(ms, assessLines(lines).ms); // one pause of the process is not a slow call
    worst.push([opening, ms]);
  }
  const over = worst.filter(([, ms]) => ms > CALL_BUDGET_MS).map(([o, ms]) => `${JSON.stringify(o)} x ${LINES_AT_CAP} lines of ${MAX_LINE_CHARS}: ${Math.round(ms)} ms`);
  assert.deepEqual(over, [], `the budget of one call is ${CALL_BUDGET_MS} ms`);
});

test("S6 the patterns that were rewritten to be linear read what they read before", () => {
  const reasonsOf = (line: string): string => assessLines([line]).reasons.join("\n");
  const flag = (name: string): RegExp => new RegExp(`command-line flag ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} added`);
  const route = (name: string): RegExp => new RegExp(`HTTP route ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} added`);
  const suppressed = /security-sensitive code: a security check suppressed/;
  const readAs = (rule: "flag" | "route", cases: Array<[string, string | null]>): void => {
    for (const [line, name] of cases) {
      const reasons = reasonsOf(line);
      const re = rule === "flag" ? /command-line flag/ : /HTTP route/;
      if (name === null) assert.doesNotMatch(reasons, re, JSON.stringify(line));
      else assert.match(reasons, (rule === "flag" ? flag : route)(name), JSON.stringify(line));
    }
  };

  // A Rust attribute that names a long flag: the first attribute, from the left, that says `long` before its own `]`; the last `long` in it
  // gives the name, and a flag with no name is the field's.
  readAs("flag", [
    ["#[arg(long)]", "--(from the field name)"],
    ['#[arg(short, long = "output-dir")]', "--output-dir"],
    ['#[clap(long = "x")]', "--x"],
    ["#[clap(value_parser, long)]", "--(from the field name)"],
    ['#[arg(long, long = "a")]', "--a"],
    ['#[arg(long = "a", long)]', "--(from the field name)"],
    ['#[arg(long  =  "spaced")]', "--spaced"],
    ['#[arg(short)] #[arg(long = "z")]', "--z"],
    ['#[arg(#[arg(short)] #[arg(long = "w")]', "--w"],
    ["#[arg(#[arg(long)]", "--(from the field name)"],
    ['#[arg(short, help = "the long way")]', "--(from the field name)"],
    ["#[arg(short)]", null],
    ['#[arg(short, help = "oblong")]', null],
    ['#[arg(help = "a]", long)]', null],
    ["#[derive(Parser)]", null],
    ["# [arg(long)]", null],
    ["#[args(long)]", null],
  ]);
  // The route of a router-like object, with type arguments or without: the arguments end at the first `>`, which must be followed by the `(`
  // (so a `<` inside them does not matter, and an unclosed one does not hide the call that follows it).
  readAs("route", [
    ['app.get("/users", h)', "GET /users"],
    ["router.post('/x', h)", "POST /x"],
    ['fastify.get<{ Params: P }>("/items/:id", h)', "GET /items/:id"],
    ['app.get<T>("/a")', "GET /a"],
    ['app.get<>("/a")', "GET /a"],
    ['app.get<T, U>("/a")', "GET /a"],
    ['app.get <T>("/a")', "GET /a"],
    ['app.get<T> ("/a")', null],
    ['app.get<Map<string, number>>("/x")', null],
    ['map.get("key")', null],
    ["server.route('*', h)", "ROUTE *"],
    ['xapp.delete<T>(`/y`)', "DELETE /y"],
    ['r.get<T>', null],
    ['r.get<T>(', null],
    ['r.get<A<B>("/x")', "GET /x"],
    ['r.get<q r.post("/p")', "POST /p"],
    ['r.get<a r.put<b>("/c")', "GET /c"],
    ['r.get<a r.put<b>(x) r.get("/d")', "GET /d"],
    ['r.get<q r.post<z>("/p")', "GET /p"],
  ]);
  // A comment that switches a security check off. `nolint:` and `eslint-disable` name the checker later on the line, and only later.
  for (const line of [
    "x := y // nolint:gosec", "// nolint:errcheck,gosec", "// nolint: gosec", "//NOLINT:GOSEC", "nolint:a nolint:gosec", "nolint:gosec nolint:",
    "// eslint-disable-next-line security/detect-eval-with-expression", "// eslint-disable no-console, security/detect-object-injection", "ESLINT-DISABLE SECURITY",
    "#nosec G104", "x = 1  # noqa: S101", "a // checkov:skip=CKV_1", "lgtm[js/xss]",
  ]) assert.match(reasonsOf(line), suppressed, JSON.stringify(line));
  for (const line of [
    "//nolint:errcheck", "// gosec nolint:", "nolint gosec", "nolint:", "gosec", "/* eslint-disable no-console */", "// security eslint-disable", "eslint-disable",
    "# noqa: E501", "security",
  ]) assert.doesNotMatch(reasonsOf(line), suppressed, JSON.stringify(line));
});
