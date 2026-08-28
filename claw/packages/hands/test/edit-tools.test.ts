// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Unit tests for the Hands edit tools (edit / multi_edit / notebook_edit).
 *
 * Tools take absolute paths straight through guardPath (path.resolve), so these
 * tests operate on a real temp directory and assert on file content.
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

import { edit } from "../src/tools/fs/edit.js";
import { multiEdit } from "../src/tools/fs/multi-edit.js";
import { notebookEdit } from "../src/tools/fs/notebook-edit.js";
import { replaceLiteralOnce } from "../src/tools/fs/literal-replace.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-hands-test-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(name: string, content: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content, "utf-8");
  return p;
}

function textOf(res: { content: Array<{ text: string }> }): string {
  return res.content.map((c) => c.text).join("\n");
}

function notebook(cellSource: string[]): string {
  return JSON.stringify({
    cells: [{ cell_type: "code", source: cellSource, metadata: {}, outputs: [] }],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
  });
}

// ── replaceLiteralOnce ────────────────────────────────────────────────────

test("replaceLiteralOnce: inserts $-sequences literally", () => {
  // Plain String.replace would expand each of these.
  assert.equal(replaceLiteralOnce("a b c", "b", "$&"), "a $& c");
  assert.equal(replaceLiteralOnce("a b c", "b", "$`"), "a $` c");
  assert.equal(replaceLiteralOnce("a b c", "b", "$'"), "a $' c");
  assert.equal(replaceLiteralOnce("a b c", "b", "$$"), "a $$ c");
  assert.equal(replaceLiteralOnce("a b c", "b", "$1"), "a $1 c");
});

test("replaceLiteralOnce: replaces only the first occurrence", () => {
  assert.equal(replaceLiteralOnce("x x x", "x", "y"), "y x x");
});

// ── edit ──────────────────────────────────────────────────────────────────

test("edit: replaces a unique match", async () => {
  const p = write("a.txt", "hello world\n");
  const res = await edit.execute({ path: p, old_string: "world", new_string: "there" });
  assert.match(textOf(res), /^Edited /);
  assert.equal(fs.readFileSync(p, "utf-8"), "hello there\n");
});

test("edit: writes $-sequences literally instead of expanding them", async () => {
  // Regression: String.replace expands `$&` in the replacement even for a
  // string pattern, which silently corrupted shell/regex/Makefile content.
  const p = write("run.sh", "wait PID\n");
  await edit.execute({ path: p, old_string: "PID", new_string: '"$!" # $& $1 $$' });
  assert.equal(fs.readFileSync(p, "utf-8"), 'wait "$!" # $& $1 $$\n');
});

test("edit: refuses a non-unique match and leaves the file untouched", async () => {
  const p = write("a.txt", "dup\ndup\n");
  const res = await edit.execute({ path: p, old_string: "dup", new_string: "x" });
  assert.match(textOf(res), /found 2 times/);
  assert.equal(fs.readFileSync(p, "utf-8"), "dup\ndup\n");
});

test("edit: reports a missing match without writing", async () => {
  const p = write("a.txt", "abc\n");
  const res = await edit.execute({ path: p, old_string: "zzz", new_string: "x" });
  assert.match(textOf(res), /not found/);
  assert.equal(fs.readFileSync(p, "utf-8"), "abc\n");
});

test("edit: reports an unreadable path as an error result, not a throw", async () => {
  const res = await edit.execute({
    path: path.join(dir, "missing.txt"),
    old_string: "a",
    new_string: "b",
  });
  assert.match(textOf(res), /^Error reading /);
});

test("edit: empty new_string deletes the matched text", async () => {
  const p = write("a.txt", "keep DROP keep\n");
  await edit.execute({ path: p, old_string: " DROP", new_string: "" });
  assert.equal(fs.readFileSync(p, "utf-8"), "keep keep\n");
});

// ── multi_edit ────────────────────────────────────────────────────────────

test("multi_edit: applies independent edits and reports per-file status", async () => {
  const a = write("a.txt", "one\n");
  const b = write("b.txt", "two\n");
  const res = await multiEdit.execute({
    edits: [
      { path: a, old_string: "one", new_string: "1" },
      { path: b, old_string: "two", new_string: "2" },
    ],
  });
  const out = textOf(res);
  assert.match(out, /a\.txt: ok/);
  assert.match(out, /b\.txt: ok/);
  assert.equal(fs.readFileSync(a, "utf-8"), "1\n");
  assert.equal(fs.readFileSync(b, "utf-8"), "2\n");
});

test("multi_edit: one failing edit does not abort the rest", async () => {
  const a = write("a.txt", "dup dup\n");
  const b = write("b.txt", "ok\n");
  const res = await multiEdit.execute({
    edits: [
      { path: a, old_string: "dup", new_string: "x" },
      { path: b, old_string: "ok", new_string: "done" },
    ],
  });
  const out = textOf(res);
  assert.match(out, /must be unique/);
  assert.match(out, /b\.txt: ok/);
  assert.equal(fs.readFileSync(a, "utf-8"), "dup dup\n");
  assert.equal(fs.readFileSync(b, "utf-8"), "done\n");
});

test("multi_edit: writes $-sequences literally", async () => {
  const p = write("m.txt", "TOKEN\n");
  await multiEdit.execute({ edits: [{ path: p, old_string: "TOKEN", new_string: "$&$1" }] });
  assert.equal(fs.readFileSync(p, "utf-8"), "$&$1\n");
});

test("multi_edit: applies sequential edits to the same file in order", async () => {
  const p = write("s.txt", "a\n");
  const res = await multiEdit.execute({
    edits: [
      { path: p, old_string: "a", new_string: "b" },
      { path: p, old_string: "b", new_string: "c" },
    ],
  });
  assert.equal(textOf(res).split("\n").filter((l) => l.endsWith(": ok")).length, 2);
  assert.equal(fs.readFileSync(p, "utf-8"), "c\n");
});

// ── notebook_edit ─────────────────────────────────────────────────────────

test("notebook_edit: replaces text inside a cell and keeps line splitting", async () => {
  const p = write("n.ipynb", notebook(["import os\n", "print(1)\n"]));
  const res = await notebookEdit.execute({
    path: p,
    cell_index: 0,
    old_string: "print(1)",
    new_string: "print(2)",
  });
  assert.match(textOf(res), /^Edited cell 0 /);
  const nb = JSON.parse(fs.readFileSync(p, "utf-8"));
  assert.deepEqual(nb.cells[0].source, ["import os\n", "print(2)\n"]);
});

test("notebook_edit: replaces the whole cell when old_string is omitted", async () => {
  const p = write("n.ipynb", notebook(["old\n"]));
  await notebookEdit.execute({ path: p, cell_index: 0, new_string: "l1\nl2\n" });
  const nb = JSON.parse(fs.readFileSync(p, "utf-8"));
  assert.deepEqual(nb.cells[0].source, ["l1\n", "l2\n"]);
});

test("notebook_edit: writes $-sequences literally", async () => {
  const p = write("n.ipynb", notebook(["cost = AMOUNT\n"]));
  await notebookEdit.execute({
    path: p,
    cell_index: 0,
    old_string: "AMOUNT",
    new_string: '"$&"',
  });
  const nb = JSON.parse(fs.readFileSync(p, "utf-8"));
  assert.deepEqual(nb.cells[0].source, ['cost = "$&"\n']);
});

test("notebook_edit: rejects a negative cell_index instead of throwing", async () => {
  // Regression: only the upper bound was checked, so cells[-1] was undefined
  // and dereferencing it raised an uncaught TypeError.
  const p = write("n.ipynb", notebook(["x\n"]));
  const res = await notebookEdit.execute({ path: p, cell_index: -1, new_string: "y" });
  assert.match(textOf(res), /out of range/);
  const nb = JSON.parse(fs.readFileSync(p, "utf-8"));
  assert.deepEqual(nb.cells[0].source, ["x\n"]);
});

test("notebook_edit: rejects a cell_index past the end", async () => {
  const p = write("n.ipynb", notebook(["x\n"]));
  const res = await notebookEdit.execute({ path: p, cell_index: 5, new_string: "y" });
  assert.match(textOf(res), /out of range \(1 cells\)/);
});

test("notebook_edit: rejects a non-integer cell_index with a distinct message", async () => {
  const p = write("n.ipynb", notebook(["x\n"]));
  const res = await notebookEdit.execute({ path: p, cell_index: 1.5, new_string: "y" });
  assert.match(textOf(res), /must be an integer \(got 1\.5\)/);
});

test("notebook_edit: rejects a notebook whose cells is not an array", async () => {
  const p = write("n.ipynb", JSON.stringify({ cells: { nope: true } }));
  const res = await notebookEdit.execute({ path: p, cell_index: 0, new_string: "y" });
  assert.match(textOf(res), /cells is not an array/);
});

test("notebook_edit: refuses an ambiguous old_string and leaves the cell untouched", async () => {
  // cell_index only disambiguates between cells; inside a cell old_string is the
  // caller's only lever, so an ambiguous match must not silently hit the first.
  const p = write("n.ipynb", notebook(["print(1)\n", "print(2)\n"]));
  const res = await notebookEdit.execute({
    path: p,
    cell_index: 0,
    old_string: "print(",
    new_string: "log(",
  });
  assert.match(textOf(res), /found 2 times in cell 0, must be unique/);
  const nb = JSON.parse(fs.readFileSync(p, "utf-8"));
  assert.deepEqual(nb.cells[0].source, ["print(1)\n", "print(2)\n"]);
});

test("notebook_edit: a unique match is still applied when other text is similar", async () => {
  const p = write("n.ipynb", notebook(["print(1)\n", "print(2)\n"]));
  const res = await notebookEdit.execute({
    path: p,
    cell_index: 0,
    old_string: "print(2)",
    new_string: "print(3)",
  });
  assert.match(textOf(res), /^Edited cell 0 /);
  const nb = JSON.parse(fs.readFileSync(p, "utf-8"));
  assert.deepEqual(nb.cells[0].source, ["print(1)\n", "print(3)\n"]);
});

test("notebook_edit: handles a cell with no source field", async () => {
  const p = write("n.ipynb", JSON.stringify({ cells: [{ cell_type: "code" }] }));
  const res = await notebookEdit.execute({
    path: p,
    cell_index: 0,
    old_string: "x",
    new_string: "y",
  });
  assert.match(textOf(res), /not found in cell/);
});

test("notebook_edit: whole-cell replace still works without old_string", async () => {
  // The uniqueness check must only apply to the old_string branch.
  const p = write("n.ipynb", notebook(["a\na\na\n"]));
  const res = await notebookEdit.execute({ path: p, cell_index: 0, new_string: "b\n" });
  assert.match(textOf(res), /^Edited cell 0 /);
  const nb = JSON.parse(fs.readFileSync(p, "utf-8"));
  assert.deepEqual(nb.cells[0].source, ["b\n"]);
});

// ── notebook_edit declared schema ─────────────────────────────────────────

test("notebook_edit: declared cell_index schema rejects negative and non-integer", () => {
  // The zodSchema is handed to mcp.tool(), so it is the contract the LLM sees.
  // Keeping it narrow steers the model away from Python-style negative indices
  // before a call is made, and matches the `read` tool's notebook_cell_index.
  const cellIndex = z.object({ cell_index: notebookEdit.zodSchema.cell_index });
  assert.ok(cellIndex.safeParse({ cell_index: 0 }).success);
  assert.ok(cellIndex.safeParse({ cell_index: 7 }).success);
  assert.ok(!cellIndex.safeParse({ cell_index: -1 }).success);
  assert.ok(!cellIndex.safeParse({ cell_index: 1.5 }).success);
  assert.ok(!cellIndex.safeParse({ cell_index: NaN }).success);
});

test("notebook_edit: reports a missing old_string without writing", async () => {
  const p = write("n.ipynb", notebook(["x\n"]));
  const res = await notebookEdit.execute({
    path: p,
    cell_index: 0,
    old_string: "nope",
    new_string: "y",
  });
  assert.match(textOf(res), /not found in cell/);
  const nb = JSON.parse(fs.readFileSync(p, "utf-8"));
  assert.deepEqual(nb.cells[0].source, ["x\n"]);
});

test("notebook_edit: reports malformed JSON as an error result", async () => {
  const p = write("bad.ipynb", "{not json");
  const res = await notebookEdit.execute({ path: p, cell_index: 0, new_string: "y" });
  assert.match(textOf(res), /^Error reading notebook/);
});

test("notebook_edit: handles a cell whose source is a plain string", async () => {
  const p = write("n.ipynb", JSON.stringify({ cells: [{ cell_type: "code", source: "a\nb\n" }] }));
  const res = await notebookEdit.execute({
    path: p,
    cell_index: 0,
    old_string: "b",
    new_string: "c",
  });
  assert.match(textOf(res), /^Edited cell 0 /);
  const nb = JSON.parse(fs.readFileSync(p, "utf-8"));
  assert.deepEqual(nb.cells[0].source, ["a\n", "c\n"]);
});
