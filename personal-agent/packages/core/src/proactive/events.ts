// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** What the delivery of unasked messages adds to Claw's events, and reads of them, shared by its modules. */
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
