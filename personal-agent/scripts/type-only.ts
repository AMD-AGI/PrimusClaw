// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Which source files have no runtime at all: every top-level statement is a type-only construct (an interface, a type
 * alias, `import type`, `export type`, an empty `export {}`, an ambient `declare ...`, a namespace of only such
 * statements). Such a file is never loaded by a test, so c8 `--all` would count it as 0 % covered although there is
 * nothing in it to run. The coverage gate leaves these out, judged by reading each file's syntax tree, never by a
 * hand-kept list of paths and never by matching emitted text: a file with any other statement (a constant, a default,
 * a zod schema, a re-export, a side-effect import, an `export =`, a directive, an expression) is counted.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

function hasDeclare(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)
  );
}

/** `export {}`, `export type { ... }` and `export { type A }` with no `from`: nothing is emitted that runs. */
function isTypeOnlyExport(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return true;
  if (node.moduleSpecifier !== undefined) return false; // (`export { type A } from "x"` still loads "x")
  const clause = node.exportClause;
  return clause !== undefined && ts.isNamedExports(clause) && clause.elements.every((element) => element.isTypeOnly);
}

/** Whether one top-level (or namespace-level) statement emits nothing that runs. */
function isTypeOnlyStatement(node: ts.Statement): boolean {
  if (hasDeclare(node)) return true;
  if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEmptyStatement(node)) return true;
  if (ts.isImportDeclaration(node)) return node.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword;
  if (ts.isImportEqualsDeclaration(node)) return node.isTypeOnly;
  if (ts.isExportDeclaration(node)) return isTypeOnlyExport(node);
  if (ts.isModuleDeclaration(node)) {
    const body = node.body;
    return body !== undefined && ts.isModuleBlock(body) && body.statements.every(isTypeOnlyStatement);
  }
  return false;
}

/** Whether `source` has nothing that runs. */
export function isTypeOnly(source: string, fileName = "file.ts"): boolean {
  // A declaration file (.d.ts, .d.mts, .d.cts) holds declarations only, by definition.
  if (/\.d\.[cm]?ts$/.test(fileName)) return true;
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, false, kind);
  return file.statements.every(isTypeOnlyStatement);
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
