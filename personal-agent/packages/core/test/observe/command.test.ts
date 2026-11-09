// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import { parseObserve, scopeOf } from "../../src/observe/command.js";
import { NOT_SUGGESTIONS, describe as describeCall, toolOf } from "../../src/observe/suggestions.js";

const CONV = "19:observed@thread.v2";

test("the command is read only when it is the command", () => {
  assert.equal(parseObserve("/observe on"), "on");
  assert.equal(parseObserve("observe off"), "off");
  assert.equal(parseObserve("/observe"), "status");
  assert.equal(parseObserve("/OBSERVE 开"), "on");
  assert.equal(parseObserve("/observe 关闭"), "off");
  assert.equal(parseObserve("/observe 状态"), "status");
  assert.equal(parseObserve("/observe maybe"), "usage");
  assert.equal(parseObserve("/observe on now"), "usage");
  assert.equal(parseObserve("observe"), undefined);
  assert.equal(parseObserve("please observe on"), undefined);
  assert.equal(parseObserve(""), undefined);
});

test("a verb that names an Object.prototype property is no verb", async (t) => {
  // Expected values are python3's parse_observe: a dict has none of these keys, so each is "usage".
  const names = [
    "constructor",
    "CONSTRUCTOR",
    "__proto__",
    "toString",
    "hasOwnProperty",
    "valueOf",
    "isPrototypeOf",
    "__defineGetter__",
  ];
  for (const name of names) {
    await t.test(`/observe ${name}`, () => {
      assert.equal(parseObserve(`/observe ${name}`), "usage");
      assert.equal(parseObserve(`observe ${name}`), "usage");
    });
  }
});

test("a scope is only an id claw takes", () => {
  assert.equal(scopeOf(CONV), `group:teams:${CONV}`);
  assert.equal(scopeOf(""), undefined);
  assert.equal(scopeOf("a b"), undefined);
  assert.equal(scopeOf("a　b"), undefined);
  assert.equal(scopeOf("x".repeat(161)), undefined);
  assert.equal(scopeOf("x".repeat(160)), `group:teams:${"x".repeat(160)}`);
});

test("a suggestion shows a reply's text, a task's title and brief, else the call's arguments", () => {
  assert.equal(toolOf("mcp__assistant__say"), "say");
  assert.equal(toolOf("say"), "say");
  assert.equal(toolOf(undefined), "");
  assert.deepEqual(describeCall("say", { text: "on it" }), { kind: "在群里回复 / Reply in the group", what: "on it" });
  assert.deepEqual(describeCall("say", "not an object"), { kind: "在群里回复 / Reply in the group", what: "" });
  assert.deepEqual(describeCall("work_create", { title: "Fix CI", brief: "" }), {
    kind: "新建任务 / Start a task",
    what: "Fix CI",
  });
  assert.deepEqual(describeCall("work_create", { brief: "only brief" }), {
    kind: "新建任务 / Start a task",
    what: "only brief",
  });
  assert.deepEqual(describeCall("remind", { at: "09:00", what: "站会" }), {
    kind: "remind",
    what: '{"at": "09:00", "what": "站会"}',
  });
  assert.equal(describeCall("remind", { x: "y".repeat(2000) }).what.length, 1200);
  assert.deepEqual(describeCall("remind", ["a"]), { kind: "remind", what: "{}" });
});

test("lookups are no suggestions", () => {
  for (const tool of ["pass", "memory_recall", "work_recall", "devenv_list", "trigger_list", "job_watch_list"]) {
    assert.ok(NOT_SUGGESTIONS.has(tool));
  }
  assert.ok(NOT_SUGGESTIONS.has("claw_self_status") && NOT_SUGGESTIONS.has("brief") && !NOT_SUGGESTIONS.has("say"));
});
