// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Outbound activities, their envelopes, and the conversation reference they are addressed by. */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  activityOfReference,
  deleteEnvelope,
  envelope,
  referenceOf,
  textActivity,
  TYPING,
  withMention,
} from "../../src/activity/outbound.js";
import { withFeedbackLoop } from "../../src/activity/feedback-loop.js";

test("envelope shapes", () => {
  const activity = {
    id: "a1",
    serviceUrl: "https://smba/",
    channelId: "msteams",
    locale: "en-US",
    from: { id: "u" },
    recipient: { id: "b" },
    conversation: { id: "c" },
  };
  const ref = referenceOf(activity);
  assert.deepEqual(ref["bot"], { id: "b" });
  assert.deepEqual(ref["user"], { id: "u" });
  assert.equal(ref["activityId"], "a1");
  const env = envelope("update", ref, textActivity("x"), { activityId: "t1" });
  assert.ok(env.operation === "update" && env.activity_id === "t1" && !("ack" in env));
  assert.equal(envelope("send", ref, TYPING, { ack: "k" }).ack, "k");
});

test("a reference keeps the Python worker's keys and order, and turns back into an activity", () => {
  const ref = referenceOf({ id: "a1", serviceUrl: "https://s/", conversation: { id: "c" }, channelId: "msteams" });
  assert.equal(
    JSON.stringify(ref),
    '{"serviceUrl":"https://s/","conversation":{"id":"c"},"bot":null,"user":null,"activityId":"a1","channelId":"msteams"}',
  );
  assert.deepEqual(activityOfReference({ ...ref, locale: "zh-CN" }, "m-9"), {
    type: "message",
    id: "m-9",
    serviceUrl: "https://s/",
    conversation: { id: "c" },
    recipient: null,
    from: null,
    text: "",
    channelId: "msteams",
    locale: "zh-CN",
  });
  assert.deepEqual(activityOfReference({}, "m"), {
    type: "message",
    id: "m",
    serviceUrl: null,
    conversation: null,
    recipient: null,
    from: null,
    text: "",
  });
});

test("a delete carries an empty message", () => {
  assert.deepEqual(deleteEnvelope({ conversation: { id: "c" } }, "m"), {
    operation: "delete",
    reference: { conversation: { id: "c" } },
    activity: { type: "message" },
    activity_id: "m",
  });
});

test("a mention goes in front of the text, with its entity, and a name is cleaned first", () => {
  const out = withMention(
    { type: "message", text: "please look", entities: [{ type: "x" }, "junk"] },
    "29:a",
    " Lin\n<Mei> ",
  );
  assert.deepEqual(out, {
    type: "message",
    text: "<at>Lin Mei</at> please look",
    entities: [
      { type: "x" },
      { type: "mention", text: "<at>Lin Mei</at>", mentioned: { id: "29:a", name: "Lin Mei" } },
    ],
  });
  assert.equal(withMention({ type: "message" }, "29:a", "x".repeat(70))["text"], `<at>${"x".repeat(60)}</at> `);
  const plain = { type: "message", text: "x" };
  assert.equal(withMention(plain, "", "Lin"), plain);
  assert.equal(withMention(plain, "29:a", " <> "), plain);
});

test("teams' thumbs are asked for in channelData, keeping what else it has", () => {
  assert.deepEqual(withFeedbackLoop({ type: "message", channelData: { notification: { alert: true } } }), {
    type: "message",
    channelData: { notification: { alert: true }, feedbackLoop: { type: "default" } },
  });
  assert.deepEqual(withFeedbackLoop({ type: "message", channelData: "x" }), {
    type: "message",
    channelData: { feedbackLoop: { type: "default" } },
  });
});
