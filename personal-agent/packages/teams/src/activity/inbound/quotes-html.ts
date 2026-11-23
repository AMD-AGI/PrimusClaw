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
import { cutForwards, cutReplies, webUrl } from "./markup.js";
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

/** Private-use characters around a marker (the reader drops any the markup had). */
const MARK_OPEN = "\uE010";
const MARK_CLOSE = "\uE011";
const MARKS = /[\uE010\uE011]/gu;

/** An image a forwarded message shows (`<img>`), read where it stands in the text. */
export interface HtmlImage {
  /** The `src` as written (an http(s) address, else ""). */
  readonly src: string;
  /** The `itemid` (Teams' id of an image it stores), "" when none. */
  readonly itemId: string;
  readonly alt: string;
}

/**
 * Where an image stands in a text read with images (`readImages`): a marker the caller replaces once it knows what the
 * image became (a file of the message, or words saying it was not passed on).
 */
export function imageMarker(index: number): string {
  return `${MARK_OPEN}img${String(index)}${MARK_CLOSE}`;
}

export const IMAGE_MARKER = /\uE010img([0-9]+)\uE011/gu;

const EMOJI_ITEMTYPE = /schema\.skype\.com\/Emoji/iu;

/** What the inside of a Reply blockquote says: who, when, and the quoted text. */
class ReplyReader {
  senderId = "";
  time = "";
  readonly parts: Record<Field, string[]> = { sender: [], text: [] };
  readonly everything: string[] = [];
  /** The images read, in order, when the reader reads them (`readImages`); else an `<img>` says nothing. */
  readonly images: HtmlImage[] | undefined;
  private field: Field | "" = "";
  private depth = 0;
  /**
   * How deep in a blockquote of its own the reader is, in a forwarded message (one read with images): a message
   * forwarded from a reply chain holds the reply's quote, whose author and preview are part of what was forwarded, not
   * the forwarded message's own.
   */
  private nested = 0;
  /** The link being read, and the words shown for it so far. */
  private href = "";
  private words = "";

  constructor(readImages = false) {
    this.images = readImages ? [] : undefined;
  }

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
    if (tag === "img") this.image(attrs);
    if (VOID.has(tag)) return;
    if (tag === "blockquote" && this.images !== undefined) this.nested++;
    if (tag === "a") [this.href, this.words] = [webUrl(attrValue(attrs, "href")), ""];
    if (this.field) {
      this.depth++;
      return;
    }
    if (this.nested > 0) return;
    const field = FIELDS.get(pyStr(attrValue(attrs, "itemprop")).toLowerCase());
    if (field === "time") {
      this.time ||= pyStr(attrValue(attrs, "itemid"));
    } else if (field) {
      if (field === "sender") this.senderId ||= pyStr(attrValue(attrs, "itemid"));
      [this.field, this.depth] = [field, 1];
    }
  }

  /** An emoji is its own character; any other image is a marker (when images are read). */
  private image(attrs: Parameters<typeof attrValue>[0]): void {
    if (this.images === undefined) return;
    const alt = squashSpaces(pyStr(attrValue(attrs, "alt")).replace(MARKS, ""));
    if (EMOJI_ITEMTYPE.test(pyStr(attrValue(attrs, "itemtype")))) {
      this.say(alt);
      return;
    }
    this.images.push({ src: webUrl(attrValue(attrs, "src")), itemId: pyStr(attrValue(attrs, "itemid")), alt });
    this.say(imageMarker(this.images.length - 1));
  }

  private end(tag: string): void {
    this.breakAt(tag);
    if (VOID.has(tag)) return;
    if (tag === "blockquote" && this.nested > 0) this.nested--;
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
    // (a marker character the markup carried would read as part of a marker)
    const words = this.images === undefined ? text : text.replace(MARKS, "");
    this.words += words;
    this.say(words);
  }

  private say(piece: string): void {
    this.everything.push(piece);
    if (this.field) this.parts[this.field].push(piece);
  }
}

/** A forwarded message as its Forward blockquote (or the HTML a forward reference carries) says it. */
export interface HtmlForward {
  readonly messageId: string;
  readonly senderId: string;
  readonly sender: string;
  readonly time: string;
  /** The text, each image in it an `imageMarker(i)` of `images[i]`. */
  readonly text: string;
  readonly images: readonly HtmlImage[];
}

/**
 * The message one Forward blockquote holds: read as a Reply blockquote is (an author and a time when Teams marks them,
 * else everything in it is the message), its images kept as markers.
 */
export function htmlForward(attrs: string, inner: string): HtmlForward {
  const reader = new ReplyReader(true).read(tokenize(inner));
  const quote = quoteOf(attrs, reader);
  return {
    messageId: quote.messageId,
    senderId: quote.senderId,
    sender: quote.sender,
    time: quote.time,
    text: quote.text,
    images: reader.images ?? [],
  };
}

/** The quote one Reply blockquote holds (`attrs`: the blockquote's own attributes; `inner`: what is inside it). */
export function htmlQuote(attrs: string, inner: string): Quote {
  return quoteOf(attrs, new ReplyReader().read(tokenize(inner)));
}

function quoteOf(attrs: string, reader: ReplyReader): Quote {
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
  // (a Reply blockquote inside a forwarded message is part of what was forwarded, not a quote of the person's)
  const cut = [...cutReplies(cutForwards(pyStr(activity.text)).kept).cut];
  for (const attachment of attachmentsOf(activity)) {
    const content = attachment["content"];
    if (pyStr(attachment["contentType"]).toLowerCase() === "text/html" && typeof content === "string") {
      cut.push(...cutReplies(cutForwards(content).kept).cut);
    }
  }
  return cut.map(([attrs, inner]) => htmlQuote(attrs, inner));
}
