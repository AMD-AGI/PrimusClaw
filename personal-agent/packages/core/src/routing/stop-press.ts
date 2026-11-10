// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { errorName } from "../errors.js";
import { routingText } from "../locales/routing.js";
import type { InboundAction } from "../ports/surface.js";
import type { Chat } from "./chat.js";
import type { RouterContext } from "./context.js";

/**
 * A press on the Stop card of a turn from Teams mobile (the Python `Agent._turn_stop_click`, `_drop_tapped`). The turn it
 * was sent for is stopped as /stop stops it, only while that very turn still runs; otherwise nothing is stopped and the
 * person is told. The pressed card is deleted, never edited (a phone does not redraw an edit), and the outcome is said as a
 * new message; where it cannot be deleted it is closed to a line.
 */
export class StopPress {
  constructor(private readonly ctx: RouterContext) {}

  async press(action: InboundAction, chat: Chat, key: string): Promise<void> {
    const token = typeof action.data["turn"] === "string" ? action.data["turn"] : "";
    const offer = this.ctx.deps.stopCards.get(token, chat.sender.id);
    if (offer !== undefined && offer.cardId === action.cardMessageId) offer.cardId = undefined; // (gone with the press)
    let stopped = false;
    if (offer !== undefined && !offer.used) {
      // the stop of the card's kind, for that turn only: it checks the turn with no wait before it stops anything, so a turn
      // that ended meanwhile (and the next one, which may already run) is never stopped; it says its own outcome
      const stop = this.ctx.stoppers.get(offer);
      stopped = stop === undefined ? false : await stop(chat, key);
      offer.used = stopped;
    }
    const said = routingText.in(chat.lang());
    if (stopped) {
      this.ctx.deps.logger.info("the Stop card of a turn was pressed", { kind: offer?.kind });
      await this.dropTapped(action, chat, said.stopPressed);
      return;
    }
    await this.dropTapped(action, chat, said.stopTurnOver);
    await chat.say(said.stopTurnOver);
  }

  /**
   * Take a pressed card away: deleted (settled, so the safety net leaves it alone); where the channel refuses the delete,
   * closed to `line`, except in a chat that is an agent's window, where nothing is edited and the card is left as it is.
   */
  private async dropTapped(action: InboundAction, chat: Chat, line: string): Promise<void> {
    const tapped = action.cardMessageId;
    if (!tapped) return;
    chat.conversation.markSettled(tapped);
    let reason: string;
    try {
      const deleted = await chat.conversation.delete(tapped);
      if (deleted.ok) return;
      reason = deleted.error.kind;
    } catch (error) {
      reason = errorName(error);
    }
    if (this.ctx.deps.remote.direct(chat.sender.id)) {
      this.ctx.deps.logger.info("a pressed Stop card could not be deleted; left as it is in an agent's window", {
        reason,
      });
      return;
    }
    this.ctx.deps.logger.info("a pressed Stop card could not be deleted; closing it to a line", { reason });
    await this.ctx.settle(action, chat, line, { announce: false });
  }
}
