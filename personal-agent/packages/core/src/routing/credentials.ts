// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { OutMessage } from "../ports/surface.js";
import { AI_NOTICE } from "../locales/transparency.js";
import { linkText } from "../locales/link.js";
import { routingText } from "../locales/routing.js";
import type { TokenExchange } from "../plugins/token-exchange.js";
import type { Chat } from "./chat.js";
import type { RouterDeps } from "./deps.js";
import type { CredentialProvider } from "./features.js";
import type { CommandViews } from "./views.js";

/** The identity service is down for a moment while a person with no key is followed: that is not "no credential". */
export class CredentialUnavailable extends Error {
  override readonly name = "CredentialUnavailable";
}

type CredentialDeps = Pick<RouterDeps, "store" | "exchange" | "config" | "logger">;

/**
 * What Claw is called with for a person, and what a person who has none is told (the Python `Agent._credential`,
 * `_unlinked`, `_connect_identity`, `_binding_card`, `_ask_to_link`, `_background_credential`, `_fresh_credential`).
 *
 * A chat runs on the person's linked key; with TEAMS_EXCHANGE_FOR_CHAT on, on a fresh exchanged token when they have a
 * confirmed binding, else their linked key, else they get the card that binds them.
 */
export class Credentials {
  /** What an ordinary chat calls Claw with: the exchange only when it is on for chats. */
  private readonly chatExchange: TokenExchange | undefined;

  constructor(
    private readonly deps: CredentialDeps,
    private readonly views: CommandViews,
  ) {
    this.chatExchange = deps.config.exchangeForChat && deps.exchange.enabled ? deps.exchange : undefined;
  }

  /** Whether chats run on exchanged tokens. */
  get onExchange(): boolean {
    return this.chatExchange !== undefined;
  }

  /** What to call Claw with for this person, or undefined after they were told what to do (`ask`). */
  async credential(chat: Chat, ask = true): Promise<string | undefined> {
    const key = this.deps.store.links.getKey(chat.sender.id) ?? undefined;
    if (this.chatExchange === undefined) {
      if (key === undefined && ask) await this.unlinked(chat);
      return key;
    }
    const token = await this.chatExchange.tokenFor(chat.sender.id);
    if (token.ok) return token.value;
    if (token.error.kind === "not_bound") {
      if (key === undefined && ask) await this.unlinked(chat);
      return key;
    }
    this.deps.logger.warn("token exchange failed", { kind: token.error.kind });
    if (key !== undefined || !ask) return key;
    await chat.say(linkText.in("en").platformDown);
    return undefined;
  }

  /** A fresh credential per call when chats run on exchanged tokens (they expire); undefined: the key as it is. */
  provider(userId: string, key: string): CredentialProvider {
    return this.chatExchange === undefined ? undefined : () => this.fresh(userId, key);
  }

  /** The person's exchanged token, else `fallback` (a turn can outlive a 10-minute token: each Claw call asks again). */
  async fresh(userId: string, fallback: string): Promise<string> {
    const token = await this.deps.exchange.tokenFor(userId);
    return token.ok ? token.value : fallback;
  }

  /**
   * What to read Claw with for a person when nobody is writing (a reader that follows a remote session): no question, no
   * message; undefined when they have no credential. Throws CredentialUnavailable while the identity service is down
   * for a person with no key.
   */
  async background(userId: string): Promise<string | undefined> {
    const key = this.deps.store.links.getKey(userId) ?? undefined;
    if (!this.deps.exchange.enabled) return key;
    const token = await this.deps.exchange.tokenFor(userId);
    if (token.ok) return token.value;
    if (token.error.kind === "not_bound" || key !== undefined) return key;
    throw new CredentialUnavailable();
  }

  /**
   * What a chat tells a person who cannot be answered yet; `lead` is a first sentence for a message that arrives unasked
   * (the 1:1 message after an @mention in a group). The key's steps, or the identity binding when chats run on it.
   */
  async unlinked(chat: Chat, lead = ""): Promise<void> {
    if (this.chatExchange === undefined) await this.askToLink(chat, lead);
    else await this.connectIdentity(chat, lead);
  }

  /** The card that connects the person's account at the identity service (what `/github` and a review need). */
  async connectIdentity(chat: Chat, lead = ""): Promise<void> {
    await chat.send(await this.bindingCard(chat, lead));
  }

  /**
   * A one-time confirm link from the identity service, opened in a browser and confirmed once. When the service cannot
   * be asked, the older card, whose Confirm button explains the desktop way: the person is never left with nothing.
   */
  async bindingCard(chat: Chat, lead = ""): Promise<OutMessage> {
    const { sender } = chat;
    const request = await this.deps.exchange.bindingRequest(sender.id, sender.email);
    if (!request.ok) {
      this.deps.logger.warn("binding request failed", { kind: request.error.kind });
      const who = sender.email || `your Teams account (${sender.name || "this chat"})`;
      return this.views.link(who);
    }
    return this.views.binding(request.value.confirmUrl, lead);
  }

  /** The `/link` steps, in the person's language (all English after a lead that has no Chinese of its own). */
  async askToLink(chat: Chat, lead = ""): Promise<void> {
    const { botName, publicBaseUrl } = this.deps.config;
    const page = `${publicBaseUrl}/primus-claw/teams-link`;
    const dmLead = routingText.in("en").dmLead;
    if (chat.zh() && (lead === "" || lead === dmLead)) {
      const zhLead = lead === "" ? "" : routingText.in("zh").dmLead;
      await chat.say(linkText.in("zh").linkSteps({ lead: zhLead, bot: botName, page, notice: AI_NOTICE.zh }));
      return;
    }
    await chat.say(linkText.in("en").linkSteps({ lead, bot: botName, page, notice: AI_NOTICE.en }));
  }
}
