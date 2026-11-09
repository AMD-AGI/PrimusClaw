// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What kind of block one line of markdown is: fence, ATX heading, a line that is one bold span, rule, bullet,
 * numbered item, quote, table separator and table cells. A line never holds "\n", so a pattern that ends in a greedy
 * `[^\n]*` needs no end anchor; no two parts of a pattern can match the same run of characters, which keeps matching
 * linear in the line.
 */
import { END, lstripChars, NS, rstripChars, S, strip } from "./escape.js";

export const FENCE = /^( {0,3})(`{3,}|~{3,})([^\n]*)/u;
export const HEADING_OPEN = /^ {0,3}#{1,6}[ \t]/u;
const BOLD_STAR = new RegExp(`^${S}*\\*\\*(?=${NS})([^\\n]+?)(?<=${NS})\\*\\*([:：]?)${S}*${END}`, "u");
const BOLD_UNDER = new RegExp(`^${S}*__(?=${NS})([^\\n]+?)(?<=${NS})__([:：]?)${S}*${END}`, "u");
export const RULE = new RegExp(`^ {0,3}([-*_])(?:[ \\t]*\\1){2,}[ \\t]*${END}`, "u");
export const BULLET = /^([ \t]*)[-*+][ \t]+([^\n]*)/u;
export const NUMBERED = /^([ \t]*)(\p{Nd}{1,9}[.)])[ \t]+([^\n]*)/u;
export const QUOTE = /^ {0,3}>[ \t]?([^\n]*)/u;
export const TABLE_SEP = new RegExp(
  `^${S}*(?:\\|${S}*)?:?-+:?${S}*\\|(?:${S}*:?-+:?${S}*\\|)*(?:${S}*:?-+:?${S}*)?${END}`,
  "u",
);
const CELL_SPLIT = /(?<!\\)\|/u;

/**
 * The text of an ATX heading line (`# x`, up to six #, an optional closing run of # after a space dropped); else
 * null. Written out rather than as one pattern, because the text and the closing run around it both take spaces.
 */
export function headingText(line: string): string | null {
  const m = HEADING_OPEN.exec(line);
  if (!m) return null;
  const rest = line.slice(m[0].length - 1);
  let text = lstripChars(rest, " \t");
  if (!text) return rest.length >= 2 ? rest.slice(-1) : null; // only blanks after the #s: the heading is one of them
  text = rstripChars(text, " \t");
  const body = rstripChars(text, "#");
  const last = body.slice(-1);
  if (body !== text && (last === " " || last === "\t") && rstripChars(body, " \t")) return rstripChars(body, " \t");
  return text;
}

/** The text of a line that is one bold span (**x** or __x__), with a trailing colon kept; else null. */
export function boldOnly(line: string): string | null {
  for (const [pattern, mark] of [
    [BOLD_STAR, "**"],
    [BOLD_UNDER, "__"],
  ] as const) {
    const m = pattern.exec(line);
    if (m && !(m[1] ?? "").includes(mark)) return (m[1] ?? "") + (m[2] ?? "");
  }
  return null;
}

/** The cells of a table row, trimmed; an escaped `\|` stays inside its cell. */
export function cells(line: string): string[] {
  let row = strip(line);
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);
  return row.split(CELL_SPLIT).map((c) => strip(c));
}

/** Whether `line` ends a paragraph: blank, or the start of another block. */
export function startsBlock(line: string): boolean {
  return (
    !strip(line) ||
    FENCE.test(line) ||
    BULLET.test(line) ||
    NUMBERED.test(line) ||
    headingText(line) !== null ||
    QUOTE.test(line) ||
    RULE.test(line)
  );
}
