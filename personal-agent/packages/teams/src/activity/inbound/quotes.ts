// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The messages an activity quotes (the Python worker's `quotes_of`, `_is_bot`, `_kinds` and the shape warning of
 * `quote_block`). Teams says a quote in two ways and a client may use either: a `quotedReply` entity {messageId,
 * senderId, senderName, preview, time, isReplyDeleted} with a `<quoted messageId="..."/>` placeholder in `text`, or a
 * Reply blockquote (`quotes-html.ts`). Both are read; one quote said both ways is one quote. What a quote says never
 * becomes part of the person's own text.
 */
import { cpHead, pyStr, pyStrip, squashSpaces, type Logger, own } from "@primusclaw/personal-agent";
import { quotedIds } from "./markup.js";
import { htmlQuotes, type Quote } from "./quotes-html.js";
import { entitiesOf, isFields, type Activity, type Fields } from "./schema.js";

export type { Quote } from "./quotes-html.js";

function entityQuotes(activity: Activity): Quote[] {
  const quotes: Quote[] = [];
  for (const entity of entitiesOf(activity)) {
    const data = entity["type"] === "quotedReply" ? entity["quotedReply"] : undefined;
    if (!isFields(data)) continue;
    quotes.push({
      messageId: pyStr(data["messageId"]),
      senderId: pyStr(data["senderId"]),
      sender: squashSpaces(pyStr(data["senderName"])),
      time: pyStr(data["time"]),
      text: pyStr(data["preview"]),
      deleted: data["isReplyDeleted"] === true,
      source: "entity",
    });
  }
  return quotes;
}

function sameQuote(known: Quote, html: Quote): boolean {
  if (known.messageId) return known.messageId === html.messageId;
  return known.sender === html.sender && known.text === html.text;
}

/**
 * The messages this one quotes, in the order Teams gave them: entities, then Reply blockquotes (one said both ways is
 * one quote: the entity's words, the HTML's where the entity has none), then placeholders nothing else describes.
 */
export function quotesOf(activity: Activity): Quote[] {
  const quotes = entityQuotes(activity);
  for (const html of htmlQuotes(activity)) {
    const same = quotes.findIndex((q) => sameQuote(q, html));
    const known = quotes[same];
    if (known === undefined) {
      quotes.push(html);
      continue;
    }
    quotes[same] = {
      ...known,
      senderId: known.senderId || html.senderId,
      sender: known.sender || html.sender,
      time: known.time || html.time,
      text: known.text || html.text,
    };
  }
  for (const id of quotedIds(pyStr(activity.text))) {
    if (!quotes.some((q) => q.messageId === id)) {
      quotes.push({
        messageId: id,
        senderId: "",
        sender: "",
        time: "",
        text: "",
        deleted: false,
        source: "placeholder",
      });
    }
  }
  return quotes;
}

/**
 * Was the quoted message written by the bot itself (`bot`: the activity's recipient)? By the Teams id (the part after
 * the `28:` / `8:orgid:` prefix names the same account whichever way a client writes it); by the display name only when
 * the quote has no id.
 */
export function isBotQuote(quote: Quote, bot: Fields): boolean {
  const botId = pyStr(bot["id"]).toLowerCase();
  const quoteId = quote.senderId.toLowerCase();
  if (botId && quoteId) {
    const botTail = botId.slice(botId.lastIndexOf(":") + 1);
    const quoteTail = quoteId.slice(quoteId.lastIndexOf(":") + 1);
    return quoteId === botId || (quoteTail !== "" && quoteTail === botTail);
  }
  return !quoteId && Boolean(quote.sender) && quote.sender.toLowerCase() === pyStrip(pyStr(bot["name"])).toLowerCase();
}

const KIND_CHAR = /^[\p{L}\p{N}/._-]$/u;

/**
 * The `key` of each object in `items` (letters, digits and `/.-_`, clipped; at most ten): for a log line that says
 * what shape came, never what it held.
 */
export function kindsOf(items: unknown, key: string): string[] {
  if (!Array.isArray(items)) return [];
  return items
    .filter(isFields)
    .slice(0, 10)
    .map((item) =>
      Array.from(cpHead(pyStr(own(item, key)), 40))
        .filter((ch) => KIND_CHAR.test(ch))
        .join(""),
    );
}

/**
 * Logs a `<quoted/>` placeholder that came with no quote data, by the activity's shape only (entity types, attachment
 * types): what the client put there is never logged.
 */
export function logPlaceholderQuotes(activity: Activity, quotes: readonly Quote[], logger: Logger): void {
  if (!quotes.some((q) => q.source === "placeholder")) return;
  logger.warn("a quoted placeholder came with no quote data", {
    entityTypes: kindsOf(activity.entities, "type").join(","),
    attachmentTypes: kindsOf(activity.attachments, "contentType").join(","),
  });
}
