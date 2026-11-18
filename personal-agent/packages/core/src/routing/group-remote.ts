// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { naturalCommand } from "../capabilities/natural.js";
import { switchCommand } from "../capabilities/sessions-words.js";
import { parseAgentCommand } from "../commands/agent-args.js";
import { commandArgs, parseCommand } from "../commands/parse.js";
import { groupText } from "../locales/group.js";
import type { InboundMessage, UserRef } from "../ports/surface.js";
import { splitOnce } from "../text/py-text.js";
import type { Chat } from "./chat.js";
import type { RouterContext } from "./context.js";
import type { PersonalText } from "./personal-text.js";
import { wireOf } from "./personal-router.js";

export interface GroupWords {
  readonly text: string;
  readonly quote: string;
  readonly sent: string;
}

/**
 * A group chat bound to one of the sender's agent sessions (one group, one session at a time; the Python
 * `Agent._group_remote`). "切到 X 上的 claude" (`/agent attach REF`) binds the group for the sender, "回到助理"
 * (`/agent detach`) unbinds it; while bound, the sender's @-messages go to that session (whether the session card is the
 * window or not) and "停掉它" stops its turn. The
 * binding is the sender's own: another member's message is never read by it. False: not a message about the binding.
 */
export class GroupRemote {
  constructor(
    private readonly ctx: RouterContext,
    private readonly text: PersonalText,
  ) {}

  private chatOf(chat: Chat): UserRef {
    return { ...chat.sender, id: this.ctx.deps.remote.groupChatKey(chat.sender.id, chat.scope) };
  }

  /** The `/agent` arguments a group message asks for: typed, said as a switch, or "回到助理" while bound. */
  private agentArgs(text: string, attached: boolean): string | null {
    const args = commandArgs(text, "agent");
    if (args !== null) return args;
    const switching = switchCommand(text);
    if (switching !== null) return splitOnce(switching)[1] ?? ""; // ("attach MACHINE/AGENT")
    // (the 1:1 reading: "回到助理" is a command only for a bound group)
    return attached && naturalCommand(text, false, new Set(), this.ctx.deps.config.botName) === "/agent detach"
      ? "detach"
      : null;
  }

  async route(message: InboundMessage, chat: Chat, key: string, words: GroupWords): Promise<boolean> {
    const { remote } = this.ctx.deps;
    const bound = this.chatOf(chat);
    const attached = remote.attached(bound.id);
    const args = message.choice === true ? null : this.agentArgs(words.text, attached); // (a choice is an answer)
    const provider = this.ctx.credentials.provider(chat.sender.id, key);
    if (args !== null) {
      const parsed = parseAgentCommand(args);
      if (parsed === null || (parsed.verb !== "attach" && parsed.verb !== "detach")) {
        await chat.say(groupText.in(chat.lang()).agentInGroup); // (the lists and the machines are the sender's: 1:1 only)
        return true;
      }
      this.ctx.deps.store.references.saveReference(bound.id, wireOf(message)); // (what follows the session posts here)
      await remote.agent({ chat: bound, credential: key, args, conversation: chat.conversation, message, provider });
      return true;
    }
    if (!attached) return false;
    this.ctx.deps.store.references.saveReference(bound.id, wireOf(message));
    return this.toBound(message, chat, key, words);
  }

  /** A message of a sender whose binding holds this group. */
  private async toBound(message: InboundMessage, chat: Chat, key: string, words: GroupWords): Promise<boolean> {
    const { remote } = this.ctx.deps;
    const bound = this.chatOf(chat);
    const provider = this.ctx.credentials.provider(chat.sender.id, key);
    const choice = message.choice === true; // (a pick on the assistant's choice card: an answer, never a command)
    if (!choice && (naturalCommand(words.text) === "/stop" || parseCommand(words.text) === "stop")) {
      await remote.stop(bound, key, chat.conversation);
      return true;
    }
    if (!choice && parseCommand(words.text) !== null) return false; // (the group's own commands stay the bot's)
    // Every @-message of the binder goes to the session, whatever the chat box mode: in a group the bot is only ever reached by
    // an @-mention, so the 1:1 "chat box stays the bot's" reading would leave nothing that reaches the session. "回到助理" (or the
    // card's button) is the way back. A reply quoting the session card names the session, not what to read: only the words go.
    const quote = remote.quotesWindow(bound.id, message) ? "" : words.quote;
    const prompt = this.ctx.deps.messageText.withQuote(words.sent, quote);
    const files = await this.text.attachments(message, chat, true);
    if (!prompt) return files.length > 0; // (files alone: told they do not go; nothing is sent to the agent)
    await remote.prompt({ message, chat: bound, credential: key, prompt, conversation: chat.conversation, provider });
    return true;
  }
}
