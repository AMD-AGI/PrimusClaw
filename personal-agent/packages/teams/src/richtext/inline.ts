// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * One line of markdown as its top-level HTML fragments: backslash escapes, code spans, links (bracketed, autolinks
 * and bare URLs) and emphasis (bold, italic, strike, underline). Text and code reach the HTML only escaped, a URL only
 * through `safeUrl`.
 */
import { cpLength } from "@primusclaw/personal-agent";
import { MAX_NEST } from "./constants.js";
import { cpBefore, escapeAttr, escaping, isAlnum, PY_SPACE, strip } from "./escape.js";
import { canOpen, codeSpans, findCloser, parseLink, trimUrl, type CodeSpans } from "./scan.js";
import { safeUrl } from "./url.js";

export type FragKind = "text" | "bold" | "code" | "link" | "other";

/** A piece of a line: its HTML, its plain text, and what it is ("text": the html is the escaped plain text). */
export interface Frag {
  readonly html: string;
  readonly plain: string;
  readonly kind: FragKind;
}

export function textFrag(plain: string): Frag {
  return { html: escaping.esc(plain), plain, kind: "text" };
}

export function joinHtml(frags: readonly Frag[]): string {
  return frags.map((f) => f.html).join("");
}

const ESCAPABLE = "\\`*_{}[]()#+-.!|~<>";
const AUTOLINK = new RegExp(`<(https?://[^${PY_SPACE}<>]+)>`, "iuy");
const BARE_URL = new RegExp(`https?://[^${PY_SPACE}<>"\`]+`, "iuy");
const EMPHASIS: Readonly<Record<string, readonly [string, FragKind]>> = {
  "*2": ["b", "bold"],
  _2: ["b", "bold"],
  "*1": ["i", "other"],
  _1: ["i", "other"],
  "~2": ["s", "other"],
  "+2": ["u", "other"],
};

function link(labelHtml: string, url: string): string {
  return `<a href="${escapeAttr(url)}">${labelHtml}</a>`;
}

function stickyMatch(pattern: RegExp, text: string, at: number): RegExpExecArray | null {
  pattern.lastIndex = at;
  return pattern.exec(text);
}

/** The delimiter sizes a run of `run` delimiters `c` may open, largest first. */
function sizesFor(c: string, run: number): readonly number[] {
  if (c === "*" || c === "_") return run >= 2 ? [2, 1] : [1];
  return run >= 2 ? [2] : [];
}

/** The reader of one line: `i` walks the text, plain characters collect in `buf` until a fragment flushes them. */
class InlineReader {
  private readonly spans: CodeSpans;
  private readonly out: Frag[] = [];
  private buf = "";
  /** `${delimiter}${size}` -> a start from which no closer exists. */
  private readonly dead = new Map<string, number>();
  private i = 0;

  constructor(
    private readonly text: string,
    private readonly depth: number,
    private readonly links: boolean,
  ) {
    this.spans = text.includes("`") ? codeSpans(text) : new Map();
  }

  read(): Frag[] {
    const n = this.text.length;
    while (this.i < n) this.step(this.text.charAt(this.i));
    this.flush();
    return this.out;
  }

  private step(c: string): void {
    const text = this.text;
    if (c === "\\" && this.i + 1 < text.length && ESCAPABLE.includes(text.charAt(this.i + 1))) {
      this.buf += text.charAt(this.i + 1);
      this.i += 2;
    } else if (c === "`") {
      this.code();
    } else if (this.links && this.linked(c)) {
      return;
    } else if ("*_~+".includes(c)) {
      this.emphasis(c);
    } else {
      this.literal(1);
    }
  }

  /** Reads a link (or the "[" / "!" / "h" that did not start one) at `c`; false when `c` cannot start a link. */
  private linked(c: string): boolean {
    if (c === "[" || (c === "!" && this.text.charAt(this.i + 1) === "[")) {
      this.bracketLink(c === "!");
      return true;
    }
    if (c === "<") return this.autolink();
    if (c === "h" || c === "H") return this.bareUrl();
    return false;
  }

  private flush(): void {
    if (this.buf) {
      this.out.push(textFrag(this.buf));
      this.buf = "";
    }
  }

  private literal(length: number): void {
    this.buf += this.text.slice(this.i, this.i + length);
    this.i += length;
  }

  private push(frag: Frag, end: number): void {
    this.flush();
    this.out.push(frag);
    this.i = end;
  }

  private sub(inner: string, withLinks: boolean = this.links): string {
    return joinHtml(inlineFrags(inner, this.depth + 1, withLinks));
  }

  private code(): void {
    const span = this.spans.get(this.i);
    if (!span) {
      let j = this.i;
      while (j < this.text.length && this.text.charAt(j) === "`") j += 1;
      this.literal(j - this.i);
      return;
    }
    const [end, a, b] = span;
    let code = this.text.slice(a, b);
    if (cpLength(code) > 2 && code.startsWith(" ") && code.endsWith(" ") && strip(code)) code = code.slice(1, -1);
    this.push({ html: `<code>${escaping.esc(code)}</code>`, plain: code, kind: "code" }, end);
  }

  private bracketLink(image: boolean): void {
    const parsed = parseLink(this.text, image ? this.i + 1 : this.i, this.spans);
    const url = parsed ? safeUrl(parsed[1]) : null;
    if (!parsed || !url) {
      this.literal(1); // not a link, or one with a URL that is not http(s): shown as the text it was
      return;
    }
    const label = parsed[0] || (image ? "image" : url);
    this.push({ html: link(this.sub(label, false), url), plain: label, kind: "link" }, parsed[2]);
  }

  private autolink(): boolean {
    const m = stickyMatch(AUTOLINK, this.text, this.i);
    const url = m?.[1];
    if (m === null || url === undefined || !safeUrl(url)) return false;
    this.push({ html: link(escaping.esc(url), url), plain: url, kind: "link" }, this.i + m[0].length);
    return true;
  }

  private bareUrl(): boolean {
    const m = stickyMatch(BARE_URL, this.text, this.i);
    if (m === null || (this.i > 0 && isAlnum(cpBefore(this.text, this.i)))) return false;
    const url = trimUrl(m[0]);
    if (safeUrl(url)) this.push({ html: link(escaping.esc(url), url), plain: url, kind: "link" }, this.i + url.length);
    else this.literal(1);
    return true;
  }

  private emphasis(c: string): void {
    const text = this.text;
    const i = this.i;
    let j = i;
    while (j < text.length && text.charAt(j) === c) j += 1;
    for (const size of sizesFor(c, j - i)) {
      const key = `${c}${String(size)}`;
      if (!canOpen(text, i, c, size) || (this.dead.get(key) ?? text.length + 1) <= i + size) continue;
      const at = findCloser(text, i + size, c, size, this.spans);
      if (at === null) {
        this.dead.set(key, i + size);
        continue;
      }
      const [tag, kind] = EMPHASIS[key] ?? ["i", "other"];
      const inner = text.slice(i + size, at);
      this.push({ html: `<${tag}>${this.sub(inner)}</${tag}>`, plain: inner, kind }, at + size);
      return;
    }
    this.literal(j - i);
  }
}

/** The top-level pieces of one line of markdown. Emphasis inside a piece is already rendered into its html. */
export function inlineFrags(text: string, depth = 0, links = true): Frag[] {
  if (depth > MAX_NEST) return [textFrag(text)];
  return new InlineReader(text, depth, links).read();
}
