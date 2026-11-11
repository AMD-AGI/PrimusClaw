// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { renderHelp } from "../capabilities/help.js";
import { ClawAnswerInvalid, ClawError, ClawUnreachable } from "../claw/errors.js";
import type { GithubConnection } from "../claw/model.js";
import { errorName } from "../errors.js";
import { accountText, LANG_NAMES, MEMORY_SWITCH } from "../locales/account.js";
import { helpLeadText } from "../locales/help-lead.js";
import { cpHead, pyLower, pyStrip } from "../text/py-text.js";
import { helpLang, type Chat } from "./chat.js";
import type { RouterContext } from "./context.js";

/** A failure of Claw that a command says plainly (anything else is a bug and is not caught). */
function clawFailure(error: unknown): boolean {
  return error instanceof ClawError || error instanceof ClawUnreachable || error instanceof ClawAnswerInvalid;
}

/**
 * Who the person is to the worker and what it can do for them (the Python `Agent._cmd_help`, `_help_values`,
 * `_cmd_whoami`, `_github_connections`, `_memory_on`, `_cmd_memory`, `_cmd_memory_switch`, `_cmd_lang`).
 */
export class AccountCommands {
  constructor(private readonly ctx: RouterContext) {}

  private memoryPage(): string {
    return `${this.ctx.deps.config.publicBaseUrl}/primus-claw?memory=1`;
  }

  /** What the bot can do, by category, each with a sentence to type; not a list of commands. */
  async help(chat: Chat, key: string | undefined, asked: string | undefined): Promise<void> {
    const lang = helpLang(this.ctx.deps.store, chat.sender.id, chat.locale, asked);
    const zh = lang === "zh";
    const lead: string[] = [];
    const who = key ? await this.ctx.owners.whoami(key) : undefined;
    if (who !== undefined) lead.push(accountText.in(lang).connectedTo({ name: who[0], email: who[1] }));
    const attached = this.attachedLead(chat, lang);
    if (attached !== undefined) lead.push(attached);
    const { assistant, config, groupHistory } = this.ctx.deps;
    const groupContext = groupHistory.kept();
    await chat.say(
      renderHelp(lang, {
        assistant: assistant.on(chat.sender.id),
        parts: this.ctx.parts(),
        values: await this.values(chat, key, zh),
        lead: lead.join("\n\n"),
        bot: config.botName,
        understanding: assistant.understands(chat.sender.id),
        ...(groupContext === undefined ? {} : { groupContext }),
      }),
    );
  }

  /** On top of help: where this chat's messages go while it is attached to an agent's session, and how to come back. */
  private attachedLead(chat: Chat, lang: "en" | "zh"): string | undefined {
    const { remote } = this.ctx.deps;
    const userId = chat.sender.id;
    const attachment = remote.attached(userId) ? remote.attachment(userId, lang) : undefined;
    if (attachment === undefined) return undefined;
    const where = {
      label: attachment.label,
      host: attachment.host,
      cwd: attachment.cwd ? ` \`${attachment.cwd}\`` : "",
    };
    const text = helpLeadText.in(lang);
    if (remote.direct(userId)) return text.direct(where);
    if (remote.windowMode(userId) === "card") return text.card({ ...where, line: attachment.cardWindowLine });
    return text.chat(where);
  }

  /** The person's settings as help shows them ("当前：..."); what the review service cannot read just now is left out. */
  private async values(chat: Chat, key: string | undefined, zh: boolean): Promise<Record<string, string>> {
    const { store, github } = this.ctx.deps;
    const prefs = store.prefs.getPrefs(chat.sender.id);
    const [on, off] = zh ? ["开", "关"] : ["on", "off"];
    const names = LANG_NAMES[chat.lang()];
    const how = langHow(prefs.langSet, prefs.lang !== "", zh);
    const values: Record<string, string> = {
      timezone: prefs.timezone,
      quiet: prefs.quietEnabled ? `${prefs.quietStart}-${prefs.quietEnd}` : off,
      brief: prefs.briefTriggerId ? on : off,
      lang: names[zh ? 0 : 1] + how,
    };
    if (prefs.pausedUntil !== null && store.now() < prefs.pausedUntil) values["pause"] = zh ? "暂停中" : "paused";
    if (key) values["account"] = zh ? "已连接" : "connected";
    if (github !== undefined) Object.assign(values, await github.helpValues(chat.sender.id, zh ? "zh" : "en"));
    return values;
  }

  /** Whose account this chat is connected to, and what else the person is connected to. */
  async whoami(chat: Chat, key: string): Promise<void> {
    const zh = chat.zh();
    const [owner, github, memory] = await Promise.all([
      this.ctx.owners.owner(key),
      this.githubConnections(chat.sender.id, key),
      this.memoryOn(key),
    ]);
    const said = accountText.in(zh ? "zh" : "en");
    // A person connected only through an identity binding (no linked key) cannot remove it with /unlink: only the account's
    // owner can, in SaFE (`LinkCommands.unlink` says the same).
    const bindingOnly = this.ctx.deps.store.links.getKey(chat.sender.id) === null;
    const person = owner === undefined ? undefined : { name: pyStrip(owner.name), email: pyStrip(owner.email) };
    const first =
      person === undefined
        ? bindingOnly
          ? said.whoamiBoundUnknown
          : said.whoamiUnknown
        : bindingOnly
          ? said.whoamiBound(person)
          : said.whoamiFirst(person);
    const lines = this.ctx.deps.connectionsText({
      owner,
      githubState: github.state,
      connection: github.connection,
      connectionKnown: github.known,
      githubPart: this.ctx.deps.github !== undefined,
      memory,
      memoryPage: this.memoryPage(),
      zh,
    });
    await chat.say(`${first}\n\n${lines}`);
  }

  private async githubConnections(
    userId: string,
    key: string,
  ): Promise<{ state: unknown; connection: GithubConnection | null | undefined; known: boolean }> {
    const { github, claw, logger } = this.ctx.deps;
    const state = github === undefined ? undefined : await github.connectionState(userId);
    try {
      return { state, connection: await claw.settings.githubConnection(key), known: true };
    } catch (error) {
      if (!clawFailure(error)) throw error;
      logger.info("Claw's GitHub connection could not be read for /whoami", { error: errorName(error) });
      return { state, connection: undefined, known: false };
    }
  }

  private async memoryOn(key: string): Promise<readonly [boolean, boolean] | undefined> {
    try {
      const memory = await this.ctx.deps.claw.settings.memory(key, 0);
      return [memory.enabled, memory.available];
    } catch (error) {
      if (!clawFailure(error)) throw error;
      this.ctx.deps.logger.info("memory settings could not be read for /whoami", { error: errorName(error) });
      return undefined;
    }
  }

  async memory(chat: Chat, key: string): Promise<void> {
    const page = this.memoryPage();
    const said = accountText.in(chat.lang());
    let memory;
    try {
      memory = await this.ctx.deps.claw.settings.memory(key);
    } catch (error) {
      if (!(error instanceof ClawError)) throw error;
      await chat.say(said.memoryUnreadable({ page }));
      return;
    }
    if (!memory.available) await chat.say(said.memoryUnavailable);
    else if (!memory.enabled) await chat.say(said.memoryOff({ page }));
    else {
      const lines = memory.items.map((item) => `- ${cpHead(item, 120)}`).join("\n") || said.nothingRemembered;
      await chat.say(said.memoryOn({ lines, page }));
    }
  }

  /** `/memory on` / `/memory off`: the person's memory in Claw, switched as them and said as Claw answers. */
  async memorySwitch(chat: Chat, key: string, arg: string): Promise<void> {
    const page = this.memoryPage();
    const said = accountText.in(chat.lang());
    const word = pyLower(pyStrip(arg));
    const choice = Object.hasOwn(MEMORY_SWITCH, word) ? MEMORY_SWITCH[word] : undefined;
    if (choice === undefined) {
      await chat.say(said.memoryUsage);
      return;
    }
    let state;
    try {
      state = await this.ctx.deps.claw.settings.setMemory(key, choice);
    } catch (error) {
      if (!clawFailure(error)) throw error;
      this.ctx.deps.logger.info("memory could not be switched", { error: errorName(error) });
      await chat.say(said.memoryNotChanged({ page }));
      return;
    }
    if (!state.available) await chat.say(said.memoryUnavailable);
    else await chat.say(state.enabled ? said.memoryTurnedOn({ page }) : said.memoryTurnedOff({ page }));
  }

  /** `/lang zh|en` answers in that language from now on; `/lang auto` follows what they write; `/lang` says which. */
  async lang(chat: Chat, arg: string): Promise<void> {
    const { prefs } = this.ctx.deps.store;
    const word = pyLower(pyStrip(arg));
    const choice = Object.hasOwn(LANG_WORDS, word) ? LANG_WORDS[word] : undefined;
    if (choice !== undefined) {
      prefs.setLang(chat.sender.id, choice);
      await chat.say(accountText.in(choice).langChosen({ lang: choice }));
      return;
    }
    if (word === "auto") prefs.setLang(chat.sender.id, prefs.getPrefs(chat.sender.id).lang, false);
    else if (word) {
      await chat.say(accountText.in(chat.lang()).langUsage);
      return;
    }
    const current = prefs.getPrefs(chat.sender.id);
    const lang = chat.lang();
    const said = accountText.in(lang);
    const why = current.langSet ? said.langWhySet : current.lang ? said.langWhyWritten : said.langWhyClient;
    await chat.say(said.langIs({ name: LANG_NAMES[lang][lang === "zh" ? 0 : 1], why }));
  }
}

const LANG_WORDS: Readonly<Record<string, "zh" | "en">> = {
  zh: "zh",
  cn: "zh",
  chinese: "zh",
  中文: "zh",
  en: "en",
  english: "en",
  英文: "en",
};

/** How the language help shows was chosen: by the person, by what they wrote, or by their client. */
function langHow(set: boolean, learnt: boolean, zh: boolean): string {
  if (set) return zh ? "（你设定的）" : ", set by you";
  if (learnt) return zh ? "（自动）" : ", auto";
  return zh ? "（按 Teams 客户端）" : ", from Teams";
}
