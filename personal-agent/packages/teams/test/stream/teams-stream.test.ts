// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** Teams' stream rules, kept by the worker: one request a second, numbered, one open stream per conversation, text that grows. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { richMessage, textMessage } from "@primusclaw/personal-agent";

import { flushMicrotasks } from "../../../../test-support/clock.js";
import { DEFAULT_STYLE } from "../../src/config/style.js";
import { StreamRefusedError, type TeamsEnvelope } from "../../src/outbound/outbox.js";
import { RecordingDirect, RecordingQueue } from "../helpers/outboxes.js";
import { build, ref } from "../messenger/fixtures.js";

function infos(sent: readonly TeamsEnvelope[]): unknown[] {
  return sent.map((e) => (e.activity["entities"] as unknown[] | undefined)?.[0]);
}

test("a stream opens with its status, numbers its requests and ends with the answer as its final message", async () => {
  const direct = new RecordingDirect();
  const { conversation, clock, busy } = build(direct);
  const opened = await conversation.openStream("user-msg-1", "Thinking…");
  assert.ok(opened.ok);
  const stream = opened.value;
  assert.equal(stream.id, "stream-1"); // (the id the first request got)
  const informed = stream.inform("Reading  the\nfile");
  await flushMicrotasks();
  await clock.advance(1000);
  assert.deepEqual(await informed, { ok: true, value: undefined });
  const emitted = stream.emit("All");
  await flushMicrotasks();
  await clock.advance(1000);
  assert.ok((await emitted).ok);
  const finished = stream.finish({ ...richMessage("All green"), aiGenerated: true });
  await flushMicrotasks();
  await clock.advance(1000);
  assert.ok((await finished).ok);
  assert.deepEqual(
    direct.streamed.map((e) => [e.activity["type"], e.activity["text"], e.activity["replyToId"]]),
    [
      ["typing", "Thinking…", "user-msg-1"],
      ["typing", "Reading the file", "user-msg-1"],
      ["typing", "All", "user-msg-1"],
      ["message", direct.streamed[3]?.activity["text"], "user-msg-1"],
    ],
  );
  assert.deepEqual(infos(direct.streamed), [
    { type: "streaminfo", streamType: "informative", streamSequence: 1 },
    { type: "streaminfo", streamType: "informative", streamSequence: 2, streamId: "stream-1" },
    { type: "streaminfo", streamType: "streaming", streamSequence: 3, streamId: "stream-1" },
    { type: "streaminfo", streamType: "final", streamId: "stream-1" },
  ]);
  const final = direct.streamed[3]?.activity["entities"] as Array<Record<string, unknown>>;
  assert.equal(final[1]?.["type"], "https://schema.org/Message");
  assert.equal(busy.isBusy("conv"), false);
});

test("the status never exceeds one request a second however fast the caller goes", async () => {
  const direct = new RecordingDirect();
  const { conversation, clock } = build(direct);
  const opened = await conversation.openStream("user-msg-1", "a");
  assert.ok(opened.ok);
  const all = Promise.all([opened.value.inform("b"), opened.value.inform("c"), opened.value.inform("d")]);
  await flushMicrotasks();
  assert.equal(direct.streamed.length, 1);
  await clock.advance(999);
  assert.equal(direct.streamed.length, 1);
  await clock.advance(1);
  assert.equal(direct.streamed.length, 2);
  await clock.advance(2000);
  await all;
  assert.equal(direct.streamed.length, 4);
});

test("a second stream in one conversation is refused while the first may be open", async () => {
  const direct = new RecordingDirect();
  const { conversation } = build(direct);
  assert.ok((await conversation.openStream("user-msg-1", "a")).ok);
  const second = await conversation.openStream("user-msg-2", "b");
  assert.ok(!second.ok && second.error.reason.includes("may still be open"));
});

test("streams are refused on the queue, where the style has them off, and without a message to reply to", async () => {
  const queued = await build(new RecordingQueue()).conversation.openStream("user-msg-1", "a");
  assert.ok(!queued.ok && queued.error.reason === "this outbox cannot stream");
  const off = build(new RecordingDirect(), { style: { ...DEFAULT_STYLE, streaming: new Set<string>() } });
  assert.ok(!(await off.conversation.openStream("user-msg-1", "a")).ok);
  const channel = build(new RecordingDirect(), { ref: ref("ch", "channel") });
  assert.ok(!(await channel.conversation.openStream("user-msg-1", "a")).ok);
  assert.ok(!(await build(new RecordingDirect()).conversation.openStream("", "a")).ok);
});

test("a stream teams refuses breaks it, but a refused update leaves it closable", async () => {
  const direct = new RecordingDirect();
  direct.answerStream = (_e, n) => (n === 1 ? undefined : "x");
  const noId = await build(direct).conversation.openStream("user-msg-1", "a");
  assert.ok(!noId.ok && noId.error.reason === "Teams gave no stream id");

  const throttled = new RecordingDirect();
  throttled.answerStream = (_e, n) =>
    n === 1 ? "stream-1" : n === 2 ? new StreamRefusedError("status 429", 429, "Throttled") : undefined;
  const { conversation, clock } = build(throttled);
  const opened = await conversation.openStream("user-msg-1", "a");
  assert.ok(opened.ok);
  const informed = opened.value.inform("b");
  await flushMicrotasks();
  await clock.advance(1000);
  assert.deepEqual(await informed, {
    ok: false,
    error: { kind: "stream_refused", reason: "status 429", status: 429, code: "Throttled" },
  });
  const finished = opened.value.finish(textMessage("done"));
  await flushMicrotasks();
  await clock.advance(1000);
  assert.ok((await finished).ok);
});

test("a final teams refuses with its label is sent again on the stream without it", async () => {
  const direct = new RecordingDirect();
  direct.answerStream = (e, n) =>
    n === 1
      ? "stream-1"
      : Array.isArray(e.activity["entities"]) && e.activity["entities"].length > 1
        ? new StreamRefusedError("status 400", 400, "BadRequest")
        : "stream-1";
  const { conversation, clock } = build(direct);
  const opened = await conversation.openStream("user-msg-1", "a");
  assert.ok(opened.ok);
  const finished = opened.value.finish({ ...textMessage("All green"), aiGenerated: true });
  await flushMicrotasks();
  await clock.advance(1000);
  await flushMicrotasks();
  await clock.advance(1000);
  assert.ok((await finished).ok);
  assert.equal(direct.streamed.length, 3);
  assert.deepEqual(direct.streamed[2]?.activity["entities"], [
    { type: "streaminfo", streamType: "final", streamId: "stream-1" },
  ]);
});

test("streamed text must grow from what was streamed before", async () => {
  const direct = new RecordingDirect();
  const { conversation, clock } = build(direct);
  const opened = await conversation.openStream("user-msg-1", "a");
  assert.ok(opened.ok);
  const first = opened.value.emit("All green");
  await flushMicrotasks();
  await clock.advance(1000);
  assert.ok((await first).ok);
  await assert.rejects(opened.value.emit("Something else"), RangeError);
});

test("an outbox that fails in another way breaks the stream as a refusal, never a lost message", async () => {
  const direct = new RecordingDirect();
  direct.answerStream = (_e, n) => (n === 1 ? "stream-1" : new TypeError("bug"));
  const { conversation, clock } = build(direct);
  const opened = await conversation.openStream("user-msg-1", "a");
  assert.ok(opened.ok);
  const informed = opened.value.inform("b");
  await flushMicrotasks();
  await clock.advance(1000);
  assert.deepEqual(await informed, {
    ok: false,
    error: { kind: "stream_refused", reason: "TypeError", status: 0, code: "" },
  });
  assert.ok(!(await opened.value.inform("c")).ok);
});
