// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A text message keeps its lines in Teams (whose markdown runs lines a single "\n" separates together): sent, edited, and
 * as the final message of a stream, which still contains every text streamed before it. A group chat's masking still
 * finds a credential written over several lines.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { NOTE, redactText, richMessage, textMessage } from "@primusclaw/personal-agent";

import { flushMicrotasks } from "../../../../test-support/clock.js";
import { teamsMasker } from "../../src/activity/redact-activity.js";
import { richActivity } from "../../src/messenger/render.js";
import { RecordingDirect, RecordingQueue } from "../helpers/outboxes.js";
import { build, ref } from "./fixtures.js";

function textOf(activity: Readonly<Record<string, unknown>> | undefined): string {
  const text = activity?.["text"];
  return typeof text === "string" ? text : "";
}

const TWO_PRS = "Opened:\nhttps://github.com/o/r/pull/804\nhttps://github.com/o/r/pull/805";
const TWO_PRS_SHOWN = "Opened:\n\nhttps://github.com/o/r/pull/804\n\nhttps://github.com/o/r/pull/805";

test("a text message is sent and edited with each line on a line of its own; a rich one is still HTML", async () => {
  const queue = new RecordingQueue();
  const { conversation } = build(queue);
  await conversation.send(textMessage(TWO_PRS));
  await conversation.update("m-1", textMessage("已开始审阅。\nReview started."));
  await conversation.send(richMessage("**A**\nB", { lead: false }));
  assert.deepEqual(queue.sent[0]?.activity, { type: "message", text: TWO_PRS_SHOWN, textFormat: "markdown" });
  assert.equal(queue.sent[1]?.activity["text"], "已开始审阅。\n\nReview started.");
  const rich = queue.sent[2]?.activity;
  assert.equal(rich?.["textFormat"], "xml");
  assert.ok(!textOf(rich).includes("\n\n"));
});

test("in a group chat a credential written over several lines is still masked", async () => {
  const queue = new RecordingQueue();
  const masker = teamsMasker((text) => redactText(text), NOTE);
  const { conversation } = build(queue, { ref: ref("g", "groupChat"), masker });
  const key = "-----BEGIN " + "PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0B\nAQEFAASC\n-----END " + "PRIVATE KEY-----";
  const token = "q8Zr2Lm4Np6Tx0Vb3Wc5Yd7Fg9Hj1Kk2";
  await conversation.send(textMessage(`Here:\n${key}\nand the token:\n${token}\nBearer\nabcdefghijklmnop1234`));
  const sent = textOf(queue.sent[0]?.activity);
  assert.ok(
    !sent.includes("MIIEvQIBADANBgkqhkiG9w0B") && !sent.includes(token) && !sent.includes("abcdefghijklmnop1234"),
  );
  assert.ok(sent.startsWith("Here:\n\n") && sent.endsWith(NOTE));
});

test("a streamed reply grows with its line breaks, and its final message starts with what was streamed", async () => {
  const direct = new RecordingDirect();
  const { conversation, clock } = build(direct);
  const opened = await conversation.openStream("user-msg-1", "Working");
  assert.ok(opened.ok);
  for (const end of [8, 20, 40, TWO_PRS.length]) {
    const emitted = opened.value.emit(TWO_PRS.slice(0, end));
    await flushMicrotasks();
    await clock.advance(1000);
    assert.ok((await emitted).ok);
  }
  const finished = opened.value.finish(textMessage(TWO_PRS));
  await flushMicrotasks();
  await clock.advance(1000);
  assert.ok((await finished).ok);
  const texts = direct.streamed.map((e) => textOf(e.activity));
  const streamed = texts.slice(1, -1);
  assert.deepEqual(streamed, [
    "Opened:",
    "Opened:\n\nhttps://gith",
    "Opened:\n\nhttps://github.com/o/r/pull/804",
    TWO_PRS_SHOWN,
  ]);
  streamed.forEach((text, i) => {
    assert.ok(text.startsWith(streamed[i - 1] ?? ""));
  });
  assert.equal(texts.at(-1), TWO_PRS_SHOWN);
  assert.equal(direct.streamed.at(-1)?.activity["textFormat"], "markdown");
});

test("a rich answer sent as markdown, because its HTML still held a credential shape, keeps its lines too", () => {
  const masker = {
    text: (text: string) => ({ text, hit: text.includes("<br>") }),
    activity: (a: never) => a,
    note: "",
  };
  assert.deepEqual(richActivity("A\nB", false, masker), { type: "message", text: "A\n\nB", textFormat: "markdown" });
});
