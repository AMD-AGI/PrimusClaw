// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the sandbox prints about its work trees, parsed: git's `-z` status and numstat
 * (spaces, renames, binaries, a cut stream), the framing the summary script writes,
 * the untracked count, the limits, and the matching of a patch request against the
 * listing. Pure: no sandbox, no git; the scripts that produce these bytes are run
 * for real in session-changes.test.ts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  CHANGES_MAX_FILES, CHANGES_MAX_REPOS, LINE_COUNT_CAP, PATCH_MAX_BYTES, PATCH_READ_BYTES,
  assembleRepo, isPathUnder, parseNumstatZ, parsePatch, parseStatusZ, parseSummary, pathParam,
  resolvePatchTarget, statusLetter, summaryScript, patchScript, checkPatchParams, maskCredentialText, type KnownFile,
} from "../src/sessions/changes.js";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const hex = (s: string) => Buffer.from(s, "utf8").toString("hex");
const z = (...parts: string[]) => Buffer.from(parts.join("\0") + "\0", "utf8");

// --- git status --porcelain=v1 -z -------------------------------------------------------

test("status -z: one entry per record, paths taken verbatim (spaces, quotes, non-ASCII, a newline)", () => {
  const { entries, partial } = parseStatusZ(z(
    " M src/a.ts", "A  new file.txt", " D gone.txt", "M  \"quoted\".txt", "MM café.txt", " M has\nnewline.txt", "UU conflict.txt", "AM both.txt",
  ));
  assert.equal(partial, false);
  assert.deepEqual(entries, [
    { xy: " M", path: "src/a.ts" }, { xy: "A ", path: "new file.txt" }, { xy: " D", path: "gone.txt" },
    { xy: "M ", path: "\"quoted\".txt" }, { xy: "MM", path: "café.txt" }, { xy: " M", path: "has\nnewline.txt" },
    { xy: "UU", path: "conflict.txt" }, { xy: "AM", path: "both.txt" },
  ]);
});

test("status -z: a rename or copy is followed by its original path, which is not an entry of its own", () => {
  const { entries } = parseStatusZ(z("R  new name.txt", "old name.txt", " M after.txt", "C  copy.txt", "src.txt", "RM both.txt", "orig.txt"));
  assert.deepEqual(entries.map((e) => [e.xy, e.path]), [["R ", "new name.txt"], [" M", "after.txt"], ["C ", "copy.txt"], ["RM", "both.txt"]]);
});

test("status -z: a rename keeps where it came from, for the patch, and the answer does not carry it", () => {
  const { entries } = parseStatusZ(z("R  new name.txt", "old name.txt", " M plain.txt"));
  assert.deepEqual(entries, [{ xy: "R ", path: "new name.txt", orig: "old name.txt" }, { xy: " M", path: "plain.txt" }]);
  const out = block({ path: "/workspace/r", status: z("R  new name.txt", "old name.txt"), numstat: z("1\t2\t", "old name.txt", "new name.txt") });
  const a = assembleRepo(parseSummary(out, "/workspace").repos[0]);
  assert.deepEqual(a.repo.files, [{ path: "new name.txt", status: "R", additions: 1, deletions: 2, binary: false }], "the contract's keys only");
  assert.equal(a.known.get("new name.txt")?.orig, "old name.txt");
  const target = resolvePatchTarget("/workspace/r", "new name.txt", new Map([["/workspace/r", a.known]]), "/workspace");
  assert.deepEqual(target, { ok: true, repo: "/workspace/r", file: "new name.txt", untracked: false, orig: "old name.txt" });
  const s = patchScript("/workspace/r", "new name.txt", false, "old name.txt");
  assert.ok(s.includes("-M \"$base\" -- 'new name.txt' 'old name.txt'"), s);
});

test("checkPatchParams: the shape alone, with nothing to look anything up in", () => {
  assert.deepEqual(checkPatchParams("/workspace/app", "src/a.ts"), { ok: true, repo: "/workspace/app", rel: "src/a.ts" });
  assert.deepEqual(checkPatchParams("/workspace/app", "/workspace/app/src/a.ts"), { ok: true, repo: "/workspace/app", rel: "src/a.ts" });
  assert.deepEqual(checkPatchParams("/etc", "x"), { ok: false, status: 400, error: "invalid_repo" });
  assert.deepEqual(checkPatchParams("/workspace/app", "../x"), { ok: false, status: 400, error: "invalid_file" });
  assert.deepEqual(checkPatchParams("/workspace/app", ["x"]), { ok: false, status: 400, error: "invalid_file" });
  assert.deepEqual(checkPatchParams("/tmp/ws/app", "x", "/tmp/ws"), { ok: true, repo: "/tmp/ws/app", rel: "x" });
});

test("status -z: empty output is no entries; a stream cut before its last NUL is reported as partial", () => {
  assert.deepEqual(parseStatusZ(Buffer.alloc(0)), { entries: [], partial: false }, "a clean tree prints nothing, which is a complete stream");
  assert.deepEqual(parseStatusZ(z()).entries, []);
  const cut = parseStatusZ(Buffer.from(" M a.ts\0 M b.ts\0 M c.", "utf8"));
  assert.equal(cut.partial, true);
  assert.deepEqual(cut.entries.map((e) => e.path), ["a.ts", "b.ts"], "the half record is dropped");
});

test("status -z: records too short to be one are skipped", () => {
  assert.deepEqual(parseStatusZ(z(" M ", "x", " M ok.txt")).entries.map((e) => e.path), ["ok.txt"]);
});

test("statusLetter: the five letters of the contract", () => {
  const rows: Array<[string, string]> = [
    [" M", "M"], ["M ", "M"], ["MM", "M"], ["T ", "M"], [" T", "M"], ["UU", "M"], ["AA", "M"] as never,
    ["A ", "A"], [" A", "A"], ["AM", "A"], ["C ", "A"], ["CM", "A"],
    [" D", "D"], ["D ", "D"], ["MD", "D"], ["DD", "D"],
    ["R ", "R"], ["RM", "R"], [" R", "R"], ["RD", "R"],
    ["??", "?"],
  ];
  // AA is "both added" (unmerged); the contract has no unmerged letter, and A is what it says.
  for (const [xy, want] of rows) {
    if (xy === "AA") continue;
    assert.equal(statusLetter(xy), want, xy);
  }
  assert.equal(statusLetter("AA"), "A");
});

// --- git diff --numstat -z ---------------------------------------------------------------

test("numstat -z: counts, spaces in a path, binary files as '-' and null, zero counts", () => {
  const m = parseNumstatZ(z("12\t3\tsrc/a.ts", "0\t0\tmode only.sh", "-\t-\timg/logo.png", "5\t0\tnew file.txt", "0\t7\tgone.txt"));
  assert.deepEqual([...m.entries()], [
    ["src/a.ts", { additions: 12, deletions: 3, binary: false }],
    ["mode only.sh", { additions: 0, deletions: 0, binary: false }],
    ["img/logo.png", { additions: null, deletions: null, binary: true }],
    ["new file.txt", { additions: 5, deletions: 0, binary: false }],
    ["gone.txt", { additions: 0, deletions: 7, binary: false }],
  ]);
});

test("numstat -z: a rename is `added TAB deleted TAB NUL old NUL new` and is keyed by the new path", () => {
  const m = parseNumstatZ(z("1\t2\t", "old name.txt", "new name.txt", "4\t0\tplain.txt", "0\t0\t", "a.txt", "b.txt"));
  assert.deepEqual([...m.keys()], ["new name.txt", "plain.txt", "b.txt"]);
  assert.deepEqual(m.get("new name.txt"), { additions: 1, deletions: 2, binary: false });
});

test("numstat -z: nothing, and records that are not numstat, give an empty map without throwing", () => {
  assert.equal(parseNumstatZ(Buffer.alloc(0)).size, 0);
  assert.equal(parseNumstatZ(z("garbage", "also garbage")).size, 0);
  assert.equal(parseNumstatZ(Buffer.from("3\t1\tcut.txt", "utf8")).size, 0, "an unterminated last record is not trusted");
});

// --- the summary framing ----------------------------------------------------------------

const ROOT = "/workspace";
function block(p: { path: string; head?: string; branch?: string; status?: Buffer; numstat?: Buffer; untracked?: Array<[string, string]>; more?: boolean }) {
  return [
    `@@REPO ${hex(p.path)}`, `@@HEAD ${p.head ?? "abc1234"}`, `@@BRANCH ${p.branch ?? "main"}`,
    `@@STATUS ${(p.status ?? Buffer.alloc(0)).toString("base64")}`, `@@NUMSTAT ${(p.numstat ?? Buffer.alloc(0)).toString("base64")}`,
    ...(p.untracked ?? []).map(([f, n]) => `@@U ${hex(f)} ${n}`),
    ...(p.more ? ["@@UMORE"] : []),
    "@@END",
  ].join("\n");
}

test("summary: a repository with a modified file, a rename, a binary, an addition, an untracked file", () => {
  const out = block({
    path: "/workspace/app", head: "1a2b3c4", branch: "feat/x",
    status: z(" M src/a.ts", "R  b new.txt", "b old.txt", "M  img/logo.png", "A  added.txt", " D gone.txt"),
    numstat: z("12\t3\tsrc/a.ts", "0\t0\t", "b old.txt", "b new.txt", "-\t-\timg/logo.png", "2\t0\tadded.txt", "0\t4\tgone.txt"),
    untracked: [["u one.txt", "4"], ["blob.bin", "-"], ["huge.log", "?"]],
  });
  const { repos, moreRepos } = parseSummary(out, ROOT);
  assert.equal(moreRepos, false);
  assert.equal(repos.length, 1);
  const { repo } = assembleRepo(repos[0]);
  assert.equal(repo.path, "/workspace/app");
  assert.equal(repo.head, "1a2b3c4");
  assert.equal(repo.branch, "feat/x");
  assert.equal(repo.truncated, false);
  assert.deepEqual(repo.files, [
    { path: "added.txt", status: "A", additions: 2, deletions: 0, binary: false },
    { path: "b new.txt", status: "R", additions: 0, deletions: 0, binary: false },
    { path: "blob.bin", status: "?", additions: null, deletions: null, binary: true },
    { path: "gone.txt", status: "D", additions: 0, deletions: 4, binary: false },
    { path: "huge.log", status: "?", additions: null, deletions: 0, binary: false },
    { path: "img/logo.png", status: "M", additions: null, deletions: null, binary: true },
    { path: "src/a.ts", status: "M", additions: 12, deletions: 3, binary: false },
    { path: "u one.txt", status: "?", additions: 4, deletions: 0, binary: false },
  ]);
  assert.deepEqual(repo.totals, { files: 8, additions: 12 + 2 + 4, deletions: 3 + 4 });
});

test("summary: an untracked file's lines are counted as added, capped", () => {
  const out = block({ path: "/workspace/r", untracked: [["big.txt", "5000000"], ["empty.txt", "0"]] });
  const files = assembleRepo(parseSummary(out, ROOT).repos[0]).repo.files;
  assert.deepEqual(files.map((f) => [f.path, f.additions]), [["big.txt", 1_000_000], ["empty.txt", 0]]);
  assert.equal(LINE_COUNT_CAP, 1_000_000);
});

test("summary: HEAD and branch edge cases: no commit yet, a detached HEAD, odd text", () => {
  const out = [
    block({ path: "/workspace/unborn", head: "", branch: "main" }),
    block({ path: "/workspace/detached", head: "deadbee", branch: "" }),
    block({ path: "/workspace/odd", head: "not a sha", branch: "  spaced  " }),
  ].join("\n");
  const rs = parseSummary(out, ROOT).repos.map((r) => assembleRepo(r).repo);
  assert.deepEqual(rs.map((r) => [r.path, r.head, r.branch]), [
    ["/workspace/unborn", "", "main"], ["/workspace/detached", "deadbee", null], ["/workspace/odd", "", "spaced"],
  ]);
});

test("summary: a repository whose path is not a path under the root is left out, not guessed at", () => {
  const bad = [
    "/etc", "/workspace/../etc", "/workspace2/x", "relative/path", "/workspace//x", "/workspace/x/", "", `/workspace/${"a".repeat(2000)}`,
    "/workspace/with\nnewline", "/workspace/nul\0byte",
  ];
  const out = bad.map((p) => block({ path: p })).join("\n") + "\n" + block({ path: "/workspace/ok" });
  assert.deepEqual(parseSummary(out, ROOT).repos.map((r) => r.path), ["/workspace/ok"]);
  // and a hex string that is not hex
  assert.deepEqual(parseSummary("@@REPO zz\n@@END\n@@REPO 2f\n@@END", ROOT).repos, []);
});

test("summary: the root itself may be a work tree; the root is whatever the caller says it is", () => {
  assert.deepEqual(parseSummary(block({ path: "/workspace" }), ROOT).repos.map((r) => r.path), ["/workspace"]);
  assert.deepEqual(parseSummary(block({ path: "/tmp/ws/app" }), "/tmp/ws").repos.map((r) => r.path), ["/tmp/ws/app"]);
  assert.deepEqual(parseSummary(block({ path: "/workspace/app" }), "/tmp/ws").repos, []);
});

test("summary: junk lines, a missing @@END, a block with no header, and CRLF are tolerated", () => {
  const out = `noise\r\n${block({ path: "/workspace/a" })}\r\n@@STATUS ${b64(" M orphan\0")}\n@@HEAD zzz\nmore noise\n@@REPO ${hex("/workspace/never-closed")}\n@@HEAD 1234abcd`;
  const rs = parseSummary(out, ROOT);
  assert.deepEqual(rs.repos.map((r) => r.path), ["/workspace/a"], "a block that never ended is not trusted");
  assert.equal(rs.repos[0].status.length, 0, "lines outside a block are not attached to the previous one");
});

// --- limits -----------------------------------------------------------------------------

test("limits: over 200 files are cut, sorted, flagged, and the totals still count what is known", () => {
  const names = Array.from({ length: 250 }, (_, i) => `f${String(i).padStart(3, "0")}.txt`);
  const status = z(...names.map((n) => ` M ${n}`));
  const numstat = z(...names.map((n) => `1\t1\t${n}`));
  const { repo } = assembleRepo(parseSummary(block({ path: "/workspace/big", status, numstat }), ROOT).repos[0]);
  assert.equal(repo.files.length, CHANGES_MAX_FILES);
  assert.equal(repo.truncated, true);
  assert.deepEqual(repo.files.map((f) => f.path), names.slice(0, CHANGES_MAX_FILES));
  assert.deepEqual(repo.totals, { files: 250, additions: 250, deletions: 250 });
});

test("limits: exactly 200 files is not truncated; 200 untracked plus 'more' is", () => {
  const exact = Array.from({ length: CHANGES_MAX_FILES }, (_, i) => `f${i}.txt`);
  const a = assembleRepo(parseSummary(block({ path: "/workspace/r", status: z(...exact.map((n) => ` M ${n}`)) }), ROOT).repos[0]).repo;
  assert.equal(a.truncated, false);
  assert.equal(a.files.length, CHANGES_MAX_FILES);
  const b = assembleRepo(parseSummary(block({ path: "/workspace/r", untracked: exact.map((n) => [n, "1"] as [string, string]), more: true }), ROOT).repos[0]).repo;
  assert.equal(b.truncated, true);
  assert.equal(b.files.length, CHANGES_MAX_FILES);
  assert.equal(b.totals.files, CHANGES_MAX_FILES + 1, "at least one more exists");
});

test("limits: a status stream that was cut at the read limit marks the repository truncated", () => {
  const cutStream = Buffer.concat([z(" M a.ts"), Buffer.from(" M b", "utf8")]);
  const r = assembleRepo(parseSummary(block({ path: "/workspace/r", status: cutStream }), ROOT).repos[0]).repo;
  assert.equal(r.truncated, true);
  assert.deepEqual(r.files.map((f) => f.path), ["a.ts"]);
});

test("limits: @@MORE after a repository is the script saying it stopped at its output budget", () => {
  const out = [block({ path: "/workspace/a" }), "@@MORE"].join("\n");
  const rs = parseSummary(out, ROOT);
  assert.deepEqual(rs.repos.map((r) => r.path), ["/workspace/a"]);
  assert.equal(rs.moreRepos, true);
  assert.equal(parseSummary(block({ path: "/workspace/a" }), ROOT).moreRepos, false);
});

test("limits: more than 20 repositories lists 20 and says there are more", () => {
  const out = Array.from({ length: CHANGES_MAX_REPOS + 1 }, (_, i) => block({ path: `/workspace/r${String(i).padStart(2, "0")}` })).join("\n");
  const rs = parseSummary(out, ROOT);
  assert.equal(rs.repos.length, CHANGES_MAX_REPOS);
  assert.equal(rs.moreRepos, true);
});

test("a path in both status and untracked is listed once, as the status says", () => {
  const out = block({ path: "/workspace/r", status: z(" M both.txt"), numstat: z("1\t1\tboth.txt"), untracked: [["both.txt", "9"]] });
  const files = assembleRepo(parseSummary(out, ROOT).repos[0]).repo.files;
  assert.deepEqual(files, [{ path: "both.txt", status: "M", additions: 1, deletions: 1, binary: false }]);
});

// --- the patch form: matching a request against the listing ------------------------------

function listingOf(): Map<string, Map<string, KnownFile>> {
  const mk = (path: string, status: KnownFile["status"]): [string, KnownFile] => [path, { path, status, additions: 1, deletions: 0, binary: false }];
  return new Map([
    ["/workspace/app", new Map([mk("src/a.ts", "M"), mk("new file.txt", "?"), mk("-rf", "?"), mk(":(top)x", "?"), mk("$(touch pwned)", "?")])],
    ["/workspace", new Map([mk("root.txt", "M")])],
  ]);
}
const resolve = (repo: unknown, file: unknown) => resolvePatchTarget(repo, file, listingOf(), ROOT);

test("patch target: a listed file, relative or absolute under its repository, with its tracked/untracked state", () => {
  assert.deepEqual(resolve("/workspace/app", "src/a.ts"), { ok: true, repo: "/workspace/app", file: "src/a.ts", untracked: false });
  assert.deepEqual(resolve("/workspace/app", "/workspace/app/src/a.ts"), { ok: true, repo: "/workspace/app", file: "src/a.ts", untracked: false });
  assert.deepEqual(resolve("/workspace/app", "new file.txt"), { ok: true, repo: "/workspace/app", file: "new file.txt", untracked: true });
  assert.deepEqual(resolve("/workspace", "root.txt"), { ok: true, repo: "/workspace", file: "root.txt", untracked: false });
  // Names that look like options, pathspec magic or shell text are fine as listed names: they travel quoted, after --.
  for (const name of ["-rf", ":(top)x", "$(touch pwned)"]) assert.equal(resolve("/workspace/app", name).ok, true, name);
});

const BAD_REPOS: Array<[string, unknown]> = [
  ["a relative path", "app"], ["outside the root", "/etc"], ["the parent of the root", "/"], ["a traversal", "/workspace/app/../../etc"],
  ["a sibling of the root with the same prefix", "/workspace2/app"], ["a double slash", "/workspace//app"], ["a trailing slash", "/workspace/app/"],
  ["a newline", "/workspace/app\n/etc"], ["a NUL", "/workspace/app\0"], ["an array", ["/workspace/app"]], ["a number", 5], ["empty", ""],
  ["too long", `/workspace/${"a".repeat(1100)}`], ["a flag", "--output=/tmp/x"], ["a shell substitution", "/workspace/$(id)"],
];
for (const [label, repo] of BAD_REPOS) {
  test(`patch target refuses a repo that is ${label}`, () => {
    const r = resolve(repo, "src/a.ts");
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.status === 400 || r.status === 404, `${r.status}`);
    // And in particular never a success: no such repository was listed.
    assert.equal(r.ok, false);
  });
}

const BAD_FILES: Array<[string, unknown]> = [
  ["a traversal", "../../etc/passwd"], ["a traversal inside", "src/../../../etc/passwd"], ["an absolute path outside the repository", "/etc/passwd"],
  ["an absolute path in another repository", "/workspace/other/x"], ["a dot segment", "./src/a.ts"], ["a lone dot", "."], ["a double dot", ".."],
  ["a trailing slash", "src/"], ["a double slash", "src//a.ts"], ["a newline", "src/a.ts\n--output=x"], ["a carriage return", "src/a.ts\r"], ["a NUL", "src/a.ts\0"],
  ["an option", "--output=/tmp/x"], ["an option and a path", "-p src/a.ts"], ["pathspec magic", ":(glob)**"], ["a glob", "src/*.ts"], ["a shell substitution", "$(id)"],
  ["a backtick", "`id`"], ["a semicolon", "src/a.ts; id"], ["a quote", "src/a'.ts"], ["an array", ["src/a.ts"]], ["a number", 5], ["null", null], ["empty", ""],
  ["too long", "a".repeat(1100)], ["a listed name with a different case", "SRC/A.ts"], ["a listed name with a trailing space", "src/a.ts "],
];
for (const [label, file] of BAD_FILES) {
  test(`patch target refuses a file that is ${label}`, () => {
    const r = resolve("/workspace/app", file);
    assert.equal(r.ok, false, JSON.stringify(file));
    if (!r.ok) assert.ok(["invalid_file", "file_not_found"].includes(r.error), r.error);
  });
}

test("patch target: malformed is 400 and well-formed but unlisted is 404, with their own words", () => {
  assert.deepEqual(resolve("/etc", "x"), { ok: false, status: 400, error: "invalid_repo" });
  assert.deepEqual(resolve("/workspace/nope", "x"), { ok: false, status: 404, error: "repo_not_found" });
  assert.deepEqual(resolve("/workspace/app", "../x"), { ok: false, status: 400, error: "invalid_file" });
  assert.deepEqual(resolve("/workspace/app", "unlisted.txt"), { ok: false, status: 404, error: "file_not_found" });
  assert.deepEqual(resolve(undefined, "x"), { ok: false, status: 400, error: "invalid_repo" });
  assert.deepEqual(resolve("/workspace/app", undefined), { ok: false, status: 400, error: "invalid_file" });
});

test("pathParam and isPathUnder", () => {
  assert.equal(pathParam("a"), "a");
  for (const bad of [undefined, null, 1, "", ["a"], "a\nb", "a\0b", "a".repeat(1025)]) assert.equal(pathParam(bad), null);
  assert.equal(isPathUnder("/workspace", "/workspace"), true);
  assert.equal(isPathUnder("/workspace", "/workspace/a/b"), true);
  for (const bad of ["/workspac", "/workspace/", "/workspace/a/..", "/workspace/./a" === "" ? "" : "/workspace/a//b"]) assert.equal(isPathUnder("/workspace", bad), false, bad);
});

// --- the patch ---------------------------------------------------------------------------

test("patch: truncated also says so when the script stopped reading, even if masking shrank what it read below the limit", () => {
  // 200 KB of Bearer headers: the script reads PATCH_READ_BYTES of them, masking turns each 38 characters into 18,
  // so what is left is well under 64 KB, and the diff was still longer than what was read.
  const raw = "Bearer abcdefghijklmnopqrstuvwxyz0123 ".repeat(5000);
  const read = raw.slice(0, PATCH_MAX_BYTES + 4096);
  const cut = parsePatch(`@@PATCH ${b64(read)}\n@@END`)!;
  assert.ok(Buffer.byteLength(cut.patch) < PATCH_MAX_BYTES, `${Buffer.byteLength(cut.patch)}`);
  assert.equal(cut.truncated, true);
  // A diff that fit in what was read, and shrank under masking, is whole.
  const whole = parsePatch(`@@PATCH ${b64("Bearer abcdefghijklmnopqrstuvwxyz0123 ".repeat(1700))}\n@@END`)!;
  assert.equal(Buffer.byteLength("Bearer abcdefghijklmnopqrstuvwxyz0123 ".repeat(1700)) < PATCH_MAX_BYTES + 4096, true);
  assert.equal(whole.truncated, false);
  assert.equal(PATCH_READ_BYTES, PATCH_MAX_BYTES + 4096);
});

test("patch: decoded, secrets masked, cut at 64 KB on a character boundary, truncated says so", () => {
  const small = parsePatch(`@@PATCH ${b64("diff --git a/x b/x\n+hello\n")}\n@@END`);
  assert.deepEqual(small, { patch: "diff --git a/x b/x\n+hello\n", truncated: false });
  assert.deepEqual(parsePatch(`@@PATCH \n@@END`), { patch: "", truncated: false }, "no difference is an empty patch");
  assert.equal(parsePatch("nothing"), null);
  assert.equal(parsePatch(""), null);

  const secret = parsePatch(`@@PATCH ${b64("+API=ghp_0123456789abcdefghijklmnopqrstuvwxyzAB\n+Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123\n+url=https://u:pw@h.example.invalid/x\n")}\n@@END`)!;
  assert.equal(secret.patch.includes("ghp_0123"), false);
  assert.equal(secret.patch.includes("abcdefghijklmnopqrstuvwxyz0123"), false);
  assert.equal(secret.patch.includes("u:pw@"), false);

  const big = parsePatch(`@@PATCH ${b64("x".repeat(PATCH_MAX_BYTES + 3000))}\n@@END`)!;
  assert.equal(big.truncated, true);
  assert.equal(Buffer.byteLength(big.patch), PATCH_MAX_BYTES);
  const exact = parsePatch(`@@PATCH ${b64("y".repeat(PATCH_MAX_BYTES))}\n@@END`)!;
  assert.equal(exact.truncated, false);
  assert.equal(Buffer.byteLength(exact.patch), PATCH_MAX_BYTES);
  const multi = parsePatch(`@@PATCH ${b64("中".repeat(30000))}\n@@END`)!;
  assert.equal(multi.truncated, true);
  assert.ok(Buffer.byteLength(multi.patch) <= PATCH_MAX_BYTES);
  assert.equal(multi.patch.includes("�"), false);
});

// --- the scripts themselves --------------------------------------------------------------

test("the summary script takes no input but the root, and is free of what would let git act on the repository's config", () => {
  const s = summaryScript("/workspace");
  assert.ok(s.includes("R='/workspace'"));
  assert.ok(s.includes("-gt 6000000 ]"), "the default output budget");
  assert.ok(summaryScript("/workspace", 123).includes("-gt 123"));
  assert.ok(s.includes("GIT_OPTIONAL_LOCKS=0"));
  assert.ok(s.includes("GIT_LITERAL_PATHSPECS=1"));
  assert.ok(s.includes("core.fsmonitor=false"));
  assert.ok(s.includes("--no-ext-diff --no-textconv"));
  assert.doesNotMatch(s, /\beval\b|\bsource\b|\bxargs\b|\bsh -c\b|bash -c/);
  assert.equal(summaryScript("/workspace"), summaryScript("/workspace"), "deterministic");
});

test("the patch script quotes the repository and the file, puts them after --, and never evals", () => {
  const s = patchScript("/workspace/my app", "it's $(x) `y`; z.txt", false);
  assert.ok(s.includes(`-C '/workspace/my app'`));
  assert.ok(s.includes(`-- 'it'\\''s $(x) \`y\`; z.txt'`));
  assert.ok(s.includes('diff --no-color --no-ext-diff --no-textconv -M "$base" -- '));
  assert.doesNotMatch(s, /\beval\b|bash -c|sh -c/);
  const u = patchScript("/workspace/app", "new.txt", true);
  assert.ok(u.includes("diff --no-index --no-color --no-ext-diff --no-textconv -- /dev/null 'new.txt'"));
  assert.equal(u.includes('"$base"'), false, "an untracked file has no base");
});

// --- credentials in a patch ----------------------------------------------------------------

// The PEM markers are assembled here so that no file of this repository holds one whole: a push with a private key
// header in it is refused by secret scanning, test fixture or not.
const PEM_BEGIN = (kind: string) => ["-----BEGIN", kind, "KEY-----"].join(" ");
const PEM_END = (kind: string) => ["-----END", kind, "KEY-----"].join(" ");

const MASK_CASES: Array<[string, string, string]> = [
  ["an env assignment", "+DB_PASSWORD=hunter2", "hunter2"],
  ["an assignment with spaces and quotes", "+  api_key = \"s3cr3tvalue\"", "s3cr3tvalue"],
  ["a yaml field", "+  password: correcthorse", "correcthorse"],
  ["a json field", "+  \"client_secret\": \"abc987xyz\",", "abc987xyz"],
  ["a single-quoted value", "-TOKEN='tok123value'", "tok123value"],
  ["a qualified name", "+MY_SERVICE_ACCESS_KEY=AKIAIOSFODNN7EXAMPLE1", "AKIAIOSFODNN7EXAMPLE1"],
  ["a flag with a separate value", "+  run --kube-token hunter2 upgrade", "hunter2"],
  ["a flag with =", "+  tool --my-api-key=abcdef123456", "abcdef123456"],
  ["a cookie header value", "+Cookie: sessionid=abc123def456", "abc123def456"],
  ["a vendor token the shape pass knows", "+x = ghp_0123456789abcdefghijklmnopqrstuvwxyzAB", "ghp_0123456789"],
  ["url userinfo", "+url = https://user:pw456789@h.example.invalid/x", "pw456789"],
];
for (const [label, line, secret] of MASK_CASES) {
  test(`patch text: ${label} is masked`, () => {
    const out = maskCredentialText(`diff --git a/f b/f\n@@ -1 +1 @@\n${line}\n+unrelated line\n`);
    assert.equal(out.includes(secret), false, out);
    assert.ok(out.includes("unrelated line"), "the rest of the patch is intact");
    assert.match(out, /redacted/i);
  });
}

test("patch text: hyphenated and dotted names, escaped quotes, block scalars and PEM blocks", () => {
  const cases: Array<[string, string, string[], string[]]> = [
    ["a hyphenated json key", '+{"api-key":"hunter2","x":1}', ["hunter2"], ['"x":1']],
    ["a hyphenated yaml key", "+  'access-key': 'abc987xyz'", ["abc987xyz"], []],
    ["a dotted property", "+my.service.password = s3cr3tvalue", ["s3cr3tvalue"], []],
    ["an escaped double quote", '+  "password": "ab\\"cd_secret_tail"', ["cd_secret_tail"], []],
    ["a doubled single quote", "+  secret: 'it''s_the_tail'", ["the_tail"], []],
    ["a block scalar", "+  private_key: |\n+    line one of the key\n+    line two of the key\n+  next: kept", ["line one", "line two"], ["next: kept"]],
    ["a folded block scalar with a chomping mark", "+secret: >-\n+  folded secret text\n+other: fine", ["folded secret"], ["other: fine"]],
    ["a block scalar's blank line inside", "+token: |\n+  first part\n+\n+  second part\n+after: 1", ["first part", "second part"], ["after: 1"]],
    ["a pem block under any name", `+cert = ${PEM_BEGIN("RSA PRIVATE")}\n+MIIEowIBAAKCAQEA\n+abcdef\n+${PEM_END("RSA PRIVATE")}\n+kept: yes`, ["MIIEowIBAAKCAQEA", "abcdef"], ["kept: yes"]],
    ["a pem block that is cut off", `+${PEM_BEGIN("PRIVATE")}\n+MIIEvQIBADANBg`, ["MIIEvQIBADANBg"], []],
  ];
  for (const [label, line, gone, kept] of cases) {
    const out = maskCredentialText(`diff --git a/f b/f\n@@ -1 +1 @@\n${line}\n`);
    for (const g of gone) assert.equal(out.includes(g), false, `${label}: ${g} in ${out}`);
    for (const k of kept) assert.ok(out.includes(k), `${label}: ${k} missing from ${out}`);
  }
  // A block ends at the first line that is not indented deeper; a hunk header ends it too.
  const out = maskCredentialText("+key:\n+  password: |\n+    hidden\n+  visible: yes\n@@ -9 +9 @@\n+    not hidden\n");
  assert.ok(out.includes("visible: yes") && out.includes("not hidden"), out);
  assert.equal(out.includes("hidden\n+  visible"), false);
});

test("patch text: ordinary code and prose are left as they were", () => {
  const text = [
    "diff --git a/src/a.ts b/src/a.ts", "@@ -1,3 +1,4 @@", " const author = getAuthor();", "+const authors = [];", "+// the password is checked elsewhere",
    "+const tokenCount = tokens.length;", "+password = getPassword();", "+const { token } = config;", "+config.secret = process.env.SECRET;", "+git commit --author \"Ada <ada@example.invalid>\"", "+if (secretKeyboardLayout) {}", "",
  ].join("\n");
  assert.equal(maskCredentialText(text), text);
});

test("patch text: masking is linear on a long single line of any shape, and loses nothing it should not", () => {
  const N = 65536;
  const shapes: Record<string, string> = {
    letters: "a".repeat(N), "dots": "a.".repeat(N / 2), "dashes": "ab-".repeat(N / 3), underscores: "a_".repeat(N / 2),
    "name-like": "password".repeat(N / 8), "assignments": "k=v ".repeat(N / 4), "colons": "a:".repeat(N / 2), "flags": " --x".repeat(N / 4),
    "flag-words": " --token".repeat(N / 8), "quotes": "\"a".repeat(N / 2), "equals": "=".repeat(N), "spaces then name": " ".repeat(N / 2) + "token" + " ".repeat(N / 2),
    "name chars then no separator": "tokenaaaa".repeat(N / 9), "dotted names": "password.".repeat(N / 9), "hyphenated names": "api-key-".repeat(N / 8),
    "block scalar headers": "token: |\n  x\n".repeat(N / 14), "pem starts": PEM_BEGIN("PRIVATE").repeat(N / 27), "escapes": '"\\a'.repeat(N / 3),
    "quote then escapes": 'password: "' + "\\a".repeat(N / 2),
  };
  for (const [label, text] of Object.entries(shapes)) {
    const t0 = Date.now();
    maskCredentialText(text);
    const ms = Date.now() - t0;
    assert.ok(ms < 1000, `${label}: ${ms} ms`);
  }
});
