// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The language a person chose to be answered in (`/lang zh|en`), as it goes to Claw with each of their messages, so that the
 * model's answer is in it as well as the agent's own texts.
 *
 * Only a choice the person said counts: a language learnt from what they write (`learnLang`), and `/lang auto`, are no
 * choice, nothing is sent, and Claw reads the language from the message as before. To the assistant the choice goes in the
 * message's `channel_context` (`reply_language`); to a plain session (a 1:1 chat without the assistant) as the line Claw's
 * assistant uses for it, after the message (`replyLanguageLine`). A group's turn carries the group's language in that line
 * instead (`groupChosenLang`): in a group a person's own choice is not read.
 */

import type { Lang } from "../locales/lang.js";

/** What of a person's preferences says the choice (`Prefs.lang`, `Prefs.langSet`). */
export interface LangPrefs {
  readonly lang: string;
  readonly langSet: boolean;
}

/** The language the person chose, or undefined when they chose none. */
export function chosenLang(prefs: LangPrefs): Lang | undefined {
  if (!prefs.langSet) return undefined;
  return prefs.lang === "zh" || prefs.lang === "en" ? prefs.lang : undefined;
}

/** The choice as `channel_context` carries it (`{ reply_language: "zh" }`); empty when there is none. */
export function replyLanguageContext(prefs: LangPrefs): { reply_language?: Lang } {
  const lang = chosenLang(prefs);
  return lang === undefined ? {} : { reply_language: lang };
}

/** The line after a message to a plain session that names the language to answer in: `[Reply language: English]`. */
export function replyLanguageLine(lang: Lang): string {
  return `[Reply language: ${lang === "zh" ? "Chinese" : "English"}]`;
}
