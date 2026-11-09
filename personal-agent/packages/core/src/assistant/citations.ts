// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The Teams citations of an assistant reply: the `sources` of an `assistant.say` (`[{n, url, title, kind}]`, which Claw
 * sends only from the turn's own lookups) become one source card each for the `[n]` its text writes. The text itself is
 * never changed (its words may already be on screen, streamed).
 *
 * Lengths and cuts count code points, white space is Python's `str.isspace`, and the patterns read Unicode the way the
 * Python worker's `re` does (`\w`, `\d`, `\b` and IGNORECASE over all of Unicode). The address handling follows
 * `urllib.parse.urlsplit` itself rather than the WHATWG `URL`, which normalises (lower-cases, punycodes, resolves dots,
 * percent-encodes) where `urlsplit` only splits; `citation-sources.ts` has it.
 */
import type { Citation } from "../ports/surface.js";
import { cpHead } from "../text/py-text.js";
import { hostnameOf, sourceName, sourceUrl } from "./citation-sources.js";

export { CITATION_NAME_MAX, SOURCE_TITLE_INPUT_MAX, SOURCE_URL_MAX, sourceName } from "./citation-sources.js";

/** Teams shows at most 20 citations on a message. */
export const CITATIONS_MAX = 20;
export const CITATION_ABSTRACT_MAX = 160;

/** What a source's `kind` is shown as on its card; any other kind is "Source". */
export const SOURCE_KINDS: ReadonlyMap<string, string> = new Map([
  ["web", "Web page"],
  ["github_pr", "GitHub pull request"],
  ["github_issue", "GitHub issue"],
  ["github_repo", "GitHub repository"],
  ["github_check", "GitHub check"],
  ["github_file", "GitHub file"],
  ["board", "Agent Board"],
]);

// What makes a link where it stands, as CommonMark with GitHub's autolinks reads a text (the same rule as Claw's
// `makesLink`): an inline link or image (a `]` right before `(`: `[1] (2 days ago)` is text), an autolink or an HTML tag
// (`<` before a letter, `/`, `!` or `?`: `p99 < 10ms` is text), an address (`://`, `www.`, `mailto:`), an e-mail
// address (a local part right before `@` and a dotted domain after it: a mention `@alice.smith` is text). A link
// reference definition makes one too (`definesLink`). ASCII only, as Python's re.ASCII: no `u` flag, so `i` folds no
// non-ASCII letter (ſ, K) onto an ASCII one.
const LINK_MAKING = /\]\(|<[a-z/!?]|:\/\/|www\.|(?:mailto|xmpp):|[a-z0-9._+-]@[a-z0-9_-]+\.[a-z0-9_-]/i;
/** What may stand before a link reference definition's `[` on its line: indentation, a quote's `>`, a list marker. */
const LINE_LEAD = new Set(" \t>*+-.)0123456789");
/** A markdown backslash escape (`unescape_markdown`). */
const ESCAPE = /\\([!-/:-@[-`{-~])/g;
/** `[n]` with one or two digits of any script (Python's `\d` is every decimal digit, and `int()` reads them all). */
const CITED = /\[(\p{Nd}{1,2})\]/uy;
const DECIMAL = /^\p{Nd}$/u;

/** `text` with markdown's backslash escapes resolved (`\-` is `-`), as a renderer reads it. */
export function unescapeMarkdown(text: string): string {
  return text.replace(ESCAPE, "$1");
}

/**
 * Whether the text defines a link reference (`[1]: https://…`, `[^2]: …`), which makes every `[1]` of it a link: a `[`
 * that opens its line (only LINE_LEAD before it) closed by `]:`, its label holding no bracket and maybe running across
 * lines. `Status [1]: merged` defines nothing. (UTF-16 units: every character it looks for is ASCII, and the two halves
 * of a surrogate pair end a lead as the one code point does.)
 */
function definesLink(text: string): boolean {
  let lead = true;
  let opened = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charAt(i);
    if (c === "[") {
      opened = lead;
    } else if (c === "]") {
      if (opened && text.charAt(i + 1) === ":") return true;
      opened = false;
    }
    lead = c === "\n" || (lead && LINE_LEAD.has(c));
  }
  return false;
}

/** Whether the text can make a link, read as it is shown: with its backslash escapes resolved (`www\.x` is `www.x`). */
export function makesLink(text: string): boolean {
  const shown = unescapeMarkdown(text);
  return LINK_MAKING.test(shown) || definesLink(shown);
}

/** The value of a decimal digit of any script: Unicode keeps each script's 0-9 as one run of ten in order. */
function digitValue(digit: string): number {
  let cp = digit.codePointAt(0) ?? 0;
  let offset = 0;
  while (DECIMAL.test(String.fromCodePoint(cp - 1))) {
    cp -= 1;
    offset += 1;
  }
  return offset % 10;
}

/** `int(digits)` for one or two decimal digits of any script. */
function decimal(digits: string): number {
  return Array.from(digits).reduce((value, digit) => value * 10 + digitValue(digit), 0);
}

/**
 * The numbers the text cites as `[n]` on their own, outside every bracket, and none at all in a text that can make a
 * link (`makesLink`): the router is told to put addresses in `sources` and never in the text, so no `[n]` can be, or be
 * inside, a link to an address of the model's. An escaped bracket is no bracket; an unclosed `[` leaves what follows it
 * uncited. (UTF-16 units: an escape that skips the first half of a surrogate pair lands on the second, which is no
 * bracket, so it skips the same code point Python does.)
 */
export function citedNumbers(text: string): Set<number> {
  const cited = new Set<number>();
  if (makesLink(text)) return cited;
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const c = text.charAt(i);
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "[") {
      CITED.lastIndex = i;
      const m = depth === 0 ? CITED.exec(text) : null;
      if (m) {
        cited.add(decimal(m[1] ?? ""));
        i = CITED.lastIndex;
        continue;
      }
      depth += 1;
    } else if (c === "]") {
      depth = Math.max(depth - 1, 0);
    }
    i += 1;
  }
  return cited;
}

/** Python's `isinstance(n, int) and not isinstance(n, bool)` for a value read from JSON (see `citationsFromSources`). */
function sourceNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function citationOf(source: Record<string, unknown>, cited: ReadonlySet<number>): Citation | undefined {
  const n = sourceNumber(source["n"]);
  const url = sourceUrl(source["url"]);
  if (n === undefined || !cited.has(n) || url === undefined) return undefined;
  const host = hostnameOf(url) ?? "";
  const kindKey = source["kind"];
  const kind = (typeof kindKey === "string" ? SOURCE_KINDS.get(kindKey) : undefined) ?? "Source";
  return {
    position: n,
    title: sourceName(source["title"], host),
    url,
    abstract: cpHead(`${kind} · ${host}`, CITATION_ABSTRACT_MAX),
  };
}

/**
 * The Teams citations of an assistant reply: one per source it carries (`[{n, url, title, kind}]`) whose `[n]` the
 * text has, in number order, at most CITATIONS_MAX. A source that is not well formed, repeats a number or is not cited
 * in the text is left out.
 *
 * One difference from Python, which JSON parsing makes: `{"n": 1.0}` is a float there (refused) and the number 1 here
 * (accepted).
 */
export function citationsFromSources(text: string, sources: unknown): Citation[] {
  if (!Array.isArray(sources)) return [];
  const cited = citedNumbers(text);
  const out = new Map<number, Citation>();
  for (const source of sources as unknown[]) {
    if (out.size >= CITATIONS_MAX) break;
    if (typeof source !== "object" || source === null || Array.isArray(source)) continue;
    const citation = citationOf(source as Record<string, unknown>, cited);
    if (citation && !out.has(citation.position)) out.set(citation.position, citation);
  }
  return [...out.keys()].sort((a, b) => a - b).map((n) => out.get(n) as Citation);
}
