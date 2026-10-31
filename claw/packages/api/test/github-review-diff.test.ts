// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Which lines of a patch an inline comment may sit on. */
import assert from "node:assert/strict";
import test from "node:test";
import { addedLines, commentableLines, eachChangedLine, removedLines } from "../src/github-review/diff.js";

const PATCH = [
  "@@ -3,4 +3,5 @@ func x()",
  " keep a",
  "-old b",
  "+new b",
  "+new c",
  " keep d",
  "@@ -20,2 +21,2 @@",
  " ctx",
  "-gone",
  "+here",
].join("\n");

test("right-side lines are the added and context lines at their new numbers; left-side are removed and context at their old numbers", () => {
  const { right, left } = commentableLines(PATCH);
  assert.deepEqual([...right].sort((a, b) => a - b), [3, 4, 5, 6, 21, 22]);
  assert.deepEqual([...left].sort((a, b) => a - b), [3, 4, 5, 20, 21]);
});

test("a line outside every hunk is not commentable, and no patch means no lines", () => {
  const { right } = commentableLines(PATCH);
  assert.equal(right.has(10), false);
  assert.equal(commentableLines(undefined).right.size, 0);
  assert.equal(commentableLines("").left.size, 0);
});

test("a context line whose only space was trimmed still counts, and the no-newline marker does not", () => {
  const { right } = commentableLines("@@ -1,3 +1,3 @@\n a\n\n+b\n\\ No newline at end of file");
  assert.deepEqual([...right], [1, 2, 3]);
});

test("added and removed lines are read without the file headers or the marks", () => {
  assert.deepEqual(addedLines("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b"), ["b"]);
  assert.deepEqual(removedLines("--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b"), ["a"]);
});

test("a content line that itself starts with ++ or -- is still an added or removed line; only what comes before the first hunk is a header", () => {
  const patch = "@@ -1,2 +1,2 @@\n-- drop table x\n+++ chmod 777 /data\n+++x; rejectUnauthorized: false\n ctx";
  assert.deepEqual(addedLines(patch), ["++ chmod 777 /data", "++x; rejectUnauthorized: false"]);
  assert.deepEqual(removedLines(patch), ["- drop table x"]);
  assert.deepEqual(addedLines("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n+real"), ["real"]);
});

test("eachChangedLine hands over the same lines as addedLines and removedLines, in order, and stops when asked", () => {
  const patch = "--- a/x\n+++ b/x\n@@ -1,4 +1,4 @@\n ctx\n-gone\n+here\n++plus\n--minus\n ctx\n@@ -20,1 +20,2 @@\n+last";
  const seen: Array<[string, string]> = [];
  eachChangedLine(patch, (mark, text) => { seen.push([mark, text]); return true; });
  assert.deepEqual(seen, [["-", "gone"], ["+", "here"], ["+", "+plus"], ["-", "-minus"], ["+", "last"]]);
  assert.deepEqual(seen.filter(([m]) => m === "+").map(([, t]) => t), addedLines(patch));
  assert.deepEqual(seen.filter(([m]) => m === "-").map(([, t]) => t), removedLines(patch));
  const first: string[] = [];
  eachChangedLine(patch, (_m, text) => { first.push(text); return first.length < 2; });
  assert.deepEqual(first, ["gone", "here"]);
  eachChangedLine(undefined, () => assert.fail("no patch, no line"));
  eachChangedLine("+not in a hunk\n-nor this", () => assert.fail("nothing before the first hunk header is content"));
});
