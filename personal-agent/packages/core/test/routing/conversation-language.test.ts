// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// The conversation decides the language (test_conversation_language.py): English sentences that are commands, from a
// Chinese Teams client, set the language, and help says which one it now is.
import assert from "node:assert/strict";
import { test } from "node:test";

import { ALICE } from "./fixtures.js";
import { link, message, said, world } from "./world.js";

test("test_english_sentences_that_are_commands_set_the_language_help_reports", async () => {
  const w = world({ assistant: { on: () => true, reachable: () => true } });
  link(w, ALICE.id, "ak-alice");
  await w.router.handle(message("turn memory on", { locale: "zh-CN" }));
  await w.router.handle(message("what can you do", { locale: "zh-CN" }));
  const shown = said(w).at(-1) ?? "";
  assert.ok(
    shown.startsWith("**What PrimusClaw Assistant can do for you**") && shown.includes("(now: English, auto)"),
    shown,
  );
  assert.ok(!shown.includes("from Teams"), shown);
});
