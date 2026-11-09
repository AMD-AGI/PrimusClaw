// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { errorName } from "../errors.js";
import type { InboundMessage } from "../ports/surface.js";
import type { Chat } from "./chat.js";
import type { RouterContext } from "./context.js";
import type { OnSent, RemoteTurn } from "./features.js";
import { isMobile, offerStopCard } from "./turn-start.js";

/** How often Claw is asked whether the assistant's turn answering a phone's message still runs. */
export const ASSISTANT_TURN_POLL_SECONDS = 3;
/** Claw not read this many times in a row: the card goes. */
export const ASSISTANT_TURN_POLL_MISSES = 6;

/**
 * The Stop cards of the turns a phone's message starts on the assistant and on an attached agent (the Python
 * `Agent._assistant_stop_offer`, `_assistant_turn_over`, `_offer_remote_stop`); a session turn's is offered where it
 * starts (`TurnStarter`).
 */
export class StopOffers {
  constructor(private readonly ctx: RouterContext) {}

  /**
   * What the assistant is told to call once Claw took a phone's message: the card for the turn that answers it, while that
   * turn runs (Claw says which message its session's turn is for). A message Claw queued (no id yet) gets none.
   */
  assistant(message: InboundMessage, chat: Chat, key: string): OnSent | undefined {
    if (!isMobile(message.clientPlatform)) return undefined;
    return (sessionId, messageId) => {
      if (!messageId) return;
      const { assistant } = this.ctx.deps;
      offerStopCard(this.ctx, chat, {
        kind: "assistant",
        alive: (credential) => this.answering(credential, sessionId, messageId),
        ended: this.assistantTurnOver(key, sessionId, messageId),
        stop: (at, credential) => assistant.stop(at.sender.id, credential, at.conversation, messageId),
      });
    };
  }

  private async answering(credential: string, sessionId: string, messageId: string): Promise<boolean> {
    const turn = await this.ctx.deps.claw.sessions.turn(credential, sessionId);
    return turn.running && turn.messageId === messageId;
  }

  /**
   * Settles once Claw no longer runs the assistant's turn for `messageId` (it ended, or another message's turn runs), read
   * every ASSISTANT_TURN_POLL_SECONDS; or once Claw could not be read that many times in a row (the card then goes).
   */
  async assistantTurnOver(key: string, sessionId: string, messageId: string): Promise<void> {
    let misses = 0;
    while (misses < ASSISTANT_TURN_POLL_MISSES) {
      await this.ctx.deps.clock.sleep(ASSISTANT_TURN_POLL_SECONDS * 1000);
      try {
        if (!(await this.answering(key, sessionId, messageId))) return;
        misses = 0;
      } catch (error) {
        misses += 1;
        this.ctx.deps.logger.info("whether the assistant's turn still runs could not be read", {
          error: errorName(error),
        });
      }
    }
  }

  /**
   * After a phone's message went to the agent session the chat is attached to: the card for the turn it started, if it
   * started one (a refused message starts none) and the chat itself is the window (the session card has a Stop of its own).
   */
  remote(message: InboundMessage, chat: Chat, before: RemoteTurn | undefined): void {
    const { remote } = this.ctx.deps;
    const userId = chat.sender.id;
    const turn = remote.currentTurn?.(userId);
    if (
      turn === undefined ||
      turn === before ||
      remote.windowed?.(userId) !== false ||
      !isMobile(message.clientPlatform)
    )
      return;
    let over = false;
    void turn.ended.then(
      () => (over = true),
      () => (over = true),
    );
    offerStopCard(this.ctx, chat, {
      kind: "remote",
      alive: () => Promise.resolve(!over && remote.currentTurn?.(userId) === turn),
      ended: turn.ended,
      stop: (at, credential) => remote.stop(at.sender, credential, at.conversation, turn),
    });
  }
}
