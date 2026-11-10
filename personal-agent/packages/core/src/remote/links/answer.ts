// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A remote agent's links, made words (ported from the Python worker's `answer_links`): what an agent on someone's machine writes
 * reaches the chat, and none of it may become a link a person can click. Every link is shown as its words with the host it points
 * at, `docs (`example.com`)` or `文档（`example.com`）`; an image as `🖼 alt`; a reference definition, an autolink, an HTML anchor or
 * image and a bare address likewise. What looks like code keeps its text, but a zero-width space goes after the colon of every
 * `://` and into every `](`; and every `www.` and `://` of the result, an escaped one too, holds one. Claw's own answers keep their
 * links: they are the assistant's, with citations a person follows on purpose.
 */
import { hostOf } from "./hosts.js";
import { CODE, type Mark, bare, emails, links, referenceDefinitions, tags } from "./scans.js";

const ZWSP = "\u{200b}";
const LOOK_ALIKE = "\u{2cb}"; // (a backtick the rich text cannot pair: what a code span of a host shows for one too)
/** What the chat's rich text drops before it reads anything: controls and bidi overrides (the rich text's own set). */
// eslint-disable-next-line no-control-regex -- the control characters are exactly what the rich text drops
export const DROPPED_BY_RICH_TEXT = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u{202a}-\u{202e}\u{2066}-\u{2069}]/gu;
/** A fence line as the rich text reads one. */
const FENCE = /^( {0,3})(`{3,}|~{3,})(.*)/su;
/** `www` before a dot and a colon before two slashes, escapes before any of them counted (a markdown escape is gone once the
 * message is read); the lookahead reads its own run of characters, so it stays linear. */
const SEPARATOR = /www(?=\\*\.)|:(?=\\*\/\\*\/)/giu;
const CJK = /[\u{3000}-\u{303f}\u{3400}-\u{4dbf}\u{4e00}-\u{9fff}\u{ff00}-\u{ffef}]/u;

/** `text` with a zero-width space after every `www` of a `www.` and every `:` of a `://`, also when a markdown escape stands in
 * either (`www\.`, `:\/\/`): no client takes what is left for an address. Its other text is unchanged. */
export function breakAddresses(text: string): string {
  return text.replace(SEPARATOR, (m) => m + ZWSP);
}

/** `text` with every link, image and address made words. Applying it again leaves no link either. */
export function inertAnswer(text: string): string {
  // (the rich text drops these before it reads anything: `https:\x01//` is `https://` to it, so they are dropped first here too)
  const kept = text.replace(DROPPED_BY_RICH_TEXT, "");
  const out = blocks(kept).map(([chunk, isCode]) => (isCode ? unlinkable(chunk) : inline(chunk)));
  // (a code span added next to a stray backtick of the text's can pair with it differently in the client: every address breaks)
  return breakAddresses(out.join(""));
}

/** Code's text kept, but no address in it followable: a zero-width space after every `://`'s colon and inside every `](`. */
function unlinkable(code: string): string {
  return code.replaceAll("://", `:${ZWSP}//`).replaceAll("](", `]${ZWSP}(`);
}

/** `text`'s lines with their ends, a line ending at `\r\n`, `\r` or `\n` and nowhere else (unlike `str.splitlines`). */
function linesOf(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let at = 0; at < text.length; at += 1) {
    const ch = text.charAt(at);
    if (ch === "\n" || (ch === "\r" && text.charAt(at + 1) !== "\n")) {
      lines.push(text.slice(start, at + 1));
      start = at + 1;
    }
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

interface Fence {
  readonly marks: string;
  readonly info: string;
}

/** The fence a line is, as the rich text reads it (its end and the characters it drops taken off first); null for none. */
function fenceOf(line: string): Fence | null {
  const m = FENCE.exec(line.replace(/[\r\n]+$/u, "").replace(DROPPED_BY_RICH_TEXT, ""));
  return m ? { marks: m[2] ?? "", info: m[3] ?? "" } : null;
}

function closes(fence: Fence | null, marks: string): boolean {
  return (
    fence !== null &&
    fence.marks.charAt(0) === marks.charAt(0) &&
    fence.marks.length >= marks.length &&
    fence.info.trim() === ""
  );
}

/** `text` in pieces, each with whether it is a fenced code block (one that is not closed runs to the end), lines and fences read
 * as the rich text reads them: a backtick fence whose info string holds a backtick is no fence. */
function blocks(text: string): [string, boolean][] {
  const pieces: [string, boolean][] = [];
  let prose: string[] = [];
  let code: string[] = [];
  let marks = "";
  for (const line of linesOf(text)) {
    const fence = fenceOf(line);
    if (marks) {
      code.push(line);
      if (closes(fence, marks)) {
        pieces.push([code.join(""), true]);
        code = [];
        marks = "";
      }
    } else if (fence && !(fence.marks.startsWith("`") && fence.info.includes("`"))) {
      if (prose.length > 0) pieces.push([prose.join(""), false]);
      prose = [];
      marks = fence.marks;
      code = [line];
    } else {
      prose.push(line);
    }
  }
  if (code.length > 0) pieces.push([code.join(""), true]);
  if (prose.length > 0) pieces.push([prose.join(""), false]);
  return pieces;
}

/** The first of the ascending `positions` past `at` (bisection), or undefined. */
function firstAfter(positions: readonly number[], at: number): number | undefined {
  let lo = 0;
  let hi = positions.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((positions[mid] ?? 0) <= at) lo = mid + 1;
    else hi = mid;
  }
  return positions[lo];
}

/** What a backslash escapes in the chat's rich text (so a backtick after one opens no code span there). */
const ESCAPABLE = "\\`*_{}[]()#+-.!|~<>";

/** The backtick runs of `text`, [start, end] each. */
function backtickRuns(text: string): [number, number][] {
  const runs: [number, number][] = [];
  let i = 0;
  while (i < text.length) {
    if (text.charAt(i) !== "`") {
      i += 1;
      continue;
    }
    let j = i;
    while (j < text.length && text.charAt(j) === "`") j += 1;
    runs.push([i, j]);
    i = j;
  }
  return runs;
}

/** Where a code span may open, and where it ends, as the rich text pairs them: each run, in order, closed by the next run of the
 * same length (found by bisection), a run inside a pair opening nothing. */
function openers(text: string): Map<number, number> {
  const runs = backtickRuns(text);
  const byLength = new Map<number, number[]>();
  runs.forEach(([start, end], index) => {
    const same = byLength.get(end - start) ?? [];
    same.push(index);
    byLength.set(end - start, same);
  });
  const opens = new Map<number, number>();
  let index = 0;
  while (index < runs.length) {
    const [start, end] = runs[index] ?? [0, 0];
    const closing = firstAfter(byLength.get(end - start) ?? [], index);
    const closer = closing === undefined ? undefined : runs[closing];
    if (closing === undefined || closer === undefined) {
      index += 1;
      continue;
    }
    opens.set(start, closer[1]);
    index = closing + 1;
  }
  return opens;
}

/** Where the code spans of `text` are, as the rich text reads them: left to right, an escaped character skipped (an escaped
 * backtick opens nothing), a run that opens a span read to its end; and only a span within one line (one that crosses a line
 * is code to the rich text only if it joins those lines, which it does not always do). */
function codeSpans(text: string): [number, number][] {
  const opens = openers(text);
  const spans: [number, number][] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text.charAt(i);
    const end = ch === "`" ? opens.get(i) : undefined;
    if (ch === "\\" && i + 1 < text.length && ESCAPABLE.includes(text.charAt(i + 1))) {
      i += 2;
    } else if (end !== undefined && !/[\r\n]/u.test(text.slice(i, end))) {
      spans.push([i, end]);
      i = end;
    } else if (ch === "`") {
      while (text.charAt(i) === "`") i += 1;
    } else {
      i += 1;
    }
  }
  return spans;
}

/** Prose: a code span kept (unlinkable), the rest made words. The client pairs a backtick run with the next one of its length,
 * across lines when that closes one, so a backtick of the text's own left in the prose (it opens no span here) could pair with
 * a span's and leave an address outside code: it is shown as a look-alike. A backslash before a span made here escapes
 * nothing, and a span made here touching one of the text's is kept apart from it. */
function inline(text: string): string {
  const parts: [string, boolean][] = [];
  let end = 0;
  for (const [start, stop] of codeSpans(text)) {
    parts.push([words(text.slice(end, start)), false], [unlinkable(text.slice(start, stop)), true]);
    end = stop;
  }
  parts.push([words(text.slice(end)), false]);
  return parts
    .map(([part, isCode]) => (isCode ? part : spansMade(part)))
    .filter(Boolean)
    .reduce(
      (joined, part) => (joined.endsWith("`") && part.startsWith("`") ? `${joined}${ZWSP}${part}` : joined + part),
      "",
    );
}

/** Prose with its own backticks as look-alikes and the code spans made here (CODE ... CODE) as backticks. */
function spansMade(prose: string): string {
  return prose.replaceAll("`", LOOK_ALIKE).replaceAll(`\\${CODE}`, `\\${ZWSP}${CODE}`).replaceAll(CODE, "`");
}

/** Prose with no code in it: every link its words, every address its host in a code span. */
function words(text: string): string {
  const hosts: string[] = [];
  const mark: Mark = (label, address) => {
    const host = hostOf(address);
    if (!host) return label;
    hosts.push(host);
    const token = `\x00${String(hosts.length - 1)}\x00`;
    if (!label) return token;
    return CJK.test(label.slice(-1)) ? `${label}（${token}）` : `${label} (${token})`;
  };
  const shown = emails(bare(tags(links(referenceDefinitions(text, mark), mark), mark), mark));
  // (a host is `\x00n\x00`: the input holds no NUL, so every odd part is a host's number; and what is left that a client could
  // still take for an address, `a@https://...` say, is made unlinkable too)
  const spans = shown
    .split("\x00")
    .map((part, n) => (n % 2 ? `${CODE}${hosts[Number(part)] ?? ""}${CODE}` : unlinkable(part)))
    .join("");
  return spans;
}
