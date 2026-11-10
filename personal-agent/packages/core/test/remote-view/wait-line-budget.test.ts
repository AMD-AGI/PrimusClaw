// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Teams' floating status (an informative update) is cut on a phone after a few characters: on 2026-11-10 a phone showed "⏳ 终端里正"
 * of "⏳ 终端里正在跑一轮，你的消息排队中，跑完就发给它。". Microsoft documents only the 1000-character upper bound of an informative
 * update, no display width, so the budget comes from that one measurement: four Chinese characters after the icon, i.e. 6 code
 * points with "⏳ " in Chinese and 16 in English. The numbers are written here, not read from the module, so that a longer constant
 * cannot make a longer line pass.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Lang } from "../../src/locales/lang.js";
import { receiptText } from "../../src/locales/assistant.js";
import { remoteQueuedText } from "../../src/locales/remote.js";
import { turnText } from "../../src/locales/turn.js";
import { WAIT_LINE_MAX_EN, WAIT_LINE_MAX_ZH, queuedLine } from "../../src/remote/lines.js";
import { cpLength } from "../../src/text/py-text.js";

const ZH_MAX = 6;
const EN_MAX = 16;

// every reason an old connector sends, the two a newer connector adds, and one nobody sends (the fallback)
const REASONS = [
  "terminal_working",
  "terminal_waiting",
  "terminal_typing",
  "terminal_scrolled",
  "terminal_dialog",
  "terminal_screen",
  "something_new",
];

for (const reason of REASONS) {
  test(`every wait line fits what a phone shows: ${reason}`, () => {
    const zh = queuedLine(reason, "zh");
    const en = queuedLine(reason, "en");
    assert.ok(cpLength(zh) <= ZH_MAX, `${reason} ${zh} ${String(cpLength(zh))}`);
    assert.ok(cpLength(en) <= EN_MAX, `${reason} ${en} ${String(cpLength(en))}`);
    assert.ok(zh.startsWith("⏳ ") && en.startsWith("⏳ "));
  });
}

test("every table entry and the fallback fit too", () => {
  const zh = Object.values(remoteQueuedText.in("zh"));
  const en = Object.values(remoteQueuedText.in("en"));
  assert.ok(zh.length >= 6 && en.length === zh.length);
  for (const words of zh) assert.ok(cpLength(`⏳ ${words}`) <= ZH_MAX, words);
  for (const words of en) assert.ok(cpLength(`⏳ ${words}`) <= EN_MAX, words);
});

test("the budget is written down where the lines are", () => {
  assert.deepEqual([WAIT_LINE_MAX_ZH, WAIT_LINE_MAX_EN], [ZH_MAX, EN_MAX]);
});

test("a dialog on the terminal says so and does not fall back", () => {
  for (const lang of ["zh", "en"] as const) {
    assert.notEqual(queuedLine("terminal_dialog", lang), queuedLine("something_new", lang));
  }
  assert.ok(queuedLine("terminal_dialog", "zh").includes("弹窗"));
  assert.ok(queuedLine("terminal_dialog", "en").includes("Dialog"));
});

const FIXED: readonly [string, (lang: Lang) => string][] = [
  ["thinking", (lang) => turnText.in(lang).thinking],
  ["received", (lang) => receiptText.in(lang).received],
  ["preparing", (lang) => turnText.in(lang).preparing],
];

for (const [name, words] of FIXED) {
  test(`the fixed floating status lines fit too: ${name}`, () => {
    assert.ok(cpLength(words("zh")) <= ZH_MAX, words("zh"));
    assert.ok(cpLength(words("en")) <= EN_MAX, words("en"));
  });
}
