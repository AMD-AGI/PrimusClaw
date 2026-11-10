// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

// No message can make reading it for a command slow. Each pattern a command said in plain words is read with is run over
// adversarial input (a word that leads into it, then a long run of spaces, then a tail that matches nothing): a pattern in
// which two `\s*` meet across an optional part splits the run between them in every way before it fails, polynomial in its
// length (the earlier patterns took seconds for 1,600 spaces). Above MAX_COMMAND_TEXT_CHARS (MAX_SESSION_CONTROL_CHARS for a sentence about
// the sessions) a message is not read at all, as in the Python worker.
import assert from "node:assert/strict";
import { test } from "node:test";

import { MAX_COMMAND_TEXT_CHARS, MAX_SESSION_CONTROL_CHARS } from "../../src/capabilities/command-text.js";
import { cpLength } from "../../src/text/py-text.js";
import { NATURAL_PATTERNS, naturalCommand } from "../../src/capabilities/natural.js";
import { parseRepo } from "../../src/commands/repo.js";
import { SESSION_PATTERNS, sessionControl, switchCommand } from "../../src/capabilities/sessions-words.js";

/** Words that lead into the patterns' optional parts, so the run of spaces lands between two of them. */
const LEADS = [
  "",
  "请",
  "帮我",
  "每",
  "每个",
  "每天",
  "工作日",
  "从",
  "早上",
  "8点",
  "先",
  "暂停",
  "2",
  "半",
  "2小时",
  "把",
  "我的",
  "免打扰",
  "免打扰时间",
  "以后",
  "用中文",
  "切到",
  "切到仓库",
  "新开",
  "新开一个",
  "切到dev",
  "切到dev的",
  "我要反馈",
  "please",
  "switch to",
  "open a new",
];
const TAILS = ["x", "!", "。x", "8点x"];
const SPACES = " ".repeat(50_000);
const LIMIT_MS = 500; // (the patterns take tens of ms here; the earlier ones took hours)

function slowest(read: (text: string) => unknown): readonly [number, string] {
  let worst: readonly [number, string] = [0, ""];
  for (const lead of LEADS) {
    for (const tail of TAILS) {
      const text = `${lead}${SPACES}${tail}`;
      const start = performance.now();
      read(text);
      const took = performance.now() - start;
      if (took > worst[0]) worst = [took, `${lead}|${tail}`];
    }
  }
  return worst;
}

for (const [family, patterns] of [...NATURAL_PATTERNS, ...SESSION_PATTERNS]) {
  for (const [i, pattern] of patterns.entries()) {
    test(`the ${family} pattern ${String(i)} reads 50,000 spaces and a tail that matches nothing in under ${String(LIMIT_MS)} ms`, () => {
      const [took, input] = slowest((text) => pattern.exec(text));
      assert.ok(took < LIMIT_MS, `${family}[${String(i)}] took ${took.toFixed(0)} ms on ${input}`);
    });
  }
}

test("a message over the limits is read for no command, quickly: 30,000 spaces and a tail", () => {
  for (const lead of ["免打扰", "每", "以后", "新开", "切到"]) {
    const text = `${lead}${" ".repeat(30_000)}x`;
    const start = performance.now();
    assert.equal(naturalCommand(text), text);
    assert.equal(sessionControl(text), false);
    assert.equal(switchCommand(text), null);
    assert.ok(performance.now() - start < 50, lead);
  }
});

/** `lead`, spaces, then `rest`: `length` characters as the message is read (the spaces are inside, so they count). */
function padded(lead: string, rest: string, length: number): string {
  return `${lead}${" ".repeat(length - cpLength(lead) - cpLength(rest))}${rest}`;
}

test("a command said in plain words exactly at its limit is still read", () => {
  assert.equal(naturalCommand(padded("以后", "用中文回复吧", MAX_COMMAND_TEXT_CHARS)), "/lang zh");
  assert.equal(
    switchCommand(padded("切到", "dev-pod 的 claude", MAX_COMMAND_TEXT_CHARS)),
    "/agent attach dev-pod/claude",
  );
  assert.equal(sessionControl(padded("新开", "一个会话", MAX_SESSION_CONTROL_CHARS)), true);
  assert.equal(sessionControl(padded("新开", "一个会话", MAX_SESSION_CONTROL_CHARS) + "。"), true); // (closing punctuation is off)
});

test("the same command one character over its limit is an ordinary message", () => {
  const lang = padded("以后", "用中文回复吧", MAX_COMMAND_TEXT_CHARS + 1);
  assert.equal(naturalCommand(lang), lang);
  assert.equal(switchCommand(padded("切到", "dev-pod 的 claude", MAX_COMMAND_TEXT_CHARS + 1)), null);
  assert.equal(sessionControl(padded("新开", "一个会话", MAX_SESSION_CONTROL_CHARS + 1)), false);
});

test("a long feedback sentence is still feedback: it is read before the limit", () => {
  const words = "太慢了".repeat(200);
  assert.equal(naturalCommand(`反馈：${words}`), `/feedback ${words}`);
});

test("a message just under the limit, built to make the readers work, is read quickly", () => {
  let worst = 0;
  for (const lead of LEADS) {
    for (const tail of TAILS) {
      const text = padded(lead, tail, MAX_COMMAND_TEXT_CHARS);
      const start = performance.now();
      naturalCommand(text);
      switchCommand(text);
      sessionControl(text);
      worst = Math.max(worst, performance.now() - start);
    }
  }
  assert.ok(worst < 100, `${worst.toFixed(1)} ms`); // (measured: ~31 ms the first time, before the patterns are warm)
});

/** The longest repository and branch GitHub and git (as the worker checks them) accept: owner 39, name 100, branch 200. */
const OWNER = `a${"b-".repeat(18)}cd`;
const NAME = "r".repeat(100);
const BRANCH = `${"feature/".repeat(24)}x${"y".repeat(7)}`;

test("the longest repository and branch can still be asked for in plain words, and with /repo", () => {
  assert.equal([OWNER.length, NAME.length, BRANCH.length].join(","), "39,100,200");
  const pick = parseRepo(`${OWNER}/${NAME} ${BRANCH}`);
  assert.deepEqual(pick, { repo: `${OWNER}/${NAME}`, branch: BRANCH }); // (the typed /repo)
  const command = `/repo ${OWNER}/${NAME} ${BRANCH}`;
  assert.equal(naturalCommand(`切到 ${OWNER}/${NAME} ${BRANCH} 分支`), command);
  assert.equal(naturalCommand(`switch to repo ${OWNER}/${NAME} ${BRANCH}`), command);
});
