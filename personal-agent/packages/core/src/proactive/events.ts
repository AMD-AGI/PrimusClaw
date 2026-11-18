// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** What the delivery of unasked messages adds to Claw's events, and reads of them, shared by its modules. */
import { sha256Hex } from "../guardrails/sha256.js";
import type { JsonObject } from "../json.js";
import { isoSeconds } from "./quiet.js";

/** Epoch seconds, added by this worker to a held approval event. */
export const EXPIRES_KEY = "_expires_at";
/** What a remote agent said on its own, held: not a Claw notification, made by this worker. */
export const REMOTE_SAID = "remote.said";

/** When the event's run finished (`occurred_at` with an offset), else `now`. */
export function finishedAt(event: JsonObject, now: number): number {
  return isoSeconds(event["occurred_at"]) ?? now;
}

/** Whether this worker's own turn answered the run in the chat ("lost": a turn of an earlier process died answering it). */
export type AnsweredInChat = "delivered" | "running" | "lost" | null;

/**
 * The id Claw gives its own "on it" line for the turn answering the person's message `messageId` ("收到，我看一下。", said by the
 * server when the turn has said nothing by a deadline or starts a slow lookup): Claw's `lookupAckSayId`, a deterministic event id
 * (`deterministicEventId("assistant.notice", <Claw user id>, "lookup_ack:<message id>")`, sha256 shaped as a uuid). The line carries
 * no field of its own that says what it is; its id does.
 */
export function turnAckId(clawUserId: string, messageId: string): string {
  const h = sha256Hex(`assistant.notice\u0000${clawUserId}\u0000lookup_ack:${messageId}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** The turn whose "on it" line `event` is (`turnAckId`), or "" when it is not one. */
export function turnAckOf(event: JsonObject): string {
  const turn = event["turn_message_id"];
  const user = event["user_id"];
  const id = event["event_id"];
  if (event["type"] !== "assistant.say" || typeof turn !== "string" || !turn || typeof user !== "string" || !user)
    return "";
  return id === turnAckId(user, turn) ? turn : "";
}
