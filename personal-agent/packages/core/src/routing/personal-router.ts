// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { switchCommand } from "../capabilities/sessions-words.js";
import { isKnownCommand } from "../commands/names.js";
import { exactCommand } from "../understanding/commands.js";
import { commandArgs, menuCommand, parseLinkCode } from "../commands/parse.js";
import type { JsonObject } from "../json.js";
import { routingText } from "../locales/routing.js";
import type { ClickHandler, MessageRoute } from "../ports/routing.js";
import type { InboundAction, InboundMessage } from "../ports/surface.js";
import { pyLower, pySplit } from "../text/py-text.js";
import { learnLang, type Chat } from "./chat.js";
import type { CommandSets } from "./command-table.js";
import type { RouterContext } from "./context.js";
import type { PersonalText } from "./personal-text.js";

/** The router's own buttons in a 1:1 chat (its feature handlers' come from the assembly). */
const OWN_VERBS = ["bind", "repo", "create_pr"] as const;

/**
 * A 1:1 chat (the Python `Agent._dispatch` from the personal-chat check on): what needs no account first (`/link`, the
 * language, a review request, feedback, a click that answers as the person's identity), then the person's credential, then
 * their commands, their buttons, and the message on its way.
 */
export class PersonalRouter {
  constructor(
    private readonly ctx: RouterContext,
    private readonly sets: CommandSets,
    private readonly text: PersonalText,
  ) {}

  async route(event: InboundMessage | InboundAction, chat: Chat): Promise<void> {
    const { store, subscriptions } = this.ctx.deps;
    const userId = chat.sender.id;
    store.references.saveReference(userId, wireOf(event)); // (serviceUrl can change: refreshed every time)
    if (event.type === "action" && event.invoke) store.members.notePersonalClick(userId); // (the app is installed for them)
    await this.backfill(userId);
    if (subscriptions !== undefined && store.links.getKey(userId) !== null) await subscriptions.ensure(userId);
    if (event.type === "message") await this.message(event, chat);
    else await this.click(event, chat);
  }

  /** Linked before the Claw user id was kept: it is read now. */
  private async backfill(userId: string): Promise<void> {
    const { links } = this.ctx.deps.store;
    if (!links.needsClawUserId(userId)) return;
    const key = links.getKey(userId);
    const clawUserId = key === null ? undefined : await this.ctx.owners.userIdOf(key);
    if (clawUserId !== undefined) links.setClawUserId(userId, clawUserId);
  }

  private async message(message: InboundMessage, chat: Chat): Promise<void> {
    const { assistant, remote } = this.ctx.deps;
    const userId = chat.sender.id;
    // The assistant understands this person's messages: only an exact command is read here
    const understood = assistant.understands(userId);
    const switching = understood && remote.enabled && switchCommand(message.text) !== null;
    const forAssistant = understood && !exactCommand(message.text, { menuCommand, isKnownCommand }) && !switching;
    const text = understood ? menuCommand(message.text) : this.text.textOf(message);
    learnLang(this.ctx.deps.store, userId, message.text);
    if (await this.beforeCredential(message, chat, text, forAssistant)) return;
    const key = await this.ctx.credentials.credential(chat, true);
    if (key === undefined) return;
    if (forAssistant && !this.text.talksToAgent(message)) await this.text.understand(message, chat, key);
    else await this.text.onText(message, chat, key);
  }

  /** What a 1:1 message can do with no account: true when it was taken. */
  private async beforeCredential(
    message: InboundMessage,
    chat: Chat,
    text: string,
    forAssistant: boolean,
  ): Promise<boolean> {
    const [first] = pySplit(text);
    if (first !== undefined && pyLower(first) === "/link") {
      await this.sets.link.link(chat, parseLinkCode(text), message.id);
      return true;
    }
    for (const handler of this.ctx.deps.handlers.commands) {
      const args = handler.beforeCredential === true ? commandArgs(text, handler.name) : null;
      const route = {
        sender: chat.sender,
        conversation: chat.conversation,
        scope: "",
        lang: () => chat.lang(),
        credential: "",
        message,
      };
      if (args !== null && (await handler.run(route, args))) return true;
    }
    const lang = commandArgs(text, "lang");
    if (lang !== null) {
      await this.sets.account.lang(chat, lang);
      return true;
    }
    if (forAssistant) return false; // (the assistant reads it, once there is a credential)
    const route: MessageRoute = {
      sender: chat.sender,
      conversation: chat.conversation,
      scope: "",
      lang: () => chat.lang(),
      message,
      text,
    };
    for (const interceptor of this.ctx.deps.handlers.personalInterceptors)
      if (await interceptor.intercept(route)) return true;
    return false;
  }

  private handlerOf(verb: string): ClickHandler | undefined {
    return this.ctx.deps.handlers.clicks.find((handler) => handler.verbs.includes(verb));
  }

  private async click(action: InboundAction, chat: Chat): Promise<void> {
    const handler = this.handlerOf(action.verb);
    const route = this.ctx.clickRoute(action, chat);
    if (action.verb === "bind" && this.ctx.deps.exchange.enabled) {
      await this.sets.link.confirmBinding(action, chat);
      return;
    }
    if (handler?.beforeCredential !== undefined && (await handler.beforeCredential(route))) return;
    const key = await this.ctx.credentials.credential(chat, false);
    if (key === undefined) {
      await this.ctx.settle(action, chat, routingText.in(chat.lang()).notConnected); // (a button of an unconnected chat)
      return;
    }
    if ((OWN_VERBS as readonly string[]).includes(action.verb)) await this.ownClick(action, chat, key);
    else if (handler?.withCredential !== undefined) await handler.withCredential(route, key);
  }

  private async ownClick(action: InboundAction, chat: Chat, key: string): Promise<void> {
    if (action.verb === "repo") await this.sets.sessions.repoClick(action, chat);
    else if (action.verb === "create_pr") await this.sets.sessions.createPr(action, chat, key);
  }
}

/** What is stored for proactive messages: the channel's own reference, as it gave it. */
export function wireOf(event: {
  readonly conversation: { readonly wire: Readonly<Record<string, unknown>> };
}): JsonObject {
  return event.conversation.wire as JsonObject;
}
