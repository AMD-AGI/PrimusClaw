// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Which language a person is answered in (teams_agent/approval_view.py: has_cjk, written_lang, pick_lang, answer_lang).
 *
 * The client's locale is passed in, never read from ambient state: the caller that handles an inbound message knows it.
 */

import type { Lang } from "../locales/lang.js";
import { isPySpace, pyStrip } from "../text/py-text.js";

const CJK = /[㐀-䶿一-鿿豈-﫿]/u;

export function hasCjk(text: unknown): boolean {
  return CJK.test(asText(text));
}

/** A separator that makes a word a name rather than prose (`owner/repo`, `#228`, `a@b`, a path, a time, `k=v`). */
const SEPARATORS = new Set(["/", "#", "@", "\\", "_", ":", "="]);
const DIGIT = /^\p{Nd}$/u;
const ASCII_LETTER = /^[A-Za-z]$/;
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
  const written = withoutNotProse(asText(text)).match(EN_WORD) ?? [];
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
  if (typeof value === "number") return String(value);
  if (value === true) return "True";
  return JSON.stringify(value);
}

/** Whether `run` (a run of non-space characters) holds what makes it a name: a digit, a separator, or `x.y` / `x-y` between letters. */
function namelike(run: readonly string[]): boolean {
  return run.some(
    (ch, i) =>
      SEPARATORS.has(ch) ||
      DIGIT.test(ch) ||
      ((ch === "." || ch === "-") &&
        i > 0 &&
        ASCII_LETTER.test(run[i - 1] ?? "") &&
        ASCII_LETTER.test(run[i + 1] ?? "")),
  );
}

/** The length of a link (`https?://` and what follows up to a space) starting at `i`, or 0. */
function linkAt(chars: readonly string[], i: number): number {
  const head = chars.slice(i, i + 8).join("");
  const scheme = head.startsWith("https://") ? 8 : head.startsWith("http://") ? 7 : 0;
  if (!scheme) return 0;
  let end = i + scheme;
  while (end < chars.length && !isPySpace(chars[end] ?? "")) end += 1;
  return end > i + scheme ? end - i : 0;
}

/** The length of a code span (`` `...` ``) starting at `i`, or 0. */
function codeAt(chars: readonly string[], i: number): number {
  if (chars[i] !== "`") return 0;
  const close = chars.indexOf("`", i + 1);
  return close < 0 ? 0 : close + 1 - i;
}

/**
 * `text` with what is not prose made a space (Python's `_NOT_PROSE.sub(" ", text)`: links, code spans, and every run of non-space
 * characters that holds a digit or a separator), in one linear pass: a run that is no name is skipped at once, and only a link or
 * a code span can then start inside it.
 */
function withoutNotProse(text: string): string {
  const chars = Array.from(text);
  let out = "";
  let i = 0;
  while (i < chars.length) {
    const at = linkAt(chars, i) || codeAt(chars, i);
    if (at) {
      out += " ";
      i += at;
      continue;
    }
    const ch = chars[i] ?? "";
    if (isPySpace(ch)) {
      out += ch;
      i += 1;
      continue;
    }
    let end = i;
    while (end < chars.length && !isPySpace(chars[end] ?? "")) end += 1;
    if (namelike(chars.slice(i, end))) {
      out += " ";
      i = end;
      continue;
    }
    i = keepUntilLinkOrCode(chars, i, end, (kept) => {
      out += kept;
    });
  }
  return out;
}

/** Keep the run's characters up to the first link or code span inside it (or its end); returns where to go on. */
function keepUntilLinkOrCode(
  chars: readonly string[],
  from: number,
  end: number,
  keep: (kept: string) => void,
): number {
  let k = from;
  while (k < end && (k === from || !(linkAt(chars, k) || codeAt(chars, k)))) k += 1;
  keep(chars.slice(from, k).join(""));
  return k;
}
