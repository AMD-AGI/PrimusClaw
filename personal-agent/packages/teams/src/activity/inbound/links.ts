// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The hyperlinks behind a message's words (the Python worker's `links_of`, `_html_links`, `_card_links`). `text` is
 * what the words look like on the screen: a link written with other words than its address shows only those words.
 * Teams sends the address beside it: in the message's `text/html` attachment (`<a href>`), in a link preview card
 * (`url`, an `openUrl` action's `value`), or in an entity's `url`. The links of a quote are the quote's (its Reply
 * blockquote is left out here); a file's `downloadUrl` is a credential and is never read; a picture is not a link.
 */
import { pyStr, squashSpaces, type InboundLink } from "@primusclaw/personal-agent";
import { attrValue, tokenize } from "../../html/lexer.js";
import { cutReplies, webUrl } from "./markup.js";
import { attachmentsOf, entitiesOf, isFields, type Activity, type Fields } from "./schema.js";

/** The most links that are added to a text. */
export const LINK_COUNT = 20;

/** A link: its address and the words shown for it ("" when there are none, or when they are the address). */
export interface Link {
  readonly url: string;
  readonly label: string;
}

const CARD_TYPES = ["application/vnd.microsoft.card.", "application/vnd.microsoft.teams.card."];
/** Entities that hold no link of the person's. */
const PLAIN_ENTITIES = new Set(["mention", "clientInfo", "quotedReply", "ProductInfo", "streamInfo"]);
/** A picture on a card is not a link to it. */
const PICTURE_KEYS = new Set(["images", "image", "icon", "thumbnail", "thumbnailUrl", "media"]);
const URL_KEYS = new Set(["url", "href", "contentUrl"]);
const MAX_DEPTH = 8;
const MAX_ITEMS = 50;

/** The `<a href>` of an HTML text, each with the words shown for it (tags inside the link dropped). */
export function htmlLinks(markup: string): Link[] {
  const found: Link[] = [];
  let url = "";
  let words = "";
  const end = (): void => {
    if (url) {
      const label = squashSpaces(words);
      found.push({ url, label: label === url ? "" : label });
    }
    [url, words] = ["", ""];
  };
  for (const token of tokenize(markup)) {
    if (token.kind === "data") {
      if (url) words += token.text;
    } else if (token.tag === "a") {
      end();
      if (token.kind === "start") url = webUrl(attrValue(token.attrs, "href"));
      // `<a href="..."/>` is a start and an end (Python's default handle_startendtag): a link with no words.
      if (token.kind === "start" && token.selfClosing) end();
    }
  }
  end();
  return found;
}

/** The links of one object of a card (see `cardLinks`). */
function objectLinks(node: Fields, title: string, depth: number): Link[] {
  const found: Link[] = [];
  const own = node["title"];
  const label = typeof own === "string" ? squashSpaces(own) : title;
  const action = node["type"] === "openUrl" || node["type"] === "Action.OpenUrl" ? webUrl(node["value"]) : "";
  if (action) found.push({ url: action, label });
  for (const [key, value] of Object.entries(node)) {
    if (URL_KEYS.has(key)) {
      const url = webUrl(value);
      if (url) found.push({ url, label });
    } else if (!PICTURE_KEYS.has(key) && (Array.isArray(value) || isFields(value))) {
      found.push(...cardLinks(value, label, depth + 1));
    }
  }
  return found;
}

/**
 * The web addresses in a card or an entity: a `url` / `href` / `contentUrl`, and the `value` of an `openUrl` action,
 * each with the `title` of what holds it. Pictures are left out; the walk stops 8 levels down and at 50 items a list.
 */
export function cardLinks(node: unknown, title = "", depth = 0): Link[] {
  if (depth > MAX_DEPTH) return [];
  if (Array.isArray(node)) return node.slice(0, MAX_ITEMS).flatMap((item) => cardLinks(item, title, depth + 1));
  if (!isFields(node) || node["type"] === "Image" || node["type"] === "Media") return [];
  return objectLinks(node, title, depth);
}

function attachmentLinks(activity: Activity): Link[] {
  const found: Link[] = [];
  for (const attachment of attachmentsOf(activity)) {
    const kind = pyStr(attachment["contentType"]).toLowerCase();
    const content = attachment["content"];
    if (kind === "text/html" && typeof content === "string") {
      found.push(...htmlLinks(cutReplies(content).kept));
    } else if (CARD_TYPES.some((prefix) => kind.startsWith(prefix))) {
      found.push(...cardLinks(content, pyStr(attachment["name"])));
      const url = "contentUrl" in attachment ? webUrl(attachment["contentUrl"]) : "";
      if (url) found.push({ url, label: "" });
    }
  }
  return found;
}

/**
 * The hyperlinks the person's own words carry, each address once, in the order found, at most LINK_COUNT: those of
 * the message's HTML (its quote left out), of a link preview's card, and of an entity.
 */
export function linksOf(activity: Activity): Link[] {
  const found = attachmentLinks(activity);
  for (const entity of entitiesOf(activity)) {
    const type = entity["type"];
    if (!(typeof type === "string" && PLAIN_ENTITIES.has(type))) found.push(...cardLinks(entity));
  }
  const unique = new Map<string, Link>();
  for (const link of found) if (!unique.has(link.url)) unique.set(link.url, link);
  return [...unique.values()].slice(0, LINK_COUNT);
}

/** `linksOf` as core's links: the words shown are the title. */
export function inboundLinksOf(activity: Activity): InboundLink[] {
  return linksOf(activity).map((link) => ({ url: link.url, title: link.label }));
}
