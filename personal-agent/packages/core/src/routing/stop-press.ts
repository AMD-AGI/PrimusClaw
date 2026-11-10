// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { errorName } from "../errors.js";
import { routingText } from "../locales/routing.js";
import type { InboundAction } from "../ports/surface.js";
import type { Chat } from "./chat.js";
import type { RouterContext } from "./context.js";

/**
 * A press on a Stop card sent before the worker stopped sending them (the Python `Agent._turn_stop_click`, `_drop_tapped`,
 * after internal #481: a turn from a phone is stopped by saying 停止 or /stop, and no card is offered any more). Such a card
 * names no turn this worker runs, so the press stops nothing and says so; the pressed card is deleted, never edited (a phone
 * does not redraw an edit), and where it cannot be deleted it is closed to a line.
 */
export class StopPress {
  constructor(private readonly ctx: RouterContext) {}

  async press(action: InboundAction, chat: Chat): Promise<void> {
    const said = routingText.in(chat.lang());
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
