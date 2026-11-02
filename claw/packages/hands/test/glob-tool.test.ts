// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Characterization tests for the glob tool.
 *
 * The tool filters a directory walk through `minimatch`, a dependency that
 * moves by major version (10 -> 11 for GHSA-g3hv-75wg-m249). The agent sends
 * the pattern, so the patterns below are the ones a model actually writes:
 * recursive, single-segment, brace and directory-scoped. A major bump that
 * changes what any of them matches changes what the agent sees.
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { glob } from "../src/tools/fs/glob.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "claw-hands-glob-"));
  for (const rel of [
    "README.md",
    "src/index.ts",
    "src/util/path.ts",
    "src/util/path.test.ts",
    "docs/guide.md",
    ".hidden/secret.ts",
    "node_modules/dep/index.ts",
  ]) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "", "utf-8");
  }
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

async function run(pattern: string, directory = dir): Promise<string[]> {
  const res = await glob.execute({ pattern, directory });
  const text = res.content.map((c) => c.text).join("\n");
  return text === "(no matches)" ? [] : text.split("\n");
}

test("glob: ** matches at every depth, sorted", async () => {
  assert.deepEqual(await run("**/*.ts"), [
    "src/index.ts",
    "src/util/path.test.ts",
    "src/util/path.ts",
  ]);
});

test("glob: a bare * stays inside one path segment", async () => {
  assert.deepEqual(await run("*.md"), ["README.md"]);
  assert.deepEqual(await run("src/*.ts"), ["src/index.ts"]);
});

test("glob: brace alternation expands", async () => {
  assert.deepEqual(await run("**/*.{md,test.ts}"), [
    "README.md",
    "docs/guide.md",
    "src/util/path.test.ts",
  ]);
});

test("glob: patterns are relative to the requested directory", async () => {
  assert.deepEqual(await run("**/*.ts", path.join(dir, "src/util")), [
    "path.test.ts",
    "path.ts",
  ]);
});

test("glob: dot directories and node_modules are never walked", async () => {
  assert.deepEqual(await run("**/secret.ts"), []);
  assert.deepEqual(await run("**/dep/index.ts"), []);
});

test("glob: a pattern that matches nothing says so", async () => {
  const res = await glob.execute({ pattern: "**/*.rs", directory: dir });
  assert.equal(res.content[0].text, "(no matches)");
});
