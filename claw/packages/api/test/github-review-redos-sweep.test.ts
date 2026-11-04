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
 *   S2  the timing sees what it is for: the patterns that were super-linear (copied as they were) are over the bound, and their cost grows
 *       faster than their line
 *   S3  every regular expression literal in `src/github-review` is under it, on lines at the longest a changed line is read, including lines
 *       that say the opening of the pattern over and over; or, where one `exec` was timed over it, its cost on its slowest line grows no
 *       faster than the line does, since a pause of a busy runner makes a pattern of a few microseconds look slow and never makes it grow
 *   S4  the entry points that read a repository's own text (`.github/claw-review.yml`, a `package.json` change) cost a bounded amount on the
 *       lines that were slow, and read what they read before
 *   S5  one `assessRisk` call on the most a pull request can make it read (500 lines at the cap) costs a bounded amount, whatever the lines
 *       repeat: the bound is on the call, which is what the shared API pays, and not on one `exec`; it is a multiple of what a call on lines
 *       nothing reads costs, timed in the same run, so that how fast or how busy the machine is cancels out; and that call on lines
 *       nothing reads is itself bounded, by the same text in lines a tenth as long and by a plain pass of linear patterns over it, since a
 *       slowdown that reaches every line moves the call and what it is compared with alike
 *   S6  the three patterns that were rewritten after S5 was written read what they read before
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { assessRisk, parseRepoConfig, type RiskFile } from "../src/github-review/risk.js";
import { MAX_LINE_CHARS, MAX_READ_CHARS } from "../src/github-review/risk-signals.js";
import { growth, regexLiterals, sampleStrings, worstCost } from "./support/regex-sweep.js";

const SOURCES = new URL("../src/github-review/", import.meta.url);
/** The longest a line is that a pattern of the rule pack reads, and the most lines of that length one change can make it read. */
const LINES_AT_CAP = MAX_READ_CHARS / MAX_LINE_CHARS;
/**
 * What one `assessRisk` call may cost on such a change whatever its lines say: the call is synchronous in the API's own process, so this is
 * how long every tenant waits for one pull request. A call on lines that no pattern has anything to say about costs a quarter of it.
 */
const CALL_BUDGET_MS = 400;
/** The same budget as S5 measures it: a call may cost this many times what a call on lines that no pattern has anything to say about costs. */
const CALL_BUDGET_RATIO = 4;
/** So the most one pattern may cost on one line at the cap: a pattern that costs more makes a call over the budget when the change repeats what it starts on. */
const EXEC_BOUND_MS = CALL_BUDGET_MS / LINES_AT_CAP;
/** The length and the bound the first sweep used, which the patterns it was written for are timed at (see S2). */
const FORMER_LENGTH = 8000;
const FORMER_BOUND_MS = 10;
/**
 * How many times as long a pattern may take on its slowest line as on that line at a quarter of the length (`growth`): a pattern linear in its
 * line takes about 4 times as long and one that costs the square of it about 16, so this is the middle of the two by ratio, not a time.
 */
const GROWTH_BOUND = 8;
/**
 * What the call on lines that nothing reads is held to, since the ratio above takes it as its unit and a slowdown that reaches every line
 * moves it as much as it moves what it is compared with. Both are timed in the same run, and neither goes through the rule pack's work on a line.
 * The call on the lines at the cap may cost this many times the call on the same characters in ten times as many lines of a tenth of the
 * length: a call that is linear in what it reads costs about the same (a little less, as a line has a cost of its own), and a pattern that
 * costs the square of its line makes the long lines cost up to ten times the short ones.
 */
const SHORT_LINES_RATIO = 2;
/**
 * ... and this many times a plain pass over the same characters: every line split into words and read by a few ordinary patterns that are
 * linear in the line, none of them the rule pack's. The call costs about five times it, so a call that does the same work several times
 * over, or a pattern that costs more than its line is long, is over it, and the rule pack has room to cost a little over three times what it does.
 */
const REFERENCE_PASS_RATIO = 20;
const REFERENCE_PATTERNS = [/foo/, /\bbar\b/i, /baz\s*=/, /(?:a|b)c+d/, /x\d{2,3}y/, /^\s*#/, /@\w+/, /todo|fixme/i, /\.get\(/, /import\s+\w+/];
const referencePass = (lines: string[]): number => {
  let n = 0;
  for (const line of lines) {
    for (const re of REFERENCE_PATTERNS) if (re.test(line)) n += 1;
    n += line.split(/\s+/).length;
  }
  return n;
};

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
    assert.ok(ms > bound, `${what}: ${ms.toFixed(1)} ms is not over the bound of ${bound} ms (${line.what})`);
    // What S3 asks of a pattern that was timed over the bound, these answer as super-linear. Asked on the slowest of all the lines (found at
    // a quarter of the length, where that costs a sixteenth), not on the first line over the bound: on a slow enough machine that one can be
    // a line the pattern reads in linear time. Three rounds: they are far over it.
    const slowest = worstCost(source, flags, length / 4).line;
    const grew = growth(source, flags, slowest, length, 3);
    assert.ok(grew > GROWTH_BOUND, `${what}: ${grew.toFixed(1)} times as long at four times the length (${slowest.what})`);
    const re = new RegExp(source, flags);
    const samples = sampleStrings(source);
    assert.ok(samples.some((x) => re.test(x)), `none of ${JSON.stringify(samples.slice(0, 3))} matches /${source}/`);
  }
});

test("S3 every regular expression literal in the module costs under the bound on a line at the longest a changed line is read, or grows no faster than the line, whatever the line repeats", () => {
  // The bound is a fraction of a millisecond, and a CI runner whose CPU is shared has once timed a pattern that costs 0.06 ms at 1.45 ms
  // (in each of the three timings of its line). So a pattern over it is asked how its cost grows on that line, a ratio of two times that
  // the same pauses touch alike, and is slow only if it grows faster than the line: the defect the bound is there for is a pattern whose
  // cost grows with the square of its line (S2), and such a pattern is over the bound in the first place and over GROWTH_BOUND as well.
  const slow: string[] = [];
  let timed = 0;
  for (const f of readdirSync(SOURCES).filter((n) => n.endsWith(".ts"))) {
    for (const r of regexLiterals(readFileSync(new URL(f, SOURCES), "utf8"))) {
      const { ms, line } = worstCost(r.source, r.flags, MAX_LINE_CHARS);
      timed += 1;
      if (ms <= EXEC_BOUND_MS) continue;
      let grew = growth(r.source, r.flags, line, MAX_LINE_CHARS);
      if (grew > GROWTH_BOUND) grew = Math.min(grew, growth(r.source, r.flags, line, MAX_LINE_CHARS)); // a super-linear pattern is over it every time
      if (grew > GROWTH_BOUND) slow.push(`${f}:${r.line} /${r.source}/ ${ms.toFixed(2)} ms on ${line.what}, ${grew.toFixed(1)} times as long as at a quarter of the length`);
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
  return { ms: performance.now() - started, reasons: r.evidence };
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

test("S5 one assessRisk call on the most a pull request can make it read costs a bounded amount, whatever the lines repeat", (t) => {
  // Every line is MAX_LINE_CHARS long and there are as many of them as the budget allows: the call reads all of them and a single
  // synchronous pattern that scans on to the end of the line from every copy of its opening makes the call take seconds. One line of
  // each opening that a pattern of the rule pack starts with and cannot finish; the sweep (S3) finds a pattern by what it costs, this finds
  // what it costs the caller, and asks for the call, not the `exec`, to be bounded.
  //
  // The bound is not a number of milliseconds, which a busy CI runner makes any call exceed (one run measured 2959 ms for a call that takes
  // 60 to 90 ms): it is CALL_BUDGET_RATIO times a call on lines that no pattern has anything to say about, timed in the same process, so
  // that a slow machine slows both and the ratio stays what it is. Each is timed ROUNDS times, round after round, and the least of the
  // rounds is the one compared: a pause only ever makes a call slower, so the least is the one it touched least, on either side of the
  // ratio, and one pause cannot decide the result. A pattern that has gone super-linear is over the bound in every round.
  //
  // That ratio cannot see a slowdown that reaches every line, which slows the call on lines nothing reads as much as the call it is compared
  // with. So the call on lines nothing reads is bounded first, and by two things that do not go through the same work on a line, timed in
  // the same rounds: the same characters in ten times as many shorter lines (what the cost does as a line grows) and a plain pass of ordinary
  // patterns over the same lines (what the call does besides reading them). Neither is a number of milliseconds either.
  const ROUNDS = 3;
  const BASE_ROUNDS = 7; // the two bounds on the call that reads nothing are cheap to time, so the least of more rounds
  const openings = ["#[arg(", "#[clap(", "r.get<", "app.PUT<", "r.get<x>(", "nolint:", "eslint-disable", "/*", "function ", "export ", "import("];
  const fill = (unit: string, length = MAX_LINE_CHARS): string => unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
  const callMs = (line: string): number => assessLines(Array.from({ length: LINES_AT_CAP }, () => line)).ms;
  const words = "lorem ipsum dolor sit amet "; // words, as a line of prose is, and none of the openings above
  const quiet = fill(words);
  const quietLines = Array.from({ length: LINES_AT_CAP }, () => quiet);
  const shortLines = Array.from({ length: 10 * LINES_AT_CAP }, () => fill(words, MAX_LINE_CHARS / 10)); // the same characters
  const timed = (f: () => unknown): number => { const t0 = performance.now(); f(); return performance.now() - t0; };

  let base = Infinity;
  let shortBase = Infinity;
  let reference = Infinity;
  let reasons: string[] = [];
  let shortReasons: string[] = [];
  for (let round = 0; round < BASE_ROUNDS; round++) {
    reference = Math.min(reference, timed(() => referencePass(quietLines)));
    const call = assessLines(quietLines);
    base = Math.min(base, call.ms);
    reasons = call.reasons;
    const shortCall = assessLines(shortLines);
    shortBase = Math.min(shortBase, shortCall.ms);
    shortReasons = shortCall.reasons;
  }
  t.diagnostic(`${LINES_AT_CAP} lines of ${MAX_LINE_CHARS}: ${base.toFixed(1)} ms; the same characters in ${shortLines.length} lines of ${MAX_LINE_CHARS / 10}: ${shortBase.toFixed(1)} ms (${(base / shortBase).toFixed(2)} times, bound ${SHORT_LINES_RATIO}); a plain pass: ${reference.toFixed(1)} ms (${(base / reference).toFixed(1)} times, bound ${REFERENCE_PASS_RATIO})`);
  // Both calls read all of what they were given (neither was cut at the budget) and say the same, or they are not the same text.
  assert.deepEqual(shortReasons, reasons, "the calls on the long and on the short lines read the same text");
  const unbounded: string[] = [];
  if (base > SHORT_LINES_RATIO * shortBase) {
    unbounded.push(`${LINES_AT_CAP} lines of ${MAX_LINE_CHARS}: ${Math.round(base)} ms against ${Math.round(shortBase)} ms for the same characters in ${shortLines.length} lines of ${MAX_LINE_CHARS / 10} (${(base / shortBase).toFixed(1)} times, over ${SHORT_LINES_RATIO}): the cost grows faster than the line`);
  }
  if (base > REFERENCE_PASS_RATIO * reference) {
    unbounded.push(`${LINES_AT_CAP} lines of ${MAX_LINE_CHARS}: ${Math.round(base)} ms against ${reference.toFixed(1)} ms for a plain pass over the same text (${(base / reference).toFixed(1)} times, over ${REFERENCE_PASS_RATIO}): the call does more work than reading it needs`);
  }
  assert.deepEqual(unbounded, [], `the call on lines that nothing reads is bounded by the same text in shorter lines and by a plain pass, least of ${BASE_ROUNDS} rounds each`);

  const lines = openings.map((o) => fill(o));
  const least = openings.map(() => Infinity);
  for (let round = 0; round < ROUNDS; round++) {
    base = Math.min(base, callMs(quiet));
    lines.forEach((line, k) => { least[k] = Math.min(least[k]!, callMs(line)); });
  }
  const over = openings.flatMap((opening, k) => least[k]! > CALL_BUDGET_RATIO * base
    ? [`${JSON.stringify(opening)} x ${LINES_AT_CAP} lines of ${MAX_LINE_CHARS}: ${Math.round(least[k]!)} ms against ${Math.round(base)} ms for a call on lines nothing reads (${(least[k]! / base).toFixed(1)} times)`]
    : []);
  assert.deepEqual(over, [], `the budget of one call is ${CALL_BUDGET_RATIO} times a call that reads nothing, least of ${ROUNDS} rounds each`);
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
