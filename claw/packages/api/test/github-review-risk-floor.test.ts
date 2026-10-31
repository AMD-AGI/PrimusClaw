// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the rule pack cannot be talked out of, by the way a change is written.
 *
 *   F1  the path floor (an authentication module, a Dockerfile, a release script) reads no content: a line that looks like a comment, in
 *       any language and including the ones that are only shaped like one, does not take the file below it
 *   F2  what a comment is depends on the language of the file: a line that only starts like one is code, and the content rules read it
 *   F3  a file tracked by Git LFS reaches the API as its pointer, a text patch, and is held like a binary whose diff was not sent
 */
import assert from "node:assert/strict";
import test from "node:test";
import { assessRisk, diffNotSent, isLfsPointerPatch, type RiskFile, type RiskInput } from "../src/github-review/risk.js";

const counts = (patch: string): { additions: number; deletions: number } => {
  let additions = 0;
  let deletions = 0;
  for (const l of patch.split("\n").slice(1)) {
    if (l.startsWith("+")) additions++;
    if (l.startsWith("-")) deletions++;
  }
  return { additions, deletions };
};
/** A modified file whose diff replaces `before` with `after` (one line each) between two lines of context. */
const edit = (path: string, before: string, after: string): RiskFile => {
  const patch = `@@ -4,3 +4,3 @@\n ctx\n-${before}\n+${after}\n ctx`;
  return { path, status: "modified", ...counts(patch), patch };
};
const assess = (files: RiskFile[], over: Partial<RiskInput> = {}) => assessRisk({
  files, changedFiles: files.length, filesComplete: true,
  additions: files.reduce((n, f) => n + f.additions, 0), deletions: files.reduce((n, f) => n + f.deletions, 0),
  fork: false, authorAssociation: "MEMBER", baseRef: "main", defaultBranch: "main", repoConfig: null, ...over,
});

test("F1 an authentication module or a release file edited with lines that look like comments is held, whatever the lines are", () => {
  const lines: Array<[string, string, string]> = [
    ["a real comment of the language", "// Sessions last a day.", "// Sessions last one day."],
    ["a JavaScript private member, which starts with the marker of another language", "#allowed() { return false; }", "#allowed() { return true; }"],
    ["an empty block comment followed by a statement", "/**/ check(token);", "/**/ ok = true;"],
    ["the end of a multiplication that starts with a star", "* 1;", "* 0;"],
    ["a docstring marker followed by code", "\"\"\" ; verify(token)", "\"\"\" ; skip(token)"],
    ["a block comment closed on the line and code after it", "/* a */ verify(token);", "/* a */ skip(token);"],
  ];
  for (const [what, before, after] of lines) {
    const r = assess([edit("src/auth/session.ts", before, after)]);
    assert.equal(r.level, "high", what);
    assert.equal(r.ruleLevel, "high", what);
    assert.match(r.reasons.join("\n"), /authentication or security code changed: src\/auth\/session\.ts/, what);
    const d = assess([edit("Dockerfile", `# ${before}`, `# ${after}`)]);
    assert.match(d.reasons.join("\n"), /release or deployment file changed: Dockerfile/, `${what} (a Dockerfile)`);
  }
  // The same files with a change that has no line at all in common with a comment are held, as they always were.
  assert.equal(assess([edit("src/auth/session.ts", "const TTL = 86400;", "const TTL = 864000;")]).level, "high");
  // A module that is not on the floor and has only comments edited is not held: the floor is a floor, not a tripwire on every source file.
  assert.equal(assess([edit("src/queue/ttl.ts", "// Entries last a day.", "// Entries last one day.")]).level, "low");
});

test("F2 a line that only starts like a comment is code, and the content rules read it; a real comment of the file's language is still not", () => {
  const code: Array<[string, string, string]> = [
    ["a JavaScript private member", "src/server.ts", "#skipAuth() { return true; }"],
    ["an empty block comment, then a call", "src/server.ts", "/**/ execSync(command);"],
    ["a block comment closed, then a call", "src/server.ts", "/* run it */ eval(input);"],
    ["the end of a multiplication", "src/server.ts", "* 0 + skipAuth();"],
    ["the end of a block comment, then a call", "src/server.ts", "*/ execSync(command);"],
    ["a Python docstring marker followed by a call", "tools/run.py", "\"\"\"x\"\"\"; os.system(command)"],
    ["a hash line in a Go file, where it is no comment", "pkg/run.go", "# eval(input)"],
    ["a double slash in a JSON file, which has no comments", "config/app.json", "// \"permissions\": [\"admin\"]"],
    ["a line of a file of a kind that is not listed", "src/tool.zzz", "# execSync(command);"],
    ["a markup comment followed by markup that runs", "web/page.html", "<!-- x --> <script>eval(input)</script>"],
  ];
  for (const [what, path, line] of code) {
    const r = assess([{ path, status: "modified", additions: 1, deletions: 0, patch: `@@ -1,1 +1,2 @@\n ctx\n+${line}` }]);
    assert.equal(r.level, "high", what);
    assert.match(r.reasons.join("\n"), /security-sensitive code/, what);
  }
  const comments: Array<[string, string, string]> = [
    ["a line comment in TypeScript", "src/server.ts", "// execSync(command) would be the wrong fix: eval(input);"],
    ["a block comment closed on its line", "src/server.ts", "/* execSync(command), eval(input) */"],
    ["the line that opens a block comment", "src/server.ts", "/** execSync(command), eval(input)"],
    ["a comment in Python", "tools/run.py", "# os.system(command) is what we replaced"],
    ["a comment in shell", "tools/run.sh", "# eval \"$x\" is what we replaced"],
    ["a comment in Go", "pkg/run.go", "// exec.Command(\"sh\", \"-c\", cmd).Run() is what we replaced"],
    ["a comment in SQL", "db/report.sql", "-- DROP TABLE reports; was here"],
    ["a comment in a PHP file, with either marker", "web/index.php", "# eval($x) was here"],
    ["a comment in markup", "web/page.html", "<!-- <script>eval(input)</script> -->"],
    ["a markup comment that opens and closes on later lines", "web/page.html", "<!-- eval(input)"],
  ];
  for (const [what, path, line] of comments) {
    const r = assess([{ path, status: "modified", additions: 1, deletions: 0, patch: `@@ -1,1 +1,2 @@\n ctx\n+${line}` }]);
    assert.deepEqual(r.reasons, [], what);
    assert.equal(r.level, "low", what);
  }
});

test("F3 a binary tracked by Git LFS is its pointer, a text patch with real line counts: it is not a diff that was shown, and the change is held", () => {
  const OLD = "a".repeat(64);
  const NEW = "b".repeat(64);
  const pointer = `@@ -1,3 +1,3 @@\n version https://git-lfs.github.com/spec/v1\n-oid sha256:${OLD}\n-size 1048576\n+oid sha256:${NEW}\n+size 1048577`;
  const file = (path: string, patch: string, status = "modified"): RiskFile => ({ path, status, ...counts(patch), patch });

  for (const [what, f] of [
    ["swapped weights", file("models/llama.safetensors", pointer)],
    ["a swapped executable", file("vendor/bin/tool", pointer)],
    ["a newly tracked file", file("assets/blob.bin", "@@ -0,0 +1,3 @@\n+version https://git-lfs.github.com/spec/v1\n+oid sha256:" + NEW + "\n+size 2048", "added")],
    ["a file that stops being tracked", file("assets/blob.bin", "@@ -1,3 +0,0 @@\n-version https://git-lfs.github.com/spec/v1\n-oid sha256:" + OLD + "\n-size 2048", "removed")],
    ["the legacy pointer spelling", file("assets/blob.bin", pointer.replace("git-lfs.github.com", "hawser.github.com"))],
    ["a pointer written with Windows line ends", file("assets/blob.bin", pointer.replace(/\n/g, "\r\n").replace("\r\n", "\n"))],
    ["only the hash line shown", file("assets/blob.bin", `@@ -2,1 +2,1 @@\n-oid sha256:${OLD}\n+oid sha256:${NEW}`)],
  ] as Array<[string, RiskFile]>) {
    assert.equal(isLfsPointerPatch(f.patch as string), true, what);
    assert.equal(diffNotSent(f), true, what);
    const r = assess([f]);
    assert.equal(r.level, "high", what);
    assert.ok(r.categories.includes("integrity"), what);
    assert.match(r.reasons.join("\n"), /Git LFS file changed .*: /, what);
  }
  // A file whose diff GitHub did not send is still the other reason, and a text file that is not a pointer is not either.
  assert.match(assess([{ path: "a.bin", status: "modified", additions: 0, deletions: 0 }]).reasons.join(), /diff not readable/);
  for (const text of ["const note = 'oid sha256:" + OLD + "';", "version https://git-lfs.github.com/spec/v1 is the first line of a pointer", "oid sha256:abc", "size 12"]) {
    const f = file("src/notes.ts", `@@ -1,1 +1,2 @@\n ctx\n+${text}`);
    assert.equal(isLfsPointerPatch(f.patch as string), false, text);
    assert.equal(diffNotSent(f), false, text);
    assert.equal(assess([f]).level, "low", text);
  }
});
