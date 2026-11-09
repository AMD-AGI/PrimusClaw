// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the turn engine needs from the world: the calls of the ports other lines own that it makes (W0: Conversation,
 * Clock; W2: the Claw sessions port). Nothing here knows Teams, HTTP or a card's JSON.
 */

import type { Clock } from "../ports/clock.js";
import type { ClawSessionsPort } from "../ports/claw/sessions.js";
import type { Conversation } from "../ports/surface.js";

/** Monotonic seconds of `clock`: the unit the turn's intervals are written in. */
export function nowSeconds(clock: Clock): number {
  return clock.monotonicMs() / 1000;
}

/** Sleep `seconds` of `clock`; rejects with the signal's reason when it is aborted. */
export function sleepSeconds(clock: Clock, seconds: number, signal?: AbortSignal): Promise<void> {
  return clock.sleep(seconds * 1000, signal);
}

/** The conversation the turn answers in: the calls of the Conversation port it makes. */
export type TurnSurface = Pick<
  Conversation,
  "typing" | "send" | "post" | "update" | "delete" | "openStream" | "outgoing" | "deliver"
>;

/** The calls of Claw's sessions port a turn makes. */
export type TurnClaw = Pick<
  ClawSessionsPort,
  "create" | "sendMessage" | "setModel" | "lastEventId" | "turn" | "stream" | "uploadFiles" | "events" | "deliveryLink" | "changes"
>;
