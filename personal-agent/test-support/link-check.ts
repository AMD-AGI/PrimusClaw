// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Whether a link ends its line (the Python worker's `test_link_on_its_own_line` checker): Teams turns a bare URL into a link by
 * itself and takes in what it can read as part of one, so nothing may follow a URL on its line. `textAfterLinks` reads a rendered
 * message; `stringsWithTextAfterALink` reads every string a TypeScript module builds.
 */
import ts from "typescript";

/** In a scanned template: an expression that holds a URL, and any other expression. */
const URL_MARK = "\u0001";
const OTHER_MARK = "\u0002";
const URL_CHARS = String.raw`[A-Za-z0-9_\-/?#&=%~+:@${URL_MARK}${OTHER_MARK}]`;
/** A dot is part of a URL only when more of it follows. */
const URL_EXTENT = new RegExp(String.raw`(?:${URL_CHARS}|\.(?=${URL_CHARS}))*`, "y");
const URL_START = /https?:\/\//y;
const NAMES_A_URL = /url|uri|link|href|public/i;
const CLOSERS: Readonly<Record<string, string>> = { '"': '"', "'": "'", "<": ">" };

function matchAt(pattern: RegExp, text: string, at: number): RegExpExecArray | null {
  pattern.lastIndex = at;
  return pattern.exec(text);
}

/**
 * Every URL in `text` (a rendered message, or a template whose URL-holding expressions are URL_MARK) that has anything after it
 * on its line, each as the words around it. A Markdown link target `](...)` and a URL in quotes or angle brackets have a delimiter
 * of their own, so they are fine.
 */
export function textAfterLinks(text: string): string[] {
  const found: string[] = [];
  let i = 0;
  while (i < text.length) {
    const start = matchAt(URL_START, text, i);
    if (start === null && text[i] !== URL_MARK) {
      i += 1;
      continue;
    }
    const begin = i;
    const end =
      begin + (start?.[0].length ?? 0) + (matchAt(URL_EXTENT, text, i + (start?.[0].length ?? 0))?.[0].length ?? 0);
    const rest = text.slice(end);
    const before = text.slice(Math.max(0, begin - 2), begin);
    const alone = /^[ \t]*(?:\n|$)/.test(rest);
    const closer = CLOSERS[before.slice(-1)];
    const delimited = (before === "](" && rest.startsWith(")")) || (closer !== undefined && rest.startsWith(closer));
    if (!alone && !delimited) {
      found.push(
        text
          .slice(Math.max(0, begin - 30), end + 30)
          .replaceAll(URL_MARK, "<URL>")
          .replaceAll(OTHER_MARK, "<...>"),
      );
    }
    i = Math.max(end, i + 1);
  }
  return found;
}

const mark = (node: ts.Node, source: ts.SourceFile) => (NAMES_A_URL.test(node.getText(source)) ? URL_MARK : OTHER_MARK);

/** The text a string expression builds, as far as the source tells: literals as they are, `${...}` and `{...}` as a mark. */
function template(node: ts.Node, source: ts.SourceFile): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text.replace(/\{[^{}]*\}/g, (m) => (NAMES_A_URL.test(m) ? URL_MARK : OTHER_MARK)); // (a `{name}` template)
  }
  if (ts.isTemplateExpression(node)) {
    return node.head.text + node.templateSpans.map((s) => mark(s.expression, source) + s.literal.text).join("");
  }
  if (ts.isParenthesizedExpression(node)) return template(node.expression, source);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = template(node.left, source);
    const right = template(node.right, source);
    if (left === undefined && right === undefined) return undefined;
    return (left ?? mark(node.left, source)) + (right ?? mark(node.right, source));
  }
  return undefined;
}

/** `name:line: words around the URL` for every string a module builds that has text after a URL. */
export function stringsWithTextAfterALink(text: string, name = "module.ts"): string[] {
  const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    // (a type, an import's or an export's module name, a property key: not a message)
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isTypeNode(node)) return;
    const built = template(node, source);
    if (built === undefined) {
      ts.forEachChild(node, visit);
      return;
    }
    // (parents first: a string made of parts is read once, whole)
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    for (const words of textAfterLinks(built)) found.push(`${name}:${String(line)}: ${JSON.stringify(words)}`);
  };
  visit(source);
  return found;
}
