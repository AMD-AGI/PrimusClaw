// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a group chat says to set the language it is answered in: `/lang zh|en|auto` (`/lang` alone asks which it is), or one of a
 * few sentences that name the group ("这个群用英文", "本群跟随提问者的语言", "use English in this group", "set the group language to
 * Chinese"). Only the whole message counts. A sentence that does not name the group ("用英文回复", "answer in English") is no
 * setting: it asks for that one answer in that language, and goes to the agent as it is.
 */

import type { GroupLanguage } from "../ports/store/group-language.js";
import { pyLower, pySplit, pyStrip } from "../text/py-text.js";

/** A group's language command: set it, say which it is, or how to write it. */
export type GroupLangCommand =
  { readonly kind: "set"; readonly lang: GroupLanguage } | { readonly kind: "status" } | { readonly kind: "usage" };

// A Map, not an object literal: a word from the chat must not find `constructor` or `__proto__` on Object.prototype.
const WORDS: ReadonlyMap<string, GroupLanguage> = new Map([
  ["zh", "zh"],
  ["cn", "zh"],
  ["chinese", "zh"],
  ["中文", "zh"],
  ["汉语", "zh"],
  ["en", "en"],
  ["english", "en"],
  ["英文", "en"],
  ["英语", "en"],
  ["auto", "auto"],
  ["follow", "auto"],
  ["自动", "auto"],
  ["跟随", "auto"],
  ["跟随提问者", "auto"],
  ["followtheasker", "auto"],
]);

const PUNCT = " \t\r\n。．.！!？?～~，,、；;：:\"'“”‘’（）()";

const GROUP = "(?:这个群聊|这个群|本群|此群|群聊|群)(?:里面|里|内|中)?";
const LANG_ZH = "(中文|汉语|英文|英语)";
const ASKER = "(?:提问者|提问人|提问的人|问问题的人|问的人|发问的人)";
/** The Chinese sentences, matched on the message with its spacing taken out (`phrase`). */
const ZH_SET: readonly RegExp[] = [
  new RegExp(
    `^(?:以后|之后|今后|从现在起|从现在开始)?(?:请|麻烦)?(?:在)?${GROUP}(?:以后|之后|今后|从现在起|从现在开始)?(?:请)?(?:都|一律|统一)?(?:用|说|使用)${LANG_ZH}(?:回复|回答|交流|说话|聊天|聊)?(?:吧|好吗|可以吗)?$`,
    "u",
  ),
  new RegExp(
    `^(?:把)?${GROUP}(?:的)?(?:回复)?语言(?:设为|设成|改成|改为|设置为|设置成|切换到|切换成|换成)${LANG_ZH}$`,
    "u",
  ),
];
const ZH_AUTO: readonly RegExp[] = [
  new RegExp(
    `^(?:以后|之后|今后)?(?:在)?${GROUP}(?:以后|之后|今后)?(?:都)?(?:跟随|跟着|按|按照|用)${ASKER}(?:的)?(?:语言)?(?:回复|回答)?(?:吧)?$`,
    "u",
  ),
  new RegExp(
    `^(?:把)?${GROUP}(?:的)?(?:回复)?语言(?:设为|设成|改成|改为|设置为|设置成|切换到|切换成|换成)(?:自动|跟随${ASKER})$`,
    "u",
  ),
];

const LANG_EN = "(english|chinese)";
const THIS_GROUP = "(?:this|the|our) (?:group chat|group|chat)";
const ANSWER = "(?:use|speak|reply in|answer in|respond in|talk in|write in)";
/** The English sentences, matched lower-cased, spaces made one, punctuation at either end taken off (`sentence`). */
const EN_SET: readonly RegExp[] = [
  new RegExp(`^(?:please )?${ANSWER} ${LANG_EN} (?:in|for) ${THIS_GROUP}(?: from now on)?(?: please)?$`),
  new RegExp(`^(?:in|for) ${THIS_GROUP},? (?:please )?${ANSWER} ${LANG_EN}(?: from now on)?(?: please)?$`),
  new RegExp(`^${THIS_GROUP} (?:uses|speaks|is in) ${LANG_EN}$`),
  new RegExp(
    `^(?:please )?(?:set|change|switch) (?:the |this )?(?:group|chat)(?:'s)? language to ${LANG_EN}(?: please)?$`,
  ),
];
const EN_AUTO: readonly RegExp[] = [
  new RegExp(
    `^(?:please )?(?:follow the asker|use the asker'?s language|reply in the asker'?s language|answer in the language of each question)(?: (?:in|for) ${THIS_GROUP})?(?: please)?$`,
  ),
  new RegExp(
    `^(?:please )?(?:set|change|switch) (?:the |this )?(?:group|chat)(?:'s)? language to (?:auto|follow the asker)(?: please)?$`,
  ),
];

/** The message with no spacing and no punctuation at either end, lower-cased: how the Chinese sentences are matched. */
function phrase(text: string): string {
  return pySplit(pyLower(pyStrip(text, PUNCT))).join("");
}

/** The message lower-cased, its spaces made one, without punctuation at either end: how the English sentences are matched. */
function sentence(text: string): string {
  return pySplit(pyLower(pyStrip(text, PUNCT))).join(" ");
}

/** The longest message read as a sentence: a longer one is a request, whatever it says. */
const MAX_SENTENCE_CHARS = 120;

function sentenceCommand(text: string): GroupLangCommand | undefined {
  if (text.length > MAX_SENTENCE_CHARS) return undefined;
  const zh = phrase(text);
  const en = sentence(text);
  for (const pattern of ZH_SET) {
    const word = pattern.exec(zh)?.[1];
    const lang = word === undefined ? undefined : WORDS.get(word);
    if (lang !== undefined) return { kind: "set", lang };
  }
  if (ZH_AUTO.some((p) => p.test(zh))) return { kind: "set", lang: "auto" };
  for (const pattern of EN_SET) {
    const word = pattern.exec(en)?.[1];
    const lang = word === undefined ? undefined : WORDS.get(word);
    if (lang !== undefined) return { kind: "set", lang };
  }
  if (EN_AUTO.some((p) => p.test(en))) return { kind: "set", lang: "auto" };
  return undefined;
}

/** The group's language command `text` is (`/lang …` or a sentence that sets it), or undefined when it is none. */
export function parseGroupLang(text: string): GroupLangCommand | undefined {
  const words = pySplit(text);
  if (pyLower(words[0] ?? "") !== "/lang") return sentenceCommand(pyStrip(text));
  if (words.length === 1) return { kind: "status" };
  const lang = WORDS.get(pyLower(words.slice(1).join("")));
  return lang === undefined ? { kind: "usage" } : { kind: "set", lang };
}
