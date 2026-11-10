// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The scans that find a remote agent's links in prose (ported from the Python worker's `answer_links`): reference definitions,
 * markdown links and images, HTML tags and autolinks, bare addresses and mail addresses. Each is one bounded pass over the text,
 * with no backtracking pattern. `mark(label, address)` says what a link becomes.
 */
import { isPySpace, pyLstrip, pyRstrip, pySplit, pyStrip } from "../../text/py-text.js";

const LINK_TEXT_MAX = 1000; // the words of a markdown link, at most
const LINK_DEST_MAX = 2000; // its address, and an HTML tag, at most
const ANCHOR_MAX = 2000; // the words of an HTML anchor, at most
const SCHEME_MAX = 32; // the letters of a scheme, at most
const TRAILING = ".,;:!?'\"）。，；：！？";
const URL_END = new Set([" ", "\t", "\r", "\n", "<", ">", '"', "`", "\x00"]);
const SCHEME_CHARS = /^[A-Za-z0-9+.-]$/u;
const BEFORE_URL = new Set(["@", "/", "`", "\x00"]); // a character an address does not start right after

/** What a link becomes, given its words and its address. */
export type Mark = (label: string, address: string) => string;

/** Python's `ch.isalnum()` of one character (a code point). */
function isAlnum(ch: string): boolean {
  return /^[\p{L}\p{N}]$/u.test(ch);
}

/** `text` with only its ASCII letters lowered, so an index into it is an index into `text` (`İ` lowers to two characters): the
 * scans look for ASCII words only (`www.`, `mailto:`, `</a`, `img`, `href`), which no other character lowers into. */
function asciiLower(text: string): string {
  return text.replace(/[A-Z]+/gu, (run) => run.toLowerCase());
}

/** The character (a whole code point, as Python indexes) that ends at `i`, "" at the start. */
function charBefore(text: string, i: number): string {
  if (i <= 0) return "";
  const point = text.codePointAt(i - 2);
  return i >= 2 && point !== undefined && point > 0xffff ? text.slice(i - 2, i) : text.charAt(i - 1);
}

/** The character (a whole code point) that starts at `i`, "" past the end. */
function charAt(text: string, i: number): string {
  const point = text.codePointAt(i);
  return point === undefined ? "" : String.fromCodePoint(point);
}

/** How many characters (code points, as Python counts) `text[from:to]` holds, counted no further than `limit` + 1. */
function charsBetween(text: string, from: number, to: number, limit: number): number {
  if (to - from <= limit) return to - from - countLow(text, from, to);
  let n = 0;
  for (let i = from; i < to && n <= limit; n += 1) i += charAt(text, i).length || 1;
  return n;
}

function countLow(text: string, from: number, to: number): number {
  let n = 0;
  for (let i = from + 1; i < to; i += 1) {
    const unit = text.charCodeAt(i);
    if (unit >= 0xdc00 && unit <= 0xdfff && charAt(text, i - 1).length === 2) n += 1;
  }
  return n;
}

/** Python `s.find(sub, start, end)` with `end` = `base` + `limit` characters: `sub` wholly inside `s[start:end]`. */
function findWithin(s: string, sub: string, start: number, base: number, limit: number): number {
  const at = s.indexOf(sub, start);
  return at >= 0 && charsBetween(s, base, at + sub.length, limit) <= limit ? at : -1;
}

/** `[label]: url` at the start of a line: its brackets escaped (no `[words][label]` can use it) and the address made words. */
export function referenceDefinitions(text: string, mark: Mark): string {
  return text
    .split("\n")
    .map((line) => {
      const body = line.replace(/^ +/u, "");
      if (line.length - body.length > 3 || !body.startsWith("[")) return line;
      const close = findWithin(body, "]:", 1, 0, LINK_TEXT_MAX);
      const label = close < 0 ? "" : body.slice(1, close);
      if (close < 0 || label.includes("]") || label.includes("[")) return line;
      const rest = pySplit(body.slice(close + 2));
      const shown = rest[0] === undefined ? "" : mark("", rest[0]);
      return pyRstrip(`${line.slice(0, line.length - body.length)}\\[${label}\\]: ${shown}`);
    })
    .join("\n");
}

function image(alt: string): string {
  return pyRstrip(`\u{1f5bc} ${pyStrip(alt)}`);
}

/** Each `opening` of `text` that is closed, with where its `closing` is: one pass, escapes skipped, nothing paired across a
 * paragraph break. */
function pairs(text: string, opening: string, closing: string): Map<number, number> {
  const found = new Map<number, number>();
  const stack: number[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text.charAt(i);
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "\n" && text.charAt(i + 1) === "\n") stack.length = 0;
    else if (ch === opening) stack.push(i);
    else if (ch === closing && stack.length > 0) found.set(stack.pop() ?? 0, i);
    i += 1;
  }
  return found;
}

function destinationOf(raw: string): string {
  const dest = pyStrip(raw);
  if (dest.startsWith("<") && dest.includes(">")) return dest.slice(1, dest.indexOf(">"));
  return dest ? (pySplit(dest)[0] ?? "") : "";
}

/** Where the link whose `[` is at `start` closes its words and its address, [-1, -1] when it is none (unclosed, or longer than
 * LINK_TEXT_MAX and LINK_DEST_MAX characters). */
function linkAt(
  text: string,
  start: number,
  brackets: Map<number, number>,
  parens: Map<number, number>,
): [number, number] {
  const close = brackets.get(start) ?? -1;
  const paren = close >= 0 ? (parens.get(close + 1) ?? -1) : -1;
  if (
    paren < 0 ||
    charsBetween(text, start, close, LINK_TEXT_MAX) > LINK_TEXT_MAX ||
    charsBetween(text, close, paren, LINK_DEST_MAX) > LINK_DEST_MAX
  ) {
    return [-1, -1];
  }
  return [close, paren];
}

/** Every `[words](dest)` and `![alt](dest)`, brackets and parentheses balanced (within the limits, inside one paragraph), the
 * words made words themselves (a link in a link's words, two levels deep). */
export function links(text: string, mark: Mark, depth = 0): string {
  const brackets = pairs(text, "[", "]");
  const parens = pairs(text, "(", ")");
  const out: string[] = [];
  let i = 0;
  for (;;) {
    const start = text.indexOf("[", i);
    if (start < 0) break;
    const [close, paren] = linkAt(text, start, brackets, parens);
    if (paren < 0) {
      out.push(text.slice(i, start + 1));
      i = start + 1;
      continue;
    }
    const isImage = start > 0 && text.charAt(start - 1) === "!" && (start < 2 || text.charAt(start - 2) !== "\\");
    out.push(isImage ? text.slice(i, Math.max(i, start - 1)) : text.slice(i, start));
    let inner = text.slice(start + 1, close);
    if (depth < 2) inner = links(inner, mark, depth + 1);
    out.push(mark(isImage ? image(inner) : pyStrip(inner), destinationOf(text.slice(close + 2, paren))));
    i = paren + 1;
  }
  out.push(text.slice(i));
  return out.join("");
}

/** The value of attribute `name` in one HTML tag, "" if it has none. */
function attr(tag: string, name: string): string {
  const low = asciiLower(tag);
  let at = 0;
  for (;;) {
    at = low.indexOf(name, at);
    if (at < 0) return "";
    const before = at ? charBefore(low, at) : " ";
    let rest = pyLstrip(tag.slice(at + name.length));
    at += name.length;
    if (isAlnum(before) || !rest.startsWith("=")) continue;
    rest = pyLstrip(rest.slice(1));
    const quote = rest.charAt(0);
    if (quote === "'" || quote === '"') {
      const end = rest.indexOf(quote, 1);
      return end > 0 ? rest.slice(1, end) : rest.slice(1);
    }
    const first = pySplit(rest)[0];
    return first === undefined ? "" : first.replace(/>+$/u, "");
  }
}

/** Where the scheme that ends at `colon` starts (a letter, then letters, digits, `+`, `.`, `-`, at most SCHEME_MAX), -1 if none. */
function schemeBefore(text: string, colon: number): number {
  let start = colon;
  while (start > 0 && colon - start < SCHEME_MAX && SCHEME_CHARS.test(text.charAt(start - 1))) start -= 1;
  while (start < colon && !/^\p{L}$/u.test(text.charAt(start))) start += 1;
  return start < colon ? start : -1;
}

interface Tag {
  readonly tag: string;
  readonly start: number;
  readonly close: number;
}

/** One tag as it is shown, and where the scan goes on. */
function tagShown(text: string, low: string, at: Tag, mark: Mark): [string, number] {
  const { tag, start, close } = at;
  if (low.charAt(start + 1) === "a" && isPySpace(charAt(low, start + 2))) {
    const end = findWithin(low, "</a", close, close, ANCHOR_MAX);
    const words = end >= 0 ? text.slice(close + 1, end) : "";
    const shown = mark(pyStrip(words), attr(tag, "href"));
    if (end < 0) return [shown, close + 1];
    const stop = text.indexOf(">", end);
    return [shown, (stop >= 0 ? stop : end) + 1];
  }
  if (low.slice(start + 1, start + 4) === "img" && !isAlnum(charAt(low, start + 4))) {
    return [mark(image(attr(tag, "alt")), attr(tag, "src")), close + 1];
  }
  if (tag.includes(":") && !Array.from(tag).some(isPySpace) && schemeBefore(tag, tag.indexOf(":")) === 1) {
    return [mark("", tag.slice(1, -1)) || tag, close + 1];
  }
  return [tag, close + 1];
}

/** `<a href=...>words</a>` as its words and host, `<img src=... alt=...>` as `🖼 alt` and host, `<scheme:...>` as its host; any
 * other tag as it is. */
export function tags(text: string, mark: Mark): string {
  const out: string[] = [];
  const low = asciiLower(text);
  let i = 0;
  for (;;) {
    const start = text.indexOf("<", i);
    if (start < 0) break;
    const close = findWithin(text, ">", start + 1, start, LINK_DEST_MAX);
    if (close < 0) {
      out.push(text.slice(i, start + 1));
      i = start + 1;
      continue;
    }
    out.push(text.slice(i, start));
    const [shown, next] = tagShown(text, low, { tag: text.slice(start, close + 1), start, close }, mark);
    out.push(shown);
    i = next;
  }
  out.push(text.slice(i));
  return out.join("");
}

function nextScheme(text: string, at: number): number {
  let sep = text.indexOf("://", at);
  while (sep >= 0) {
    const start = schemeBefore(text, sep);
    const before = charBefore(text, start);
    if (start >= at && (start === 0 || !(isAlnum(before) || BEFORE_URL.has(before)))) return start;
    sep = text.indexOf("://", sep + 3);
  }
  return -1;
}

function nextWww(text: string, low: string, at: number): number {
  let www = low.indexOf("www.", at);
  while (www >= 0) {
    // (after a `/` too: `x/www.host` is a path to the rich text, but a client's own markdown may still take it for an address)
    const before = charBefore(text, www);
    if (www === 0 || !(isAlnum(before) || "@`\x00.".includes(before))) return www;
    www = low.indexOf("www.", www + 4);
  }
  return -1;
}

/** Where the next bare address (`scheme://`, `www.`, `mailto:`) at or after `at` starts, -1 if none. */
function nextAddress(text: string, low: string, at: number): number {
  const found = [nextScheme(text, at), nextWww(text, low, at), low.indexOf("mailto:", at)].filter((n) => n >= 0);
  return found.length > 0 ? Math.min(...found) : -1;
}

/** An address without the punctuation that ends its sentence, or the closing parentheses it did not open (counted once). One
 * pass from the end, sliced once. */
export function trim(address: string): string {
  const url = pyRstrip(address, TRAILING);
  let excess = 0;
  for (const ch of url) excess += ch === ")" ? 1 : ch === "(" ? -1 : 0;
  let end = url.length;
  while (excess > 0 && end > 0 && url.charAt(end - 1) === ")") {
    end -= 1;
    excess -= 1;
    while (end > 0 && TRAILING.includes(url.charAt(end - 1))) end -= 1;
  }
  return url.slice(0, end);
}

/** `text` in a code span, which no client makes a link of (a backtick in it made a look-alike). */
function code(text: string): string {
  return text ? `\`${text.replaceAll("`", "\u{2cb}")}\`` : "";
}

/** Every bare address as its host (in a code span whole when it names none), without the punctuation that ends its sentence or
 * a closing parenthesis it did not open; read with any markdown escape in it taken out, as the rich text reads it. */
export function bare(text: string, mark: Mark): string {
  const low = asciiLower(text);
  const out: string[] = [];
  let i = 0;
  for (;;) {
    const start = nextAddress(text, low, i);
    if (start < 0) break;
    let stop = start;
    while (stop < text.length && !URL_END.has(text.charAt(stop))) stop += 1;
    const url = trim(text.slice(start, stop));
    out.push(text.slice(i, start));
    if (!url) {
      // (only the punctuation that would end a sentence)
      out.push(text.charAt(start));
      i = start + 1;
      continue;
    }
    // (in a path: kept as it is, in a code span)
    out.push(start && text.charAt(start - 1) === "/" ? code(url) : mark("", url.replaceAll("\\", "")) || code(url));
    i = start + url.length;
  }
  out.push(text.slice(i));
  return out.join("");
}

function isMailLocal(ch: string): boolean {
  return isAlnum(ch) || "._%+-\\".includes(ch);
}

function isMailDomain(ch: string): boolean {
  return isAlnum(ch) || ".-\\".includes(ch);
}

/** Whether `found` (escapes taken out) is a mail address `name@host.tld`. */
function isMail(found: string): boolean {
  const plain = found.replaceAll("\\", "");
  const at = plain.indexOf("@");
  const local = plain.slice(0, at);
  const domain = plain.slice(at + 1);
  const tld = domain.slice(domain.lastIndexOf(".") + 1);
  return local !== "" && domain.includes(".") && /^\p{L}+$/u.test(tld);
}

/** Every mail address `name@host.tld` (a client makes a mail link of one) in a code span. */
export function emails(text: string): string {
  const out: string[] = [];
  let i = 0;
  for (;;) {
    const at = text.indexOf("@", i);
    if (at < 0) break;
    let start = at;
    while (start > i && isMailLocal(charBefore(text, start))) start -= charBefore(text, start).length;
    let stop = at + 1;
    while (stop < text.length && isMailDomain(charAt(text, stop))) stop += charAt(text, stop).length;
    const found = pyRstrip(text.slice(start, stop), ".-\\");
    if (isMail(found)) {
      out.push(text.slice(i, start), code(found.replaceAll("\\", "")));
      i = start + found.length;
    } else {
      out.push(text.slice(i, at + 1));
      i = at + 1;
    }
  }
  out.push(text.slice(i));
  return out.join("");
}
