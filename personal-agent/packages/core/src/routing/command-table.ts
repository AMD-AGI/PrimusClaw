// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { agentActionAllowed } from "../capabilities/visibility.js";
import { parseAgentCommand } from "../commands/agent-args.js";
import { commandArgs, parseCommand, parseTimezone } from "../commands/parse.js";
import type { CommandRoute } from "../ports/routing.js";
import type { InboundMessage } from "../ports/surface.js";
import type { AccountCommands } from "./commands-account.js";
import type { SessionCommands } from "./commands-session.js";
import type { SettingsCommands } from "./commands-settings.js";
import type { Chat } from "./chat.js";
import type { RouterContext } from "./context.js";
import type { LinkCommands } from "./link-commands.js";

export interface CommandSets {
  readonly settings: SettingsCommands;
  readonly sessions: SessionCommands;
  readonly account: AccountCommands;
  readonly link: LinkCommands;
}

/**
 * The 1:1 chat's commands (the Python `Agent._command`): `text` is carried out when it is one, and true is returned;
 * false (nothing done) when it is not. `message` is undefined for a command the assistant asked for: the commands that
 * need the message itself are then not carried out.
 */
export class CommandTable {
  constructor(
    private readonly ctx: RouterContext,
    private readonly sets: CommandSets,
  ) {}

  private route(chat: Chat, key: string, message: InboundMessage | undefined): CommandRoute {
    return {
      sender: chat.sender,
      conversation: chat.conversation,
      scope: chat.scope,
      lang: () => chat.lang(),
      credential: key,
      message,
    };
  }

  async run(text: string, chat: Chat, key: string, message?: InboundMessage): Promise<boolean> {
    const timezone = parseTimezone(text);
    if (timezone.isTimezone) {
      await this.sets.settings.timezone(chat, timezone.arg);
      return true;
    }
    for (const [name, run] of [
      ["quiet", (arg: string) => this.sets.settings.quiet(chat, arg)],
      ["pause", (arg: string) => this.sets.settings.pause(chat, arg)],
    ] as const) {
      const arg = commandArgs(text, name);
      if (arg !== null) {
        await run(arg);
        return true;
      }
    }
    if (await this.features(text, chat, key, message)) return true;
    if (await this.board(text, chat, key)) return true;
    if (await this.settingsWords(text, chat, key)) return true;
    if (await this.agent(text, chat, key, message)) return true;
    return this.plain(text, chat, key, message);
  }

  /** A command a feature carries out (`/brief`, and any other the assembly registered). */
  private async features(text: string, chat: Chat, key: string, message: InboundMessage | undefined): Promise<boolean> {
    for (const handler of this.ctx.deps.handlers.commands) {
      if (handler.beforeCredential === true) continue;
      const arg = commandArgs(text, handler.name);
      if (arg !== null && (await handler.run(this.route(chat, key, message), arg))) return true;
    }
    return false;
  }

  private async board(text: string, chat: Chat, key: string): Promise<boolean> {
    const { assistant, observing } = this.ctx.deps;
    const userId = chat.sender.id;
    const board = commandArgs(text, "board") !== null;
    if (board && !assistant.on(userId) && observing.mayTurnOn(userId)) {
      await observing.board(userId, key, chat.conversation); // (an observer without the assistant: the suggestions only)
      return true;
    }
    if (!assistant.on(userId)) return false;
    // `/sessions` (the menu's "sessions") with remote agents: the sessions there are, the ones `/agents` shows, never "there are
    // no sessions" beside a card that lists them (2026-11-11 guide re-check).
    if (parseCommand(text) === "sessions" && this.ctx.deps.remote.enabled) {
      await this.ctx.deps.remote.agents(chat.sender, key, chat.conversation);
      return true;
    }
    const hidden = assistant.hiddenCommand(text, chat.lang()); // (one conversation: no sessions or repositories)
    if (hidden !== undefined) {
      await chat.say(hidden);
      return true;
    }
    if (!board) return false;
    await assistant.board(userId, key, chat.conversation);
    await observing.board(userId, key, chat.conversation);
    return true;
  }

  private async settingsWords(text: string, chat: Chat, key: string): Promise<boolean> {
    const memory = commandArgs(text, "memory");
    if (memory) {
      await this.sets.account.memorySwitch(chat, key, memory);
      return true;
    }
    const repo = commandArgs(text, "repo");
    if (repo === null) return false;
    await this.sets.sessions.repo(chat, repo);
    return true;
  }

  /** `/agents`, `/agent ARGS` (the plural is the one word people remember: `/agents new` is `/agent new`). */
  private async agent(text: string, chat: Chat, key: string, message: InboundMessage | undefined): Promise<boolean> {
    const { remote } = this.ctx.deps;
    const agents = commandArgs(text, "agents");
    if (agents !== null && parseAgentCommand(agents) === null) {
      await remote.agents(chat.sender, key, chat.conversation);
      return true;
    }
    const args = agents ?? commandArgs(text, "agent");
    if (args === null) return false;
    if (message === undefined && !agentActionAllowed(args)) return false; // (the assistant asks only for a switch, back, the list)
    await remote.agent({
      chat: chat.sender,
      credential: key,
      args,
      conversation: chat.conversation,
      message,
      provider: this.ctx.credentials.provider(chat.sender.id, key),
    });
    return true;
  }

  private async plain(text: string, chat: Chat, key: string, message: InboundMessage | undefined): Promise<boolean> {
    const command = parseCommand(text);
    const { sessions, account, link, settings } = this.sets;
    switch (command) {
      case null:
        return false;
      case "help":
        await account.help(chat, key, message?.text);
        break;
      case "new":
        await sessions.new(chat);
        break;
      case "stop":
        await sessions.stop(chat, key);
        break;
      case "unlink":
        await link.unlink(chat);
        break;
      case "whoami":
        await account.whoami(chat, key);
        break;
      case "resume":
        await settings.resume(chat);
        break;
      case "memory":
        await account.memory(chat, key);
        break;
      case "sessions":
        await sessions.sessions(chat, key);
        break;
    }
    return true;
  }
}
