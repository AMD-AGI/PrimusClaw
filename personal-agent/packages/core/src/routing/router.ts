// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { naturalCommand } from "../capabilities/natural.js";
import { menuCommand, parseCommand } from "../commands/parse.js";
import { errorName } from "../errors.js";
import { routingText } from "../locales/routing.js";
import { noRequestScope } from "../ports/request-scope.js";
import type { InboundEvent, InboundMessage, InboundVote, UserRef } from "../ports/surface.js";
import type { ReviewSlots } from "./admission.js";
import { Chat } from "./chat.js";
import { CommandTable } from "./command-table.js";
import { AccountCommands } from "./commands-account.js";
import { SessionCommands } from "./commands-session.js";
import { SettingsCommands } from "./commands-settings.js";
import { RouterContext } from "./context.js";
import type { RouterDeps } from "./deps.js";
import { GroupRemote } from "./group-remote.js";
import { GroupRouter } from "./group-router.js";
import { LinkCommands } from "./link-commands.js";
import { Onboarding } from "./onboarding.js";
import { PersonalRouter } from "./personal-router.js";
import { filesNotReviewed, PersonalText } from "./personal-text.js";
import { TurnStarter, type RunningTurn, type StartTurn } from "./turn-start.js";

/**
 * The entry point of every inbound event (the Python `Agent.handle`, `_route`, `_settle_click`, `_dispatch`): idempotent
 * per event id; a message over its sender's rate is dropped before anything is read for it; a group message not addressed
 * to the bot goes to the group's observer; a group, a 1:1 chat, anything else is told where the bot works. Whatever a click
 * handler left open is settled here, so a click never stays a "Working on it..." card.
 */
export class Router {
  readonly ctx: RouterContext;
  readonly starter: TurnStarter;
  readonly onboarding: Onboarding;
  readonly commands: CommandTable;
  private readonly text: PersonalText;
  private readonly personal: PersonalRouter;
  readonly group: GroupRouter;

  constructor(deps: RouterDeps) {
    this.ctx = new RouterContext(deps);
    this.starter = new TurnStarter(this.ctx);
    const sessions = new SessionCommands(this.ctx, this.starter);
    this.onboarding = new Onboarding(this.ctx, this.starter);
    const link = new LinkCommands(this.ctx, (chat, pending, announce) =>
      this.onboarding.resume(chat, pending, announce),
    );
    const sets = { settings: new SettingsCommands(this.ctx), sessions, account: new AccountCommands(this.ctx), link };
    this.commands = new CommandTable(this.ctx, sets);
    this.text = new PersonalText(this.ctx, this.commands, this.starter);
    this.personal = new PersonalRouter(this.ctx, sets, this.text);
    this.group = new GroupRouter(
      this.ctx,
      this.text,
      sessions,
      this.onboarding,
      new GroupRemote(this.ctx, this.text),
      this.starter,
    );
  }

  async handle(event: InboundEvent): Promise<void> {
    const { store } = this.ctx.deps;
    if (event.id && store.idempotency.seen(event.id)) return;
    // (what this event starts runs in its context: its locale, its id for audit records, its sender and chat for logs)
    const context = {
      clientLocale: event.locale,
      activityId: event.id,
      userId: event.sender.id,
      conversationId: event.conversation.id,
    };
    if (event.sender.id) await (this.ctx.deps.requestScope ?? noRequestScope).run(context, () => this.route(event));
    if (event.id) store.idempotency.markProcessed(event.id);
  }

  private async route(event: InboundEvent): Promise<void> {
    const scope = event.conversation.kind === "group" ? event.conversation.id : "";
    const chat = this.ctx.chatOf(event, scope);
    if (event.type === "vote") {
      await this.vote(event, chat);
      return;
    }
    try {
      await this.dispatch(event, chat);
    } catch (error) {
      await this.settleOpen(event, chat, routingText.in(chat.lang()).notFinished);
      throw error;
    }
    await this.settleOpen(event, chat, routingText.in(chat.lang()).buttonInactive);
  }

  /** The safety net under every card click: a click whose card is still the placeholder ends with a note. */
  private async settleOpen(event: InboundEvent, chat: Chat, text: string): Promise<void> {
    if (event.type !== "action" || !event.invoke || !event.cardMessageId) return; // (only a card click left a placeholder)
    if (chat.conversation.edited.has(event.cardMessageId)) return; // (a handler tried)
    this.ctx.deps.logger.warn("card click was not settled by its handler; replacing the card with a note", {
      verb: event.verb,
    });
    try {
      await this.ctx.settle(event, chat, text);
    } catch (error) {
      this.ctx.deps.logger.warn("the clicked card could not be settled", { error: errorName(error) });
    }
  }

  private async vote(vote: InboundVote, chat: Chat): Promise<void> {
    const handler = this.ctx.deps.handlers.votes;
    if (handler === undefined) return;
    await handler.vote({
      sender: chat.sender,
      conversation: chat.conversation,
      scope: chat.scope,
      lang: () => chat.lang(),
      vote,
    });
  }

  private async dispatch(event: Exclude<InboundEvent, InboundVote>, chat: Chat): Promise<void> {
    const kind = event.conversation.kind;
    if (event.type === "message" && !(await this.withinRate(event, chat))) return; // (dropped before anything is read)
    if (kind === "group" && event.type === "message" && !event.mentioned && !event.targeted) {
      this.ctx.deps.groupHistory.record(event); // (kept in memory as background for the next @mention; never answered)
      await this.ctx.deps.observing.forward(event); // (to the group's observer, if it has one)
      return;
    }
    if (event.type === "message") this.ctx.deps.github?.remember(event); // (which channel id is whose, for mentions)
    if (kind === "group") await this.group.route(event, chat);
    else if (kind === "personal") await this.personal.route(event, chat);
    else await chat.say(routingText.in("en").onlyChats);
  }

  /** The message is /stop (typed, the menu word, or a sentence that means it): what a refused person can still send. */
  private static isStop(text: string, group: boolean): boolean {
    return parseCommand(naturalCommand(menuCommand(text, group), group)) === "stop";
  }

  /**
   * Counts a message against its sender's rate, across all their chats. False: over it, dropped, and the person is told
   * once per burst. /stop is never counted or refused; a group message that does not mention the bot is not counted.
   */
  private async withinRate(message: InboundMessage, chat: Chat): Promise<boolean> {
    const group = message.conversation.kind === "group";
    if ((group && !message.mentioned) || (message.choice !== true && Router.isStop(message.text, group))) return true;
    const { limits, securityEvent, metrics } = this.ctx.deps;
    const verdict = limits.checkMessage(chat.sender.id);
    if (verdict.allowed) return true;
    securityEvent("rate_limited", {
      aad_object_id: chat.sender.id,
      activity_id: message.id || null,
      operation: "message",
      reason: "user_limit",
      scope: "user",
      limit: verdict.limit,
      window_seconds: Math.trunc(verdict.windowSeconds),
      retry_after_seconds: Math.trunc(verdict.retryAfterSeconds + 0.999),
    });
    metrics.limited("user_limit");
    if (verdict.notify) await chat.say(limits.rateNotice(chat.lang(), verdict.retryAfterSeconds));
    return false;
  }

  // --- what the features ask of the router -------------------------------------------------------------------------

  /** Start (or queue) a turn: the review service starts its reviews here. */
  startTurn(request: StartTurn): Promise<RunningTurn | undefined> {
    return this.starter.start(request);
  }

  /** Admit up to `count` pull requests of one review request against the person's task limit. */
  admitReviews(chat: Chat, activityId: string, count: number, boardKey: string): Promise<ReviewSlots> {
    return this.ctx.admission.admitReviews(chat, activityId, count, boardKey);
  }

  /** A command the assistant asked the chat to carry out, as if typed (no message: those that need one are refused). */
  async runCommand(text: string, chat: Chat): Promise<boolean> {
    const key = await this.ctx.credentials.credential(chat, false);
    return key !== undefined && (await this.commands.run(text, chat, key));
  }

  /** The person's 1:1 chat has a turn of the old kind running (the assistant lets it finish). */
  hasPersonalTurn(userId: string): boolean {
    return this.ctx.hasTurn(userId);
  }

  /**
   * A work item was stopped from its card (the assistant's Stop): the review turn this router follows for it ends as
   * stopped, not as a task that failed, as when a group's "停 N" stops it (Python `Agent._item_stopped`).
   */
  itemStopped(itemId: string): void {
    this.ctx.itemStopped(itemId);
  }

  /** A chat as the router answers in it, for work that runs on its own (no client locale). */
  chat(sender: UserRef, conversation: Chat["conversation"], scope = ""): Chat {
    return new Chat(this.ctx.deps.store, sender, conversation, scope, "");
  }

  /** What the review service says when the files of a review request do not go with it. */
  filesNotReviewed(chat: Chat, message: InboundMessage, text: string): Promise<void> {
    return filesNotReviewed(this.ctx, chat, message, text);
  }

  /** The turns that run now, for a test to wait on. */
  settled(): Promise<void> {
    return this.starter.settled();
  }
}
