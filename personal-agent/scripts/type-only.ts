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
  // A declaration file (.d.ts, .d.mts, .d.cts) emits nothing by definition; the compiler refuses to transpile one.
  if (/\.d\.[cm]?ts$/.test(fileName)) return true;
  const { outputText } = ts.transpileModule(source, {
    fileName,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: true,
      removeComments: true,
    },
  });
  // A file with no import or export compiles as a script, which gains a "use strict" directive and nothing else; a
  // CommonJS module (.cts) gains the `__esModule` marker. Neither is code of the file's own.
  const code = outputText
    .replace(/\s+/g, "")
    .replace(/^["']usestrict["'];/, "")
    .replace(/^Object\.defineProperty\(exports,["']__esModule["'],\{value:true\}\);/, "");
  return code === "" || code === "export{};";
}

/** Every extension a source file of the workspace can have: what the compiler or Node would load. */
export const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"] as const;

/** Only TypeScript can be type-only: a JavaScript file always counts. */
const TYPESCRIPT = new Set([".ts", ".tsx", ".mts", ".cts"]);

/** The source files under `dir`, recursively, by any extension in `SOURCE_EXTENSIONS`. */
export function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return (SOURCE_EXTENSIONS as readonly string[]).includes(path.extname(entry.name)) ? [full] : [];
  });
}

/**
 * The symbolic links under `dir` (recursively, not followed), relative to `base`. The coverage gate refuses a source
 * tree that has any: a linked directory is walked by neither this judgement nor reliably by c8, so a file in it could
 * be counted wrongly or not at all.
 */
export function symlinksUnder(dir: string, base: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) return [path.relative(base, full)];
    return entry.isDirectory() ? symlinksUnder(full, base) : [];
  });
}

/** The source files under `dir` that are type-only, relative to `base`, sorted. */
export function typeOnlyFiles(dir: string, base: string): string[] {
  return sourceFiles(dir)
    .filter((file) => TYPESCRIPT.has(path.extname(file)) && isTypeOnly(fs.readFileSync(file, "utf8"), file))
    .map((file) => path.relative(base, file))
    .sort();
}
