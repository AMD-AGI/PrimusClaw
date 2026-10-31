// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a stranger's pull request can cost the shared API.
 *
 * The rule pack reads every changed line of a pull request on an allowed repository, in the API's own process, synchronously, and the author need
 * not be a member of the organisation. A pattern that backtracks super-linearly on a line they write (a few whitespace characters in the wrong
 * place) freezes `gh_pr_get`, `gh_pr_risk`, a review and a merge for every tenant: measured, `func (` and spaces cost 0.6 s at 500 characters and
 * about 35 s at the 4000 the reader cuts a line to. These tests time the rule pack on adversarial lines, and on changes with more lines than
 * anything reads.
 *
 *   R1  the three exported-symbol patterns that were super-linear: the Go `func` pattern, the function-valued constant in `jsSignature`
 *       and the JVM `public` method pattern, each on a 4000-character line
 *   R2  every language's exported-symbol patterns on lines of a repeated filler, and the whole rule pack on the other shapes that are
 *       cheap to write (a manifest, a route, a flag, an environment read, a secret, a dependency line)
 *   R4  nothing else costs more than the patch is long: the rules that look at a patch as a whole run once per file, over a bounded head
 *   R3  the number of lines read is capped: a change with more is not read past the cap, says so, and is held, and the rest of a
 *       huge patch is not even split into lines
 */
import assert from "node:assert/strict";
import test from "node:test";
import { assessRisk, type RiskFile } from "../src/github-review/risk.js";
import { MAX_LINE_CHARS, MAX_READ_CHARS, MAX_READ_LINES, readChange } from "../src/github-review/risk-signals.js";

/** Healthy cost is about a millisecond; the slow patterns took 5 to 35 seconds. The bound leaves a slow machine room and a quadratic pattern none to hide in. */
const BOUND_MS = 400;

const run = (files: RiskFile[]): { ms: number; reasons: string[]; level: string } => {
  const started = performance.now();
  const r = assessRisk({
    files, changedFiles: files.length, filesComplete: true,
    additions: files.reduce((n, f) => n + f.additions, 0), deletions: files.reduce((n, f) => n + f.deletions, 0),
    fork: false, authorAssociation: "MEMBER", baseRef: "main", defaultBranch: "main", repoConfig: null,
  });
  return { ms: performance.now() - started, reasons: r.reasons, level: r.level };
};

/**
 * One removed and one added line, as an exported-symbol change reads them (both sides of the diff are matched). The two differ in their
 * last character, inside the cut: a line that is the same on both sides cancels out of the net change before any pattern reads it.
 */
const change = (path: string, line: string): RiskFile => ({
  path, status: "modified", additions: 1, deletions: 1, patch: `@@ -1,2 +1,2 @@\n-${line}\n+${line.slice(0, -1)}y\n ctx`,
});
/** A line of exactly the longest length a pattern reads: the prefix, the filler repeated, and the suffix that makes the match fail at the very end. */
const fill = (prefix: string, filler: string, suffix = ""): string => (prefix + filler.repeat(Math.ceil(MAX_LINE_CHARS / filler.length))).slice(0, MAX_LINE_CHARS - suffix.length) + suffix;

test("R1 the Go func pattern, the function-valued constant and the JVM public method pattern cost a bounded amount on a 4000-character line", () => {
  const rows: Array<[string, string, string]> = [
    ["a Go func with a receiver that never closes, and spaces", "pkg/queue/queue.go", fill("func (", " ")],
    ["the same with two spaces repeated", "pkg/queue/queue.go", fill("func (", "  ")],
    ["a Go func receiver of words and spaces", "pkg/queue/queue.go", fill("func (r ", "a ")],
    ["a function-valued constant with a return type and spaces, then a character that fails it", "src/api.ts", fill("export const f = (a) : ", " ", "!")],
    ["the same with tabs", "src/api.ts", fill("export const f = (a): ", "\t", "!")],
    ["the same in a file that is an entry point", "src/index.ts", fill("export const f = (a) : ", " ", "!")],
    ["a Java public method of spaces and nothing that ends it", "src/main/A.java", fill("public ", " ", "!")],
    ["a Java public static method", "src/main/A.java", fill("public static ", " ", "!")],
    ["a Kotlin public method", "src/main/A.kt", fill("public final ", " ", "!")],
    ["a C# public method", "src/A.cs", fill("public async ", " ", "!")],
    ["a Scala public method", "src/A.scala", fill("public ", "a ", "!")],
  ];
  for (const [what, path, line] of rows) {
    assert.equal(line.length, MAX_LINE_CHARS, what);
    const { ms } = run([change(path, line)]);
    assert.ok(ms < BOUND_MS, `${what}: ${Math.round(ms)} ms (bound ${BOUND_MS})`);
  }
});

test("R2 every language's patterns, and the rest of the rule pack, cost a bounded amount on lines of repeated fillers", () => {
  const files: Array<[string, string[]]> = [
    ["src/a.ts", ["export const x = (", "export const x = async <", "export const x: ", "export function ", "export {", "export * from '", "export type {", "app.get(", "process.env.", "const x = require("]],
    ["pkg/a.go", ["func (r *T[", "func (r *T", "func Foo", "type ", "var ", "const ", "http.HandleFunc("]],
    ["src/A.java", ["public static List<", "public class ", "public static void ", "@GetMapping(", "public sealed partial "]],
    ["tools/a.py", ["def ", "class ", "async def ", "os.environ[", "parser.add_argument("]],
    ["src/a.rs", ["pub(crate) ", "pub fn ", "pub async unsafe ", "std::env::var("]],
    ["package.json", ["\"@a/b\": ", "\"version\" "]],
    ["go.mod", ["require ", "github.com/a/b "]],
    ["db/a.sql", ["ALTER TABLE ", "CREATE OR REPLACE ", "DROP "]],
    [".env.example", ["SECRET_", "TOKEN="]],
    ["Dockerfile", ["# syntax ", "FROM "]],
    ["src/a.c", ["# ", "#define "]],
  ];
  const fillers = [" ", "\t", "a", "a ", " a", "(", "<", "[", ",", ":", "=", "*", "-", ".", "\"", "_a"];
  let worst = 0;
  let lines = 0;
  for (const [path, prefixes] of files) {
    for (const prefix of prefixes) {
      for (const filler of fillers) {
        for (const suffix of ["", "!"]) {
          const { ms } = run([change(path, fill(prefix, filler, suffix))]);
          lines += 1;
          worst = Math.max(worst, ms);
          assert.ok(ms < BOUND_MS, `${path} ${JSON.stringify(prefix)} ${JSON.stringify(filler)} ${JSON.stringify(suffix)}: ${Math.round(ms)} ms (bound ${BOUND_MS})`);
        }
      }
    }
  }
  assert.ok(lines > 1000, `the matrix has ${lines} lines`);
});

test("R3 a change with more lines than are read is not read past the cap, says so, and is held; one within the cap says nothing of it", () => {
  const lines = (n: number, text: string): RiskFile => ({
    path: "src/big.ts", status: "modified", additions: n, deletions: 0, patch: `@@ -1,1 +1,${n} @@\n${Array.from({ length: n }, () => `+${text}`).join("\n")}`,
  });
  const message = /more changed text than is read line by line/;

  const manyShort = run([lines(MAX_READ_LINES + 1000, "const a = 1;")]);
  assert.match(manyShort.reasons.join("\n"), message);
  assert.equal(manyShort.level, "high");
  assert.ok(manyShort.ms < 3000, `${Math.round(manyShort.ms)} ms`);

  const manyLong = run([lines(Math.ceil(MAX_READ_CHARS / MAX_LINE_CHARS) + 100, "a".repeat(MAX_LINE_CHARS))]);
  assert.match(manyLong.reasons.join("\n"), message);
  assert.ok(manyLong.ms < 3000, `${Math.round(manyLong.ms)} ms`);

  // Three hundred lines is a large change, but it is all read.
  const within = run([lines(300, "const a = 1;")]);
  assert.doesNotMatch(within.reasons.join("\n"), message);
  assert.equal(within.level, "low");
});

test("R3b the cap is over the files together, not per file: many files of a few lines each do not add up to an unbounded read", () => {
  const files: RiskFile[] = Array.from({ length: 500 }, (_, i) => ({
    path: `src/f${i}.ts`, status: "modified", additions: 60, deletions: 0,
    patch: `@@ -1,1 +1,60 @@\n${Array.from({ length: 60 }, () => "+const a = 1;").join("\n")}`,
  }));
  const r = run(files);
  assert.match(r.reasons.join("\n"), /more changed text than is read line by line/);
  assert.ok(r.ms < 3000, `${Math.round(r.ms)} ms`);
});

test("R3c a patch of millions of lines is read up to the cap and no further: the rest of it is not split or collected", () => {
  const n = 4_000_000;
  const patch = `@@ -1,1 +1,2 @@\n${"+x = 1;\n".repeat(n)}`; // about 32 MB, which splitting into lines costs more than a second to collect
  const file: RiskFile = { path: "src/huge.ts", status: "modified", additions: n, deletions: 0, patch };
  const started = performance.now();
  const read = readChange([file]);
  const ms = performance.now() - started;
  assert.equal(read.lines.get(file)?.added.length, MAX_READ_LINES);
  assert.equal(read.truncated, true);
  assert.ok(ms < 250, `${Math.round(ms)} ms`);
});

test("R4 a manifest of tens of thousands of workspace-entry lines, and many such manifests, cost a bounded amount: the patch is not scanned again for every line", () => {
  /** The key is context at the top of the diff, as it is when a workspace glob is added to the list under it; without it nothing in the diff says `workspaces`. */
  const manifest = (path: string, lines: number, key: boolean): RiskFile => ({
    path, status: "modified", additions: lines, deletions: 0,
    patch: `@@ -1,3 +1,${lines + 3} @@\n   ${key ? '"workspaces": [' : '"files": ['}\n${Array.from({ length: lines }, (_, i) => `+    "pkg/p${i}",`).join("\n")}\n   ]`,
  });
  const bound = 800;
  const withKey = run([manifest("package.json", 40_000, true)]);
  assert.match(withKey.reasons.join("\n"), /workspace, layering or module-boundary rules changed \(package\.json\)/);
  const without = run([manifest("package.json", 40_000, false)]);
  assert.ok(without.ms < bound, `one manifest of 40000 lines without the key: ${Math.round(without.ms)} ms (bound ${bound})`);
  const many = run(Array.from({ length: 100 }, (_, k) => manifest(`p${k}/package.json`, 10_000, false)));
  assert.ok(many.ms < bound, `100 manifests of 10000 lines: ${Math.round(many.ms)} ms (bound ${bound})`);
  // Whatever its size, a change of that many lines is held.
  assert.equal(many.level, "high");
});
