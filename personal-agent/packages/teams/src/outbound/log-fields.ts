// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What an outbound log line says about where an envelope goes and what it is, so that a delivery can be traced to its
 * conversation: the target conversation's id (`conversation`, from the envelope's reference, the id the Bot Connector
 * posts to; "-" when the reference has none) and what kind of activity it is (`content`: "card" for a message carrying
 * a card attachment, else the activity's type, such as "message" or "typing"; "-" when it has none). Ids and kinds
 * only: never the text, a name or any other identity of a person.
 */
import { isObject, type JsonObject } from "../cards/json.js";

/** The prefix of every Bot Framework card content type (adaptive, hero, thumbnail, sign-in, ...). */
const CARD_CONTENT_TYPE = "application/vnd.microsoft.card.";

export interface OutboundLogFields {
  readonly conversation: string;
  readonly content: string;
}

/** The target conversation's id and the activity's kind, for an outbound log line. */
export function outboundLogFields(envelope: JsonObject): OutboundLogFields {
  const reference = envelope["reference"];
  const conversation = isObject(reference) ? reference["conversation"] : undefined;
  const id = isObject(conversation) ? conversation["id"] : undefined;
  const activity = envelope["activity"];
  return {
    conversation: typeof id === "string" && id !== "" ? id : "-",
    content: isObject(activity) ? contentOf(activity) : "-",
  };
}

function contentOf(activity: JsonObject): string {
  const type = typeof activity["type"] === "string" && activity["type"] !== "" ? activity["type"] : "-";
  return type === "message" && hasCard(activity) ? "card" : type;
}

function hasCard(activity: JsonObject): boolean {
  const attachments = activity["attachments"];
  if (!Array.isArray(attachments)) return false;
  return attachments.some((attachment) => {
    const contentType = isObject(attachment) ? attachment["contentType"] : undefined;
    return typeof contentType === "string" && contentType.startsWith(CARD_CONTENT_TYPE);
  });
}
