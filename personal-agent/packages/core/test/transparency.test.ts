// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Ported from teams/tests/test_transparency.py: help says answers are AI-generated and what happens to people's data. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { renderHelp } from "../src/capabilities/help.js";
import { naturalCommand } from "../src/capabilities/natural.js";
import type { Part } from "../src/capabilities/registry.js";
import { menuCommand } from "../src/commands/parse.js";
import { AI_NOTICE, DATA_LINES, DATA_TITLE, dataStatement, REMOTE_LINE } from "../src/locales/transparency.js";

const PARTS: ReadonlySet<Part> = new Set<Part>(["github", "remote", "brief"]);

test("test_every_help_says_answers_are_ai_generated_and_carries_the_data_statement", () => {
  for (const lang of ["en", "zh"] as const) {
    for (const group of [false, true]) {
      for (const assistant of [false, true]) {
        const text = renderHelp(lang, { group, assistant, parts: PARTS });
        assert.ok(
          text.includes(AI_NOTICE[lang]) && text.includes(dataStatement(lang, !group)),
          `${lang} ${String(group)}`,
        );
        const last = text.split("\n\n").at(-1) ?? "";
        assert.ok(text.indexOf(`**${DATA_TITLE[lang]}**`) < text.length - last.length); // before the closing line
      }
    }
  }
});

test("test_where_remote_agents_are_on_a_1to1_help_says_an_attached_chat_goes_to_the_agent", () => {
  for (const lang of ["en", "zh"] as const) {
    assert.ok(renderHelp(lang, { parts: PARTS }).includes(REMOTE_LINE[lang]));
    assert.ok(renderHelp(lang, { parts: PARTS }).includes(dataStatement(lang, true)));
    assert.ok(!renderHelp(lang, { parts: new Set<Part>(["github"]) }).includes(REMOTE_LINE[lang])); // remote agents off
    assert.ok(!renderHelp(lang, { group: true, parts: PARTS }).includes(REMOTE_LINE[lang])); // a group cannot attach
  }
});

test("test_the_data_statement_says_what_is_seen_where_it_goes_how_long_and_how_to_stop", () => {
  const en = DATA_LINES.en.join(" ");
  for (const words of [
    "only the messages you send me",
    "@mention me",
    "Microsoft Teams",
    "Primus SaFE",
    "AMD APIM or runs on Primus",
    "until you delete them",
    "about a week",
    "30 days",
    "private repository",
    "Do not paste secrets",
    '"stop"',
    "Deleting a session",
    "marked deleted, not erased",
  ]) {
    assert.ok(en.includes(words), words);
  }
  assert.equal(DATA_LINES.zh.length, DATA_LINES.en.length); // one Chinese line for each English one
  const zh = DATA_LINES.zh.join(" ");
  for (const words of ["@我", "Primus SaFE", "AMD APIM", "运行在 Primus 上", "约一周", "30 天", "停一下", "并不抹掉"]) {
    assert.ok(zh.includes(words), words);
  }
});

test("test_the_stop_word_help_teaches_is_the_stop_command", () => {
  assert.equal(menuCommand("stop"), "/stop");
  assert.equal(naturalCommand("停一下"), "/stop");
});
