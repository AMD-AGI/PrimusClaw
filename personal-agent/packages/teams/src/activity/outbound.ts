// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Outbound activities and the envelopes they travel in. The envelope is the contract of the outbound queue (and what the
 * store keeps for a card sent later), byte for byte the Python worker's: keys in its order, values as it wrote them.
 */
import { pySplit, own } from "@primusclaw/personal-agent";

import { isObject, type JsonObject } from "../cards/json.js";
import type { Operation, TeamsEnvelope } from "../outbound/outbox.js";

export const TYPING: JsonObject = { type: "typing" };

/** The longest display name an @mention carries. */
const MENTION_NAME_MAX = 60;

/** A plain message (markdown). */
export function textActivity(text: string): JsonObject {
  return { type: "message", text, textFormat: "markdown" };
}

function copy(activity: JsonObject, key: string): JsonObject {
  const value = own(activity, key);
  return value === undefined ? {} : { [key]: value };
}

/** The conversation reference the outbound side (queue relay or Bot Connector) needs to post back into `activity`'s chat. */
export function referenceOf(activity: JsonObject): JsonObject {
  const ref: JsonObject = {
    serviceUrl: activity["serviceUrl"] ?? null,
    conversation: activity["conversation"] ?? null,
    bot: activity["recipient"] ?? null,
    user: activity["from"] ?? null,
    activityId: activity["id"] ?? null,
  };
  for (const optional of ["channelId", "locale"]) {
    if (own(activity, optional)) Object.assign(ref, copy(activity, optional));
  }
  return ref;
}

/**
 * A message activity in the conversation `reference` points at (the inverse of `referenceOf`), for work done for a person
 * without a message of theirs in hand. It carries no text.
 */
export function activityOfReference(reference: JsonObject, activityId: string): JsonObject {
  const activity: JsonObject = {
    type: "message",
    id: activityId,
    serviceUrl: reference["serviceUrl"] ?? null,
    conversation: reference["conversation"] ?? null,
    recipient: reference["bot"] ?? null,
    from: reference["user"] ?? null,
    text: "",
  };
  for (const optional of ["channelId", "locale"]) {
    if (own(reference, optional)) Object.assign(activity, copy(reference, optional));
  }
  return activity;
}

export interface EnvelopeOptions {
  readonly activityId?: string | undefined;
  readonly ack?: string | undefined;
}

/** One outbound envelope: `{operation, reference, activity, [activity_id], [ack]}`. */
export function envelope(
  operation: Operation,
  reference: JsonObject,
  activity: JsonObject,
  options: EnvelopeOptions = {},
): TeamsEnvelope {
  const body: TeamsEnvelope = { operation, reference, activity };
  if (options.activityId) body.activity_id = options.activityId;
  if (options.ack) body.ack = options.ack;
  return body;
}

/** Remove the message `activityId`. Every envelope carries an activity, so a delete carries an empty message. */
export function deleteEnvelope(reference: JsonObject, activityId: string): TeamsEnvelope {
  return { operation: "delete", reference, activity: { type: "message" }, activity_id: activityId };
}

/**
 * A copy of `activity` that starts by @mentioning this person (Teams notifies them): `<at>name</at>` in front of the text,
 * and the mention entity. The activity itself when the id or the name is missing.
 */
export function withMention(activity: JsonObject, teamsId: string, name: string): JsonObject {
  const shown = Array.from(pySplit(name.replace(/[<>]/g, " ")).join(" "))
    .slice(0, MENTION_NAME_MAX)
    .join("");
  if (!(teamsId && shown)) return activity;
  const tag = `<at>${shown}</at>`;
  const entities = Array.isArray(activity["entities"]) ? activity["entities"].filter(isObject) : [];
  const text = typeof activity["text"] === "string" ? activity["text"] : "";
  return {
    ...activity,
    text: `${tag} ${text}`,
    entities: [...entities, { type: "mention", text: tag, mentioned: { id: teamsId, name: shown } }],
  };
}
