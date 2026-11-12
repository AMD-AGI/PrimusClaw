// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import { errorName } from "../errors.js";
import { parseGroupLang } from "../language/group.js";
import { GROUP_LANGUAGE_CARD, groupLanguageSet, groupLanguageText } from "../locales/group-language.js";
import { noteMessage } from "../note/note.js";
import type { GroupLanguage } from "../ports/store/group-language.js";
import type { InboundAction } from "../ports/surface.js";
import type { Chat } from "./chat.js";
import type { RouterContext } from "./context.js";
import { viewButtonOf } from "./views.js";

/** The verb of the language card's buttons. */
export const GROUP_LANG_VERB = "group_lang";

const LANGS: readonly GroupLanguage[] = ["zh", "en", "auto"];

function isGroupLanguage(value: unknown): value is GroupLanguage {
  return typeof value === "string" && (LANGS as readonly string[]).includes(value);
}

/**
 * The language a group chat is answered in, as its members set it (the store's `groupLanguage`): `@bot /lang zh|en|auto` or a
 * sentence that names the group ("这个群用英文"), and a card the first time the bot is @mentioned in a chat that has none. Anyone in
 * the chat may set it, with no Claw credential (it is the chat's, not one person's), and every change is announced in the chat with
 * the name of who made it. The group's language then governs everything said there (`Chat.lang`, `groupLangOf`) and the language
 * its turns are asked to answer in (`TurnStarter`).
 */
export class GroupLanguages {
  constructor(private readonly ctx: RouterContext) {}

  /** `/lang …` or a sentence that sets the group's language: answered here; false when `text` is neither. */
  async command(chat: Chat, text: string): Promise<boolean> {
    const command = parseGroupLang(text);
    if (command === undefined) return false;
    const bot = this.ctx.deps.config.botName;
    if (command.kind === "set") {
      this.ctx.deps.store.groupLanguage.setGroupLanguage(chat.scope, command.lang);
      await chat.say(groupLanguageSet(command.lang, chat.sender.name));
      return true;
    }
    const said = groupLanguageText.in(chat.lang());
    if (command.kind === "usage") {
      await chat.say(said.usage({ bot }));
      return true;
    }
    const lang = this.ctx.deps.store.groupLanguage.groupLanguage(chat.scope);
    const state = lang === "zh" ? said.isZh : lang === "en" ? said.isEn : lang === "auto" ? said.isAuto : said.isNone;
    await chat.say(state({ bot }));
    return true;
  }

  /**
   * The first @mention in a chat that has no language: the card that asks its members which, once (the chat is recorded as asked
   * before the card goes, so two mentions at once put one; a card that could not be posted is asked again next time).
   */
  async askOnce(chat: Chat): Promise<void> {
    const { store, logger, config } = this.ctx.deps;
    if (!store.groupLanguage.markGroupLanguageAsked(chat.scope)) return;
    const buttons = LANGS.map((lang) =>
      viewButtonOf({ title: GROUP_LANGUAGE_CARD.buttons[lang], verb: GROUP_LANG_VERB, data: { lang } }),
    );
    try {
      await chat.send(
        noteMessage({
          title: GROUP_LANGUAGE_CARD.title,
          text: GROUP_LANGUAGE_CARD.text({ bot: config.botName }),
          tone: "accent",
          buttons,
        }),
      );
    } catch (error) {
      store.groupLanguage.unmarkGroupLanguageAsked(chat.scope);
      logger.warn("group: the language card could not be posted; it is asked again next time", {
        error: errorName(error),
      });
    }
  }

  /** A pick on the language card, by anyone in the chat: the language is set, the card says so, and so does the chat. */
  async click(action: InboundAction, chat: Chat): Promise<void> {
    const lang = action.data["lang"];
    if (!isGroupLanguage(lang)) {
      await this.ctx.settle(
        action,
        chat,
        groupLanguageText.in(chat.lang()).usage({ bot: this.ctx.deps.config.botName }),
      );
      return;
    }
    this.ctx.deps.store.groupLanguage.setGroupLanguage(chat.scope, lang);
    await this.ctx.settle(action, chat, groupLanguageSet(lang, chat.sender.name));
  }
}
