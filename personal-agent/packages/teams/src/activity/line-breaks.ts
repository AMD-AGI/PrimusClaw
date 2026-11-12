// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Line breaks of a markdown-format message as Teams shows them. Teams' markdown runs two lines separated by a single "\n"
 * together (a soft break), so a line written to stand alone (a URL, one language of a bilingual note, the sentence after a
 * list) is glued onto the one before it. The single "\n" that would join two lines of text becomes "\n\n" (what Teams
 * shows as a line break); everything else is left as written: blank lines, fenced code, consecutive list items, table
 * rows, and a line that starts a heading, a quote or a fence, none of which Teams joins to the line before.
 *
 * Each "\n" is decided by the line before it and the start of the line after it, so the same text streamed in growing
 * parts never changes what an earlier part was turned into: `streamedLineBreaks` holds back only a last "\n" whose next
 * line is too short yet to tell (it may still become a list item or a fence), and what it gives is always the start of
 * what `withLineBreaks` gives for any text that continues it. Teams refuses a stream whose text does not contain what was
 * streamed before; this keeps the streamed text and the final message one text.
 */

const BLANK = /^\s*$/u;
const LIST_ITEM = /^[ \t]*(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/u;
const TABLE_ROW = /^[ \t]*\|/u;
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/u;
const HEADING = /^ {0,3}#{1,6}(?:[ \t]|$)/u;
const QUOTE = /^ {0,3}>/u;
/** The start of a line that may still become a list item, a fence, a heading or a blank line as more of it arrives. */
const UNDECIDED = /^\s*(?:[-*+]|\d{1,9}[.)]?|`{1,2}|~{1,2}|#{1,6})?$/u;

/** Whether a line after a line of text keeps its single "\n": anything but more text. */
function startsOwnBlock(line: string): boolean {
  return (
    BLANK.test(line) ||
    LIST_ITEM.test(line) ||
    TABLE_ROW.test(line) ||
    FENCE.test(line) ||
    HEADING.test(line) ||
    QUOTE.test(line)
  );
}

/** The fenced code blocks of a text, line by line: whether a line is code or one of its fences. */
class Fences {
  private open: string | undefined;

  /** Whether `line` (the next line of the text) is a fence or a line inside a fenced code block. */
  code(line: string): boolean {
    const fence = FENCE.exec(line);
    const marks = fence?.[1] ?? "";
    if (this.open !== undefined) {
      const closes = marks[0] === this.open[0] && marks.length >= this.open.length && BLANK.test(fence?.[2] ?? "x");
      if (closes) this.open = undefined;
      return true;
    }
    // (a backtick fence with a backtick in its info string opens no code block)
    if (fence && !(marks.startsWith("`") && (fence[2] ?? "").includes("`"))) {
      this.open = marks;
      return true;
    }
    return false;
  }
}

function breakLines(text: string, complete: boolean): string {
  if (!text.includes("\n")) return text;
  const lines = text.split("\n");
  const fences = new Fences();
  let out = lines[0] ?? "";
  for (let i = 1; i < lines.length; i += 1) {
    const before = lines[i - 1] ?? "";
    const line = lines[i] ?? "";
    const code = fences.code(before);
    if (!complete && i === lines.length - 1 && !code && !BLANK.test(before) && UNDECIDED.test(line)) return out;
    const single = code || BLANK.test(before) || startsOwnBlock(line);
    out += (single ? "\n" : "\n\n") + line;
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
