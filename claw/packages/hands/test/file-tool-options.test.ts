// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The file tools' options that bring them level with what a coding agent
 * expects: numbered and paged `read`, `edit` with `replace_all`, and `grep` that
 * searches dot-directories, can match case and can be narrowed by a glob.
 */
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { read, READ_DEFAULT_LINES } from "../src/tools/fs/read.js";
import { edit } from "../src/tools/fs/edit.js";
import { grep, GREP_SKIP, GREP_MAX_FILE_BYTES } from "../src/tools/fs/grep.js";
import { WORKSPACE_EXCLUDES } from "@claw/protocol";

let dir: string;

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-hands-fileopts-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function put(rel: string, content: string): string {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf-8");
  return p;
}

const textOf = (res: { content: Array<{ text: string }> }) => res.content.map((c) => c.text).join("\n");

// ── read ──────────────────────────────────────────────────────────────────

test("read numbers every line by default", async () => {
  const p = put("a.txt", "alpha\nbeta\ngamma");
  assert.equal(textOf(await read.execute({ path: p })), "1|alpha\n2|beta\n3|gamma");
});

test("read pages a long file and says where to continue", async () => {
  const total = READ_DEFAULT_LINES + 500;
  const p = put("log.txt", Array.from({ length: total }, (_, i) => `line ${i + 1}`).join("\n"));
  const first = textOf(await read.execute({ path: p }));
  assert.ok(first.includes(`${READ_DEFAULT_LINES}|line ${READ_DEFAULT_LINES}`));
  assert.ok(!first.includes(`${READ_DEFAULT_LINES + 1}|`), "the first page ran past its size");
  assert.match(first, new RegExp(`lines 1-${READ_DEFAULT_LINES} of ${total}; call read with offset=${READ_DEFAULT_LINES + 1}`));
  // Following the hint reaches the line asked for, and the last page says nothing more.
  const rest = textOf(await read.execute({ path: p, offset: READ_DEFAULT_LINES + 1 }));
  assert.ok(rest.includes(`${total - 7}|line ${total - 7}`));
  assert.doesNotMatch(rest, /call read with offset/);
});

test("read with line_numbers=false returns the file byte for byte", async () => {
  const body = '{"size_bytes": 12, "inode_count": 3}\n';
  const p = put("meta.json", body);
  assert.equal(textOf(await read.execute({ path: p, line_numbers: false })), body);
});

// ── edit ──────────────────────────────────────────────────────────────────

test("edit replace_all replaces every occurrence and says how many", async () => {
  const p = put("r.py", "foo = 1\nprint(foo)\nfoo += foo\n");
  const out = textOf(await edit.execute({ path: p, old_string: "foo", new_string: "bar", replace_all: true }));
  assert.match(out, /4 replacements/);
  assert.equal(fs.readFileSync(p, "utf-8"), "bar = 1\nprint(bar)\nbar += bar\n");
});

test("edit replace_all inserts $-sequences literally", async () => {
  const p = put("m.mk", "X X");
  await edit.execute({ path: p, old_string: "X", new_string: "$$&", replace_all: true });
  assert.equal(fs.readFileSync(p, "utf-8"), "$$& $$&");
});

test("edit without replace_all still refuses an ambiguous match and names the option", async () => {
  const p = put("r.py", "foo foo");
  const out = textOf(await edit.execute({ path: p, old_string: "foo", new_string: "bar" }));
  assert.match(out, /found 2 times.*replace_all=true/);
  assert.equal(fs.readFileSync(p, "utf-8"), "foo foo");
});

test("edit that misses on whitespace points at the line that nearly matched", async () => {
  const p = put("i.py", "def f():\n\treturn 1\n");
  const out = textOf(await edit.execute({ path: p, old_string: "    return 1", new_string: "    return 2" }));
  assert.match(out, /not found.*line 2.*"\\treturn 1"/);
});

test("edit refuses an empty old_string", async () => {
  const p = put("e.txt", "abc");
  assert.match(textOf(await edit.execute({ path: p, old_string: "", new_string: "x", replace_all: true })), /old_string is empty/);
  assert.equal(fs.readFileSync(p, "utf-8"), "abc");
});

// ── grep ──────────────────────────────────────────────────────────────────

test("grep searches dot-directories such as .github, and skips .git and node_modules", async () => {
  put(".github/workflows/ci.yaml", "runs-on: needle\n");
  put(".git/config", "needle\n");
  put("node_modules/x/index.js", "needle\n");
  const out = textOf(await grep.execute({ pattern: "needle", path: dir }));
  assert.ok(out.includes(path.join(".github", "workflows", "ci.yaml")) || out.includes("ci.yaml"), out);
  assert.doesNotMatch(out, /\.git[/\\]config|node_modules/);
});

test("grep skips every tree a workspace snapshot leaves behind, so uploads and transcripts are not read whole", async () => {
  for (const d of [".uploads", ".runtime", ".transcripts", ".hands-binary", "hsa", "worktree", ".tool-results", "torchinductor_root"]) {
    put(`${d}/f.txt`, "needle\n");
  }
  put("src/kept.txt", "needle\n");
  const out = textOf(await grep.execute({ pattern: "needle", path: dir }));
  assert.match(out, /kept\.txt/);
  assert.doesNotMatch(out, /\.uploads|\.runtime|\.transcripts|\.hands-binary|hsa|worktree|\.tool-results|torchinductor/, out);
  for (const name of WORKSPACE_EXCLUDES) assert.ok(GREP_SKIP.includes(name as never), `grep enters ${name}`);
});

test("grep does not read a file over the size cap, and says so", async () => {
  put("small.txt", "needle\n");
  const big = put("big.bin", "");
  fs.truncateSync(big, GREP_MAX_FILE_BYTES + 1);
  fs.appendFileSync(big, "needle\n");
  const out = textOf(await grep.execute({ pattern: "needle", path: dir }));
  assert.match(out, /small\.txt/);
  assert.doesNotMatch(out, /big\.bin/);
  assert.match(out, /1 file\(s\) over 8 MB not searched/);
});

test("grep reads only regular files: a link to a FIFO or a device is passed over, not read forever", async () => {
  put("a.txt", "needle\n");
  const fifo = path.join(dir, "..", `${path.basename(dir)}.fifo`);
  execFileSync("mkfifo", [fifo]);
  try {
    fs.symlinkSync(fifo, path.join(dir, "pipe"));
    fs.symlinkSync("/dev/zero", path.join(dir, "zero"));
    const out = textOf(await grep.execute({ pattern: "needle", path: dir }));
    assert.match(out, /a\.txt/);
  } finally {
    fs.rmSync(fifo, { force: true });
  }
});

test("grep is case-insensitive by default and exact with case_sensitive", async () => {
  put("c.txt", "Needle\n");
  assert.match(textOf(await grep.execute({ pattern: "needle", path: dir })), /Needle/);
  assert.equal(textOf(await grep.execute({ pattern: "needle", path: dir, case_sensitive: true })), "(no matches)");
  assert.match(textOf(await grep.execute({ pattern: "Needle", path: dir, case_sensitive: true })), /Needle/);
});

test("grep glob narrows the files searched, by name at any depth or by path", async () => {
  put("src/a.ts", "needle\n");
  put("src/deep/b.py", "needle\n");
  put("docs/c.md", "needle\n");
  const ts = textOf(await grep.execute({ pattern: "needle", path: dir, glob: "*.ts" }));
  assert.match(ts, /a\.ts/);
  assert.doesNotMatch(ts, /b\.py|c\.md/);
  const py = textOf(await grep.execute({ pattern: "needle", path: dir, glob: "src/**/*.py" }));
  assert.match(py, /b\.py/);
  assert.doesNotMatch(py, /a\.ts|c\.md/);
});
