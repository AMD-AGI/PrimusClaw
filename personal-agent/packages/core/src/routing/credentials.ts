// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { LinkRepository } from "../ports/store/link.js";
import type { OutMessage, UserRef } from "../ports/surface.js";
import type { Lang } from "../locales/lang.js";
import { AI_NOTICE } from "../locales/transparency.js";
import { linkPage, linkText } from "../locales/link.js";
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

/** The identity card after a refused answer goes to a person at most this often (`identityAfterRefusal`). */
export const IDENTITY_CARD_INTERVAL_SECONDS = 24 * 3600;
/** Its kind in the store's notice record (`claimGithubNotice`): the time it was last sent to the person. */
export const IDENTITY_CARD_NOTICE = "identity_card";

type CredentialDeps = Pick<RouterDeps, "store" | "exchange" | "config" | "logger">;

/**
 * What an action of the person's outside a turn (a thumb on an answer) calls Claw with: what their chats run on, so it acts
 * on the same session as the same Claw user. With chats on the exchange (`exchange` given), the person's exchanged token,
 * else their linked key; without, the linked key. Undefined when they have neither. Never asks or tells them anything.
 */
export function chatCredentialOf(
  links: Pick<LinkRepository, "getKey">,
  exchange: TokenExchange | undefined,
): (sender: UserRef) => Promise<string | undefined> {
  return async (sender) => {
    const key = links.getKey(sender.id) ?? undefined;
    if (exchange === undefined || !exchange.enabled) return key;
    const token = await exchange.tokenFor(sender.id);
    return token.ok ? token.value : key;
  };
}

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

  /**
   * After an answer of the assistant that was refused for want of a confirmed identity (`needs_identity`: a person whose chats
   * run on their key because they never confirmed it asked for something only they may do, such as a review as them): the card
   * that confirms it, at most once per person in IDENTITY_CARD_INTERVAL_SECONDS (the time it was last sent is kept in the
   * store, so a restart or another replica does not send it again), and never once the person has confirmed. Nothing when
   * chats do not run on the exchange, or it cannot be asked; a card that was not sent leaves the allowance unspent. Never
   * before such an answer: connecting a machine and the rest of what a key may do are not held behind it.
   */
  async identityAfterRefusal(chat: Chat): Promise<boolean> {
    if (this.chatExchange === undefined) return false;
    const token = await this.chatExchange.tokenFor(chat.sender.id);
    if (token.ok || token.error.kind !== "not_bound") return false;
    // (the store's once-per-interval notice record, shared with the review service's notices under a kind of its own)
    const notices = this.deps.store.reviewDelegation;
    const userId = chat.sender.id;
    if (!notices.claimGithubNotice(userId, IDENTITY_CARD_NOTICE, IDENTITY_CARD_INTERVAL_SECONDS)) return false;
    let sent = false;
    try {
      sent = await this.sendIdentityCard(chat, linkText.in(chat.lang()).identityRefused);
    } finally {
      if (!sent) notices.releaseGithubNotice(userId, IDENTITY_CARD_NOTICE);
    }
    return sent;
  }

  /** The binding card with `lead`; false (nothing sent) when the identity service gives no link: a key's owner is not sent the `/link` steps. */
  private async sendIdentityCard(chat: Chat, lead: string): Promise<boolean> {
    const request = await this.deps.exchange.bindingRequest(chat.sender.id, chat.sender.email);
    if (!request.ok) {
      this.deps.logger.warn("binding request failed", { kind: request.error.kind });
      return false;
    }
    const shown = bindingLang(chat, lead);
    await chat.send(this.views.binding(request.value.confirmUrl, shown.lead, shown.lang));
    return true;
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
      const { channel, shortName } = chat.conversation.caps;
      const who = sender.email || `your ${shortName} account (${sender.name || "this chat"})`;
      return this.views.link(who, channel);
    }
    const shown = bindingLang(chat, lead);
    return this.views.binding(request.value.confirmUrl, shown.lead, shown.lang);
  }

  /** The `/link` steps, in the person's language (all English after a lead that has no Chinese of its own). */
  async askToLink(chat: Chat, lead = ""): Promise<void> {
    const { botName, publicBaseUrl } = this.deps.config;
    const { channel: id, name: channel } = chat.conversation.caps;
    const page = linkPage(publicBaseUrl, id);
    const dmLead = routingText.in("en").dmLead;
    if (chat.zh() && (lead === "" || lead === dmLead)) {
      const zhLead = lead === "" ? "" : routingText.in("zh").dmLead;
      await chat.say(linkText.in("zh").linkSteps({ lead: zhLead, bot: botName, page, notice: AI_NOTICE.zh, channel }));
      return;
    }
    await chat.say(linkText.in("en").linkSteps({ lead, bot: botName, page, notice: AI_NOTICE.en, channel }));
  }
}

/**
 * The language the binding card is drawn in, and its lead in it: the person's, unless the caller's lead is English with
 * no Chinese of its own (then all English, as the `/link` steps are), so a card is never half one language and half the other.
 * The group @mention's lead is said in Chinese to a person who reads Chinese.
 */
function bindingLang(chat: Chat, lead: string): { readonly lang: Lang; readonly lead: string } {
  if (chat.lang() !== "zh") return { lang: "en", lead };
  if (lead === routingText.in("en").dmLead) return { lang: "zh", lead: routingText.in("zh").dmLead };
  return lead === "" || /[\u4e00-\u9fff]/u.test(lead) ? { lang: "zh", lead } : { lang: "en", lead };
}
