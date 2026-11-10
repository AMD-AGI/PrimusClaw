// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { linkText, unlinkText } from "../locales/link.js";
import type { PendingRequest } from "../ports/store/onboarding.js";
import type { InboundAction } from "../ports/surface.js";
import type { Chat } from "./chat.js";
import type { RouterContext } from "./context.js";
import { CONFIRM_BUTTON } from "./views.js";

/** Runs a group request that waited for its asker to connect (`GroupRouter.resumeRequest`). */
export type ResumeRequest = (chat: Chat, pending: PendingRequest, announce: boolean) => Promise<boolean>;

/**
 * Connecting and disconnecting a chat (the Python `Agent._cmd_link`, `_cmd_unlink`, `_confirm_binding`). The `/link`
 * code is the proof that the same human holds the console session that minted it and this channel account; every
 * attempt goes through the store, which counts it against the limits and records it.
 */
export class LinkCommands {
  constructor(
    private readonly ctx: RouterContext,
    private readonly resume: ResumeRequest,
  ) {}

  async link(chat: Chat, code: string | null, messageId: string): Promise<void> {
    const { store } = this.ctx.deps;
    const outcome = store.links.redeemPending(chat.sender.id, chat.sender.name, code ?? "", messageId || undefined);
    const said = linkText.in("en");
    if (outcome === "ok") await this.linked(chat);
    else if (outcome === "limited") {
      const minutes = Math.max(1, Math.ceil(store.links.linkWindowSeconds / 60));
      await chat.say(said.tooManyWrong({ minutes }));
    } else if (outcome === "global_limit") await chat.say(said.linkingPaused);
    else await chat.say(said.badCode);
  }

  private async linked(chat: Chat): Promise<void> {
    const { store, subscriptions } = this.ctx.deps;
    const userId = chat.sender.id;
    const key = store.links.getKey(userId) ?? "";
    const clawUserId = key ? await this.ctx.owners.userIdOf(key) : undefined;
    if (clawUserId !== undefined) store.links.setClawUserId(userId, clawUserId);
    if (subscriptions !== undefined) await subscriptions.ensure(userId);
    const pending = store.onboarding.takePendingRequest(userId); // (a group request that waited for this link)
    const zh = chat.zh();
    const said = linkText.in(zh ? "zh" : "en");
    let who: string;
    if (zh) {
      const owner = key ? await this.ctx.owners.whoami(key) : undefined;
      who = owner === undefined ? "" : `到 SaFE 用户 ${owner[0]}` + (owner[1] ? `（${owner[1]}）` : "");
    } else {
      who = (await this.ctx.owners.whoLine(key)) ?? "";
    }
    await chat.say(said.linkedAs({ who }) + (pending === null ? said.getStarted : said.runningFromGroup));
    if (pending !== null) await this.resume(chat, pending, true);
  }

  async unlink(chat: Chat): Promise<void> {
    const { store, remote, assistant, subscriptions, keyRevoker } = this.ctx.deps;
    const userId = chat.sender.id;
    remote.forgetPerson(userId); // (nothing may keep reading a remote session with the key being deleted)
    assistant.forget(userId);
    const stored = store.links.getKey(userId);
    if (stored === null) {
      // only an exchanged token is in play: no key to delete, and only the person can remove the binding
      store.sessions.clearSession(userId);
      await chat.say(unlinkText.in("en").bindingOnly);
      return;
    }
    if (subscriptions !== undefined) await subscriptions.remove(userId, stored); // (Claw needs the key to delete it)
    const revoked = await keyRevoker.revoke(stored);
    store.links.unlink(userId);
    const stillBound = await this.stillBound(userId);
    const said = unlinkText.in(chat.lang());
    const tail = (revoked ? said.deleted : said.notDeleted) + (stillBound ? said.stillBound : "");
    await chat.say(said.unlinked({ tail }));
  }

  /** A chat that runs on the exchange stays connected through the person's binding, which only they can remove. */
  private async stillBound(userId: string): Promise<boolean> {
    if (!this.ctx.credentials.onExchange) return false;
    this.ctx.deps.exchange.invalidate(userId);
    return (await this.ctx.deps.exchange.tokenFor(userId)).ok;
  }

  /**
   * The person pressed the button that says they confirmed: the binding is looked for now. The worker cannot make it,
   * only the person can; not there yet, the card comes back with the link that is still open (or a new one).
   */
  async confirmBinding(action: InboundAction, chat: Chat): Promise<void> {
    const { exchange, store, logger } = this.ctx.deps;
    const said = linkText.in("en");
    exchange.invalidate(chat.sender.id);
    const token = await exchange.tokenFor(chat.sender.id);
    if (!token.ok && token.error.kind === "not_bound") {
      const card = await this.ctx.credentials.bindingCard(chat, said.notConfirmedYet);
      await this.ctx.settle(action, chat, card, { fallback: said.notConfirmedLine });
      return;
    }
    if (!token.ok) {
      logger.warn("token exchange failed", { kind: token.error.kind });
      const text = said.platformUnreachable;
      const card = this.ctx.views.note(`${text}${said.pressConfirmAgain}`, {
        buttons: [CONFIRM_BUTTON],
        title: said.connectTitle({ bot: this.ctx.deps.config.botName }),
      });
      await this.ctx.settle(action, chat, card, { fallback: text });
      return;
    }
    const pending = store.onboarding.takePendingRequest(chat.sender.id);
    await this.ctx.settle(action, chat, said.connected + (pending === null ? said.getStarted : said.runningFromGroup));
    if (pending !== null) await this.resume(chat, pending, true);
  }
}
