// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A name with what is in brackets taken out (`withoutParens`, Python `github_review._unparen`): read in one pass however many
 * unclosed brackets a name has (as a regular expression in Python, "请 " and 28000 "(" held the worker for seconds), and as the
 * Python worker reads it. The expectations are the Python worker's answers to the same texts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { withoutParens } from "../../src/review-text/names.js";
import { plainWords } from "../../src/review/receipt.js";

test("unclosed brackets are read in one pass", () => {
  const cpu = process.cpuUsage();
  for (const open of ["(", "（", "(a", "a("]) assert.equal(withoutParens(open.repeat(28000)), open.repeat(28000));
  const used = process.cpuUsage(cpu);
  assert.ok((used.user + used.system) / 1000 < 250, `${String((used.user + used.system) / 1000)} ms of CPU`);
});

test("brackets are taken out as the python worker takes them out", () => {
  for (const [text, out] of [
    ["Lin (Mei)", "Lin "],
    ["Lin（梅）x", "Linx"],
    ["a(b(c)d)e", "ad)e"],
    ["((((", "(((("],
    ["x)y(z", "x)y(z"],
    ["（（（（（a", "（（（（（a"],
  ] as const)
    assert.equal(withoutParens(text), out, JSON.stringify(text));
});

test("the missing workflow permission is said in plain words", () => {
  assert.equal(
    plainWords("refused: github_workflow_scope_missing"),
    "refused: GitHub's workflow permission is missing",
  );
  assert.equal(plainWords("被拒：github_workflow_scope_missing"), "被拒：缺少 GitHub 的 workflow 权限");
});
