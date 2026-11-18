// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The bot's earlier default name collides with third-party products: it is gone from the packages' sources except where it is
 * kept for what earlier releases left behind, each such name declared as a `LEGACY_` (read, never written) or `PERSISTED_`
 * (held outside the process already) constant. Every other text names the bot by the deployment's configured name.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EARLIER = /clawy/iu;
const DECLARATION = /^export const (?:LEGACY|PERSISTED)_[A-Z_]+(?:: [^=]+)? = /u;

/** The lines of `text` that name the earlier name outside a `LEGACY_`/`PERSISTED_` declaration (one line, or an object to `};`). */
export function strayLines(text: string): number[] {
  const stray: number[] = [];
  let inDeclaration = false;
  text.split("\n").forEach((line, i) => {
    const opens = DECLARATION.test(line);
    if (opens && line.trimEnd().endsWith("{")) inDeclaration = true;
    else if (inDeclaration && line.startsWith("};")) inDeclaration = false;
    else if (!opens && !inDeclaration && EARLIER.test(line)) stray.push(i + 1);
  });
  return stray;
}

function sources(): string[] {
  const packages = path.join(root, "packages");
  return readdirSync(packages).flatMap((name) => {
    const src = path.join(packages, name, "src");
    let files: string[];
    try {
      files = readdirSync(src, { recursive: true, encoding: "utf8" });
    } catch {
      return []; // (a package without sources)
    }
    return files.filter((f) => f.endsWith(".ts")).map((f) => path.join(src, f));
  });
}

test("the earlier name is only in LEGACY_ and PERSISTED_ declarations", () => {
  const files = sources();
  assert.ok(files.length > 100, "the packages' sources were read");
  const found = files.flatMap((file) =>
    strayLines(readFileSync(file, "utf8")).map((line) => `${path.relative(root, file)}:${String(line)}`),
  );
  assert.deepEqual(found, []);
});

test("the check finds the earlier name anywhere else", () => {
  assert.deepEqual(strayLines('export const LEGACY_BOT_NAME = "Clawy";'), []);
  assert.deepEqual(
    strayLines('export const LEGACY_NAMES: Readonly<Record<string, string>> = {\n  a: "clawy-a",\n};'),
    [],
  );
  assert.deepEqual(strayLines('const BOT_NAME = "Clawy";'), [1]);
  assert.deepEqual(strayLines('export const LEGACY_X = "x";\n// says Clawy'), [2]);
  assert.deepEqual(strayLines('export const NAMES = {\n  a: "clawy-a",\n};'), [2]);
  assert.deepEqual(strayLines("export const LEGACY_N = {\n};\n`ask CLAWY`"), [3]);
});
