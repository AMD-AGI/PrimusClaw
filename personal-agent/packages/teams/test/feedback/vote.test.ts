// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Port of the thumbs-invoke tests of tests/test_feedback_discoverable.py (`activity.thumb_of`). */
import assert from "node:assert/strict";
import test from "node:test";

import { parseActivity } from "../../src/activity/inbound/schema.js";
import { voteOf } from "../../src/feedback/vote.js";

function activityOf(raw: Record<string, unknown>) {
  const parsed = parseActivity({ id: "a1", from: { id: "29:a", aadObjectId: "aad-a" }, ...raw });
  assert.ok(parsed.ok);
  return parsed.value;
}

function thumb(value: unknown): [string, string] | undefined {
  const vote = voteOf(activityOf({ type: "invoke", name: "message/submitAction", value }));
  return vote && [vote.reaction, vote.comment];
}

const fb = (actionValue: unknown): Record<string, unknown> => ({ actionName: "feedback", actionValue });

test("the feedback invoke is read tolerantly and nothing else is taken for it", () => {
  const cases: readonly (readonly [unknown, [string, string] | undefined])[] = [
    [fb({ reaction: "dislike", feedback: '{"feedbackText": "bad"}' }), ["dislike", "bad"]],
    [fb({ reaction: "like", feedback: '{"feedbackText": "Nice!"}' }), ["like", "Nice!"]],
    [fb({ reaction: "like", feedback: "{}" }), ["like", ""]],
    [fb({ reaction: "like" }), ["like", ""]],
    [fb({ reaction: "dislike", feedback: { feedbackText: "as an object" } }), ["dislike", "as an object"]],
    [fb({ reaction: "dislike", feedback: "plain words" }), ["dislike", "plain words"]],
    [fb({ reaction: "dislike", feedback: '{"feedbackText": 5}' }), ["dislike", ""]],
    [fb({ reaction: "dislike", feedback: '"  quoted  "' }), ["dislike", "quoted"]],
    [fb({ reaction: "meh" }), undefined],
    [fb("like"), undefined],
    [{ actionName: "other", actionValue: { reaction: "like" } }, undefined],
    ["feedback", undefined],
  ];
  for (const [value, expected] of cases) assert.deepEqual(thumb(value), expected, JSON.stringify(value));
});

test("only message submit action invokes are thumbs", () => {
  const value = fb({ reaction: "like" });
  assert.equal(voteOf(activityOf({ type: "invoke", name: "adaptiveCard/action", value })), undefined);
  assert.equal(voteOf(activityOf({ type: "message", name: "message/submitAction", value })), undefined);
});
