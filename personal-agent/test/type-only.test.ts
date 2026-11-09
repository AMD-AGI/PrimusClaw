// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import { packagesToCheck } from "../scripts/coverage.js";
import { isTypeOnly, sourceFiles, symlinksUnder, typeOnlyFiles } from "../scripts/type-only.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("a file of interfaces, types, type imports and module augmentations is type-only", () => {
  const sources = [
    "",
    "// only a comment\n",
    "export interface A { readonly x: string }\nexport type B = A | number;\n",
    'import type { Lang } from "./lang.js";\nexport interface C { lang: Lang }\n',
    'export type { A } from "./a.js";\n',
    'declare module "../ports/surface.js" {\n  interface ViewMap { note: { text: string } }\n}\nexport {};\n',
  ];
  for (const source of sources) assert.equal(isTypeOnly(source), true, source);
});

test("a file with any runtime value is counted: a constant, a default, a zod schema, a re-export, an enum", () => {
  const sources = [
    "export const noRouteExtensions: readonly string[] = [];\n",
    "export const LIMIT = 3;\n",
    'import { z } from "zod";\nexport const Item = z.object({ id: z.string() });\n',
    'export * from "./surface.js";\n',
    'export { neutralPlugins } from "./plugins.js";\n',
    "export enum Kind { A, B }\n",
    "export function f(): number {\n  return 1;\n}\n",
    "export class C {}\n",
    'import "./side-effect.js";\nexport interface A { x: string }\n',
  ];
  for (const source of sources) assert.equal(isTypeOnly(source), false, source);
});

test("core's type-only files are found by compiling them, and files with runtime values are not among them", () => {
  const found = typeOnlyFiles(path.join(root, "packages/core/src"), root);
  for (const file of ["packages/core/src/json.ts", "packages/core/src/ports/random.ts"]) {
    assert.ok(found.includes(file), file);
  }
  for (const file of [
    "packages/core/src/plugins/route-extension.ts",
    "packages/core/src/ports/clock.ts",
    "packages/core/src/ports/logger.ts",
    "packages/core/src/validate.ts",
    "packages/core/src/index.ts",
  ]) {
    assert.ok(!found.includes(file), file);
  }
});

test("every source extension is found; only TypeScript can be type-only, JavaScript always counts", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "type-only-"));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(dir, "nested"));
  const types = "export interface A {\n  readonly x: string;\n}\n";
  const files: Record<string, string> = {
    "a.ts": types,
    "nested/b.tsx": types,
    "c.mts": types,
    "d.cts": types,
    "e.tsx": "export const probe = (): number => 1;\n",
    "f.js": "export {};\n",
    "g.mjs": "export const x = 1;\n",
    "h.cjs": "module.exports = {};\n",
    "i.jsx": "export {};\n",
    "notes.txt": "x",
  };
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  assert.deepEqual(
    sourceFiles(dir)
      .map((f) => path.relative(dir, f))
      .sort(),
    ["a.ts", "c.mts", "d.cts", "e.tsx", "f.js", "g.mjs", "h.cjs", "i.jsx", "nested/b.tsx"],
  );
  assert.deepEqual(typeOnlyFiles(dir, dir), ["a.ts", "c.mts", "d.cts", "nested/b.tsx"]);
});

test("edge shapes: a declaration file and comments-only are type-only; a JSON import and a chain of re-exports count", () => {
  assert.equal(isTypeOnly("declare const x: number;\nexport declare function f(): void;\n", "a.d.ts"), true);
  assert.equal(isTypeOnly("export declare const y: string;\n", "dir/b.d.mts"), true);
  assert.equal(isTypeOnly("declare const x: number;\nexport declare function f(): void;\n", "c.ts"), true);
  assert.equal(isTypeOnly("/* only */\n// comments\n"), true);
  assert.equal(isTypeOnly('import type { A } from "./a.js";\nimport type B from "./b.js";\n'), true);
  assert.equal(isTypeOnly('import data from "./data.json" with { type: "json" };\nexport const n = data;\n'), false);
  assert.equal(isTypeOnly('export * from "./index.js";\n'), false);
  assert.equal(isTypeOnly('export { a as b } from "./again.js";\n'), false);
});

function scratch(t: { after: (fn: () => void) => void }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "coverage-pkgs-"));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test("every package directory needs a floor, every floor a package, and no src holds a symbolic link", (t) => {
  const dir = scratch(t);
  const packages = path.join(dir, "packages");
  for (const p of ["core", "teams", "teams-ingress"]) {
    fs.mkdirSync(path.join(packages, p, "src"), { recursive: true });
    fs.writeFileSync(path.join(packages, p, "package.json"), "{}");
  }
  fs.mkdirSync(path.join(packages, "not-a-package"));
  fs.writeFileSync(path.join(packages, "core", "src", "a.ts"), "export const a = 1;\n");
  fs.symlinkSync(path.join(packages, "core", "src", "a.ts"), path.join(packages, "teams", "src", "linked.ts"));
  fs.symlinkSync(path.join(packages, "core", "src"), path.join(packages, "teams", "src", "linked-dir"));
  const result = packagesToCheck(packages, { core: 90, teams: 85, runtime: 85 });
  assert.deepEqual(result.packages, [
    ["core", 90],
    ["teams", 85],
  ]);
  assert.deepEqual(result.errors, [
    "packages/teams-ingress has no coverage floor in FLOORS",
    "FLOORS names runtime, which is not a package",
    "packages/teams/src/linked-dir is a symbolic link (not allowed in src)",
    "packages/teams/src/linked.ts is a symbolic link (not allowed in src)",
  ]);
  assert.deepEqual(symlinksUnder(path.join(packages, "core"), packages), []);
});
