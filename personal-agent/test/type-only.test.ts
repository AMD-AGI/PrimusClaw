// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import { codeOutsideSrc, missingFromReport, packagesToCheck } from "../scripts/coverage.js";
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

test("a package's src that is itself a link, and a package directory that is a link, are refused", (t) => {
  const dir = scratch(t);
  const packages = path.join(dir, "packages");
  const elsewhere = path.join(dir, "elsewhere");
  fs.mkdirSync(path.join(elsewhere, "src"), { recursive: true });
  fs.writeFileSync(path.join(elsewhere, "src", "a.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(elsewhere, "package.json"), "{}");
  fs.mkdirSync(path.join(packages, "teams"), { recursive: true });
  fs.writeFileSync(path.join(packages, "teams", "package.json"), "{}");
  fs.symlinkSync(path.join(elsewhere, "src"), path.join(packages, "teams", "src"));
  fs.symlinkSync(elsewhere, path.join(packages, "linked-package"));
  fs.mkdirSync(path.join(packages, "core"));
  fs.writeFileSync(path.join(packages, "core", "package.json"), "{}");
  fs.symlinkSync(path.join(dir, "missing"), path.join(packages, "core", "src"));
  const result = packagesToCheck(packages, { core: 90, teams: 85 });
  assert.deepEqual(result.errors, [
    "packages/linked-package is a symbolic link (not allowed: a package is a directory of its own)",
    "packages/core/src is a symbolic link (not allowed: src must be the package's own directory)",
    "packages/teams/src is a symbolic link (not allowed: src must be the package's own directory)",
  ]);
});

test("a package without src is refused, not skipped", (t) => {
  const dir = scratch(t);
  const packages = path.join(dir, "packages");
  fs.mkdirSync(path.join(packages, "empty"), { recursive: true });
  fs.writeFileSync(path.join(packages, "empty", "package.json"), "{}");
  assert.deepEqual(packagesToCheck(packages, { empty: 85 }).errors, ["packages/empty has no src directory"]);
});

test("a file with runtime code that c8's report does not hold is named, wherever the report put its paths", () => {
  const base = "/w";
  const expected = ["packages/a/src/x.ts", "packages/a/src/test/y.ts", "packages/a/src/node_modules/z.ts"];
  assert.deepEqual(missingFromReport(expected, ["/w/packages/a/src/x.ts"], base), [
    "packages/a/src/test/y.ts",
    "packages/a/src/node_modules/z.ts",
  ]);
  assert.deepEqual(
    missingFromReport(expected, [...expected.map((f) => `/w/${f}`), "/w/packages/a/src/extra.ts"], base),
    [],
  );
  assert.deepEqual(missingFromReport(expected, expected, base), []);
});

test("the judgement reads statements, not emitted text: what only looks like compiler output still counts", () => {
  assert.equal(isTypeOnly('Object.defineProperty(exports, "__esModule", { value: true });\n', "a.ts"), false);
  assert.equal(
    isTypeOnly('Object.defineProperty(exports, "__esModule", { value: true });\nexport {};\n', "a.cts"),
    false,
  );
  assert.equal(isTypeOnly('"use strict";\n'), false);
  assert.equal(isTypeOnly("#!/usr/bin/env node\nexport interface A {\n  readonly x: string;\n}\n"), true);
  assert.equal(isTypeOnly('import { type A } from "./a.js";\nexport type B = A;\n'), false);
  assert.equal(isTypeOnly('export { type A } from "./a.js";\n'), false);
  assert.equal(isTypeOnly('import type { A } from "./a.js";\nexport { type A };\n'), true);
  assert.equal(isTypeOnly("export namespace N {\n  export type X = string;\n}\n"), true);
  assert.equal(isTypeOnly("export namespace N {\n  export const x = 1;\n}\n"), false);
  assert.equal(isTypeOnly("declare global {\n  interface Window { x: string }\n}\nexport {};\n"), true);
  assert.equal(isTypeOnly("export declare enum E { A }\nexport const enum F { B }\n"), false);
  assert.equal(isTypeOnly("export default interface D {\n  readonly x: string;\n}\n"), true);
  assert.equal(isTypeOnly("const x = 1;\nexport default x;\n"), false);
  assert.equal(isTypeOnly("export = {};\n", "a.cts"), false);
});

test("a package whose entry points or source files lie outside src is refused", (t) => {
  const dir = scratch(t);
  const packages = path.join(dir, "packages");
  const pkg = path.join(packages, "core");
  fs.mkdirSync(path.join(pkg, "src"), { recursive: true });
  fs.mkdirSync(path.join(pkg, "test"));
  fs.mkdirSync(path.join(pkg, "lib"));
  fs.mkdirSync(path.join(pkg, "node_modules", "x"), { recursive: true });
  const manifest = {
    exports: { ".": { types: "./src/index.ts", default: "./outside.js" }, "./more": "./src/more.ts" },
    main: "./src/index.ts",
    bin: { tool: "./bin/tool.js" },
  };
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify(manifest));
  for (const f of ["src/index.ts", "test/a.test.ts", "outside.js", "lib/helper.ts", "node_modules/x/index.js"]) {
    fs.writeFileSync(path.join(pkg, f), "export const x = 1;\n");
  }
  fs.writeFileSync(path.join(pkg, "README.md"), "# core\n");
  assert.deepEqual(codeOutsideSrc(packages, "core"), [
    "packages/core/package.json points at ./outside.js, outside src (the floor would not see it)",
    "packages/core/package.json points at ./bin/tool.js, outside src (the floor would not see it)",
    "packages/core/lib/helper.ts is source outside src/ and test/",
    "packages/core/outside.js is source outside src/ and test/",
  ]);
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ exports: { ".": "./src/index.ts" } }));
  fs.rmSync(path.join(pkg, "outside.js"));
  fs.rmSync(path.join(pkg, "lib"), { recursive: true });
  assert.deepEqual(codeOutsideSrc(packages, "core"), []);
});
