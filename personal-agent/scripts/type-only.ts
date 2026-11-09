// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Which source files have no runtime at all: compiled, they are empty or only `export {}` (interfaces, type aliases,
 * `import type`, `declare module` augmentations). Such a file is never loaded by a test, so c8 `--all` would count it
 * as 0 % covered although there is nothing in it to run. The coverage gate leaves these out, judged by compiling each
 * file, never by a hand-kept list of paths: a file that gains one runtime value (a constant, a default, a zod schema)
 * is counted again at once.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

/** Whether `source` compiles to nothing that runs. */
export function isTypeOnly(source: string, fileName = "file.ts"): boolean {
  const { outputText } = ts.transpileModule(source, {
    fileName,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: true,
      removeComments: true,
    },
  });
  // A file with no import or export compiles as a script, which gains a "use strict" directive and nothing else.
  const code = outputText.replace(/\s+/g, "").replace(/^["']usestrict["'];/, "");
  return code === "" || code === "export{};";
}

/** The `.ts` files under `dir` (recursively) that are type-only, relative to `base`, sorted. */
export function typeOnlyFiles(dir: string, base: string): string[] {
  const walk = (d: string): string[] =>
    fs.readdirSync(d, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) return walk(full);
      return entry.name.endsWith(".ts") ? [full] : [];
    });
  return walk(dir)
    .filter((file) => isTypeOnly(fs.readFileSync(file, "utf8"), file))
    .map((file) => path.relative(base, file))
    .sort();
}
