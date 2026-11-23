// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The messages a person forwarded into the chat, with the images they showed. Teams says a forward in two ways and a
 * client may use either:
 *  - a Forward blockquote in the message's HTML (its text when that is HTML, or its `text/html` attachment), one per
 *    message forwarded, after the forwarder's own words: `<p>FYI</p><blockquote itemtype="http://schema.skype.com/
 *    Forward">...</blockquote>`, with the author (`itemprop="mri"`) and the time (`itemprop="time"`) when Teams marks
 *    them, as a Reply blockquote has them;
 *  - a `forwardedMessageReference` attachment, whose `content` (a JSON string, or the object) carries the original:
 *    `originalMessageId`, `originalMessageContent` (HTML), `originalSentDateTime`, `originalMessageSender`.
 * Both are read; one message said both ways is one message. An image in a forwarded message (`<img>`, Teams' stored
 * image `.../v1/objects/<id>/views/imgo`) is fetched as a pasted image is, from the Bot Connector the activity came
 * through (`<serviceUrl>v3/attachments/<id>/views/original`), unless the message already carries it as an image
 * attachment; an image with no such id is said to be not passed on.
 */
import {
  own,
  pyStr,
  squashSpaces,
  type InboundFile,
  type InboundForward,
  type Logger,
} from "@primusclaw/personal-agent";
import type { TeamsFileHandle } from "../../inbound/attachments.js";
import { cutForwards, FORWARD_ITEMTYPE } from "./markup.js";
import { htmlForward, IMAGE_MARKER, type HtmlForward, type HtmlImage } from "./quotes-html.js";
import { kindsOf } from "./quotes.js";
import { attachmentsOf, isFields, type Activity, type Fields } from "./schema.js";

/** The `contentType` of a forward reference (Teams writes it in this case; it is compared without case). */
export const FORWARD_REFERENCE = "forwardedmessagereference";

/** The longest forward reference `content` read (characters): a larger one is not parsed. */
const REFERENCE_CHARS = 1_000_000;

/** Where a forwarded message was read: for a log line, never the text. */
type Source = InboundForward["source"];

interface Read extends HtmlForward {
  readonly source: Source;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** The Forward blockquotes of the activity's HTML: its text when that is HTML, then its `text/html` attachments. */
function htmlForwards(activity: Activity): Read[] {
  const markups = [pyStr(activity.text)];
  for (const attachment of attachmentsOf(activity)) {
    const content = attachment["content"];
    if (pyStr(attachment["contentType"]).toLowerCase() === "text/html" && typeof content === "string") {
      markups.push(content);
    }
  }
  const found: Read[] = [];
  for (const markup of markups) {
    if (!FORWARD_ITEMTYPE.test(markup)) continue;
    for (const [attrs, inner] of cutForwards(markup).cut) found.push({ ...htmlForward(attrs, inner), source: "html" });
  }
  return found;
}

/** A reference's `content`: the object, or the object a JSON string holds; undefined when it is neither. */
function referenceContent(content: unknown): Fields | undefined {
  if (isFields(content)) return content;
  if (typeof content !== "string" || content.length > REFERENCE_CHARS) return undefined;
  try {
    const parsed: unknown = JSON.parse(content);
    return isFields(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Who wrote the original (`originalMessageSender`: a person, or an app): their name and id. */
function senderOf(content: Fields): { name: string; id: string } {
  const sender = content["originalMessageSender"];
  if (!isFields(sender)) return { name: "", id: "" };
  for (const kind of ["user", "application", "device"]) {
    const who = own(sender, kind);
    if (isFields(who) && (str(who["displayName"]) || str(who["id"]))) {
      return { name: squashSpaces(str(who["displayName"])), id: str(who["id"]) };
    }
  }
  return { name: "", id: "" };
}

/** The forward references of the activity's attachments. */
function referenceForwards(activity: Activity): Read[] {
  const found: Read[] = [];
  for (const attachment of attachmentsOf(activity)) {
    if (pyStr(attachment["contentType"]).toLowerCase() !== FORWARD_REFERENCE) continue;
    const content = referenceContent(attachment["content"]) ?? {};
    const html = htmlForward("", str(content["originalMessageContent"]));
    const sender = senderOf(content);
    found.push({
      messageId: str(content["originalMessageId"]) || pyStr(attachment["id"]),
      senderId: sender.id,
      sender: sender.name,
      time: str(content["originalSentDateTime"]),
      text: html.text,
      images: html.images,
      source: "reference",
    });
  }
  return found;
}

function plainText(read: Read): string {
  return squashSpaces(read.text.replace(IMAGE_MARKER, ""));
}

function sameForward(known: Read, other: Read): boolean {
  if (known.messageId && other.messageId) return known.messageId === other.messageId;
  return plainText(known) !== "" && plainText(known) === plainText(other);
}

/**
 * The messages the activity forwards, in the order Teams gave them: references first (they carry the most), then
 * Forward blockquotes no reference describes; one blockquote said in both the text and its HTML copy is one message.
 */
function forwardsRead(activity: Activity): Read[] {
  const found = referenceForwards(activity);
  for (const html of htmlForwards(activity)) {
    const same = found.findIndex((known) => sameForward(known, html));
    const known = found[same];
    if (known === undefined) {
      found.push(html);
      continue;
    }
    found[same] = {
      ...known,
      senderId: known.senderId || html.senderId,
      sender: known.sender || html.sender,
      time: known.time || html.time,
      ...(plainText(known) || known.images.length ? {} : { text: html.text, images: html.images }),
    };
  }
  return found;
}

const OBJECT_PATH = /\/objects\/([A-Za-z0-9._~-]{1,200})\/views\//u;
const OBJECT_ID = /^[A-Za-z0-9._~-]{1,200}$/u;

/** The id Teams stores an image under: the `itemid`, else the object in its address; "" when it has none. */
function objectIdOf(image: HtmlImage): string {
  if (OBJECT_ID.test(image.itemId) && image.itemId.includes("-")) return image.itemId;
  return OBJECT_PATH.exec(image.src)?.[1] ?? "";
}

/** The Bot Connector address of a stored image; "" when the activity names no https service. */
function connectorImageUrl(serviceUrl: string, objectId: string): string {
  if (!serviceUrl.startsWith("https://")) return "";
  const base = serviceUrl.endsWith("/") ? serviceUrl : `${serviceUrl}/`;
  return `${base}v3/attachments/${encodeURIComponent(objectId)}/views/original`;
}

/** `decodeURIComponent`, or the text as it is when it is no valid escape (a malformed address is not an error here). */
function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** A forwarded text as lines: each paragraph's tags made one line break, the ends trimmed, no line only spaces. */
function tidy(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "")
    .join("\n")
    .trim();
}

/** The forwarded messages for core, and the message's files with the images they showed added. */
export interface ForwardsAndFiles {
  readonly forwards: InboundForward[];
  readonly files: InboundFile[];
}

/**
 * `files` (what `inboundFiles` read from the attachments) with each image of a forwarded message added as a pasted
 * image (once, and not when an attachment already carries it), and the forwarded messages with their image markers
 * made words: `[image-<n>]` for file n, `[image not passed on]` for one that has no Teams id to fetch it by.
 */
export function forwardsOf(activity: Activity, files: readonly InboundFile[], logger?: Logger): ForwardsAndFiles {
  const read = forwardsRead(activity);
  const all = [...files];
  if (read.length === 0) return { forwards: [], files: all };
  const serviceUrl = pyStr(activity.serviceUrl);
  /** The place (1-based) of the file each stored image already is. */
  const placeOf = new Map<string, number>();
  for (const [at, file] of all.entries()) {
    const url = str(file.handle["url"]);
    const id = file.handle["kind"] === "pasted" ? (/\/attachments\/([^/]+)\/views\//u.exec(url)?.[1] ?? "") : "";
    if (id) placeOf.set(decoded(id), at + 1);
  }
  const forwards = read.map((forward): InboundForward => {
    const words = forward.images.map((image) => {
      const id = objectIdOf(image);
      const url = id ? connectorImageUrl(serviceUrl, id) : "";
      if (!url) return "[image not passed on]";
      let place = placeOf.get(id);
      if (place === undefined) {
        place = all.length + 1;
        const handle: TeamsFileHandle = { kind: "pasted", url, index: place };
        all.push({ name: "", type: "", handle: { ...handle } });
        placeOf.set(id, place);
      }
      return `[image-${String(place)}]`;
    });
    return {
      messageId: forward.messageId,
      author: forward.sender,
      text: tidy(forward.text.replace(IMAGE_MARKER, (_, at: string) => words[Number(at)] ?? "")),
      sentAt: forward.time,
      source: forward.source,
    };
  });
  logger?.info("forwarded messages read", {
    count: forwards.length,
    sources: [...new Set(read.map((f) => f.source))].sort().join("+"),
    images: read.reduce((n, f) => n + f.images.length, 0),
    attachmentTypes: kindsOf(activity.attachments, "contentType").join(","),
  });
  return { forwards, files: all };
}

/**
 * `text` (the person's words) without the forwarded messages' text that Teams also put there: a client that sends the
 * forward as plain text writes the forwarded messages into `text` as well, after the person's words and in their order,
 * and they must not read as the person's own words. Only that shape is cut: every forwarded message's text, in order, at
 * the end of `text` (after a space, or as all of it). A forwarded text the person happens to repeat in their own words
 * ("who said LGTM on this?" with "LGTM" forwarded), or one written anywhere else, stays theirs; `text` is untouched then.
 */
export function ownWords(text: string, forwards: readonly InboundForward[]): string {
  // (a forwarded message with no text, an image alone, leaves nothing in `text`)
  const said = forwards
    .map((f) => squashSpaces(f.text.replace(/\[image(?:-[0-9]+| not passed on)\]/gu, "")))
    .filter(Boolean);
  if (said.length === 0) return text;
  let own = squashSpaces(text);
  for (const one of said.reverse()) {
    if (own === one) {
      own = "";
    } else if (own.endsWith(` ${one}`)) {
      own = own.slice(0, own.length - one.length - 1);
    } else {
      return text;
    }
  }
  return squashSpaces(own);
}

const READ_KINDS =
  /^(?:text\/html|image\/.*|application\/vnd\.microsoft\.card\..*|application\/vnd\.microsoft\.teams\.file\.download\.info|forwardedmessagereference)$/u;

/**
 * Logs, by shape only (the attachments' and entities' types), a message that carries an attachment of a kind no reader
 * here reads: how a client says something new (a forward in a form not known yet) shows in the log, never what it held.
 */
export function logUnreadKinds(activity: Activity, logger: Logger): void {
  const kinds = kindsOf(activity.attachments, "contentType");
  if (!kinds.some((kind) => !READ_KINDS.test(kind.toLowerCase()))) return;
  logger.info("an attachment of a kind not read", {
    attachmentTypes: kinds.join(","),
    entityTypes: kindsOf(activity.entities, "type").join(","),
  });
}
