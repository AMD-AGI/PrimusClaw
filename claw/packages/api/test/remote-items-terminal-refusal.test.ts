// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** What the assistant says for a message the connector would not type into a terminal (`terminalRefusal`), in both languages. */
import assert from "node:assert/strict";
import test from "node:test";
import { terminalRefusal } from "../src/assistant/remote-items.js";

test("a terminal screen the connector could not read is said with what to do, in each language, never by its code", () => {
  const zh = terminalRefusal("terminal_screen_unknown", "", "zh");
  const en = terminalRefusal("terminal_screen_unknown", "", "en");
  assert.match(zh ?? "", /30 秒内都认不出那个终端的画面.*没有输入/);
  assert.match(en ?? "", /could not read the terminal's screen for 30 seconds .*nothing was typed/);
  for (const t of [zh, en]) assert.doesNotMatch(t ?? "", /terminal_screen_unknown/);
});

test("the codes an older connector sends are still said; a code it does not know is left to the caller", () => {
  assert.match(terminalRefusal("terminal_mode_not_allowed", "auto", "zh") ?? "", /终端会话处于 auto/);
  assert.match(terminalRefusal("terminal_command_refused", "", "en") ?? "", /starting with ! or \//);
  assert.equal(terminalRefusal("adapter_unavailable", "", "en"), null);
});
