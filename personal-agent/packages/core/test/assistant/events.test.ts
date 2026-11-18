// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { it } from "node:test";

import {
  ASSISTANT_SUGGESTED_REPLIES,
  confirmActionOf,
  confirmWriteOf,
  remoteNoticeOf,
  shortPull,
  suggestedRepliesOf,
  PULL_LINK,
} from "../../src/assistant/events.js";

const exact = (text: string) => /^\/(board|agent|brief)\b/.test(text);

it("claws replies are checked again a command or a long line is no button", () => {
  const event = {
    type: "assistant.say",
    suggested_replies: ["/unlink", "two\nlines", "x".repeat(31), 7, "  ok  ", "ok", "a", "b", "c"],
  };
  assert.deepEqual(suggestedRepliesOf(event, "好", true), [
    ["ok", "ok"],
    ["a", "a"],
    ["b", "b"],
  ]);
  assert.deepEqual(
    suggestedRepliesOf({ ...event, suggested_replies: ["/unlink"] }, "好", true),
    ASSISTANT_SUGGESTED_REPLIES.zh,
  );
});

it("without claws own the defaults in the replys language and none with the switch off or under another event", () => {
  assert.deepEqual(suggestedRepliesOf({ type: "assistant.say" }, "done", true), ASSISTANT_SUGGESTED_REPLIES.en);
  assert.deepEqual(suggestedRepliesOf({ type: "assistant.say" }, "完成", true, "en"), ASSISTANT_SUGGESTED_REPLIES.en);
  assert.deepEqual(suggestedRepliesOf({ type: "assistant.say" }, "done", false), []);
  assert.deepEqual(suggestedRepliesOf({ type: "work_item.needs_you" }, "done", true), []);
  assert.ok(ASSISTANT_SUGGESTED_REPLIES.zh.every(([, value]) => value !== "/new"));
});

it("a command the assistant puts to the person is read only when it is one typed whole", () => {
  const say = (confirm: unknown) => ({ type: "assistant.say", confirm_action: confirm });
  assert.deepEqual(confirmActionOf(say({ name: " /board ", args: "", channel_message_id: "m1" }), exact), {
    channelMessageId: "m1",
    name: "board",
    args: "",
  });
  assert.deepEqual(
    confirmActionOf(say({ name: "agent", args: " attach   pod/claude ", channel_message_id: "m1" }), exact)?.args,
    "attach pod/claude",
  );
  for (const bad of [
    say({ name: "unlink", args: "", channel_message_id: "m1" }),
    say({ name: "board", args: "", channel_message_id: "" }),
    say({ name: "", channel_message_id: "m1" }),
    say({ name: "board", args: "x".repeat(201), channel_message_id: "m1" }),
    say("board"),
    { type: "work_item.needs_you", confirm_action: { name: "board", channel_message_id: "m1" } },
  ]) {
    assert.equal(confirmActionOf(bad, exact), undefined, JSON.stringify(bad));
  }
});

it("a held write is drawn only for the kinds this worker knows", () => {
  const say = (confirm: unknown) => ({ type: "assistant.say", confirm_write: confirm });
  assert.deepEqual(
    confirmWriteOf(say({ confirmation_id: "cf-1", kind: "trigger_create", allow_label: "  建  定时任务 " })),
    {
      confirmationId: "cf-1",
      kind: "trigger_create",
      allowLabel: "建 定时任务",
    },
  );
  assert.equal(
    confirmWriteOf(say({ confirmation_id: "cf-1", kind: "github_comment", allow_label: "x".repeat(60) }))?.allowLabel
      .length,
    40,
  );
  for (const bad of [
    say({ confirmation_id: "cf-1", kind: "rm_rf" }),
    say({ confirmation_id: "", kind: "trigger_cancel" }),
    say({ confirmation_id: "c".repeat(65), kind: "trigger_cancel" }),
    say(["x"]),
    { type: "work_item.needs_you", confirm_write: { confirmation_id: "cf", kind: "trigger_create" } },
  ]) {
    assert.equal(confirmWriteOf(bad), undefined, JSON.stringify(bad));
  }
});

it("a remote notice names its session and kind", () => {
  const notice = remoteNoticeOf({
    type: "assistant.say",
    remote: { kind: "needs_you", session_id: "rs-1", ask: { action_id: "a1" }, machine: "robin-dev", agent: 5 },
  });
  assert.deepEqual(notice, {
    kind: "needs_you",
    sessionId: "rs-1",
    ask: { action_id: "a1" },
    machine: "robin-dev",
    agent: "5",
  });
  for (const bad of [
    { type: "assistant.say", remote: { kind: "started", session_id: "rs-1" } },
    { type: "assistant.say", remote: { kind: "progress", session_id: "rs-1" } },
    { type: "assistant.say", remote: { kind: "done" } },
    { type: "assistant.say", remote: { kind: "done", session_id: "" } },
    { type: "work_item.needs_you", remote: { kind: "done", session_id: "rs-1" } },
    { type: "assistant.say" },
  ]) {
    assert.equal(remoteNoticeOf(bad), undefined);
  }
});

it("a pull request is named as people say it", () => {
  assert.equal(shortPull("https://github.com/AMD-AGI/PrimusClaw/pull/381"), "#381");
  assert.equal(shortPull("not a pull"), "not a pull");
  assert.ok(PULL_LINK.test("see https://github.com/AMD-AGI/PrimusClaw/pull/12 now"));
});
