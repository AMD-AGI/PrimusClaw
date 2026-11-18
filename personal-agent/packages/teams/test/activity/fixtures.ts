// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Activities shaped as Teams documents them (no sample from a live chat), for the inbound readers' tests: the Python
 * suite's `dm`, `grp`, `reply_entity`, `reply_html` builders, and the texts the Python worker built from an activity
 * (`quote_block`, `with_links`, `marked_text`) composed from the Teams readers and core's channel-neutral texts.
 */
import assert from "node:assert/strict";
import {
  markedText,
  quoteBlock,
  withLinks,
  type InboundMention,
  type InboundMessage,
  type Logger,
} from "@primusclaw/personal-agent";
import { isGroup, messageText, toInboundEvent, type Activity } from "../../src/activity/inbound/index.js";

export const BOT = "28:bot";
export const CONV = "19:group@thread.v2";
export const WHEN_MS = "1793695000000"; // 2026-11-03 08:36:40 UTC
export const WHEN = "2026-11-03 08:36 UTC";
export const MENTION = {
  type: "mention",
  text: "<at>PrimusClaw Assistant</at>",
  mentioned: { id: BOT, name: "PrimusClaw Assistant" },
};
export const USER_A = { aadObjectId: "aad-a", name: "Alice", id: "29:a" };
export const USER_B = { aadObjectId: "aad-b", name: "Bob", id: "29:b" };
export const QUOTE = `Quoted message from Bob (${WHEN}):\n> The deploy failed on node 3`;

type Json = Record<string, unknown>;

/** A `quotedReply` entity; a field given as null is left out (Python's `None`). */
export function replyEntity(
  preview: string | null = "The deploy failed on node 3",
  sender: string | null = "Bob",
  senderId: string | null = "29:b",
  messageId: string | null = "m-100",
  time: string | null = WHEN_MS,
  more: Json = {},
): Json {
  const data: Json = { messageId, senderId, senderName: sender, preview, time, ...more };
  return { type: "quotedReply", quotedReply: Object.fromEntries(Object.entries(data).filter(([, v]) => v !== null)) };
}

export interface ReplyHtml {
  readonly preview?: string;
  readonly sender?: string;
  readonly senderId?: string;
  readonly messageId?: string;
  readonly time?: string;
  readonly own?: string;
}

/** The older shape: what Teams puts in a text/html attachment of a reply. */
export function replyHtml(fields: ReplyHtml = {}): string {
  const preview = fields.preview ?? "The deploy failed on node 3";
  const sender = fields.sender ?? "Bob";
  const senderId = fields.senderId ?? "8:orgid:bob";
  const messageId = fields.messageId ?? "m-100";
  const time = fields.time ?? WHEN_MS;
  const own = fields.own ?? "@PrimusClaw Assistant summarize this";
  return (
    `<blockquote itemscope="" itemtype="http://schema.skype.com/Reply" itemid="${messageId}">` +
    `<strong itemprop="mri" itemid="${senderId}">${sender}</strong><span itemprop="time" itemid="${time}"></span>` +
    `<p itemprop="preview">${preview}</p></blockquote><p>${own}</p>`
  );
}

export interface Parts {
  readonly entities?: readonly unknown[];
  readonly attachments?: readonly unknown[];
  readonly activityId?: string;
  readonly user?: Json & { aadObjectId: string };
  /** grp only: the bot's mention entity comes first (default true). */
  readonly mention?: boolean;
}

export function dm(text: string, parts: Parts = {}): Activity {
  const user = parts.user ?? USER_A;
  return {
    type: "message",
    id: parts.activityId ?? "act-1",
    text,
    from: user,
    entities: [...(parts.entities ?? [])],
    attachments: [...(parts.attachments ?? [])],
    recipient: { id: BOT, name: "PrimusClaw Assistant" },
    serviceUrl: "https://smba.test/",
    channelId: "msteams",
    conversation: { id: `conv-${user.aadObjectId}`, conversationType: "personal" },
  };
}

/** A group message. `text` is what Teams put in `text`, the bot's mention (when there is one) included by the caller. */
export function grp(text: string, parts: Parts = {}): Activity {
  return {
    type: "message",
    id: parts.activityId ?? "g1",
    text,
    entities: [...((parts.mention ?? true) ? [MENTION] : []), ...(parts.entities ?? [])],
    attachments: [...(parts.attachments ?? [])],
    from: parts.user ?? USER_A,
    recipient: { id: BOT, name: "PrimusClaw Assistant" },
    serviceUrl: "https://smba.test/",
    channelId: "msteams",
    conversation: { id: CONV, conversationType: "groupChat" },
  };
}

export function htmlAttachment(content: unknown): Json {
  return { contentType: "text/html", content };
}

export function quotedGroup(textAfter = "summarize this", entity: Json = replyEntity()): Activity {
  return grp(`<quoted messageId="m-100"/> <at>PrimusClaw Assistant</at> ${textAfter}`, { entities: [entity] });
}

export function quotedDm(textAfter = "summarize this", entity: Json = replyEntity()): Activity {
  return dm(`<quoted messageId="m-100"/> ${textAfter}`, { entities: [entity] });
}

/** A stand-in for the masking a group gets (W2's redaction): a GitHub token is "[hidden]". */
export function mask(text: string): string {
  return text.replace(/ghp_[A-Za-z0-9]+/g, "[hidden]");
}

/** The activity as core's message event. */
export function eventOf(activity: Activity, logger?: Logger): InboundMessage {
  const event = toInboundEvent(activity, logger ? { logger } : {});
  assert.ok(event.ok && event.value?.type === "message", "a message event");
  return event.value;
}

/** Python `quote_block(activity, group=group)`. */
export function quoteBlockOf(activity: Activity, group = false, logger?: Logger): string {
  return quoteBlock(eventOf(activity).quotes, { group, redact: mask, ...(logger ? { logger } : {}) });
}

/** Python `with_links(text, activity)`. */
export function withLinksOf(text: string, activity: Activity): string {
  return withLinks(text, eventOf(activity).links, { group: isGroup(activity), redact: mask });
}

/** The person's words with the address behind each link: what is sent on. */
export function said(activity: Activity): string {
  return withLinksOf(messageText(activity), activity);
}

/** Python `marked_text(activity)`. */
export function markedTextOf(activity: Activity): [string, readonly InboundMention[]] {
  const event = eventOf(activity);
  const marked = markedText(event.text, event.mentions, {
    links: event.links,
    group: isGroup(activity),
    redact: mask,
  });
  return [marked.text, marked.mentions];
}

/** A logger that keeps every line, for what a test says is (and is not) logged. */
export function recordingLogger(): { logger: Logger; lines: [string, string, Json | undefined][] } {
  const lines: [string, string, Json | undefined][] = [];
  const logger: Logger = {
    debug: (m, f) => lines.push(["debug", m, f]),
    info: (m, f) => lines.push(["info", m, f]),
    warn: (m, f) => lines.push(["warn", m, f]),
    error: (m, f) => lines.push(["error", m, f]),
    child: () => logger,
  };
  return { logger, lines };
}
