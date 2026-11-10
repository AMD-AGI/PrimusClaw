// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { errorName } from "../errors.js";
import { groupText, onboardingText } from "../locales/group.js";
import { routingText } from "../locales/routing.js";
import type { PendingRequest } from "../ports/store/onboarding.js";
import type { Conversation, InboundAction, InboundMessage } from "../ports/surface.js";
import type { Chat } from "./chat.js";
import type { RouterContext } from "./context.js";
import type { TurnStarter } from "./turn-start.js";

/** Opening a 1:1 chat and sending the steps may hold the card back this long, at most. */
export const ONBOARDING_DM_BUDGET_SECONDS = 15;

/** What a member asked in a group, kept for when they connect (`quote` and `sent` as the turn takes them). */
export interface GroupAsk {
  readonly text: string;
  readonly quote: string;
  readonly sent: string;
  /** Kept to run later (not for /new, /stop, /whoami, which mean nothing to replay). */
  readonly keep: boolean;
  /** What they lack is the identity binding (a review for a colleague needs it), not what a chat runs on. */
  readonly identity: boolean;
}

/**
 * A group member who has not connected an account (the Python `Agent._onboard_group_member`, `_send_onboarding_dm`,
 * `_onboard_click`, `_resume_group_request`, `_targeted_in_group`): a card addressed to them (one per person per chat
 * per day) and, once a day, a 1:1 message with the steps; what they asked runs in the group as soon as they connect
 * (within the store's 15 minutes). Nothing here uses any credential, and the card carries no part of the request.
 */
export class Onboarding {
  constructor(
    private readonly ctx: RouterContext,
    private readonly starter: TurnStarter,
  ) {}

  /** The person's 1:1 chat, opened within the budget; undefined when the channel cannot or does not in time. */
  private async openPersonal(chat: Chat): Promise<Conversation | undefined> {
    const { surface, clock } = this.ctx.deps;
    const timer = new AbortController();
    const late = clock.sleep(ONBOARDING_DM_BUDGET_SECONDS * 1000, timer.signal).then(
      () => "late" as const,
      () => "late" as const,
    );
    const opened = surface.openPersonal(chat.conversation.ref, {
      channelUserId: chat.sender.channelUserId,
      userId: chat.sender.id,
    });
    const first = await Promise.race([opened, late]);
    timer.abort();
    return first === "late" ? undefined : first;
  }

  async member(message: InboundMessage, chat: Chat, ask: GroupAsk): Promise<void> {
    const { store } = this.ctx.deps;
    if (ask.keep) {
      store.onboarding.savePendingRequest({
        userId: chat.sender.id,
        scope: chat.scope,
        messageId: message.id,
        text: ask.text,
        reference: chat.conversation.ref.wire as PendingRequest["reference"],
        quote: ask.quote,
        sent: ask.sent,
      });
    }
    const promptId = store.onboarding.claimOnboardingCard(chat.sender.id, chat.scope, {
      channelUserId: chat.sender.channelUserId,
      name: chat.sender.name,
    });
    if (promptId === null) {
      this.ctx.deps.logger.info("group onboarding: this member already got a card in this chat today; nothing posted");
      return;
    }
    const stepsSent = await this.sendSteps(chat, true, ask.identity);
    try {
      await chat.send(this.ctx.views.onboarding(chat.sender, promptId, stepsSent));
    } catch (error) {
      store.onboarding.releaseOnboardingCard(promptId); // (the message is redelivered: it must be able to post the card)
      throw error;
    }
  }

  /**
   * The steps in a 1:1 chat with the member: true when they have them (sent now, or with `claim` earlier today). False
   * when it did not work; the in-group card is then the only help, and the day's message is not used up.
   */
  async sendSteps(chat: Chat, claim: boolean, identity = false): Promise<boolean> {
    const { store, logger } = this.ctx.deps;
    if (claim && !store.onboarding.claimOnboardingDm(chat.sender.id)) {
      logger.info("group onboarding: a 1:1 message already went to this member today; card only");
      return true;
    }
    try {
      const conversation = await this.openPersonal(chat);
      if (conversation === undefined) throw new Error("no 1:1 conversation");
      const dm = this.ctx.chatIn(chat, conversation.ref);
      const lead = routingText.in("en").dmLead;
      if (identity) await this.ctx.credentials.connectIdentity(dm, lead);
      else await this.ctx.credentials.unlinked(dm, lead);
    } catch (error) {
      logger.warn("group onboarding: the 1:1 message did not go out; card only", { error: errorName(error) });
      if (claim) store.onboarding.releaseOnboardingDm(chat.sender.id);
      return false;
    }
    logger.info("group onboarding: the steps were sent in a 1:1 chat");
    return true;
  }

  /**
   * Connect under an onboarding card. The store says whose card it is (never the card); anyone else gets their own card
   * back with a line saying so. The person it is for gets the steps in a 1:1 chat, or in the card when that cannot be done.
   */
  async click(action: InboundAction, chat: Chat): Promise<void> {
    const { store, config } = this.ctx.deps;
    const promptId = typeof action.data["prompt"] === "string" ? action.data["prompt"] : "";
    const card = store.onboarding.getOnboardingCard(promptId);
    let pending: PendingRequest | null = null;
    let closing;
    let said: string | undefined;
    if (card === null || card.scope !== chat.scope) {
      closing = onboardingText.inactive;
    } else if (card.userId !== chat.sender.id) {
      said = onboardingText.notYours(card.name);
      closing = this.ctx.views.onboarding(card, promptId, false, said);
    } else if ((await this.ctx.credentials.credential(chat, false)) !== undefined) {
      pending = store.onboarding.takePendingRequest(chat.sender.id); // (connected meanwhile)
      closing = onboardingText.connected(pending !== null);
    } else if (await this.sendSteps(chat, false)) {
      closing = onboardingText.stepsSent(config.botName);
    } else {
      said = onboardingText.noDm(`${config.publicBaseUrl}/primus-claw/teams-link`);
      closing = this.ctx.views.onboarding(card, promptId, false, said);
    }
    await this.ctx.settle(action, chat, closing, said === undefined ? {} : { fallback: said });
    if (pending !== null) await this.resume(chat, pending, false); // (after the card: its progress must not come first)
  }

  /**
   * The member connected while their group request waited: it runs there, as them, and the group is told so. `notify`
   * (the chat where they connected) hears if this could not be done; a failure never undoes the connection.
   */
  async resume(notify: Chat, pending: PendingRequest, announce: boolean): Promise<boolean> {
    const ref = this.ctx.deps.channel.refOf(pending.reference);
    try {
      if (ref === undefined) throw new Error("the group's reference cannot be read");
      const group = this.ctx.chatIn(notify, ref, pending.scope);
      const key = await this.ctx.credentials.credential(group, false);
      if (key === undefined) throw new Error("no credential after connecting");
      if (announce) await group.say(onboardingText.resuming(notify.sender.name, this.ctx.deps.config.botName));
      await this.starter.start({
        chat: group,
        credential: key,
        text: pending.text,
        messageId: pending.messageId,
        clientPlatform: "",
        quote: pending.quote,
        sent: pending.sent,
      });
    } catch (error) {
      this.ctx.deps.logger.warn("could not run the request that waited in the group chat", { error: errorName(error) });
      await notify.say(onboardingText.notResumed);
      return false;
    }
    return true;
  }

  /**
   * A private message in a group (picked under "/"): an answer in the group would show everyone what only the bot was
   * meant to see, so the sender gets one line in their 1:1 chat saying where to ask instead.
   */
  async targeted(chat: Chat): Promise<void> {
    const { logger, config } = this.ctx.deps;
    try {
      const conversation = await this.openPersonal(chat);
      if (conversation === undefined) throw new Error("no 1:1 conversation");
      await this.ctx.chatIn(chat, conversation.ref).say(groupText.in(chat.lang()).targeted({ bot: config.botName }));
    } catch (error) {
      logger.warn("group: the 1:1 line about a private message did not go out", { error: errorName(error) });
      return;
    }
    logger.info("group: a private message to the bot was pointed to the 1:1 chat");
  }
}
