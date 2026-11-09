// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * An inbound Teams activity as core's `InboundEvent`: validated, then read into a message (the person's words, who
 * they mention, the links behind the words, the messages they quote) or a card press. Everything else Teams delivers
 * (typing, installs, conversation updates) is not an event core acts on.
 */
import { voteOf } from "../../feedback/vote.js";
import { inboundFiles } from "../../inbound/attachments.js";
import {
  err,
  ok,
  pyStr,
  silentLogger,
  type ConversationRef,
  type InboundAction,
  type InboundMessage,
  type InboundVote,
  type InvalidInput,
  type Logger,
  type Result,
  type UserRef,
} from "@primusclaw/personal-agent";
import { cardDataOf, cardKindOf, cardVerb, isCardClick } from "./actions.js";
import { clientPlatform, conversationId, conversationKind, isPersonal, senderOf, tenantOf } from "./identity.js";
import { inboundLinksOf } from "./links.js";
import { addressedToBot, DEFAULT_BOT_NAME, isMentioned, isTargeted, mentionsOf, messageText } from "./mentions.js";
import { isBotQuote, logPlaceholderQuotes, quotesOf } from "./quotes.js";
import { parseActivity, partOf, truthy, type Activity } from "./schema.js";

/** The events a Teams activity can be. */
export type TeamsInboundEvent = InboundMessage | InboundAction | InboundVote;

/** The activity has no Entra identity behind it: nobody to act for. */
export interface NoSender {
  readonly kind: "no_sender";
}

export interface ToEventOptions {
  /** The bot's display name, for "@<name> ..." (default "Clawy"). */
  readonly botName?: string;
  readonly logger?: Logger;
}

/**
 * The conversation reference the outbound side posts back with (the Python worker's `reference_of`), keys in its
 * order; a field the activity lacks is null, as Python stored it. Stored for proactive messages, so it stays
 * byte-for-byte what the Python worker stored.
 */
export function wireReferenceOf(activity: Activity): Record<string, unknown> {
  const ref: Record<string, unknown> = {
    serviceUrl: activity.serviceUrl ?? null,
    conversation: activity.conversation ?? null,
    bot: activity.recipient ?? null,
    user: activity.from ?? null,
    activityId: activity.id ?? null,
  };
  if (truthy(activity.channelId)) ref["channelId"] = activity.channelId;
  if (truthy(activity.locale)) ref["locale"] = activity.locale;
  return ref;
}

function conversationRefOf(activity: Activity): ConversationRef {
  return {
    id: conversationId(activity),
    kind: conversationKind(activity),
    tenantId: tenantOf(activity),
    wire: wireReferenceOf(activity),
  };
}

type Base = Pick<InboundMessage, "id" | "sender" | "conversation" | "locale" | "clientPlatform">;

function base(activity: Activity, sender: UserRef): Base {
  return {
    id: pyStr(activity.id),
    sender,
    conversation: conversationRefOf(activity),
    locale: pyStr(activity.locale),
    clientPlatform: clientPlatform(activity),
  };
}

function messageOf(activity: Activity, sender: UserRef, options: ToEventOptions): InboundMessage {
  const logger = options.logger ?? silentLogger;
  const personal = isPersonal(activity);
  const found = quotesOf(activity);
  const attached = inboundFiles(activity);
  logPlaceholderQuotes(activity, found, logger);
  const bot = partOf(activity, "recipient");
  return {
    type: "message",
    ...base(activity, sender),
    text: messageText(activity),
    mentioned: isMentioned(activity),
    targeted: isTargeted(activity),
    namesBotFirst: addressedToBot(activity, options.botName ?? DEFAULT_BOT_NAME),
    conversationName: personal ? "" : pyStr(partOf(activity, "conversation")["name"]),
    mentions: mentionsOf(activity),
    links: inboundLinksOf(activity),
    quotes: found.map((q) => ({
      author: q.sender,
      text: q.text,
      fromBot: isBotQuote(q, bot),
      sentAt: q.time,
      messageId: q.messageId,
      deleted: q.deleted,
      source: q.source,
    })),
    files: attached.files,
    unreadableFiles: attached.unreadable,
    provenance: "typed",
  };
}

function actionOf(activity: Activity, sender: UserRef): InboundAction {
  return {
    type: "action",
    ...base(activity, sender),
    verb: cardKindOf(activity),
    data: cardDataOf(activity) ?? {},
    cardMessageId: pyStr(activity.replyToId),
    invoke: isCardClick(activity),
    clickVerb: cardVerb(activity),
  };
}

/**
 * What core acts on in `raw`: a message, a card press, or undefined for an activity that is neither. Refused when
 * `raw` is not an activity, or when no Entra identity is behind it.
 */
export function toInboundEvent(
  raw: unknown,
  options: ToEventOptions = {},
): Result<TeamsInboundEvent | undefined, InvalidInput | NoSender> {
  const parsed = parseActivity(raw);
  if (!parsed.ok) return parsed;
  const activity = parsed.value;
  const who = senderOf(activity);
  if (who === undefined) return err({ kind: "no_sender" });
  const sender: UserRef = {
    id: who.aadId,
    channelUserId: pyStr(partOf(activity, "from")["id"]),
    name: who.name,
    email: who.email,
  };
  if (isCardClick(activity) || (activity.type === "message" && cardKindOf(activity))) {
    return ok(actionOf(activity, sender));
  }
  const vote = voteOf(activity);
  if (vote !== undefined) {
    // (the answer the thumb is on: Teams names it as the invoke's replyToId; anything but a string names none, as in
    // Python's voted_message_id)
    const replyTo = activity["replyToId"];
    const messageId = typeof replyTo === "string" ? replyTo : "";
    return ok({ type: "vote", ...base(activity, sender), messageId, ...vote });
  }
  return ok(activity.type === "message" ? messageOf(activity, sender, options) : undefined);
}
