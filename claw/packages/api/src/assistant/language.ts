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
 * the model reads the language from the message as it always did. A message without wording of its own (`ok`, `#3`,
 * `retry #2`, `done`, an emoji: at most one Latin word, and no letter of another script) says nothing either, but it
 * says nothing about the user's language rather than something unknown: the caller then looks at the user's earlier
 * messages, newest first, and the first of them that has words decides, named or not (a French message after English
 * ones is not answered in English). A wrong line would be worse
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

/** A word in Latin script of at least this many letters is a word a language can be told from; one letter is not (`a`, `x`). */
const MIN_WORD_LETTERS = 2;

/** A run of Latin letters, an apostrophe inside it (`don't`) keeping it one word. */
const LATIN_WORD = /\p{Script=Latin}+(?:'\p{Script=Latin}+)*/gu;

/** A letter of any other script: Cyrillic, Arabic, Hebrew, Greek, Devanagari, Thai, and also what is Chinese, Japanese or Korean. */
const NON_LATIN_LETTER = /(?!\p{Script=Latin})\p{L}/u;

/**
 * Whether the text is wording in some language, as opposed to a command or an acknowledgement. Latin script is the one
 * that cannot be judged from a single token: `stop 3`, `retry #2`, `cancel 1`, `done` and `okay` are what a user says to
 * the Router about an item whatever language they speak, and nothing in them is a sentence of any language. So Latin
 * script is wording only from two words of two letters or more on (`merci beaucoup`), and any letter of another script is
 * wording on its own, because a single Cyrillic or Arabic word is a word of a language that is not the one to look back to.
 */
function hasWordsOfItsOwn(text: string): boolean {
  if (NON_LATIN_LETTER.test(text)) return true;
  let words = 0;
  for (const [word] of text.matchAll(LATIN_WORD)) {
    if (word.replace(/'/g, "").length >= MIN_WORD_LETTERS && ++words >= 2) return true;
  }
  return false;
}

export interface LanguageReading {
  /** The language of the message, or null when it cannot be told. */
  language: string | null;
  /** Whether the message has wording of its own, whatever language it is in: false for `ok`, `#3`, `retry #2`, `done` or an emoji. */
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
  return { language, hasWords: language !== null || hasWordsOfItsOwn(text) };
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
 * (`ok`, `#3`, `retry #2`): a message with words in a language that cannot be named gets no line, not the language of older ones,
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

/**
 * The languages a user can choose to be answered in, in their channel (its `/lang zh|en`), as the channel sends the choice
 * (`channel_context.reply_language`), and the name the reply-language line gives each. `auto` is no choice: nothing is sent, and the
 * language is read from what the user writes, as above.
 */
export const CHOSEN_LANGUAGES = { zh: "Chinese", en: "English" } as const;
export type ChosenLanguage = keyof typeof CHOSEN_LANGUAGES;

export const isChosenLanguage = (v: unknown): v is ChosenLanguage => v === "zh" || v === "en";

/**
 * The language to answer in, when the user may have chosen one: their choice wins over what they wrote, every turn, whatever language the
 * message (or a worker's report) is in; without one it is read from their words (`languageToAnswerIn`), as before there was a choice. What
 * they ask for in a language they name (a translation, or an answer: 用英文回复, answer in English) is still written in that language: the
 * prompt says so, and say lets it through (`replyLanguageMismatch`'s `asked`), so the choice is the language of everything else.
 */
export async function replyLanguageFor(
  chosen: ChosenLanguage | null, message: string | null, earlier: () => Promise<readonly string[]> | readonly string[],
): Promise<string | null> {
  return chosen ? CHOSEN_LANGUAGES[chosen] : languageToAnswerIn(message, earlier);
}

/** The names a request gives the four languages, in the user's words: Chinese, English, and what a model writes for them. */
const LANGUAGE_NAMES: ReadonlyArray<[string, string]> = [
  ["英文", "English"], ["英语", "English"], ["english", "English"],
  ["中文", "Chinese"], ["汉语", "Chinese"], ["chinese", "Chinese"],
  ["日文", "Japanese"], ["日语", "Japanese"], ["japanese", "Japanese"],
  ["韩文", "Korean"], ["韩语", "Korean"], ["korean", "Korean"],
];
const NAME_ALTERNATIVES = LANGUAGE_NAMES.map(([n]) => n).join("|");

/**
 * How a message asks for a text in a named language: 翻成英文, 翻译为英语, 译成日文, 写成英文, 用英文写, 用英文回复, 英文版, 英文翻译, 英文回复,
 * translate … into English, (answer) in English, an English reply. Each captures the name. Bounded: a name follows its verb within a few characters, and `translate` looks at most
 * 200 characters ahead for its `into`.
 */
const ASKED_IN = [
  new RegExp(`(?:翻译|翻|译|转换|转|写|改写|改)\\s*(?:成|为|作|到)\\s*(${NAME_ALTERNATIVES})`, "iu"),
  new RegExp(`用\\s*(${NAME_ALTERNATIVES})\\s*(?:写|回|说|发|表达|翻|讲|总结|概括)`, "iu"),
  new RegExp(`(${NAME_ALTERNATIVES})\\s*(?:版本|版|翻译|译文|回复|回答)`, "iu"),
  new RegExp(`\\btranslat\\w*\\b[^\\n]{0,200}?\\b(?:in)?to\\s+(english|chinese|japanese|korean)\\b`, "iu"),
  new RegExp(`\\bin\\s+(english|chinese|japanese|korean)\\b`, "iu"),
  new RegExp(`\\b(english|chinese|japanese|korean)\\s+(?:reply|replies|answer|response|version|translation)\\b`, "iu"),
];

/**
 * The language the user asked a text to be written in, in their own words (what they quoted is left out): English for
 * 把这句翻成英文，只给译文：…, or for "translate this into English". Null when the message asks for no language by name. A
 * translation the user asked for is what they asked to read, in the language they named, whatever language they write in
 * themselves: the parity run of 2026-11-06 (S2) had say refuse the English translation of a Chinese request, and the rewrite came
 * 1.4 s later with a Chinese label before it.
 */
export function requestedTextLanguage(message: string): string | null {
  const own = unquoted(wording(readable(message)));
  for (const re of ASKED_IN) {
    const name = re.exec(own)?.[1]?.toLowerCase();
    const found = name ? LANGUAGE_NAMES.find(([n]) => n === name)?.[1] : undefined;
    if (found) return found;
  }
  return null;
}

/**
 * Whether a message the assistant is about to send is plainly in another language than the one it was told to answer in
 * (`[Reply language: X]`): the language it is in, or null when it is in that language or cannot be told apart from it.
 * `asked`: the language the user asked the text in (`requestedTextLanguage`), which a message in it is never refused for.
 *
 * Asked of an answer due in Chinese, and refused only when it has no Chinese character at all once the user's item titles
 * (`others`, quoted from elsewhere) are left out: an answer to a Chinese message with none is in another language, whatever it
 * quotes. The other way cannot be told safely from the answer alone: an English sentence may quote a Chinese title of anything (a pull
 * request, a page) at any length, and a short Japanese answer may be all kanji, so an answer due in English, Japanese or Korean is not
 * refused here (the prompt asks for it), with one exception, `chosen`: English the user chose to be answered in (`/lang en`), whatever
 * they write in. Then the model's pull is toward the language of the message, and an answer is refused when it is Chinese with not one
 * English word of its own: Chinese characters outside the item titles and quotations, and no English function word (`the`, `is`, `you`)
 * beside them, which every English sentence that only quotes a Chinese name has. Pure, for the tests.
 */
export function replyLanguageMismatch(
  text: string, expected: string, others: readonly string[] = [], asked: string | null = null, chosen = false,
): string | null {
  let own = text;
  for (const o of others) if (o.trim()) own = own.split(o).join(" ");
  if (expected === "English" && chosen) {
    if (asked && asked !== "English") return null;
    const words = unquoted(wording(readable(own)));
    return /\p{Script=Han}/u.test(words) && englishWords(words) === 0 && readLanguage(own).language === "Chinese" ? "Chinese" : null;
  }
  if (expected !== "Chinese") return null;
  if (/\p{Script=Han}/u.test(wording(own))) return null;
  const found = readLanguage(own).language;
  return found && found !== expected && found !== asked ? found : null;
}
