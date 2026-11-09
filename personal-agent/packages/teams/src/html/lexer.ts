// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A small HTML lexer: the tokens Python's `html.parser.HTMLParser(convert_charrefs=True)` hands its subclasses, for the
 * readers of a message's HTML (its links, its quotes). Start tags (with `selfClosing` for `<br/>`, which Python reports
 * through `handle_startendtag`), end tags, and text with its character references decoded (`unescape`). Tag and
 * attribute names are lower-cased; an attribute value may be double-quoted, single-quoted (and then hold `>`) or bare,
 * is decoded, and is null when the attribute has no `=`. Comments, `<!...>` declarations and `<?...?>` instructions are
 * dropped; a `<` that starts none of these is text. The text of `<script>` and `<style>` is raw: up to its end tag, not
 * decoded.
 *
 * Every step reads forward only (no regular expression, no backtracking): linear in the markup.
 *
 * Where it differs from CPython 3.12's parser (all on malformed or unusual markup; well-formed HTML gives the same tokens):
 *  - a tag that is never closed by `>` before the end of the markup is dropped with everything after it (HTML5, and
 *    CPython 3.13+); 3.12 hands it on as text;
 *  - inside a tag only ASCII white space (tab, LF, FF, CR, space) separates attributes; 3.12's patterns also take Unicode
 *    spaces there;
 *  - one `=` introduces a value (`a==b` has the value "=b", as in HTML5); 3.12 skips any number of them;
 *  - an end tag ends at its first `>` (as in 3.12), its attributes ignored;
 *  - an unterminated comment runs to the end of the markup; `--!>` does not end a comment;
 *  - only `script` and `style` are raw text (3.12's CDATA_CONTENT_ELEMENTS); 3.14 adds more elements;
 *  - named character references outside the subset of `entities.ts` are left as written.
 */
import { unescape } from "./entities.js";

/** An attribute: its lower-cased name and its decoded value (null when it has no `=`). */
export type HtmlAttr = readonly [name: string, value: string | null];

export type HtmlToken =
  | { readonly kind: "start"; readonly tag: string; readonly attrs: readonly HtmlAttr[]; readonly selfClosing: boolean }
  | { readonly kind: "end"; readonly tag: string }
  | { readonly kind: "data"; readonly text: string };

/** The value of attribute `name`, the last one when it is given twice (Python's `dict(attrs)`); undefined when absent. */
export function attrValue(attrs: readonly HtmlAttr[], name: string): string | null | undefined {
  let found: string | null | undefined;
  for (const [key, value] of attrs) if (key === name) found = value;
  return found;
}

const RAW_TEXT = new Set(["script", "style"]);

function isSpace(ch: string | undefined): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f";
}

function isLetter(ch: string | undefined): boolean {
  return ch !== undefined && ((ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z"));
}

/** One pass over `markup`. */
class Lexer {
  readonly tokens: HtmlToken[] = [];
  private pos = 0;
  private text = "";

  constructor(private readonly markup: string) {}

  run(): HtmlToken[] {
    const { markup } = this;
    while (this.pos < markup.length) {
      const lt = markup.indexOf("<", this.pos);
      if (lt < 0) {
        this.text += markup.slice(this.pos);
        break;
      }
      this.text += markup.slice(this.pos, lt);
      this.pos = lt;
      if (!this.markupAt(lt)) {
        this.text += "<";
        this.pos = lt + 1;
      }
    }
    this.flush();
    return this.tokens;
  }

  /** Reads the construct that starts with the `<` at `lt`; false when it starts none (the `<` is text). */
  private markupAt(lt: number): boolean {
    const next = this.markup[lt + 1];
    if (isLetter(next)) return this.startTag(lt);
    if (next === "/") return this.endTag(lt);
    if (next === "!" && this.markup.startsWith("<!--", lt)) {
      const close = this.markup.indexOf("-->", lt + 4);
      this.skipTo(close < 0 ? this.markup.length : close + 3);
      return true;
    }
    if (next === "!" || next === "?") {
      this.skipPast(lt + 2);
      return true;
    }
    return false;
  }

  private startTag(lt: number): boolean {
    const { markup } = this;
    let at = lt + 1;
    while (at < markup.length && !"\t\n\r\f />\0".includes(markup[at] ?? "")) at++;
    const tag = markup.slice(lt + 1, at).toLowerCase();
    const attrs: HtmlAttr[] = [];
    for (;;) {
      while (isSpace(markup[at]) || (markup[at] === "/" && markup[at + 1] !== ">")) at++;
      if (at >= markup.length) return this.unterminated();
      if (markup[at] === ">" || markup[at] === "/") break;
      const attr = this.attribute(at);
      if (attr === undefined) return this.unterminated();
      attrs.push(attr.attr);
      at = attr.end;
    }
    const selfClosing = markup[at] === "/";
    this.emit({ kind: "start", tag, attrs, selfClosing });
    this.pos = at + (selfClosing ? 2 : 1);
    if (!selfClosing && RAW_TEXT.has(tag)) this.rawText(tag);
    return true;
  }

  /** The attribute that starts at `at` and where it ends; undefined when the markup ends inside it. */
  private attribute(at: number): { attr: HtmlAttr; end: number } | undefined {
    const { markup } = this;
    let end = at + 1;
    while (end < markup.length && !"\t\n\r\f />=".includes(markup[end] ?? "")) end++;
    const name = markup.slice(at, end).toLowerCase();
    let pos = end;
    while (isSpace(markup[pos])) pos++;
    if (markup[pos] !== "=") return pos >= markup.length ? undefined : { attr: [name, null], end };
    pos++;
    while (isSpace(markup[pos])) pos++;
    const quote = markup[pos];
    if (quote === '"' || quote === "'") {
      const close = markup.indexOf(quote, pos + 1);
      if (close < 0) return undefined;
      return { attr: [name, unescape(markup.slice(pos + 1, close))], end: close + 1 };
    }
    let stop = pos;
    while (stop < markup.length && markup[stop] !== ">" && !isSpace(markup[stop])) stop++;
    if (stop >= markup.length) return undefined;
    return { attr: [name, unescape(markup.slice(pos, stop))], end: stop };
  }

  private endTag(lt: number): boolean {
    const { markup } = this;
    const first = markup[lt + 2];
    if (first === undefined) return false;
    if (first === ">") {
      this.skipTo(lt + 3);
      return true;
    }
    if (!isLetter(first)) {
      this.skipPast(lt + 2);
      return true;
    }
    let at = lt + 2;
    while (at < markup.length && !"\t\n\r\f />".includes(markup[at] ?? "")) at++;
    const close = markup.indexOf(">", at);
    if (close < 0) return this.unterminated();
    this.emit({ kind: "end", tag: markup.slice(lt + 2, at).toLowerCase() });
    this.pos = close + 1;
    return true;
  }

  /** The text of a raw-text element, up to its end tag (or the end of the markup), as it is written. */
  private rawText(tag: string): void {
    const { markup } = this;
    let at = this.pos;
    for (;;) {
      at = markup.indexOf("</", at);
      if (at < 0) {
        at = markup.length;
        break;
      }
      const after = markup[at + 2 + tag.length];
      if (
        markup.slice(at + 2, at + 2 + tag.length).toLowerCase() === tag &&
        (after === undefined || "\t\n\r\f />".includes(after))
      )
        break;
      at += 2;
    }
    if (at > this.pos) this.emitRaw(markup.slice(this.pos, at));
    this.pos = at;
  }

  /** The rest of the markup from `from` up to and including the next `>` is dropped (to the end when there is none). */
  private skipPast(from: number): void {
    const close = this.markup.indexOf(">", from);
    this.skipTo(close < 0 ? this.markup.length : close + 1);
  }

  private skipTo(pos: number): void {
    this.flush();
    this.pos = pos;
  }

  /** A tag the markup ends inside: it and the rest are dropped. */
  private unterminated(): true {
    this.flush();
    this.pos = this.markup.length;
    return true;
  }

  private emit(token: HtmlToken): void {
    this.flush();
    this.tokens.push(token);
  }

  private emitRaw(text: string): void {
    this.flush();
    this.pushText(text);
  }

  /** The text read so far, decoded on its own (a reference never spans a tag or a comment, as in Python). */
  private flush(): void {
    if (this.text) this.pushText(unescape(this.text));
    this.text = "";
  }

  /** Adds text, joined to the text token before it (text on both sides of a dropped comment is one token). */
  private pushText(text: string): void {
    const last = this.tokens.at(-1);
    if (last?.kind === "data") this.tokens[this.tokens.length - 1] = { kind: "data", text: last.text + text };
    else this.tokens.push({ kind: "data", text });
  }
}

/** The tokens of `markup`, in order; adjacent text is one token. */
export function tokenize(markup: string): HtmlToken[] {
  return new Lexer(markup).run();
}
