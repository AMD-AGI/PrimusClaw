// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The activities of a Teams stream (Bot Framework REST "Stream agent messages"): its numbered requests and its final message. */
import { isObject, type JsonObject } from "../cards/json.js";

export const STREAM_ENTITY_TYPE = "streaminfo";

export type StreamKind = "informative" | "streaming";

/**
 * One request of a Teams stream: an informative update or the streamed text so far, a typing activity in reply to the
 * person's message, numbered; the first has no stream id yet.
 */
export function streamActivity(
  kind: StreamKind,
  text: string,
  replyTo: string,
  sequence: number,
  streamId = "",
): JsonObject {
  const info: JsonObject = { type: STREAM_ENTITY_TYPE, streamType: kind, streamSequence: sequence };
  if (streamId) info["streamId"] = streamId;
  return { type: "typing", text, replyToId: replyTo, entities: [info] };
}

/**
 * `activity` (a message) as the request that closes the stream `streamId`: the final message, which Teams keeps. Its
 * stream entity goes first, without a sequence number; the activity's own entities (the root entity) follow.
 */
export function streamFinal(activity: JsonObject, replyTo: string, streamId: string): JsonObject {
  const own = Array.isArray(activity["entities"]) ? activity["entities"] : [];
  const entities = own.filter((e) => !(isObject(e) && e["type"] === STREAM_ENTITY_TYPE));
  const final: JsonObject = { type: STREAM_ENTITY_TYPE, streamType: "final", streamId };
  return { ...activity, type: "message", replyToId: replyTo, entities: [final, ...entities] };
}

/** The stream entity of an activity, if it has one (what a recording connector reads to apply Teams' stream rules). */
export function streamInfo(activity: JsonObject): JsonObject | undefined {
  const entities = Array.isArray(activity["entities"]) ? activity["entities"] : [];
  return entities.filter(isObject).find((e) => e["type"] === STREAM_ENTITY_TYPE);
}
