// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The assistant's messages this process sent lately that a later one may add to (`amends`) or take the place of (`replaces`):
 * event id -> (the channel's message id, the event). In memory: after a restart an addition is sent as a message of its own.
 * Shared by every delivery path of one process (teams_agent/proactive.py `_SAID`).
 */
import type { JsonObject } from "../json.js";
import type { MessageId } from "../ports/surface.js";

export const SAID_MAX = 512;

export interface SaidMessage {
  readonly messageId: MessageId;
  readonly event: JsonObject;
}

export class SaidMessages {
  private readonly said = new Map<string, SaidMessage>();

  constructor(private readonly max = SAID_MAX) {}

  get(eventId: string): SaidMessage | undefined {
    return this.said.get(eventId);
  }

  /** Remember an `assistant.say` sent as `messageId` (nothing for another event, one without an id, or no message id). */
  remember(event: JsonObject, messageId: MessageId | undefined): void {
    const eventId = event["event_id"];
    if (event["type"] !== "assistant.say" || typeof eventId !== "string" || !eventId || !messageId) return;
    this.set(eventId, { messageId, event });
  }

  set(eventId: string, said: SaidMessage): void {
    this.said.delete(eventId);
    this.said.set(eventId, said);
    while (this.said.size > this.max) {
      const oldest = this.said.keys().next();
      if (oldest.done === true) break;
      this.said.delete(oldest.value);
    }
  }
}
