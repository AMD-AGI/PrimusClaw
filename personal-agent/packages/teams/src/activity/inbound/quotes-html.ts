// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The older form of a quote: a Reply blockquote (`itemtype="http://schema.skype.com/Reply" itemid="<message id>"`), the
 * author in `<strong itemprop="mri" itemid="<author id>">`, the time in `<span itemprop="time" itemid="...">`, the text
 * in `<p itemprop="preview">` (the Python worker's `_ReplyHtml`, `_html_quote`, `_html_quotes`). Tags are dropped, line
 * breaks kept, and a link whose words are not its address is followed by the address.
 */
import { pyStr, squashSpaces } from "@primusclaw/personal-agent";
import { attrValue, tokenize, type HtmlToken } from "../../html/lexer.js";
import { caseless, SPACE, SPACE_CHARS, WORD } from "./patterns.js";
import { cutReplies, webUrl } from "./markup.js";
import { attachmentsOf, type Activity } from "./schema.js";

/** A quoted message as the activity describes it. */
export interface Quote {
  readonly messageId: string;
  readonly senderId: string;
  readonly sender: string;
  /** As Teams said it: epoch milliseconds, or a date. */
  readonly time: string;
  readonly text: string;
  readonly deleted: boolean;
  /** Where it was read from: for a log line, never the text. */
  readonly source: "entity" | "html" | "placeholder";
}

type Field = "sender" | "text";

const FIELDS: ReadonlyMap<string, Field | "time"> = new Map([
  ["mri", "sender"],
  ["time", "time"],
  ["preview", "text"],
  ["copy", "text"],
]);
const BREAKS = new Set(["br", "p", "div", "li", "tr"]);
/** No end tag: they must not count as an open element. */
const VOID = new Set(["br", "img", "hr", "wbr", "input", "meta", "link"]);
const ITEMID = new RegExp(`(?<!${WORD})${caseless("itemid")}${SPACE}*=${SPACE}*["']?([^"'>${SPACE_CHARS}]+)`, "u");

/** What the inside of a Reply blockquote says: who, when, and the quoted text. */
class ReplyReader {
  senderId = "";
  time = "";
  readonly parts: Record<Field, string[]> = { sender: [], text: [] };
  readonly everything: string[] = [];
  private field: Field | "" = "";
  private depth = 0;
  /** The link being read, and the words shown for it so far. */
  private href = "";
  private words = "";

  read(tokens: readonly HtmlToken[]): this {
    for (const token of tokens) {
      if (token.kind === "data") this.data(token.text);
      else if (token.kind === "end") this.end(token.tag);
      else if (token.selfClosing) this.breakAt(token.tag);
      else this.start(token.tag, token.attrs);
    }
    return this;
  }

  private breakAt(tag: string): void {
    if (BREAKS.has(tag)) this.say("\n");
  }

  private start(tag: string, attrs: Parameters<typeof attrValue>[0]): void {
    this.breakAt(tag);
    if (VOID.has(tag)) return;
    if (tag === "a") [this.href, this.words] = [webUrl(attrValue(attrs, "href")), ""];
    if (this.field) {
      this.depth++;
      return;
    }
    const field = FIELDS.get(pyStr(attrValue(attrs, "itemprop")).toLowerCase());
    if (field === "time") {
      this.time ||= pyStr(attrValue(attrs, "itemid"));
    } else if (field) {
      if (field === "sender") this.senderId ||= pyStr(attrValue(attrs, "itemid"));
      [this.field, this.depth] = [field, 1];
    }
  }

  private end(tag: string): void {
    this.breakAt(tag);
    if (VOID.has(tag)) return;
    if (tag === "a") {
      // A link whose words are not its address: say the address.
      if (this.href && !this.words.includes(this.href)) this.say(` <${this.href}>`);
      this.href = "";
    }
    if (this.field) {
      this.depth--;
      if (this.depth <= 0) this.field = "";
    }
  }

  private data(text: string): void {
    this.words += text;
    this.say(text);
  }

  private say(piece: string): void {
    this.everything.push(piece);
    if (this.field) this.parts[this.field].push(piece);
  }
}

/** The quote one Reply blockquote holds (`attrs`: the blockquote's own attributes; `inner`: what is inside it). */
export function htmlQuote(attrs: string, inner: string): Quote {
  const reader = new ReplyReader().read(tokenize(inner));
  const sender = squashSpaces(reader.parts.sender.join(""));
  let text = reader.parts.text.join("");
  if (!text) {
    // A blockquote without the usual markup: everything in it but the author's name is the quote.
    const everything = reader.everything.join("");
    text = sender ? everything.replace(sender, () => "") : everything;
  }
  return {
    messageId: ITEMID.exec(attrs)?.[1] ?? "",
    senderId: reader.senderId,
    sender,
    time: reader.time,
    text,
    deleted: false,
    source: "html",
  };
}

/** The Reply blockquotes of an activity: those of its text (when it is HTML), then of its `text/html` attachments. */
export function htmlQuotes(activity: Activity): Quote[] {
  const cut = [...cutReplies(pyStr(activity.text)).cut];
  for (const attachment of attachmentsOf(activity)) {
    const content = attachment["content"];
    if (pyStr(attachment["contentType"]).toLowerCase() === "text/html" && typeof content === "string") {
      cut.push(...cutReplies(content).cut);
    }
  }
  return cut.map(([attrs, inner]) => htmlQuote(attrs, inner));
}
