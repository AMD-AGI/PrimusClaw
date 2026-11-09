// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import { isTypeOnly, sourceFiles, typeOnlyFiles } from "../scripts/type-only.js";

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
