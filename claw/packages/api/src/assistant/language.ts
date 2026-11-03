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
 * words tell apart without a model or a dependency. For any other text there is no verdict and no line is added, and
 * the model reads the language from the message as it always did. A message with too few letters to be in any language
 * (`ok`, `#3`, an emoji) says nothing either, but it says nothing about the user's language rather than something
 * unknown: the caller then looks at the user's earlier messages, newest first, and the first of them that has words
 * decides, named or not (a French message after English ones is not answered in English). A wrong line would be worse
 * than none, so every rule below prefers "no verdict".
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

/** The words of a text in lower case, apostrophes inside a word kept. */
const wordsOf = (text: string): string[] => text.toLowerCase().split(/[^\p{L}']+/u).map((w) => w.replace(/^'+|'+$/g, ""));

const englishWords = (text: string): number => wordsOf(text).filter((w) => ENGLISH.has(w)).length;

/**
 * Chinese characters that carry a sentence rather than name a thing: pronouns, particles, auxiliaries, question and
 * request words ("帮我", "请", "把", "这个", "吗"). A Chinese word quoted in an English sentence is a noun or a phrase;
 * one of these in a run of characters says the run is the user's own grammar. Japanese and Korean say it with any kana
 * or Hangul, which occur in their grammar and hardly anywhere else.
 */
const HAN_FRAME = new Set([..."我你您他她它们咱的了吗呢吧把被让给对在要能想会可请帮替为是这那哪什么怎还就也都又不没别有"]);

const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}ー]+/gu;

/**
 * How much of a message is read: this many characters from its start and from its end. A message is a sentence or a
 * paragraph; what is longer is a paste, and the user's own words are in front of it or after it. This runs on every
 * turn, on the thread that serves every other request, and a message may be megabytes (so may the earlier ones that are
 * read when it shows nothing), so the cost is fixed here instead of left to the length of whatever was sent. What lies
 * between the two parts is not read: the user's words in the middle of a message, between two long pastes, say nothing.
 */
export const READ_CHARS = 2000;

/** The text itself when it is short, else its start and its end, joined by a line break so no token or quotation runs across the cut. */
function readable(text: string): string {
  return text.length <= 2 * READ_CHARS ? text : `${text.slice(0, READ_CHARS)}\n${text.slice(-READ_CHARS)}`;
}

/**
 * What the user said, without what only looks like language: code, links, paths and addresses are not in any language,
 * and a pasted log must not decide how the answer is written.
 *
 * Each pattern below that matches a run of characters starts only at the start of its run (the lookbehind), so a run
 * that does not end the way the pattern needs is read once and not again from every character in it.
 */
function wording(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    // ASCII only below: Chinese is written without spaces, so a path or a link is followed directly by the sentence.
    .replace(/(?<![a-z0-9+.-])[0-9+.-]*[a-z][a-z0-9+.-]*:\/\/[\x21-\x7e]+/gi, " ")
    .replace(/(?<![\w.~@:+/\\-])[\w.~@:+-]*[\\/][\w.~@:+/\\-]*/g, " ")
    .replace(/(?<![\w.+-])[\w.+-]+@[\w.-]+/g, " ")
    .replace(/’/g, "'");
}

/**
 * The message without what it quotes. A quotation is somebody else's sentence: "translate 'Please fix the build' into
 * Chinese" is a Chinese user's request about an English sentence, and `What does "你好" mean?` an English user's about a
 * Chinese one. So the words around the quotes decide, and the quotes only when there is nothing else. An apostrophe
 * inside a word (`don't`, `users'`) opens nothing.
 */
function unquoted(text: string): string {
  const inWord = "\\p{Script=Latin}\\p{N}";
  return withoutQuotations(withoutQuotations(text.replace(/"[^"\n]*"/g, " "), /“/g, /”/g), /[「『]/g, /[」』]/g)
    // wording() has already turned a curly apostrophe into a straight one, so ‘…’ arrives as ‘…'. An apostrophe between
    // two letters belongs to its word, also inside the quotation ('I don't know').
    .replace(new RegExp(`(?<![${inWord}])['‘](?:[^'‘\\n]|(?<=[${inWord}])'(?=[${inWord}]))*'(?![${inWord}])`, "gu"), " ");
}

/**
 * The text without each stretch that opens with a mark matching `opening` and ends with the first mark matching
 * `closing` after it, on one line: what `/“[^”\n]*”/g` would remove. Written as a scan because that expression, with
 * an opening mark that has no closing mark on its line, reads to the end of the line again from every opening mark
 * after it, a time that grows with the square of the line. Here each mark is looked for once, going forward.
 */
function withoutQuotations(text: string, opening: RegExp, closing: RegExp): string {
  const next = (re: RegExp, from: number): number => { re.lastIndex = from; return re.exec(text)?.index ?? Infinity; };
  let out = "";
  let kept = 0; // the text before this is in `out`
  let from = 0; // where an opening mark is looked for
  let close = -1; // the first closing mark after the opening mark being looked at, found once for all that come before it
  let lineEnd = -1; // and the end of the line it is on
  for (;;) {
    const open = next(opening, from);
    if (open === Infinity) break;
    if (close <= open) close = next(closing, open + 1);
    if (close === Infinity) break; // nothing is closed from here on
    if (lineEnd <= open) {
      const newline = text.indexOf("\n", open);
      lineEnd = newline < 0 ? Infinity : newline;
    }
    if (lineEnd < close) {
      from = lineEnd + 1; // closed on a later line: none of the opening marks on this line is
      continue;
    }
    out += `${text.slice(kept, open)} `;
    kept = from = close + 1;
  }
  return out + text.slice(kept);
}

/**
 * Whether the message opens in Chinese, Japanese or Korean: it begins with a run of those characters, or its first run
 * with grammar of its own (see HAN_FRAME; any kana or Hangul) has no English function word before it. English that
 * follows is then what the user's sentence is about ("翻译 this paragraph into English", "帮我 check the build and then
 * fix it please"), however much of it there is. When English comes first, the English is the frame and the characters
 * are what it asks about ("What does 我爱你 mean?").
 */
function opensInCjk(text: string): boolean {
  // Where the first letter or digit is, found once: looking in the text before each run would read a long start of punctuation again for every run.
  const firstLetter = text.search(/[\p{L}\p{N}]/u);
  for (const run of text.matchAll(CJK_RUN)) {
    if (firstLetter >= run.index) return true;
    const hasGrammar = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(run[0]) || [...run[0]].some((c) => HAN_FRAME.has(c));
    if (hasGrammar) return englishWords(text.slice(0, run.index)) === 0;
  }
  return false;
}

/** Fewer letters than this are not a sentence of any language: `ok`, `#3`, `👍`. */
const MIN_LETTERS = 3;

/** Whether there are enough letters in the text to be wording in some language. */
function hasLetters(text: string): boolean {
  let letters = 0;
  for (const _ of text.matchAll(/\p{L}/gu)) if (++letters >= MIN_LETTERS) return true;
  return false;
}

export interface LanguageReading {
  /** The language of the message, or null when it cannot be told. */
  language: string | null;
  /** Whether the message has wording of its own, whatever language it is in: false for `ok`, `#3` or an emoji. */
  hasWords: boolean;
}

/** What one message says about the language: which, and whether it says anything. Of a long message only the start and the end are read (READ_CHARS). */
export function readLanguage(message: string): LanguageReading {
  return readLanguageOfAll(readable(message));
}

/** The language of one message, or null when it cannot be told. */
export function detectLanguage(message: string): string | null {
  return readLanguage(message).language;
}

/** The language of the whole of `text`, however long it is: `detectLanguage` without the limit on how much is read. Here so that a test can time what the limit would hide. */
export function detectLanguageOfAll(whole: string): string | null {
  return readLanguageOfAll(whole).language;
}

function readLanguageOfAll(whole: string): LanguageReading {
  const text = wording(whole);
  const outside = unquoted(text);
  // The user's own words first; what they quoted only when they said nothing besides it.
  const language = judge(outside) ?? (outside === text ? null : judge(text));
  return { language, hasWords: language !== null || hasLetters(text) };
}

function judge(text: string): string | null {
  const kana = count(text, /[\p{Script=Hiragana}\p{Script=Katakana}]/gu);
  const hangul = count(text, /\p{Script=Hangul}/gu);
  const han = count(text, /\p{Script=Han}/gu);
  const cjk = kana + hangul + han;
  const words = wordsOf(text);
  // English needs a function word to say so: a Chinese sentence full of English terms has none, and must not be called English.
  const english = words.filter((w) => ENGLISH.has(w)).length;
  if (english > 0 && cjk === 0) return "English";
  // Both in one message: the one that is the user's own sentence wins, and a quoted word is not a sentence. English counts
  // only when it is more words than the other script (a word of those is about two characters) and is made like a sentence:
  // a pasted log or a list of terms in a Chinese message has far fewer function words than an English sentence that
  // asks about a Chinese, Japanese or Korean word. A message that opens in the other script is that script's, whatever
  // English follows.
  const latinWords = words.filter((w) => /^[\p{Script=Latin}']{2,}$/u.test(w)).length;
  if (english > 0 && latinWords > cjk / 2 && english / latinWords >= ENGLISH_SENTENCE_SHARE && !opensInCjk(text)) return "English";
  // Kana only occur in Japanese and Hangul only in Korean, so a couple of them settle it between the three.
  if (kana >= 2) return "Japanese";
  if (hangul >= 2) return "Korean";
  return han > 0 ? "Chinese" : null;
}

/**
 * The language to answer in: the one the user's message is in, and failing that the one of what they wrote before,
 * newest first. `message` is null when the turn did not start with the user's words (a worker's report woke the
 * assistant): a report says nothing about the user's language. `earlier` is asked only when the message has no words
 * (`ok`, `#3`): a message with words in a language that cannot be named gets no line, not the language of older ones,
 * and among the earlier messages the newest that has words decides in the same way.
 */
export async function languageToAnswerIn(
  message: string | null, earlier: () => Promise<readonly string[]> | readonly string[],
): Promise<string | null> {
  if (message !== null) {
    const own = readLanguage(message);
    if (own.hasWords) return own.language;
  }
  for (const text of await earlier()) {
    const reading = readLanguage(text);
    if (reading.hasWords) return reading.language;
  }
  return null;
}
