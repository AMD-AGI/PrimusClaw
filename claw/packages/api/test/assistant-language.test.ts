// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The language the assistant is told to answer in (`src/assistant/language.ts`).
 *
 *   L1  Chinese, Japanese, Korean and English are told apart, with the other things a message contains left out
 *   L1c a quotation is not the user's sentence, and a message that opens in Chinese, Japanese or Korean is theirs whatever English follows
 *   L1d a quotation ends at the first closing mark on its line, whatever opens inside it or never closes
 *   L2  a message that cannot be told, or is in another language, has no verdict rather than a wrong one
 *   L3  the verdict agrees with the language every evaluation message is labelled with
 *   L4  the language is the message's own, else the one the user wrote in before; a report is not the user's message
 *   L4b a message with words in a language that cannot be named gets no line, and is not answered in the language of older ones; one with no more than a single Latin word (`retry #2`, `done`, `ok`, `#3`, an emoji) still looks back
 *   L5  the line is the same every time and is added once
 *   L6  only the start and the end of a long message are read, and a paste between them does not decide
 *   L7  what it costs does not grow with what was sent: not by the length of the message, nor by how its characters are arranged
 */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";

import {
  detectLanguage, detectLanguageOfAll, languageToAnswerIn, readLanguage, replyLanguageLine, withReplyLanguage, READ_CHARS, REPLY_LANGUAGE_LABEL,
} from "../src/assistant/language.js";
import { WORK_EVENT_PREFIX } from "../src/assistant/prompts.js";
import { CASES } from "./e2e/assistant-router-eval-cases.js";

test("L1 the four languages are told apart", () => {
  const table: Array<[string, string]> = [
    ["帮我写个脚本，把 /data/runs 下超过 30 天的日志压缩归档", "Chinese"],
    ["帮我 review 一下 retry budget 那个 PR", "Chinese"],
    ["给 Primus-SaFE 的 README 加一节 FAQ，讲怎么申请 GPU 配额，改完提个 PR", "Chinese"],
    ["把docs/a2a.md翻成英文，代码块保持原样", "Chinese"],
    ["好的", "Chinese"],
    ["Can you find out why the nightly build on main has been red since yesterday?", "English"],
    ["Please stop the weekly one", "English"],
    ["thanks", "English"],
    ["I'm not sure it's the right item", "English"],
    ["What happened to Q3 MI300 利用率汇总 and why is it taking so long?", "English"],
    ["ビルドが赤い理由を調べてください", "Japanese"],
    ["이번 주 빌드가 왜 깨졌는지 알아봐 줘", "Korean"],
    ["この error の理由を調べてください", "Japanese"],
    ["What does こんにちは mean?", "English"],
    ["What does 안녕하세요 mean?", "English"],
    ["Please translate 日本語のビルドエラー into English for me", "English"],
    ["ビルドが赤い理由を調べてください please", "Japanese"],
  ];
  for (const [text, want] of table) assert.equal(detectLanguage(text), want, text);
});

test("L1b code, links, paths and addresses do not decide the language", () => {
  assert.equal(detectLanguage("看看这个报错 ```\nthe build is failing and you should check that the cache is not stale\n```"), "Chinese");
  assert.equal(detectLanguage("看看 https://example.com/the/build/is/not/what/you/think 这个"), "Chinese");
  assert.equal(detectLanguage("what is `the and of to` about"), "English");
  assert.equal(detectLanguage("```\nthe and that this with you\n```"), null, "nothing outside the code is language");
  assert.equal(detectLanguage("send it to someone@example.com please"), "English");
  assert.equal(detectLanguage("see docs/the-and-that/with-you.md"), null);
});

test("L1c a quotation is not the user's sentence, and a message that opens in Chinese, Japanese or Korean is theirs whatever English follows", () => {
  const table: Array<[string, string | null]> = [
    // A Chinese user asking about an English sentence: the English is quoted, or what the Chinese sentence is about.
    ["把 'Please fix the build and then deploy it' 翻译成中文", "Chinese"],
    ["这个 PR 的 title 是 \"Fix the build and add the tests for it\"，帮我改成中文", "Chinese"],
    ["帮我 check the build and then fix it please", "Chinese"],
    ["OK 帮我 check the build and then fix it please", "Chinese"],
    ["把‘Please fix the build and then deploy it’翻译成中文", "Chinese"],
    ["把「Please fix the build and then deploy it」翻译成中文", "Chinese"],
    ["请把 “Fix the build and add the tests for it” 改成中文", "Chinese"],
    ["帮我翻译一下：Please fix the build and then deploy it. The nightly job has been red since yesterday and nobody has looked at it.", "Chinese"],
    ["ビルドを check the build and then fix it please", "Japanese"],
    ["빌드가 왜 깨졌는지 check the build and then fix it please", "Korean"],
    // The message opens with Chinese, whatever it is made of; and an apostrophe inside a quoted English sentence belongs to its word.
    ["翻译 'I don't know' into Chinese", "Chinese"],
    ["翻译 this paragraph into English", "Chinese"],
    ["翻译成中文：'I don't think the build is fixed, and it isn't what we want'", "Chinese"],
    ["翻译成中文：“I don’t think the build is fixed, and it isn’t what we want”", "Chinese"],
    ["翻译成中文：‘I don’t think the build is fixed, and it isn’t what we want’", "Chinese"],
    ["Hmm 翻译成中文: 'I don't think the build is fixed, and it isn't what we want'", "Chinese"],
    ["Hmm 翻译成中文: \"Please fix the build and then deploy it\"", "Chinese"],
    ["Hmm 翻译成中文: ‘Please fix the build and then deploy it’", "Chinese"],
    // Whatever the quotation marks, when the Chinese around them has no grammar word of its own to open the message with.
    ["翻译成中文：\"Please fix the build and then deploy it\"", "Chinese"],
    ["翻译成中文：“Please fix the build and then deploy it”", "Chinese"],
    ["翻译成中文：'Please fix the build and then deploy it'", "Chinese"],
    ["翻译成中文：‘Please fix the build and then deploy it’", "Chinese"],
    ["翻译成中文：「Please fix the build and then deploy it」", "Chinese"],
    // An English user asking about a Chinese, Japanese or Korean one.
    ["Please translate 'I don't know' into Chinese", "English"],
    ["What does '你好' mean? I don't get it", "English"],
    ["What does \"你好\" mean?", "English"],
    ["Translate “这个构建为什么一直是红的” into English, please", "English"],
    ["Please translate '日本語のビルドエラー' into English for me", "English"],
    ["Please translate 「ビルドが赤い理由を調べてください」 into English", "English"],
    ["Can you check why the nightly build is red? The error says \"找不到模块\"", "English"],
    ["What does 我爱你 mean?", "English"],
    ["Please translate 帮我看一下这个 into English", "English"],
    // A pasted line with one function word among many is not an English sentence, however much of it there is.
    ["npm ERR missing script build for the package json 报错信息 scripts section", "Chinese"],
    // An apostrophe inside a word is not a quote.
    ["I don't know what the 帮助 doc says, it isn't clear", "English"],
    ["The users' list isn't what I'd expect, and 我的 items are missing", "English"],
    ["Sadly 构建 builds don't work for the users and that isn't fine", "English"],
    ["Sadly 构建 builds don't work for the users' 构建 items", "English"],
    // Nothing but a quotation: the quotation is all there is to go on.
    ["\"Please fix the build\"", "English"],
    ["\"这个构建为什么是红的\"", "Chinese"],
    ["「ビルドが赤い」", "Japanese"],
    ["''", null],
  ];
  for (const [text, want] of table) assert.equal(detectLanguage(text), want, text);
});

test("L2 what cannot be told has no verdict", () => {
  for (const text of ["", "   ", "ok", "#3", "3", "👍", "stop", "Wie ist der Stand von #3?", "¿Cómo va el informe?", "Où en est le rapport ?", "Is dit klaar? Het is goed", "Это готово?"]) {
    assert.equal(detectLanguage(text), null, text);
  }
});

test("L3 the verdict is never different from the language every evaluation message is labelled with, and almost always there", async () => {
  const labelled = CASES.filter((c) => c.lang && !c.text.startsWith(WORK_EVENT_PREFIX));
  assert.ok(labelled.length >= 100, `${labelled.length} labelled messages`);
  const want = (c: { lang?: string }) => (c.lang === "zh" ? "Chinese" : "English");
  const wrong = labelled.filter((c) => { const got = detectLanguage(c.text); return got !== null && got !== want(c); });
  assert.deepEqual(wrong.map((c) => `${c.id}: ${c.text}`), [], "a wrong verdict is worse than none");
  const silent = labelled.filter((c) => detectLanguage(c.text) === null);
  assert.ok(silent.length <= 2, `no verdict for ${silent.map((c) => `${c.id}: ${c.text}`).join(" | ")}`);
  // Where the message shows nothing, the conversation does: every case that has earlier turns ends up with its label.
  for (const c of silent) {
    const earlier = [...(c.history ?? [])].reverse().map((h) => h.user);
    assert.equal(await languageToAnswerIn(c.text, () => earlier), earlier.length ? want(c) : null, c.id);
  }
  for (const turn of CASES.flatMap((c) => c.history ?? [])) {
    const language = detectLanguage(turn.user);
    assert.ok(language === null || language === "Chinese" || language === "English", turn.user);
  }
});

test("L4 the message's own language, else the user's earlier words, and a report is not the user's message", async () => {
  const asked: string[] = [];
  const earlier = (...texts: string[]) => () => { asked.push("asked"); return texts; };
  assert.equal(await languageToAnswerIn("What is the status?", earlier("请看一下")), "English");
  assert.deepEqual(asked, [], "the earlier messages are not read when the message shows its language");
  assert.equal(await languageToAnswerIn("ok", earlier("好", "请看一下")), "Chinese", "the newest of the earlier messages that has one");
  assert.equal(await languageToAnswerIn("ok", earlier("#3", "Please look")), "English", "one that cannot be told is passed over");
  assert.equal(await languageToAnswerIn(null, earlier("请看一下 the build")), "Chinese", "a report: the user's words decide");
  assert.equal(await languageToAnswerIn(null, earlier()), null);
  assert.equal(await languageToAnswerIn("ok", earlier("ok", "#2")), null, "nothing says, so no verdict");
  assert.equal(await languageToAnswerIn("ok", async () => ["Please look"]), "English", "earlier may be asked asynchronously");
});

test("L4b a message with words in a language that cannot be named gets no line; one with no more than a single Latin word looks back", async () => {
  const french = "Bonjour, peux-tu corriger le build s'il te plaît ?";
  const german = "Hallo, kannst du bitte den Build reparieren? Er ist seit gestern rot.";
  const spanish = "Hola, ¿puedes arreglar la compilación? Lleva en rojo desde ayer.";
  const italian = "Ciao, puoi sistemare la build? È rossa da ieri.";
  const russian = "Привет, можешь починить сборку? Она красная со вчера.";
  const english = "Please fix the CI";
  const chinese = "请看一下";
  // [the message, what the user wrote before it (newest first), the language to answer in, whether the earlier messages are read]
  const table: Array<[string | null, string[], string | null, boolean]> = [
    // Words in a language this cannot name: no line, whatever was written before.
    ...[french, german, spanish, italian, russian].flatMap((message): Array<[string, string[], null, false]> => [
      [message, [english], null, false],
      [message, [english, chinese], null, false],
      [message, [chinese], null, false],
    ]),
    // Two Latin words are wording of the user's, in whatever language; any letter of another script is too.
    ["merci beaucoup", [english], null, false],
    ["ok gracias", [chinese], null, false],
    ["да", [english], null, false],
    ["ok да", [english, chinese], null, false],
    ["نعم", [chinese], null, false],
    // A single Latin word, with or without numbers and punctuation, is a command or an acknowledgement, not wording in an
    // unnamed language: the older messages are read, newest first. These are what the Router is typically sent.
    ["oui", [english], "English", true],
    ["Hola", [english], "English", true],
    ["retry #2", [english], "English", true],
    ["retry #2", [chinese], "Chinese", true],
    ["retry #2", [chinese, english], "Chinese", true],
    ["stop 3", [english], "English", true],
    ["stop 3", [chinese], "Chinese", true],
    ["cancel 1", [english], "English", true],
    ["cancel 1", [chinese], "Chinese", true],
    ["done", [english], "English", true],
    ["done", [chinese], "Chinese", true],
    ["okay", [english], "English", true],
    ["okay!", [chinese], "Chinese", true],
    ["#2 retry.", [chinese], "Chinese", true],
    ["x 3 y", [chinese], "Chinese", true],
    ["retry #2", ["ok", french], null, true],
    // Too few letters to be in any language: the older messages are read, newest first.
    ["ok", [english], "English", true],
    ["#3", [chinese, english], "Chinese", true],
    ["👍", [english], "English", true],
    ["3", ["#2", english], "English", true],
    ["ok", ["", "#2", chinese], "Chinese", true],
    ["```\nERROR build failed\n```", [chinese], "Chinese", true],
    ["https://example.com/a/b?c=d", [english], "English", true],
    // Among the older messages the newest that has words decides, named or not.
    ["ok", [french, english], null, true],
    ["#3", ["ok", german, chinese], null, true],
    ["ok", ["#2", spanish, english], null, true],
    ["ok", ["#2", english, spanish], "English", true],
    // A report is not the user's message: their words decide in the same way.
    [null, [french, english], null, true],
    [null, ["ok", english, french], "English", true],
    [null, ["ok", "#2"], null, true],
  ];
  const wrong: string[] = [];
  for (const [message, before, language, readEarlier] of table) {
    let asked = false;
    const answer = await languageToAnswerIn(message, () => { asked = true; return before; });
    const want = `${JSON.stringify(language)}, earlier messages ${readEarlier ? "read" : "not read"}`;
    const got = `${JSON.stringify(answer)}, earlier messages ${asked ? "read" : "not read"}`;
    if (want !== got) wrong.push(`${JSON.stringify(message)} after ${JSON.stringify(before)}: want ${want}, got ${got}`);
  }
  assert.deepEqual(wrong, []);
  // The reading says which of the two a message is.
  assert.deepEqual(readLanguage(french), { language: null, hasWords: true });
  assert.deepEqual(readLanguage("ok"), { language: null, hasWords: false });
  assert.deepEqual(readLanguage("retry #2"), { language: null, hasWords: false });
  assert.deepEqual(readLanguage("stop 3"), { language: null, hasWords: false });
  assert.deepEqual(readLanguage("okay"), { language: null, hasWords: false });
  assert.deepEqual(readLanguage("merci beaucoup"), { language: null, hasWords: true });
  assert.deepEqual(readLanguage("да"), { language: null, hasWords: true });
  assert.deepEqual(readLanguage("Please stop"), { language: "English", hasWords: true });
  assert.deepEqual(readLanguage("好"), { language: "Chinese", hasWords: true });
  assert.deepEqual(readLanguage(""), { language: null, hasWords: false });
});

test("L5 the line is the same every time and is added once", () => {
  assert.equal(replyLanguageLine("English"), "[Reply language: English]");
  assert.equal(REPLY_LANGUAGE_LABEL, "Reply language");
  const once = withReplyLanguage("hello there", "English");
  assert.equal(once, "hello there\n\n[Reply language: English]");
  assert.equal(withReplyLanguage(once, "English"), once);
  assert.equal(withReplyLanguage("hello there  \n", "Chinese"), "hello there  \n\n\n[Reply language: Chinese]");
  // Neutral: the line names a language and nothing else.
  assert.doesNotMatch(replyLanguageLine("English"), /claw|assistant|router/i);
});

test("L1d a quotation ends at the first closing mark on its line, whatever opens inside it or never closes", () => {
  const table: Array<[string, string]> = [
    // Nested: what is inside is quoted too, and what the user says around it is theirs.
    ["Translate 「他说『你好』」 into English please", "English"],
    ["Translate “他说 “你好” 谢谢” and summarize it", "English"],
    // An opening mark with no closing mark does not quote what comes after it...
    ["Please look at “ and tell me why 你好 你好 你好", "English"],
    ["What does 「你好 mean? Please tell me, thanks and 「再见」", "English"],
    ["“你好 “你好 “你好 please tell me why the build is red and what to do about it", "Chinese"],
    // ... and a quotation does not run onto the next line.
    ["Is “你好\n谢谢” a greeting? Please tell me", "Chinese"],
    ["What does 你好 mean?\n“\n“\n”", "English"],
  ];
  for (const [message, language] of table) assert.equal(detectLanguage(message), language, message);
});

// A paste of this many lines is far longer than what is read of a message.
const LOG_LINES = 5000;

test("L6 only the start and the end of a long message are read, and a paste between them does not decide", () => {
  const english = "ERROR the build failed because of the missing file in this run\n".repeat(LOG_LINES);
  const chinese = "错误：构建失败，请检查这个文件是否存在\n".repeat(LOG_LINES);
  assert.ok(english.length > 10 * READ_CHARS && chinese.length > 10 * READ_CHARS);
  // The user's words in front of a paste, and after it; and a paste in a code block is left out although the cut falls
  // inside it: the block opens in what is read of the start and closes in what is read of the end.
  const fence = "```";
  const table: Array<[string, string]> = [
    [`帮我看看这个日志\n${english}`, "Chinese"],
    [`Please summarise the log below\n${fence}\n${chinese}${fence}\n`, "English"],
    [`${fence}\n${chinese}${fence}\nWhy is the build red? Please tell me`, "English"],
    [`${fence}\n${english}${fence}\n请帮我看看`, "Chinese"],
  ];
  for (const [message, language] of table) {
    assert.equal(detectLanguage(message), language, message.slice(0, 40));
    assert.equal(detectLanguage(message), detectLanguageOfAll(message), "what is read gives the verdict that reading all of it would");
  }
  // A message no longer than what is read is read whole, with a word in the middle of it; one character more and the middle is not.
  const whole = `${"a".repeat(READ_CHARS)}请${"a".repeat(READ_CHARS - 1)}`;
  assert.equal(whole.length, 2 * READ_CHARS);
  assert.equal(detectLanguage(whole), "Chinese");
  assert.equal(detectLanguage(`${whole}a`), null);
});

/** The fastest of `times` runs, in milliseconds: the least that noise on a busy machine can add to is the run it left alone. */
function fastest(times: number, run: () => unknown): number {
  let least = Infinity;
  for (let i = 0; i < times; i++) {
    const start = performance.now();
    run();
    least = Math.min(least, performance.now() - start);
  }
  return least;
}

/**
 * Text that costs a time that grows with the square of its length to a regular expression that backtracks: a long run of
 * the characters a pattern accepts that does not end the way the pattern needs, and an opening mark that nothing closes,
 * many times over. Each is made of `size` characters or a few more.
 */
const AWKWARD: Array<[string, (size: number) => string]> = [
  ["one long token", (n) => "a".repeat(n)],
  ["one long token after a Chinese word", (n) => `帮我看 ${"a".repeat(n)}`],
  ["a long dotted token", (n) => "a.".repeat(n / 2)],
  ["a long token with an at sign at its end", (n) => `${"a.".repeat(n / 2)}@`],
  ["a long token with a colon at its end", (n) => `${"a.".repeat(n / 2)}:`],
  ["unclosed curly quotation marks", (n) => "“a ".repeat(n / 3)],
  ["unclosed corner brackets", (n) => "「a ".repeat(n / 3)],
  ["unclosed corner brackets of both kinds", (n) => "『「".repeat(n / 2)],
  ["curly quotation marks closed on the next line", (n) => `${"“a ".repeat(n / 3)}\n”`],
  ["corner brackets closed on the next line", (n) => `${"「a ".repeat(n / 3)}\n』`],
  ["curly quotation marks on many lines, closed on the last", (n) => `${"“a\n".repeat(n / 3)}”`],
  ["unclosed single quotation marks", (n) => "x 'y ".repeat(n / 5)],
  ["unclosed code marks", (n) => `\`\`\`${"a ".repeat(n / 2)}`],
  ["single Chinese characters", (n) => "构 ".repeat(n / 2)],
  ["punctuation, then a Chinese character after each English word", (n) => `${"!".repeat(n / 2)}${"to 构 ".repeat(n / 12)}`],
];

const PROSE = "Please check the build on main and tell me why it has been red since yesterday. ";
const proseOf = (n: number): string => PROSE.repeat(Math.ceil(n / PROSE.length)).slice(0, n);

// The bounds compare one run of the code with another in the same process, so how fast the machine is does not enter.
// What is measured is about 1 to 3 times its reference; text that costs the square of its length is a thousand times.
const BOUND = 20;

test("L7 the cost of reading a message does not grow with the arrangement of its characters", () => {
  // The whole text, with no limit on how much is read: the reference is a text of the same length that is plain prose.
  for (const size of [80_000, 200_000]) {
    const plain = fastest(3, () => detectLanguageOfAll(proseOf(size)));
    for (const [name, make] of AWKWARD) {
      const text = make(size);
      const took = fastest(3, () => detectLanguageOfAll(text));
      assert.ok(took <= BOUND * plain, `${name}, ${text.length} characters: ${took.toFixed(1)} ms, plain prose of the same length ${plain.toFixed(1)} ms`);
    }
  }
});

test("L7 the cost of reading a message does not grow with its length", () => {
  const bodyLimit = 4 * 1024 * 1024;
  // What is read of a message is the same however long it is: the reference is the same text at the length that is read.
  for (const [name, make] of [...AWKWARD, ["plain prose", proseOf] as [string, (size: number) => string]]) {
    const read = fastest(15, () => detectLanguage(make(2 * READ_CHARS)));
    for (const size of [80_000, 200_000, bodyLimit]) {
      const text = make(size);
      const took = fastest(15, () => detectLanguage(text));
      assert.ok(took <= BOUND * read, `${name}, ${text.length} characters: ${took.toFixed(3)} ms, the same text cut to what is read ${read.toFixed(3)} ms`);
    }
  }
  // One long message among the earlier ones does not slow every later turn: each of them is read the same way.
  const poisoned = Array.from({ length: 5 }, () => "“a ".repeat(bodyLimit / 3));
  const cut = Array.from({ length: 5 }, () => "“a ".repeat(2 * READ_CHARS / 3));
  const again = (earlier: readonly string[]) => () => languageToAnswerIn("ok", () => earlier);
  const read = fastest(15, again(cut));
  const took = fastest(15, again(poisoned));
  assert.ok(took <= BOUND * read, `five messages of ${bodyLimit} characters: ${took.toFixed(3)} ms, cut to what is read ${read.toFixed(3)} ms`);
});
