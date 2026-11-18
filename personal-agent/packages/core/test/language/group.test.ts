// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** What a group chat says to set its language: `/lang …`, or a whole sentence that names the group; nothing else. */
import assert from "node:assert/strict";
import { it } from "node:test";

import { parseGroupLang } from "../../src/language/group.js";

it("reads /lang with a language, alone, and malformed", () => {
  assert.deepEqual(parseGroupLang("/lang en"), { kind: "set", lang: "en" });
  assert.deepEqual(parseGroupLang("/LANG Zh"), { kind: "set", lang: "zh" });
  assert.deepEqual(parseGroupLang("/lang auto"), { kind: "set", lang: "auto" });
  assert.deepEqual(parseGroupLang("/lang follow the asker"), { kind: "set", lang: "auto" });
  assert.deepEqual(parseGroupLang("/lang 英文"), { kind: "set", lang: "en" });
  assert.deepEqual(parseGroupLang("/lang 跟随提问者"), { kind: "set", lang: "auto" });
  assert.deepEqual(parseGroupLang("/lang"), { kind: "status" });
  assert.deepEqual(parseGroupLang("/lang fr"), { kind: "usage" });
  assert.deepEqual(parseGroupLang("/lang constructor"), { kind: "usage" }); // (no name of Object.prototype)
  assert.equal(parseGroupLang("/language en"), undefined);
});

it("reads the Chinese sentences that name the group, spaced or not, with what people put around them", () => {
  for (const [text, lang] of [
    ["这个群用英文", "en"],
    ["这个群 用 英文。", "en"],
    ["本群用中文回复", "zh"],
    ["以后这个群都用英语交流吧", "en"],
    ["群里统一用中文", "zh"],
    ["请在这个群里说英文", "en"],
    ["把本群的回复语言改成英文", "en"],
    ["这个群语言设为中文", "zh"],
    ["这个群跟随提问者的语言", "auto"],
    ["本群按提问的人的语言回复", "auto"],
    ["把这个群的语言改成跟随提问者", "auto"],
    ["这个群语言设为自动", "auto"],
  ] as const)
    assert.deepEqual(parseGroupLang(text), { kind: "set", lang }, text);
});

it("reads the English sentences that name the group, in any case and with closing punctuation", () => {
  for (const [text, lang] of [
    ["use English in this group", "en"],
    ["Use Chinese in this group chat.", "zh"],
    ["please reply in English in this chat from now on", "en"],
    ["In this group, answer in Chinese", "zh"],
    ["this group speaks English", "en"],
    ["set the group language to Chinese", "zh"],
    ["change this chat's language to English!", "en"],
    ["follow the asker", "auto"],
    ["reply in the asker's language in this group", "auto"],
    ["set the group language to auto", "auto"],
  ] as const)
    assert.deepEqual(parseGroupLang(text), { kind: "set", lang }, text);
});

it("a request for one answer in a language, or a sentence that only mentions one, is not a setting", () => {
  for (const text of [
    "用英文回复",
    "用中文回答这个问题",
    "以后用英文回复", // (the person's own setting in a 1:1 chat; in a group, a request for this answer)
    "answer in English",
    "reply in Chinese please",
    "translate this into English",
    "这个群用英文的人多吗",
    "is this group using English?",
    "use English in this group when you write the release notes for the team",
    "这个群用英文".repeat(30),
    "",
  ])
    assert.equal(parseGroupLang(text), undefined, text);
});
