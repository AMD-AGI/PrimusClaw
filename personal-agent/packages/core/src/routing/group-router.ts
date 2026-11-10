// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { renderHelp } from "../capabilities/help.js";
import { parseAgentCommand } from "../commands/agent-args.js";
import { isGroupCommand, isKnownCommand } from "../commands/names.js";
import { commandArgs, parseCommand } from "../commands/parse.js";
import { ClawError, ClawUnreachable, isErrorWord } from "../claw/errors.js";
import type { WorkItem } from "../claw/model.js";
import { hasCjk } from "../language/detect.js";
import { groupText } from "../locales/group.js";
import type { MessageInterceptor, MessageRoute } from "../ports/routing.js";
import type { InboundAction, InboundMessage } from "../ports/surface.js";
import { pyLower, pySplit } from "../text/py-text.js";
import { helpLang, learnLang, type Chat } from "./chat.js";
import type { SessionCommands } from "./commands-session.js";
import type { RouterContext } from "./context.js";
import type { GroupRemote, GroupWords } from "./group-remote.js";
import type { Onboarding } from "./onboarding.js";
import { hasFiles, type PersonalText } from "./personal-text.js";
import type { TurnStarter } from "./turn-start.js";

const STOP_SAID: Readonly<Record<string, readonly [string, string]>> = {
  "": ["代审已停下。", "the review is stopped."],
  already_merged: [
    "已经合入了，停不了（不会自动撤回）。",
    "already merged; it cannot be stopped (nothing is reverted).",
  ],
  merge_in_progress: ["正在合入，停不了。", "the merge is under way and cannot be stopped."],
  item_closed: ["已经结束了。", "it had already ended."],
};

/**
 * A group chat (the Python `Agent._route_group`). The bot acts on a message only when it is @mentioned, and everything
 * runs as the SENDER: their own key, their own session for this conversation. No other member's credential is read.
 */
export class GroupRouter {
  constructor(
    private readonly ctx: RouterContext,
    private readonly text: PersonalText,
    private readonly sessions: SessionCommands,
    private readonly onboarding: Onboarding,
    private readonly remote: GroupRemote,
    private readonly starter: TurnStarter,
  ) {}

  async route(event: InboundMessage | InboundAction, chat: Chat): Promise<void> {
    if (!chat.scope) return;
    if (event.type === "action") await this.click(event, chat);
    else if (event.targeted)
      await this.onboarding.targeted(chat); // (answering in the group would show it to all)
    else if (event.mentioned) await this.message(event, chat);
  }

  /** A button in a group: only those of the presser's own cards that may be pressed there answer. */
  private async click(action: InboundAction, chat: Chat): Promise<void> {
    if (action.verb === "onboard") {
      await this.onboarding.click(action, chat);
      return;
    }
    const handler = this.ctx.deps.handlers.clicks.find((h) => h.verbs.includes(action.verb));
    if (handler?.inGroup !== undefined) await handler.inGroup(this.ctx.clickRoute(action, chat));
  }

  private words(message: InboundMessage): GroupWords {
    const text = this.text.textOf(message, true);
    const { messageText } = this.ctx.deps;
    return { text, quote: messageText.quoteBlock(message, true), sent: messageText.withLinks(text, message) };
  }

  private async message(message: InboundMessage, chat: Chat): Promise<void> {
    const words = this.words(message);
    learnLang(this.ctx.deps.store, chat.sender.id, message.text);
    if (await this.groupOwn(message, chat, words)) return;
    const route: MessageRoute = {
      sender: chat.sender,
      conversation: chat.conversation,
      scope: chat.scope,
      lang: () => chat.lang(),
      message,
      text: words.text,
    };
    for (const interceptor of this.ctx.deps.handlers.groupInterceptors) if (await interceptor.intercept(route)) return;
    const key = await this.ctx.credentials.credential(chat, false);
    if (key === undefined) {
      const keep = parseCommand(words.text) === null; // (/new, /stop and /whoami mean nothing to replay after a link)
      await this.onboarding.member(message, chat, { ...words, keep, identity: false });
      return;
    }
    if (this.ctx.deps.remote.enabled && (await this.remote.route(message, chat, key, words))) return;
    await this.withKey(message, chat, key, words);
  }

  /** Help, and the commands a group does not take (they are a 1:1 chat's). True when the message was answered. */
  private async groupOwn(message: InboundMessage, chat: Chat, words: GroupWords): Promise<boolean> {
    const { github, remote, config } = this.ctx.deps;
    const empty = !words.sent && !words.quote && !hasFiles(message);
    const [first = ""] = pySplit(words.text);
    const word = pyLower(first);
    if (empty || word === "/help") {
      const lang = helpLang(this.ctx.deps.store, chat.sender.id, chat.locale, message.text);
      await chat.say(renderHelp(lang, { group: true, parts: this.ctx.parts(), bot: config.botName }));
      return true;
    }
    if (github !== undefined && word === "/github") {
      await chat.say(groupText.in("en").githubOneToOne);
      return true;
    }
    if (!this.oneToOneOnly(word, words.text, remote.enabled)) return false;
    await chat.say(groupText.in("en").oneToOneOnly({ word }));
    return true;
  }

  /** A command of a 1:1 chat (`/agent attach|detach` binds the group: it stays the group's). */
  private oneToOneOnly(word: string, text: string, remoteOn: boolean): boolean {
    if (!word.startsWith("/") || !isKnownCommand(word.slice(1)) || isGroupCommand(word.slice(1))) return false;
    const verb = parseAgentCommand(commandArgs(text, "agent") ?? "")?.verb ?? "";
    return !(word === "/agent" && remoteOn && (verb === "attach" || verb === "detach"));
  }

  private async withKey(message: InboundMessage, chat: Chat, key: string, words: GroupWords): Promise<void> {
    const command = parseCommand(words.text);
    if (command === "new") await this.sessions.new(chat, chat.scope);
    else if (command === "stop") await this.sessions.stop(chat, key, chat.scope);
    else if (command === "whoami") await this.whoami(chat, key);
    else {
      const files = await this.text.attachments(message, chat);
      if (!words.sent && !words.quote && files.length === 0) return;
      await this.starter.start({
        chat,
        credential: key,
        text: words.text,
        messageId: message.id,
        clientPlatform: message.clientPlatform,
        quote: words.quote,
        sent: words.sent,
        files,
      });
    }
  }

  /** Which account, in a group: never the sender's email. */
  private async whoami(chat: Chat, key: string): Promise<void> {
    const said = groupText.in(chat.lang());
    const who = await this.ctx.owners.whoLine(key, false);
    if (chat.zh()) {
      const name = who === undefined ? "" : ((await this.ctx.owners.whoami(key))?.[0] ?? "");
      await chat.say(name ? said.whoami({ name: chat.sender.name, who: name }) : said.whoamiUnknown);
      return;
    }
    await chat.say(who === undefined ? said.whoamiUnknown : said.whoami({ name: chat.sender.name, who }));
  }

  /**
   * "停 825", from a person the assistant understands: their reviews of those pull requests are stopped in Claw at once
   * (not said to the assistant, where it could wait while the merge happens). Placed by the assembly among the group's
   * interceptors (after feedback, before review requests).
   */
  reviewStopInterceptor(): MessageInterceptor {
    return {
      name: "review_stop",
      intercept: async (route) => {
        const { assistant, reviewStop } = this.ctx.deps;
        if (reviewStop === undefined || !assistant.understands(route.sender.id)) return false;
        const pulls = reviewStop(route.text);
        if (pulls.length === 0) return false;
        await this.stopReviews(this.ctx.chatOf(route.message, route.scope), pulls, route.text);
        return true;
      },
    };
  }

  private async stopReviews(chat: Chat, pulls: readonly (readonly [string, number])[], text: string): Promise<void> {
    const zh = hasCjk(text);
    const said = groupText.in(zh ? "zh" : "en");
    const key = await this.ctx.credentials.credential(chat, false);
    let items: WorkItem[] | undefined;
    try {
      items = key === undefined ? undefined : await this.ctx.deps.claw.workItems.list(key, "in_progress");
    } catch {
      items = undefined;
    }
    if (key === undefined || items === undefined) {
      await chat.say(said.stopUnreachable);
      return;
    }
    const lines: string[] = [];
    for (const [slug, number] of pulls) {
      const found = items.filter(
        (i) =>
          i.kind === "review" &&
          i.pull !== null &&
          i.pull.number === number &&
          (slug === "" || slug === pyLower(`${i.pull.owner}/${i.pull.repo}`)),
      );
      const [only] = found;
      if (only === undefined) lines.push(said.stopNone({ number }));
      else if (found.length > 1) lines.push(said.stopMany({ number }));
      else lines.push(await this.stopReview(key, only, zh));
    }
    await chat.say(lines.join("\n"));
  }

  private async stopReview(key: string, item: WorkItem, zh: boolean): Promise<string> {
    const pull = item.pull ?? { owner: "", repo: "", number: 0 };
    const short = `${pull.owner}/${pull.repo}#${String(pull.number)}`;
    let error: string;
    try {
      const decision = await this.ctx.deps.claw.workItems.stop(key, item.itemId);
      error = decision.ok ? "" : decision.error;
      if (decision.ok) this.ctx.itemStopped(item.itemId); // (the review turn that follows it ends as stopped)
    } catch (failure) {
      if (failure instanceof ClawUnreachable)
        return zh
          ? `${short}：没连上 PrimusClaw，请再说一次。`
          : `${short}: PrimusClaw did not answer; please say it again.`;
      if (!(failure instanceof ClawError)) throw failure;
      error = failure.status === 409 && isErrorWord(failure.code) ? failure.code : `error ${String(failure.status)}`;
    }
    const said = (Object.hasOwn(STOP_SAID, error) ? STOP_SAID[error] : undefined) ?? [
      `没能停下（${error}）。`,
      `it could not be stopped (${error}).`,
    ];
    return zh ? `${short}：${said[0]}` : `${short}: ${said[1]}`;
  }
}
