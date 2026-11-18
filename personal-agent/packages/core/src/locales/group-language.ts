// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import type { GroupLanguage } from "../ports/store/group-language.js";
import { defineCatalog } from "./catalog.js";

/**
 * What a group chat is told of the language it is answered in. The announcement of a change and the question the first time are
 * in both languages (Chinese, then English): they are said before the chat's members share one, and to all of them. The rest is
 * in the group's language.
 */
const NAMES: Readonly<Record<GroupLanguage, readonly [string, string]>> = {
  zh: ["中文", "Chinese"],
  en: ["英文", "English"],
  auto: ["跟随提问者的语言", "the language of each question"],
};

/** The announcement, in the chat, of a change of its language by `name` ("" when the channel gave none). */
export function groupLanguageSet(lang: GroupLanguage, name: string): string {
  const [zh, en] = NAMES[lang];
  return `已改为${zh}回复，由 ${name || "群成员"} 设置。\nI answer in ${en} in this group from now on (set by ${name || "a member"}).`;
}

/** The card the first @mention in a chat with no language puts to its members. */
export const GROUP_LANGUAGE_CARD = {
  title: "这个群用哪种语言回复？/ Which language should I use in this group?",
  text: (p: { bot: string }) =>
    `群里任何人都可以选，之后也能用 @${p.bot} /lang zh | en | auto 再改。\n` +
    `Anyone here may pick; @${p.bot} /lang zh | en | auto changes it later.`,
  buttons: { zh: "中文", en: "English", auto: "跟随提问者 (Follow the asker)" } satisfies Record<GroupLanguage, string>,
};

export const groupLanguageText = defineCatalog({
  en: {
    isZh: (p: { bot: string }) => `This group is answered in Chinese. @${p.bot} /lang en or /lang auto changes it.`,
    isEn: (p: { bot: string }) => `This group is answered in English. @${p.bot} /lang zh or /lang auto changes it.`,
    isAuto: (p: { bot: string }) =>
      `This group is answered in the language each question is asked in. @${p.bot} /lang zh or /lang en sets one.`,
    isNone: (p: { bot: string }) =>
      `This group has no language set: each question is answered in the language it is asked in. ` +
      `@${p.bot} /lang zh, /lang en or /lang auto sets it.`,
    usage: (p: { bot: string }) => `Usage: @${p.bot} /lang zh | en | auto (follow the asker).`,
  },
  zh: {
    isZh: (p) => `这个群用中文回复。@${p.bot} /lang en 或 /lang auto 可改。`,
    isEn: (p) => `这个群用英文回复。@${p.bot} /lang zh 或 /lang auto 可改。`,
    isAuto: (p) => `这个群按每个问题所用的语言回复。@${p.bot} /lang zh 或 /lang en 可设为固定语言。`,
    isNone: (p) => `这个群还没设语言：每个问题按它所用的语言回复。@${p.bot} /lang zh、/lang en 或 /lang auto 可设置。`,
    usage: (p) => `用法：@${p.bot} /lang zh | en | auto（跟随提问者）。`,
  },
});
