// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isTypeOnly, typeOnlyFiles } from "../scripts/type-only.js";

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
