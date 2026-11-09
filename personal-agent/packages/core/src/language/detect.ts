// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Which language a person is answered in (teams_agent/approval_view.py: has_cjk, written_lang, pick_lang, answer_lang).
 *
 * The client's locale is passed in, never read from ambient state: the caller that handles an inbound message knows it.
 */

import type { Lang } from "../locales/lang.js";
import { pyStrip } from "../text/py-text.js";

export type { Lang };

const CJK = /[㐀-䶿一-鿿豈-﫿]/u;

export function hasCjk(text: unknown): boolean {
  return CJK.test(asText(text));
}

/** What is not prose, whatever language it is in: links, code, words with a digit or a separator in them. */
const NOT_PROSE = /https?:\/\/\S+|`[^`]*`|\S*(?:[/#@\\_:=\d]|[A-Za-z][.-][A-Za-z])\S*/g;
const EN_WORD = /[A-Za-z]+(?:'[A-Za-z]+)?/g;
const EN_GLUE = new Set(
  `a an the is are was were be been am do does did not no to of in on at for from with by about and or but if
so it its this that these those what why how when where which who can could would should will shall may might must please i i'm
me my we our you your he she they them there here have has had get got let let's don't doesn't can't won't isn't it's what's all again
still now just also then too some any more yet`.split(/\s+/),
);
const EN_FORM = /^[a-z]{3,}(?:ed|ing)$/;
const EN_VERBS = new Set(
  `add fix update check run make write remove delete create show explain review merge build deploy test open close
find look help tell give change rename move list read summarize summarise translate rewrite refactor implement investigate debug
install upgrade revert rebase compare describe clean set send start stop try draft`.split(/\s+/),
);

/**
 * The language a message is written in, when it says so: "zh" with Chinese in it, "en" for a sentence in English (three words or
 * more, one of them glue, a lower-case -ed/-ing form, or the first a verb of a request); otherwise undefined.
 */
export function writtenLang(text: unknown): Lang | undefined {
  if (hasCjk(text)) return "zh";
  const written = asText(text).replace(NOT_PROSE, " ").match(EN_WORD) ?? [];
  const words = written.map((w) => w.toLowerCase());
  if (words.length < 3) return undefined;
  const first = words[0] ?? "";
  const sentence = EN_VERBS.has(first) || words.some((w) => EN_GLUE.has(w)) || written.some((w) => EN_FORM.test(w));
  return sentence ? "en" : undefined;
}

/** Chinese when the first text that has any non-space character has Chinese in it, else English. */
export function pickLang(...texts: unknown[]): Lang {
  for (const text of texts) {
    if (pyStrip(asText(text))) return hasCjk(text) ? "zh" : "en";
  }
  return "en";
}

/**
 * The language a person is answered in: `said` (the conversation's chosen or learnt language) when set; else the locale of the
 * Teams client the message being handled came from; else that of `texts` (`pickLang`).
 */
export function answerLang(said: string, clientLocale: string, ...texts: unknown[]): Lang {
  if (said === "zh" || said === "en") return said;
  if (clientLocale) return clientLocale.toLowerCase().startsWith("zh") ? "zh" : "en";
  return pickLang(...texts);
}

/** Python's `str(x or "")`: the text of a value, "" for anything falsy. */
export function asText(value: unknown): string {
  if (value === null || value === undefined || value === false || value === 0 || value === "") return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return pyStr(value);
  return JSON.stringify(value);
}

function pyStr(value: number | boolean): string {
  if (typeof value === "boolean") return value ? "True" : "False";
  return String(value);
}
