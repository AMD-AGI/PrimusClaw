// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The message(s) a person quoted, as text for the model (the Python worker's `activity.quote_block` and `with_quote`).
 * Each quote is a line that says it is a quote and who wrote it ("Quoted your earlier reply" when that was the bot),
 * then the quoted text with every line after "> ", so nothing a quote says can pass for a line of its own. In a group
 * the author's name and the text are masked as an outbound message is; all the quotes of a message share one budget of
 * QUOTE_CHARS characters, cut after the mask (a cut cannot leave half a credential).
 */
import { silentLogger, type Logger } from "../ports/logger.js";
import type { InboundQuote } from "../ports/surface.js";
import { cpHead, cpLength, cpSlice, pyRstrip, pyStrip } from "../text/py-text.js";
import { noRedact, type Redact } from "./redact.js";
import { whenOf } from "./when.js";

/** The most quoted text, over all the quotes of one message, that is sent on (code points). */
export const QUOTE_CHARS = 4000;
/** The most quoted messages that are shown. */
export const QUOTE_COUNT = 5;
/** The longest author name shown. */
export const NAME_CHARS = 80;

/** Where a channel read a quote from: for a log line, never its text. */
export type QuoteSource = "entity" | "html" | "placeholder";

/**
 * A quote with what the text needs beyond core's `InboundQuote` (to be folded into it): whether the quoted message
 * was deleted (its text then says so), and where it was read from.
 */
export type QuoteForText = InboundQuote & {
  readonly deleted: boolean;
  readonly source: QuoteSource;
};

export interface QuoteBlockOptions {
  /** A group conversation: names and texts are masked. */
  readonly group?: boolean;
  readonly redact?: Redact;
  readonly logger?: Logger;
}

const AT_TAG = /<\/?[Aa][Tt]>/g;
/** Python's `str.splitlines()` boundaries. */
// eslint-disable-next-line no-control-regex -- \x1c-\x1e are line boundaries for Python's splitlines
const LINE_BREAK = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;

function pySplitlines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split(LINE_BREAK);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function headOf(quote: QuoteForText, group: boolean, redact: Redact): string {
  let head: string;
  if (quote.fromBot) {
    head = "Quoted your earlier reply";
  } else {
    // The author's name is a stranger's words too.
    const name = cpHead(group ? redact(quote.author) : quote.author, NAME_CHARS);
    head = "Quoted message" + (name ? ` from ${name}` : "");
  }
  const when = whenOf(quote.sentAt);
  return head + (when ? ` (${when}):` : ":");
}

function bodyOf(quote: QuoteForText, group: boolean, redact: Redact, budget: number): string {
  let text = quote.text.replace(AT_TAG, "");
  text = group ? redact(text) : text;
  text = pySplitlines(pyStrip(text))
    .map((line) => pyRstrip(line))
    .join("\n");
  if (!text) {
    return quote.deleted ? "[the quoted message was deleted]" : "[the text of the quoted message is not available]";
  }
  return cpLength(text) > budget ? pyRstrip(cpSlice(text, 0, budget)) + "… [cut]" : text;
}

/** `activity.quote_block`: the quotes as text for the model, "" when there are none. */
export function quoteBlock(quotes: readonly QuoteForText[], options: QuoteBlockOptions = {}): string {
  if (quotes.length === 0) return "";
  const group = options.group ?? false;
  const redact = options.redact ?? noRedact;
  const sources = [...new Set(quotes.map((q) => q.source))].sort().join("+");
  (options.logger ?? silentLogger).info("the message quotes earlier messages", { count: quotes.length, sources });
  let budget = QUOTE_CHARS;
  const blocks: string[] = [];
  for (const quote of quotes.slice(0, QUOTE_COUNT)) {
    if (budget <= 0) break;
    const text = bodyOf(quote, group, redact, budget);
    budget -= cpLength(text);
    const lines = text.split("\n").map((line) => pyRstrip(`> ${line}`));
    blocks.push(`${headOf(quote, group, redact)}\n${lines.join("\n")}`);
  }
  const hidden = quotes.length - blocks.length;
  if (hidden > 0) blocks.push(`(${String(hidden)} more quoted message${hidden === 1 ? "" : "s"} not shown)`);
  return blocks.join("\n\n");
}

/** `activity.with_quote`: what the model is sent, the quote (`quoteBlock`) before what the person wrote. */
export function withQuote(text: string, quote: string): string {
  return quote && text ? `${quote}\n\n${text}` : quote || text;
}
