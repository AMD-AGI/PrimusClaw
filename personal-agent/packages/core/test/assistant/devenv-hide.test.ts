// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { it } from "node:test";

import { confirmOutcome } from "../../src/assistant/confirm-outcome.js";
import { devenvHideOutcome } from "../../src/assistant/devenv-hide-outcome.js";
import { confirmWriteOf } from "../../src/assistant/events.js";

it("a hide cards outcome says how many conversations were hidden shown again and disconnected", () => {
  const done = { status: "done", answered_now: true, result: { hidden: 2, shown_again: 1, disconnected: 1 } };
  assert.equal(
    devenvHideOutcome("done", done, "zh"),
    "好了：隐藏了 2 段对话，恢复显示 1 段，断开 1 个会话。发 /agents 看看；说“显示隐藏的会话”可以恢复。",
  );
  assert.equal(
    confirmOutcome("devenv_hide", done, "en"),
    "Done: hid 2 conversations, showed 1 again, disconnected 1 sessions. Send /agents to see; say “show hidden sessions” to bring them back.",
  );
  assert.equal(
    devenvHideOutcome("done", { answered_now: true, result: { hidden: true } }, "en"),
    "Done; nothing needed changing.",
  );
  assert.equal(devenvHideOutcome("done", {}, "zh"), "这张卡已经处理过了。");
  assert.equal(devenvHideOutcome("denied", {}, "en"), "OK, nothing changed.");
  assert.equal(devenvHideOutcome("expired", {}, "zh"), "这张卡已过期，什么都没改。");
  assert.equal(
    devenvHideOutcome("failed", { result: { error: "connector_offline" } }, "en"),
    "It could not be done (connector_offline).",
  );
  assert.equal(devenvHideOutcome("failed", {}, "zh"), "没能完成（failed）。");
});

it("a held hide is a card this worker draws", () => {
  const event = {
    type: "assistant.say",
    confirm_write: { confirmation_id: "cf-9", kind: "devenv_hide", allow_label: "隐藏" },
  };
  assert.deepEqual(confirmWriteOf(event), { confirmationId: "cf-9", kind: "devenv_hide", allowLabel: "隐藏" });
});
