// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { ClawError, ClawUnreachable } from "../claw/errors.js";
import { sessionText } from "../locales/sessions.js";
import type { InboundAction } from "../ports/surface.js";
import { answerParts, deepLink } from "../turn/answer-parts.js";
import type { Chat } from "./chat.js";
import type { RouterContext } from "./context.js";
import { showButton } from "./views.js";

/**
 * A press on "Show here" (1:1 chat only; Python agent.py `_show`): that session's last answer is posted in the chat and the
 * session becomes the chat's current one. The card is not trusted: the session is read with the PRESSER's own credential,
 * and Claw refuses a session that is not theirs, so nothing is posted and nothing is switched then. The card is replaced on
 * every outcome; where pressing again can help it comes back with its button.
 */
export class ShowHere {
  constructor(private readonly ctx: RouterContext) {}

  async click(action: InboundAction, chat: Chat, key: string): Promise<void> {
    const said = sessionText.in("en"); // (the Python worker says these in English whatever the chat's language)
    const raw = action.data["session_id"];
    const sessionId = typeof raw === "string" ? raw : typeof raw === "number" ? String(raw) : "";
    const again = (text: string): Promise<unknown> =>
      this.ctx.settle(action, chat, this.ctx.views.note(text, { buttons: [showButton(sessionId)] }), {
        fallback: text,
      });
    if (!sessionId) {
      await this.ctx.settle(action, chat, said.showGone);
      return;
    }
    if (this.ctx.hasTurn(chat.sender.id)) {
      await again(said.showBusy);
      return;
    }
    const answer = await this.read(action, chat, key, sessionId, again);
    if (answer === null) return;
    if (answer === undefined) {
      await again(said.showNoAnswer);
      return;
    }
    this.switchTo(chat.sender.id, sessionId);
    // (the lead goes before the first part once the answer is split, as the Python worker does it)
    const [first = "", ...rest] = answerParts(answer, deepLink(this.ctx.deps.config.publicBaseUrl, sessionId));
    for (const part of [`${said.showLead}\n\n${first}`, ...rest]) await chat.sayRich(part);
    await this.ctx.settle(action, chat, said.showDone, { announce: false }); // (the answer, just posted, is the outcome)
  }

  /** The session's last answer (undefined: none finished); null when it could not be read (the card was replaced). */
  private async read(
    action: InboundAction,
    chat: Chat,
    key: string,
    sessionId: string,
    again: (text: string) => Promise<unknown>,
  ): Promise<string | undefined | null> {
    const said = sessionText.in("en");
    try {
      return await this.ctx.deps.turns.lastAnswer(key, sessionId);
    } catch (error) {
      if (error instanceof ClawError && [401, 403, 404].includes(error.status)) {
        // gone, or never this person's: /sessions stops offering it
        if (error.status !== 401) this.ctx.deps.store.repoHistory.forgetSession(chat.sender.id, sessionId);
        await this.ctx.settle(action, chat, said.showRefused);
      } else if (error instanceof ClawError) await again(said.showFailed({ status: error.status }));
      else if (error instanceof ClawUnreachable) await again(said.showUnreachable);
      else throw error;
      return null;
    }
  }

  /** The chat has this session again, and no repository waits for a new one. */
  private switchTo(userId: string, sessionId: string): void {
    const { store, config } = this.ctx.deps;
    store.sessions.setSession(userId, { sessionId, model: "", pluginId: config.pluginId });
    store.repoHistory.noteSession(userId, sessionId);
    store.repoHistory.clearPendingRepo(userId);
  }
}
