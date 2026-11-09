// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What was held, sent when the person can be reached again, and approval cards recorded and never sent (teams_agent/proactive.py
 * `release_due`, `release`, `resend_unsent_approvals`). Held notices go as one digest card (one alone goes as itself), held
 * approvals still in time as live cards, the assistant's messages and a remote agent's one by one (the newest few).
 */
import { errorName } from "../errors.js";
import type { JsonObject } from "../json.js";
import { proactiveLines } from "../locales/proactive-lines.js";
import type { Conversation } from "../ports/surface.js";
import { ASSISTANT_SAID_TYPES } from "../subscriptions/event-types.js";
import type { ProactiveDeps } from "./deps.js";
import { EXPIRES_KEY, REMOTE_SAID } from "./events.js";
import type { Proactive } from "./proactive.js";

/** Held assistant messages sent one by one when the person can be reached; the older ones are one line. */
export const ASSISTANT_RELEASE_MAX = 10;
/** Held remote agent messages sent one by one; the older ones are one line. */
export const REMOTE_RELEASE_MAX = 5;

interface Sorted {
  readonly said: JsonObject[];
  readonly remote: JsonObject[];
  readonly live: JsonObject[];
  readonly expired: number;
  readonly notices: JsonObject[];
}

export class Release {
  constructor(
    private readonly deps: ProactiveDeps,
    private readonly proactive: Proactive,
  ) {}

  /** Deliver what was held for every person who may be reached now. Run on a timer; one person's failure does not stop the rest. */
  async releaseDue(): Promise<void> {
    for (const userId of this.deps.store.held.usersWithHeld()) {
      if (this.proactive.muted(userId) !== undefined) continue;
      try {
        await this.release(userId);
      } catch (error) {
        this.deps.logger.error("releasing held notices failed", { error: errorName(error) });
      }
    }
  }

  /** Send what was held for this person; on a failure everything is held again for the next sweep, and the error goes on. */
  async release(userId: string): Promise<void> {
    const { store } = this.deps;
    const reference = store.references.getReference(userId);
    const events = store.held.takeHeld(userId);
    if (!events.length || reference === null) return; // (nobody to send to: unlinked, or never chatted)
    const sorted = this.sort(events);
    try {
      await this.sendAll(userId, reference, sorted);
    } catch (error) {
      for (const event of events) store.held.holdEvent(userId, event);
      throw error;
    }
  }

  private sort(events: readonly JsonObject[]): Sorted {
    const now = this.deps.store.now();
    const said = events.filter((e) => typeof e["type"] === "string" && ASSISTANT_SAID_TYPES.includes(e["type"]));
    const remote = events.filter((e) => e["type"] === REMOTE_SAID);
    const others = events.filter((e) => !said.includes(e) && !remote.includes(e));
    const approvals = others.filter((e) => e["type"] === "approval.requested");
    return {
      said,
      remote,
      live: approvals.filter((e) => Number(e[EXPIRES_KEY]) > now),
      expired: approvals.filter((e) => Number(e[EXPIRES_KEY]) <= now).length,
      // (answered in the chat while it was held: not shown again)
      notices: others.filter(
        (e) => e["type"] !== "approval.requested" && this.proactive.answeredInChat(e, now) !== "delivered",
      ),
    };
  }

  private async sendAll(userId: string, reference: JsonObject, sorted: Sorted): Promise<void> {
    const { deliveries } = this.proactive;
    const conversation = this.deps.conversationFor(reference);
    const lines = proactiveLines.in("en");
    const [only] = sorted.notices;
    if (sorted.notices.length === 1 && only !== undefined && !sorted.expired) {
      await deliveries.send(userId, reference, only);
    } else if (sorted.notices.length || sorted.expired) {
      await this.digest(conversation, sorted);
    }
    for (const event of sorted.live) await deliveries.send(userId, reference, event);
    if (sorted.said.length > ASSISTANT_RELEASE_MAX) {
      await say(conversation, lines.olderSaid({ n: sorted.said.length - ASSISTANT_RELEASE_MAX }));
    }
    for (const event of sorted.said.slice(-ASSISTANT_RELEASE_MAX)) await deliveries.send(userId, reference, event);
    if (sorted.remote.length > REMOTE_RELEASE_MAX) {
      await say(conversation, lines.olderRemote({ n: sorted.remote.length - REMOTE_RELEASE_MAX }));
    }
    for (const event of sorted.remote.slice(-REMOTE_RELEASE_MAX)) await deliveries.send(userId, reference, event);
  }

  private async digest(conversation: Conversation, sorted: Sorted): Promise<void> {
    const events = sorted.notices.map((e) => this.deps.publicEvent(this.proactive.deliveries.namedByPrompt(e)));
    const model = { events, expiredApprovals: sorted.expired, publicBaseUrl: this.deps.publicBaseUrl };
    await conversation.send({ body: { type: "view", view: { name: "digest", model }, fallbackText: "" } });
  }

  /**
   * Send again every approval card that was recorded and never reached the chat (its worker died between recording it and the
   * send). Quiet hours do not apply: a card is recorded only once it was due. At least once: a second copy is answered "already
   * answered". Returns how many were sent.
   */
  async resendUnsentApprovals(): Promise<number> {
    const { store, logger } = this.deps;
    let sent = 0;
    for (const card of store.approvals.claimUnsentApprovals()) {
      logger.info("sending an approval card again: it was recorded and never sent", {
        session: card.sessionId,
        toolUse: card.toolUseId,
      });
      const reference = store.references.getReference(card.userId);
      try {
        if (reference === null) throw new Error("no conversation to send to");
        await this.deps.conversationFor(reference).deliver(card.envelope);
      } catch (error) {
        store.approvals.approvalSendFailed(card.sessionId, card.toolUseId); // (recorded, unsent: the next sweep tries again)
        logger.warn("sending an approval card again failed; the next sweep tries again", { error: errorName(error) });
        continue;
      }
      store.approvals.approvalSent(card.sessionId, card.toolUseId);
      sent += 1;
    }
    return sent;
  }
}

function say(conversation: Conversation, text: string): Promise<void> {
  return conversation.send({ body: { type: "text", text } });
}
