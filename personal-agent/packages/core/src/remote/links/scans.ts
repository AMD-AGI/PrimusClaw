// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The scans that find a remote agent's links in prose (ported from the Python worker's `answer_links`): reference definitions,
 * markdown links and images, HTML tags and autolinks, bare addresses and mail addresses. Each is one bounded pass over the text,
 * with no backtracking pattern. `mark(label, address)` says what a link becomes.
 */
import { isPySpace, pyLstrip, pyRstrip, pySplit, pyStrip } from "../../text/py-text.js";
import { CODE, DomainFinder, domains, tailAt } from "./domains.js";

export { CODE } from "./domains.js";

const LINK_TEXT_MAX = 1000; // the words of a markdown link, at most
const LINK_DEST_MAX = 2000; // its address, and an HTML tag, at most
const ANCHOR_MAX = 2000; // the words of an HTML anchor, at most
const SCHEME_MAX = 32; // the letters of a scheme, at most
const TRAILING = ".,;:!?'\"）。，；：！？";
const URL_END = new Set([" ", "\t", "\r", "\n", "<", ">", '"', "`", CODE, "\x00"]);
const SCHEME_CHARS = /^[A-Za-z0-9+.-]$/u;
const BEFORE_URL = new Set(["@", "/", "`", CODE, "\x00"]); // a character an address does not start right after

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

/** The characters (code points, as Python counts) of one text between two of its offsets, in constant time. */
class Chars {
  private readonly before: Int32Array | undefined;

  constructor(text: string) {
    let pairs = false;
    for (let i = 0; i < text.length && !pairs; i += 1) pairs = charAt(text, i).length === 2;
    if (!pairs) return;
    this.before = new Int32Array(text.length + 1);
    let n = 0;
    for (let i = 0; i < text.length; i += 1) {
      this.before[i] = n;
      const unit = text.charCodeAt(i);
      if (!(unit >= 0xdc00 && unit <= 0xdfff && charAt(text, i - 1).length === 2)) n += 1;
    }
    this.before[text.length] = n;
  }

  /** How many characters `text[from:to]` holds. */
  between(from: number, to: number): number {
    return this.before ? (this.before[to] ?? 0) - (this.before[from] ?? 0) : to - from;
  }
}

/** `text.indexOf(sub, from)` for a `from` that never goes back: each stretch of the text is searched once, so a scan that asks
 * for every `<` of a long text with no `>` stays linear. */
class Finder {
  private last = -1;
  private found = -1;
  private readonly text: string;
  private readonly sub: string;

  constructor(text: string, sub: string) {
    this.text = text;
    this.sub = sub;
  }

  at(from: number): number {
    if (this.last < 0 || from < this.last || (this.found >= 0 && this.found < from)) {
      this.found = this.text.indexOf(this.sub, from);
    }
    this.last = from;
    return this.found;
  }
}

/** Python `s.find(sub, start, end)` with `end` = `base` + `limit` characters, given where `sub` is next at or after `start`. */
function within(at: number, sub: string, chars: Chars, base: number, limit: number): number {
  return at >= 0 && chars.between(base, at + sub.length) <= limit ? at : -1;
}

/** `[label]: url` at the start of a line: its brackets escaped (no `[words][label]` can use it) and the address made words. */
export function referenceDefinitions(text: string, mark: Mark): string {
  return text
    .split("\n")
    .map((line) => {
      const body = line.replace(/^ +/u, "");
      if (line.length - body.length > 3 || !body.startsWith("[")) return line;
      const close = within(body.indexOf("]:", 1), "]:", new Chars(body), 0, LINK_TEXT_MAX);
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
  chars: Chars,
  start: number,
  brackets: Map<number, number>,
  parens: Map<number, number>,
): [number, number] {
  const close = brackets.get(start) ?? -1;
  const paren = close >= 0 ? (parens.get(close + 1) ?? -1) : -1;
  if (paren < 0 || chars.between(start, close) > LINK_TEXT_MAX || chars.between(close, paren) > LINK_DEST_MAX) {
    return [-1, -1];
  }
  return [close, paren];
}

/** Every `[words](dest)` and `![alt](dest)`, brackets and parentheses balanced (within the limits, inside one paragraph), the
 * words made words themselves (a link in a link's words, two levels deep). */
export function links(text: string, mark: Mark, depth = 0): string {
  const brackets = pairs(text, "[", "]");
  const parens = pairs(text, "(", ")");
  const chars = new Chars(text);
  const out: string[] = [];
  let i = 0;
  for (;;) {
    const start = text.indexOf("[", i);
    if (start < 0) break;
    const [close, paren] = linkAt(chars, start, brackets, parens);
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

/** One text the tag scan reads: lowered for its words, counted, and where its next `>` and `</a` are. */
interface TagScan {
  readonly text: string;
  readonly low: string;
  readonly chars: Chars;
  readonly closes: Finder;
  readonly anchorEnds: Finder;
}

interface Tag {
  readonly tag: string;
  readonly start: number;
  readonly close: number;
}

/** One tag as it is shown, and where the scan goes on. */
function tagShown(scan: TagScan, at: Tag, mark: Mark): [string, number] {
  const { text, low } = scan;
  const { tag, start, close } = at;
  if (low.charAt(start + 1) === "a" && isPySpace(charAt(low, start + 2))) {
    const end = within(scan.anchorEnds.at(close), "</a", scan.chars, close, ANCHOR_MAX);
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
  const scan: TagScan = {
    text,
    low,
    chars: new Chars(text),
    closes: new Finder(text, ">"),
    anchorEnds: new Finder(low, "</a"),
  };
  let i = 0;
  for (;;) {
    const start = text.indexOf("<", i);
    if (start < 0) break;
    const close = within(scan.closes.at(start + 1), ">", scan.chars, start, LINK_DEST_MAX);
    if (close < 0) {
      out.push(text.slice(i, start + 1));
      i = start + 1;
      continue;
    }
    out.push(text.slice(i, start));
    const [shown, next] = tagShown(scan, { tag: text.slice(start, close + 1), start, close }, mark);
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
    if (www === 0 || !(isAlnum(before) || "@`\x00\x02.".includes(before))) return www;
    www = low.indexOf("www.", www + 4);
  }
  return -1;
}

/** Where the next bare address (`scheme://`, `www.`, `mailto:`, a bare domain) at or after `at` starts, -1 if none. */
function nextAddress(finders: readonly ((at: number) => number)[], at: number): number {
  const found = finders.map((next) => next(at)).filter((n) => n >= 0);
  return found.length > 0 ? Math.min(...found) : -1;
}

/** `next(at)` (where the first of something is at or after `at`, -1 if nowhere) for an `at` that never goes back: an answer
 * still at or after `at` is the answer again, so a text with an address at every turn is searched once, not once per address. */
function remembered(next: (at: number) => number): (at: number) => number {
  let from = Infinity;
  let found = -1;
  return (at) => {
    if (!(from <= at && (found < 0 || found >= at))) {
      found = next(at);
      from = at;
    }
    return found;
  };
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

/** `text` with markdown's backslash escapes resolved (`example\\.com` is `example.com`), as the client shows it. */
function unescaped(text: string): string {
  // (but `\|`, which a table row keeps as a bar in its cell: unescaped there it would split the cell, and the span, in two)
  return text.replace(/\\([!-/:-@[-`{}~])/gu, "$1");
}

/** `text` in a code span, which no client makes a link of (a backtick in it made a look-alike). */
function code(text: string): string {
  return text ? `${CODE}${text.replaceAll("`", "\u{2cb}")}${CODE}` : "";
}

/** Every bare address as its host (in a code span whole when it names none), without the punctuation that ends its sentence or
 * a closing parenthesis it did not open; read with any markdown escape in it taken out, as the rich text reads it. */
export function bare(text: string, mark: Mark): string {
  const low = asciiLower(text);
  const bareDomains = new DomainFinder(text);
  const finders = [
    remembered((at) => nextScheme(text, at)),
    remembered((at) => nextWww(text, low, at)),
    remembered((at) => low.indexOf("mailto:", at)),
    (at: number) => bareDomains.at(at),
  ];
  const out: string[] = [];
  let i = 0;
  for (;;) {
    const start = nextAddress(finders, i);
    if (start < 0) break;
    // (a bare domain, not a `www.` one, is its run of labels, and goes on only with a port, a path, a query or a fragment:
    // `example.com看看`)
    const run = low.startsWith("www.", start) ? -1 : bareDomains.runEnd(start);
    let stop = start;
    if (run >= 0 && !tailAt(text, run)) stop = run;
    else while (stop < text.length && !URL_END.has(text.charAt(stop))) stop += 1;
    const url = trim(text.slice(start, stop));
    out.push(text.slice(i, start));
    if (!url) {
      // (only the punctuation that would end a sentence)
      out.push(text.charAt(start));
      i = start + 1;
      continue;
    }
    // (in a path: kept as it is, in a code span; a bare domain whole, as the client shows it, in a code span)
    if (run >= 0) out.push(code(unescaped(url)));
    else
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

/** Every mail address `name@host.tld` (a client makes a mail link of one) in a code span; not looked for inside a code span an
 * earlier scan made (one there is code already, and a span opened inside it would cross it). */
export function emails(text: string): string {
  return text
    .split(CODE)
    .map((part, n) => (n % 2 ? part : mailsIn(part)))
    .join(CODE);
}

function mailsIn(text: string): string {
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

/** Where the `@` of every mail address of `text` is (the rule `emails` makes code spans by). */
function mailAts(text: string): number[] {
  // (each `@` read on its own, its name back to the `@` before it: in `john.doe@example.comx@y.example` the second is a mail
  // address too, `example.comx@y.example`, and a client may link it)
  const found: number[] = [];
  let after = 0;
  for (let at = text.indexOf("@"); at >= 0; at = text.indexOf("@", at + 1)) {
    let start = at;
    while (start > after && isMailLocal(charBefore(text, start))) start -= charBefore(text, start).length;
    let stop = at + 1;
    while (stop < text.length && isMailDomain(charAt(text, stop))) stop += charAt(text, stop).length;
    if (isMail(pyRstrip(text.slice(start, stop), ".-\\"))) found.push(at);
    after = at + 1;
  }
  return found;
}

/** A short line with no bare domain or mail address a client could link: a zero-width space before the dot of a domain's last
 * label (`example\u200b.com`) and right after the `@` of a mail address. Neither shows. */
export function breakDomainsAndMails(text: string): string {
  const at = new Set<number>();
  for (const [, end] of domains(text)) at.add(text.lastIndexOf(".", end - 1));
  for (const sign of mailAts(text)) at.add(sign + 1);
  if (at.size === 0) return text;
  const cuts = [...at].sort((a, b) => a - b);
  let out = "";
  let from = 0;
  for (const cut of cuts) {
    out += `${text.slice(from, cut)}\u{200b}`;
    from = cut;
  }
  return out + text.slice(from);
}

/** A bare domain left in prose next to a code span or a host made here: the scans read `docs.evil.mdmailto:` as one word, but
 * once `mailto:` is code the client sees `docs.evil.md` on its own. Each stretch of prose between spans is read again for bare
 * domains, its ends as a start and an end. */
export function leftoverDomains(text: string): string {
  return (
    text
      // eslint-disable-next-line no-control-regex -- a host's token and a code span's marks are these control characters
      .split(/(\x00\d+\x00|\x02[^\x02]*\x02)/u)
      .map((part, n) => (n % 2 ? part : domainsIn(part)))
      .join("")
  );
}

function domainsIn(text: string): string {
  const out: string[] = [];
  let i = 0;
  for (const [start, run] of domains(text)) {
    if (start < i) continue;
    let stop = run;
    if (tailAt(text, run)) while (stop < text.length && !URL_END.has(text.charAt(stop))) stop += 1;
    const url = trim(text.slice(start, stop));
    out.push(text.slice(i, start), code(unescaped(url)));
    i = start + url.length;
  }
  out.push(text.slice(i));
  return out.join("");
}
