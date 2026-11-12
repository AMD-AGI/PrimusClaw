// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Line breaks of a markdown-format message as Teams shows them. Teams' markdown runs two lines separated by a single "\n"
 * together (a soft break), so a line written to stand alone (a URL, one language of a bilingual note, the sentence after a
 * list) is glued onto the one before it. The single "\n" that would join two lines of text becomes "\n\n" (what Teams
 * shows as a line break); everything else is left as written: blank lines, fenced code, list items and their indented
 * lines, table rows (with or without the outer pipes), and a line that starts a heading, a quote or a fence.
 *
 * Each "\n" is decided by the whole lines before it and the start of the line after it, so the same text streamed in
 * growing parts never changes what an earlier part was turned into: `streamedLineBreaks` holds back only a last "\n"
 * whose next line cannot be told yet (it may still become a list item, a fence or a table row), and what it gives is the
 * start of
 * what `withLineBreaks` gives for any text that continues it. Teams refuses a stream whose text does not contain what was
 * streamed before; this keeps the streamed text and the final message one text.
 */

const BLANK = /^\s*$/u;
const LIST_ITEM = /^[ \t]*(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/u;
const TABLE_ROW = /^[ \t]*\|/u;
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/u;
const HEADING = /^ {0,3}#{1,6}(?:[ \t]|$)/u;
const QUOTE = /^ {0,3}>/u;
const INDENTED = /^[ \t]/u;
/** The start of a line that may still become a list item, a fence, a heading or a blank line as more of it arrives. */
const UNDECIDED = /^\s*(?:[-*+]|\d{1,9}[.)]?|`{1,2}|~{1,2}|#{1,6})?$/u;
/** The start of a line that may still become a table's delimiter row. */
const DELIMITER_SO_FAR = /^[\s\-:|]*$/u;

/** A table's delimiter row (`--- | :---:`, with or without the outer pipes). */
function delimiterRow(line: string): boolean {
  return /^[-:| \t]+$/u.test(line) && line.includes("|") && line.includes("-");
}

/** Whether a line after a line of text starts a block of its own (Teams does not join it to the line before). */
function startsOwnBlock(line: string): boolean {
  return (
    BLANK.test(line) ||
    LIST_ITEM.test(line) ||
    TABLE_ROW.test(line) ||
    delimiterRow(line) ||
    FENCE.test(line) ||
    HEADING.test(line) ||
    QUOTE.test(line)
  );
}

/** Where a line of the text stands: in fenced code (or a fence), blank, in a list item, in a table. */
interface Place {
  readonly code: boolean;
  readonly blank: boolean;
  readonly list: boolean;
  readonly table: boolean;
}

/** The blocks of a text, read line by line; each line is read only once it is whole. */
class Blocks {
  private fence: string | undefined;
  private list = false;
  private table = false;

  /** Where `line`, the next line of the text, stands. */
  read(line: string): Place {
    if (this.code(line)) {
      this.list = this.table = false;
      return { code: true, blank: false, list: false, table: false };
    }
    const blank = BLANK.test(line);
    // (a list item goes on in its indented lines, also after a blank one; a table in its rows, which hold a pipe)
    if (LIST_ITEM.test(line)) this.list = true;
    else if (!blank && !INDENTED.test(line)) this.list = false;
    this.table = !blank && (delimiterRow(line) || TABLE_ROW.test(line) || (this.table && line.includes("|")));
    return { code: false, blank, list: this.list, table: this.table };
  }

  /** Whether `line` is a fence or a line inside a fenced code block. */
  private code(line: string): boolean {
    const fence = FENCE.exec(line);
    const marks = fence?.[1] ?? "";
    if (this.fence !== undefined) {
      const closes = marks[0] === this.fence[0] && marks.length >= this.fence.length && BLANK.test(fence?.[2] ?? "x");
      if (closes) this.fence = undefined;
      return true;
    }
    // (a backtick fence with a backtick in its info string opens no code block)
    if (fence && !(marks.startsWith("`") && (fence[2] ?? "").includes("`"))) {
      this.fence = marks;
      return true;
    }
    return false;
  }
}

/**
 * Whether the "\n" between a line standing at `before` and `line` stays single; undefined when `line` is only the start of
 * a line and what it becomes may still change that.
 */
function single(before: Place, line: string, whole: boolean): boolean | undefined {
  if (before.code || before.blank) return true;
  if (!whole) {
    if (UNDECIDED.test(line) || DELIMITER_SO_FAR.test(line)) return undefined;
    if (before.table && !line.includes("|")) return undefined;
  }
  // (an indented line goes on the list item before it, as written: a blank line would loosen the list)
  return startsOwnBlock(line) || (before.list && INDENTED.test(line)) || (before.table && line.includes("|"));
}

function breakLines(text: string, complete: boolean): string {
  if (!text.includes("\n")) return text;
  const lines = text.split("\n");
  const blocks = new Blocks();
  let out = lines[0] ?? "";
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const keep = single(blocks.read(lines[i - 1] ?? ""), line, complete || i < lines.length - 1);
    if (keep === undefined) return out;
    out += (keep ? "\n" : "\n\n") + line;
  }
  return out;
}

/** `text` (markdown) with every line that follows a line of text on a line of its own in Teams. */
export function withLineBreaks(text: string): string {
  return breakLines(text, true);
}

/**
 * The part of `text`, streamed so far, that can be shown with its line breaks already: `withLineBreaks` of it, less a last
 * line that may still turn out to need its single "\n".
 */
export function streamedLineBreaks(text: string): string {
  return breakLines(text, false);
}
