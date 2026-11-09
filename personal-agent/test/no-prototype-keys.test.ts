// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * own-keys/no-prototype-keys, run through the workspace's own ESLint configuration on purpose-written code: every
 * line of the bad fixture marked "REPORTED" is reported and nothing else is; nothing in the good fixture is.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtures = path.join(root, "test", "fixtures", "no-prototype-keys");
const RULE = "own-keys/no-prototype-keys";

async function reportedLines(file: string): Promise<number[]> {
  const eslint = new ESLint({ cwd: root, ignore: false });
  const [result] = await eslint.lintFiles([file]);
  assert.ok(result, file);
  const fatal = result.messages.filter((m) => m.fatal === true);
  assert.deepEqual(fatal, [], "the fixture parses with type information");
  return result.messages.filter((m) => m.ruleId === RULE).map((m) => m.line);
}

function markedLines(file: string): number[] {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .flatMap((line, index) => (line.includes("// REPORTED") ? [index + 1] : []));
}

test("every marked lookup in the bad fixture is reported, and only those", async () => {
  const file = path.join(fixtures, "bad.ts");
  const marked = markedLines(file);
  assert.equal(marked.length, 10);
  assert.deepEqual(await reportedLines(file), marked);
});

test("nothing in the good fixture is reported: Map, own(), hasOwn guards, null-prototype and literal keys", async () => {
  assert.deepEqual(await reportedLines(path.join(fixtures, "good.ts")), []);
});
