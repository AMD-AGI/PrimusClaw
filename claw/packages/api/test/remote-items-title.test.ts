// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** A remote item's title (`remoteTitle`): the machine's and the tool's names whole, what was asked cut after a whole word. */
import assert from "node:assert/strict";
import test from "node:test";
import { legacyRemoteTitle, remoteTitle, remoteTitleWithoutMachine } from "../src/assistant/remote-items.js";
import { clipWords, graphemes, TITLE_MAX } from "../src/assistant/work-items.js";

test("a long machine name keeps the tool's name and the whole first word of what was asked", () => {
  const machine = "gpu-dev-pod-7f3k2-node-0";
  // The title before: the whole line cut at 40 code points, "work" shown as "wor".
  assert.equal(legacyRemoteTitle(machine, "Claude Code", "work", "zh"), `${machine} Claude Code：wor`);
  assert.equal(remoteTitle(machine, "Claude Code", "work", "zh"), `${machine} Claude Code：work`);
  assert.equal(remoteTitle(machine, "Claude Code", "work on the flaky CI job", "en"), `${machine} Claude Code: work on the flaky…`);
  // Never fewer than 16 characters of what was asked: the word that crosses them is kept whole, past TITLE_MAX.
  assert.equal(remoteTitle(machine, "Claude Code", "please update connector settings", "en"), `${machine} Claude Code: please update connector…`);
  // A word too long to keep whole is cut where it must be.
  assert.equal(remoteTitle(machine, "Claude Code", "edit /home/u/work/claw/packages/api/src/assistant", "en"), `${machine} Claude Code: edit /home/u/work…`);
});

test("clipWords keeps at least what it is asked to, a crossing word whole, or the whole text when that word ends it", () => {
  assert.equal(clipWords("please update connector settings", 16), "please update…");
  assert.equal(clipWords("please update connector settings", 16, 15), "please update connector…");
  assert.equal(clipWords("please update connectors", 16, 15), "please update connectors");
  assert.equal(clipWords("please supercalifragilisticexpialidocious", 16, 15), "please supercal…");
});

test("what was asked is cut after its last whole word, with an ellipsis, and the title stays within TITLE_MAX when the names leave room", () => {
  const t = remoteTitle("laptop", "Codex", "please refactor the connector pairing flow to drop the legacy path", "en");
  assert.equal(t, "laptop Codex: please refactor the…");
  assert.ok(graphemes(t).length <= TITLE_MAX, t);
  assert.ok(!/\b(connec|conn|co)…$/.test(t), t);
});

test("Chinese breaks between any two characters; a word longer than the room is cut where it must be", () => {
  assert.equal(remoteTitle("laptop", "Claude Code", "修复连接器配对流程里的旧路径并补上测试和文档说明以及发布说明", "zh"), "laptop Claude Code：修复连接器配对流程里的旧路径并补上测试和…");
  assert.equal(clipWords("supercalifragilisticexpialidocious", 10), "supercali…");
});

test("an emoji or a combined character is never split, and is counted as one", () => {
  const family = "👨‍👩‍👧‍👦";
  assert.equal(clipWords(`${family}${family}${family}`, 2), `${family}…`);
  assert.equal(clipWords("café au lait", 6), "café…");
  assert.equal(graphemes(clipWords("é".repeat(50), 10)).length, 10);
});

test("text that fits is left as it is, on one line", () => {
  assert.equal(clipWords("  fix\n CI  ", 40), "fix CI");
  assert.equal(remoteTitle("laptop", "Claude Code", "修 CI", "zh"), "laptop Claude Code：修 CI");
  assert.equal(remoteTitle("laptop", "Claude Code", "", "en"), "laptop Claude Code:");
});

test("a title with no machine keeps the tool's name whole too", () => {
  assert.equal(remoteTitleWithoutMachine({ tool: "codex", agent_id: "codex-sessions", asked: "work on the flaky CI job in the release workflow", lang: "en" }),
    "Codex: work on the flaky CI job in the…");
});
