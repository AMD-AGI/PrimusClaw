// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** An outbound activity masked for a group chat: text and card text, never ids, verbs or a card's data. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { redactActivity, teamsMasker } from "../../src/activity/redact-activity.js";

const MASK = (text: string) => ({ text: text.replaceAll("sk-secret", "sk-***"), masked: text.includes("sk-secret") });
const NOTE = "(masked)";

test("text and card text are masked, and one line says so", () => {
  const activity = {
    type: "message",
    textFormat: "markdown",
    text: "key sk-secret",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: {
          type: "AdaptiveCard",
          body: [{ type: "TextBlock", text: "sk-secret", id: "sk-secret" }],
          actions: [{ type: "Action.Execute", verb: "sk-secret", data: { key: "sk-secret" }, title: "sk-secret" }],
        },
      },
    ],
  };
  const out = redactActivity(activity, MASK, NOTE);
  assert.deepEqual(out, {
    type: "message",
    textFormat: "markdown",
    text: "key sk-***\n\n(masked)",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: {
          type: "AdaptiveCard",
          body: [
            { type: "TextBlock", text: "sk-***", id: "sk-secret" },
            { type: "TextBlock", text: NOTE, wrap: true, isSubtle: true },
          ],
          actions: [{ type: "Action.Execute", verb: "sk-secret", data: { key: "sk-secret" }, title: "sk-***" }],
        },
      },
    ],
  });
  assert.equal(activity.text, "key sk-secret"); // (a copy)
});

test("an activity with nothing to mask is returned as it is", () => {
  const typing = { type: "typing" };
  assert.equal(redactActivity(typing, MASK, NOTE), typing);
  const card = { type: "message", attachments: ["x", { content: "y" }], value: 3 };
  assert.equal(redactActivity(card, MASK, NOTE), card);
});

test("the teams masker masks text and activities with the same rule", () => {
  const masker = teamsMasker(MASK, NOTE);
  assert.deepEqual(masker.text("sk-secret"), { text: "sk-***", hit: true });
  assert.equal(masker.note, NOTE);
  assert.deepEqual(masker.activity({ type: "message", text: "sk-secret", attachments: [{ content: { body: "x" } }] }), {
    type: "message",
    text: "sk-***\n\n(masked)",
    attachments: [{ content: { body: "x" } }],
  });
});
