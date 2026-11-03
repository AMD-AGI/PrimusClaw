// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Which language the assistant should answer in, decided from what the user wrote and told to the model.
 *
 * Left to itself the model follows whatever is loudest in its context, and the work item list is loud: a user who
 * writes English to an assistant whose items have Chinese titles was answered in Chinese in about one case in seven.
 * The user's own words are the evidence, so the server reads them and puts the answer beside the message as a line
 * the model cannot mistake for anything else.
 *
 * Deliberately small: Chinese, Japanese, Korean and English, which a script count and a short list of English function
 * words tell apart without a model or a dependency. For any other text, and for a message too short to tell (`ok`,
 * `#3`), there is no verdict and no line is added; the caller then looks at the user's earlier messages, and if they
 * say nothing either the model reads the language from the message as it always did. A wrong line would be worse than
 * none, so every rule below prefers "no verdict".
 */

export const REPLY_LANGUAGE_LABEL = "Reply language";

export const replyLanguageLine = (language: string): string => `[${REPLY_LANGUAGE_LABEL}: ${language}]`;

/** The message with the line after it. Applied twice it changes nothing more. */
export function withReplyLanguage(message: string, language: string): string {
  const line = replyLanguageLine(language);
  return message.trimEnd().endsWith(line) ? message : `${message}\n\n${line}`;
}

/**
 * English function words, and the plain words short chat messages are made of ("hi", "looks good"). Only words that
 * are not also common in the languages a Latin-script message may be in, so no `is` or `of` (Dutch), `was` or `will`
 * (German), `a`, `in`, `me`, `no` or `do` (the Romance languages).
 */
const ENGLISH = new Set((
  "the and to are were be been with that this these those you your yours my our we they them it its "
  + "i'm i've i'll i'd don't doesn't didn't can't won't isn't aren't it's that's what's there's let's "
  + "please thanks thank yes hello what which who whom whose how why when where while because about from have has had "
  + "would should could not but or if then than also just still already into over after before "
  + "again any some all each every more most other another new old "
  + "hi hey lgtm anything everything nothing something waiting looks good great accepted"
).split(/\s+/));

/** The share of function words below which English in a message that also has Chinese, Japanese or Korean is not a sentence of the user's. */
const ENGLISH_SENTENCE_SHARE = 0.2;

const count = (text: string, re: RegExp): number => text.match(re)?.length ?? 0;

/**
 * What the user said, without what only looks like language: code, links, paths and addresses are not in any language,
 * and a pasted log must not decide how the answer is written.
 */
function wording(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    // ASCII only below: Chinese is written without spaces, so a path or a link is followed directly by the sentence.
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[\x21-\x7e]+/gi, " ")
    .replace(/[\w.~@:+-]*[\\/][\w.~@:+/\\-]*/g, " ")
    .replace(/[\w.+-]+@[\w.-]+/g, " ")
    .replace(/’/g, "'");
}

/** The language of one message, or null when it cannot be told. */
export function detectLanguage(message: string): string | null {
  const text = wording(message);
  const kana = count(text, /[\p{Script=Hiragana}\p{Script=Katakana}]/gu);
  const hangul = count(text, /\p{Script=Hangul}/gu);
  const han = count(text, /\p{Script=Han}/gu);
  const cjk = kana + hangul + han;
  const words = text.toLowerCase().split(/[^\p{L}']+/u).map((w) => w.replace(/^'+|'+$/g, ""));
  // English needs a function word to say so: a Chinese sentence full of English terms has none, and must not be called English.
  const english = words.filter((w) => ENGLISH.has(w)).length;
  if (english > 0 && cjk === 0) return "English";
  // Both in one message: the one that is the user's own sentence wins, and a quoted word is not a sentence. English counts
  // only when it is more words than the other script (a word of those is about two characters) and is made like a sentence:
  // a pasted log or a list of terms in a Chinese message has far fewer function words than an English sentence that
  // asks about a Chinese, Japanese or Korean word.
  const latinWords = words.filter((w) => /^[\p{Script=Latin}']{2,}$/u.test(w)).length;
  if (english > 0 && latinWords > cjk / 2 && english / latinWords >= ENGLISH_SENTENCE_SHARE) return "English";
  // Kana only occur in Japanese and Hangul only in Korean, so a couple of them settle it between the three.
  if (kana >= 2) return "Japanese";
  if (hangul >= 2) return "Korean";
  return han > 0 ? "Chinese" : null;
}

/**
 * The language to answer in: the one the user's message is in, and failing that the one of what they wrote before,
 * newest first. `message` is null when the turn did not start with the user's words (a worker's report woke the
 * assistant): a report says nothing about the user's language. `earlier` is asked only when the message did not show one.
 */
export async function languageToAnswerIn(
  message: string | null, earlier: () => Promise<readonly string[]> | readonly string[],
): Promise<string | null> {
  const own = message === null ? null : detectLanguage(message);
  if (own) return own;
  for (const text of await earlier()) {
    const language = detectLanguage(text);
    if (language) return language;
  }
  return null;
}
