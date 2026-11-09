// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the turn engine needs from the world: the calls of the ports other lines own that it makes (W0: Conversation,
 * Clock; W2: the Claw sessions port). Nothing here knows Teams, HTTP or a card's JSON.
 */

import type { Clock } from "../ports/clock.js";
import type { ClawSessionsPort } from "../ports/claw/sessions.js";
import type { Conversation, OutMessage } from "../ports/surface.js";

/** Monotonic seconds of `clock`: the unit the turn's intervals are written in. */
export function nowSeconds(clock: Clock): number {
  return clock.monotonicMs() / 1000;
}

/** Sleep `seconds` of `clock`; rejects with the signal's reason when it is aborted. */
export function sleepSeconds(clock: Clock, seconds: number, signal?: AbortSignal): Promise<void> {
  return clock.sleep(seconds * 1000, signal);
}

/**
 * The conversation the turn answers in: the calls of the Conversation port it makes. INTERIM (until W0-b adds it to the
 * port): `update` may be given the signal of the edit's sender, and an edit whose sender is cancelled before the channel
 * took it is withdrawn (a cancelled turn's last progress edit never lands after it). A Conversation without the option
 * fits this type and sends such an edit anyway.
 */
export type TurnSurface = Pick<
  Conversation,
  "typing" | "send" | "post" | "delete" | "openStream" | "outgoing" | "deliver"
> & {
  update(id: string, message: OutMessage, options?: { readonly signal?: AbortSignal }): Promise<void>;
};

/** The calls of Claw's sessions port a turn makes. */
export type TurnClaw = Pick<
  ClawSessionsPort,
  | "create"
  | "sendMessage"
  | "setModel"
  | "lastEventId"
  | "turn"
  | "stream"
  | "uploadFiles"
  | "events"
  | "deliveryLink"
  | "changes"
>;
