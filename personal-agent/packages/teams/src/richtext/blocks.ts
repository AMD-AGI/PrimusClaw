// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The markdown answer, block by block, as Teams xml: fenced code, tables, headings and bold lines, rules, bullets and
 * numbered items (indented by level), quotes and paragraphs, joined with `<br>`; then the size limit and the
 * allow-list check.
 */
import { cpLength } from "@primusclaw/personal-agent";
import { checkHtml } from "./check.js";
import { LABEL_PX, LEAD_PX, MAX_INPUT_CHARS, MAX_OUTPUT_BYTES, RichTextError } from "./constants.js";
import { escaping, strip } from "./escape.js";
import { inlineFrags, joinHtml } from "./inline.js";
import { boldOnly, BULLET, cells, FENCE, headingText, NUMBERED, QUOTE, RULE, startsBlock, TABLE_SEP } from "./lines.js";
import { unmatchedTicks } from "./scan.js";
import { heading, statusLine } from "./status.js";

// eslint-disable-next-line no-control-regex -- these control characters are what the pattern removes
const STRIP = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f‪-‮⁦-⁩]/gu; // controls and bidi overrides
const LONE_SURROGATE = /\p{Cs}/u;
const CODE_JOIN_LINES = 8; // a code span may run over a few lines of one paragraph

/** Python's `len(indent.expandtabs(2))` for an indent of spaces and tabs. */
function indentWidth(indent: string): number {
  let width = 0;
  for (const ch of indent) width = ch === "\t" ? width + 2 - (width % 2) : width + 1;
  return width;
}

/**
 * `text` with the next lines of its paragraph joined to it when that closes a code span the line opens (a code span
 * may cross a line break; the break reads as a space): [text, index of the first line not used].
 */
function joinCodeSpan(lines: readonly string[], i: number, text: string): [string, number] {
  const before = text.includes("`") ? unmatchedTicks(text) : 0;
  if (!before) return [text, i];
  let joined = text;
  for (let k = i; k < Math.min(lines.length, i + CODE_JOIN_LINES); k++) {
    const line = lines[k] ?? "";
    if (startsBlock(line)) break;
    joined = `${joined} ${strip(line)}`;
    if (unmatchedTicks(joined) < before) return [joined, k + 1];
  }
  return [text, i];
}

function inlineHtml(text: string): string {
  return joinHtml(inlineFrags(text));
}

/** The pieces written so far and the spacing state between them. */
class Writer {
  readonly out: string[] = [];
  blank = false;
  /** The last piece was a <pre>: a block already has its own spacing. */
  private afterBlock = false;
  /** The indentation of each open list level. */
  private readonly indents: number[] = [];

  constructor(public lead: boolean) {}

  levelOf(indent: string): number {
    const width = indentWidth(indent);
    while (this.indents.length && (this.indents.at(-1) ?? 0) > width) this.indents.pop();
    if (!this.indents.length || (this.indents.at(-1) ?? 0) < width) this.indents.push(width);
    return Math.min(this.indents.length - 1, 3);
  }

  add(piece: string, listed = false, block = false): void {
    if (!listed) this.indents.length = 0;
    if (this.out.length) this.out.push(block || this.afterBlock || !this.blank ? "<br>" : "<br><br>");
    this.out.push(piece);
    this.blank = false;
    this.lead = false;
    this.afterBlock = block;
  }
}

/** Whether `line` closes a fence opened with `marks`: the same character, at least as many, nothing after. */
function closesFence(line: string, marks: string): boolean {
  const closing = FENCE.exec(line);
  if (!closing) return false;
  const closeMarks = closing[2] ?? "";
  return closeMarks[0] === marks[0] && closeMarks.length >= marks.length && !strip(closing[3] ?? "");
}

/** The fence that opens a code block at `line`; a backtick fence with a backtick in its info string opens none. */
function openingFence(line: string): RegExpExecArray | null {
  const fence = FENCE.exec(line);
  return fence && !((fence[2] ?? "").startsWith("`") && (fence[3] ?? "").includes("`")) ? fence : null;
}

/** Throws unless `result` is valid text that fits a Teams message. */
function checkSize(result: string): void {
  if (LONE_SURROGATE.test(result)) throw new RichTextError("converted answer is not valid text"); // Python: encode() raises
  if (Buffer.byteLength(result, "utf8") > MAX_OUTPUT_BYTES) throw new RichTextError("converted answer too long"); // the markup can be several times the markdown
}

/** A fenced code block from lines[i] (its opening fence): the index after it. */
function fencedBlock(lines: readonly string[], i: number, fence: RegExpExecArray, w: Writer): number {
  const marks = fence[2] ?? "";
  const indent = (fence[1] ?? "").length;
  const body: string[] = [];
  let k = i + 1;
  for (; k < lines.length; k++) {
    const line = lines[k] ?? "";
    if (closesFence(line, marks)) {
      k += 1;
      break;
    }
    body.push(line.slice(Math.min(indent, line.length - line.replace(/^ +/, "").length)));
  }
  while (body.length && !strip(body.at(-1) ?? "")) body.pop();
  if (body.length) w.add(`<pre>${body.map((b) => escaping.esc(b)).join("<br>")}</pre>`, false, true);
  return k;
}

/** A table from its header at lines[i] (the separator follows): the index after its last row. */
function table(lines: readonly string[], i: number, w: Writer): number {
  w.add(
    `<b>${cells(lines[i] ?? "")
      .map(inlineHtml)
      .join(" | ")}</b>`,
  );
  let k = i + 2;
  for (; k < lines.length; k++) {
    const row = lines[k] ?? "";
    if (!strip(row) || !row.includes("|")) break;
    w.add(cells(row).map(inlineHtml).join(" | "));
  }
  return k;
}

/** A list item: its marker (indented by level) and its text. */
function listItem(
  lines: readonly string[],
  i: number,
  indent: string,
  marker: string | null,
  text: string,
  w: Writer,
): number {
  const level = w.levelOf(indent);
  const [item, next] = joinCodeSpan(lines, i, text);
  const mark = marker === null ? (level === 0 ? "•" : "◦") : escaping.esc(marker);
  w.add(`${"&nbsp;".repeat(4 * level)}${mark} ${statusLine(inlineFrags(item))}`, true);
  return next;
}

/** One line that is not code or a table, from lines[i - 1]: the index after what it used. */
function lineBlock(lines: readonly string[], i: number, line: string, w: Writer): number {
  const bold = boldOnly(line) ?? headingText(line);
  if (bold !== null) {
    w.add(heading(bold, w.lead ? LEAD_PX : LABEL_PX));
    return i;
  }
  if (RULE.test(line)) {
    w.add("─".repeat(12));
    return i;
  }
  const bullet = BULLET.exec(line);
  if (bullet) return listItem(lines, i, bullet[1] ?? "", null, bullet[2] ?? "", w);
  const numbered = NUMBERED.exec(line);
  if (numbered) return listItem(lines, i, numbered[1] ?? "", numbered[2] ?? "", numbered[3] ?? "", w);
  const quote = QUOTE.exec(line);
  if (quote) {
    w.add(`│ <i>${inlineHtml(quote[1] ?? "")}</i>`);
    return i;
  }
  const [paragraph, next] = joinCodeSpan(lines, i, strip(line));
  w.add(statusLine(inlineFrags(paragraph)));
  return next;
}

/**
 * `markdown` as Teams xml. `lead`: the answer's first line is its verdict, so a bold first line is the heading; a
 * later part of a long answer passes false. Throws RichTextError when the result is not safe or too long.
 */
export function toTeamsHtml(markdown: string, options: { readonly lead?: boolean } = {}): string {
  if (markdown.length > MAX_INPUT_CHARS && cpLength(markdown) > MAX_INPUT_CHARS) {
    throw new RichTextError("answer too long to convert");
  }
  const lines = markdown.replaceAll("\r\n", "\n").replaceAll("\r", "\n").replace(STRIP, "").split("\n");
  const w = new Writer(options.lead ?? true);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const fence = strip(line) ? openingFence(line) : null;
    if (!strip(line)) {
      w.blank = true;
      i += 1;
    } else if (fence) {
      i = fencedBlock(lines, i, fence, w);
    } else if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1] ?? "")) {
      i = table(lines, i, w);
    } else {
      i = lineBlock(lines, i + 1, line, w);
    }
  }
  const result = w.out.join("");
  checkSize(result);
  checkHtml(result);
  return result;
}
