// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Which personal skills a message names (`namedUserSkills`), the rule the API's router turn and Brain's worker turn share. */
import test from "node:test";
import assert from "node:assert/strict";
import { namedUserSkills } from "../src/user-skill-names.js";

const NAMES = ["weekly-report", "standup-notes", "report", "deploy", "a.b"];

test("a hyphenated name is named wherever it stands as a word of its own, in any case", () => {
  assert.deepEqual(namedUserSkills("用 weekly-report 写本周周报", NAMES), ["weekly-report"]);
  assert.deepEqual(namedUserSkills("Use Weekly-Report please", NAMES), ["weekly-report"]);
  assert.deepEqual(namedUserSkills("/standup-notes today", NAMES), ["standup-notes"]);
  assert.deepEqual(namedUserSkills("用weekly-report写", NAMES), ["weekly-report"], "Chinese around it is no word of its own");
  assert.deepEqual(namedUserSkills("my-weekly-report-v2 is old", NAMES), [], "part of a longer name is not it");
  assert.deepEqual(namedUserSkills("weekly-reports", NAMES), []);
});

test("a one-word name only when marked as a skill's name", () => {
  assert.deepEqual(namedUserSkills("write the report for this week", NAMES), [], "an ordinary word");
  assert.deepEqual(namedUserSkills("deploy it now", NAMES), []);
  for (const text of ["/report now", "use `report`", "用「report」", "use the report skill", "用技能 report", "技能：deploy 上线", "\"deploy\" please"]) {
    assert.equal(namedUserSkills(text, NAMES).length, 1, text);
  }
});

test("in the order named, each once, at most two; nothing for an empty message or a name with a space", () => {
  assert.deepEqual(namedUserSkills("first standup-notes, then weekly-report, then /report", NAMES), ["standup-notes", "weekly-report"]);
  assert.deepEqual(namedUserSkills("standup-notes standup-notes", NAMES, 5), ["standup-notes"]);
  assert.deepEqual(namedUserSkills("", NAMES), []);
  assert.deepEqual(namedUserSkills("weekly report", ["weekly report"]), []);
  assert.deepEqual(namedUserSkills("use a.b now", NAMES), [], "a dot is not a wildcard, and a one-word name needs its mark");
  assert.deepEqual(namedUserSkills("use /a.b now", NAMES), ["a.b"]);
});

test("a /name inside a link or a path is no naming: only at the start or after a space", () => {
  const names = ["docs", "review"];
  assert.deepEqual(namedUserSkills("see https://github.com/acme/docs/tree/main", names), []);
  assert.deepEqual(namedUserSkills("look at src/review/index.ts", names), []);
  assert.deepEqual(namedUserSkills("/review this one", names), ["review"]);
  assert.deepEqual(namedUserSkills("please /docs now", names), ["docs"]);
});

