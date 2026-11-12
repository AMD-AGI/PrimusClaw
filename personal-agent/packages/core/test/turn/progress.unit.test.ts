// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The status message's live stream and progress message on their less common paths: a cancel while the stream is open
 * or opening, a status update the chat refuses, the chat's ten-minute limit, a progress message that never posted, a
 * stream closed after a refusal, and a policy of the caller's own.
 */

import assert from "node:assert/strict";
import { it } from "node:test";

import type { OutMessage } from "../../src/ports/surface.js";
import { LiveView } from "../../src/turn/live-view.js";
import { plainMessage } from "../../src/turn/progress/answer-messages.js";
import { StatusMessage, STREAM_CLOSE_SECONDS, turnStatusMessage } from "../../src/turn/progress/status-message.js";
import {
  defaultStreamFinish,
  type StatusPolicy,
  STREAM_TEXT_MAX,
  TurnStatusPolicy,
} from "../../src/turn/progress/status-policy.js";
import { statusText } from "../../src/turn/progress/status-text.js";
import { StreamHandle } from "../../src/turn/progress/stream-handle.js";
import type { Step } from "../../src/turn/step.js";
import { Timeline } from "./timeline.js";
import { Bus, type BusOptions, RecordingLogger, textOf } from "./world.js";

function streaming(options: BusOptions = {}, lang = "en") {
  const clock = new Timeline();
  const bus = new Bus(clock, options);
  const log = new RecordingLogger();
  const status = turnStatusMessage(bus, { clock, log, lang, streamReplyTo: "act-1" });
  return { clock, bus, log, status };
}

const RUNNING: Step = { tool: ["bash", "start"] };

it("a turn cancelled while its stream is open closes the stream with Interrupted, in the person's language", async () => {
  const { clock, bus, status } = streaming({}, "zh");
  status.begin();
  await clock.advanceTo(clock.start + 0.5);
  status.close(true);
  await clock.drain();
  assert.deepEqual(
    bus.streamOps.map((o) => [o.op, o.text]),
    [
      ["open", "思考中…"],
      ["finish", "已中断。"],
    ],
  );
});

it("a turn cancelled before its stream opened closes it as soon as it opens, and a refused close is only logged", async () => {
  const { clock, bus, log, status } = streaming({ stream: { refuse: (op) => (op.op === "finish" ? 500 : undefined) } });
  status.begin();
  status.close(true);
  await clock.drain();
  assert.deepEqual(
    bus.streamOps.map((o) => o.op),
    ["open"],
  );
  assert.ok(log.lines.some((l) => l.message.startsWith("the stream of a cancelled turn could not be closed")));
});

it("a status update the chat throttles is sent again after the interval; any other refusal hands over to the progress message", async () => {
  let refused = 0;
  const { clock, bus, log, status } = streaming({
    stream: { refuse: (op) => (op.op === "inform" && refused++ === 0 ? 429 : undefined) },
  });
  status.begin();
  status.progress(RUNNING);
  await clock.advanceTo(clock.start + 4);
  assert.deepEqual(
    bus.streamOps.map((o) => [o.op, o.text]),
    [
      ["open", "⏳ Running a command"],
      ["inform", "⏳ Running a command"],
    ],
  );
  assert.ok(log.lines.some((l) => l.message.startsWith("a status update of the turn's stream was not taken")));
  const broken = streaming({ stream: { refuse: (op) => (op.op === "inform" ? 500 : undefined) } });
  broken.status.begin();
  broken.status.progress(RUNNING);
  await broken.clock.advanceTo(broken.clock.start + 4);
  const posted = broken.bus.sent.filter((s) => s.operation === "send" && s.kind === "message");
  assert.equal(textOf(posted[0]?.message), "Working on it...\n\n⏳ Running a command");
  await broken.clock.pump(broken.status.finish(["the answer", "more"]));
  // the stream that was refused is still closed, with the first part, and the rest follows as messages
  assert.equal(broken.bus.streamOps.at(-1)?.op, "finish");
  assert.equal(broken.bus.streamOps.at(-1)?.text, "the answer");
  assert.ok(broken.bus.texts.includes("more") && !broken.bus.texts.includes("the answer"));
});

it("a refused stream with nothing to close it with is closed with Done, and one that refuses that too leaves the answer whole", async () => {
  const refuse = (finish: boolean) => (op: { op: string }) =>
    op.op === "inform" || (finish && op.op === "finish") ? 500 : undefined;
  const empty = streaming({ stream: { refuse: refuse(false) } });
  empty.status.begin();
  empty.status.progress(RUNNING);
  await empty.clock.advanceTo(empty.clock.start + 4);
  await empty.clock.pump(empty.status.finish([]));
  assert.equal(empty.bus.streamOps.at(-1)?.text, "Done.");
  const closed = streaming({ stream: { refuse: refuse(true) } });
  closed.status.begin();
  closed.status.progress(RUNNING);
  await closed.clock.advanceTo(closed.clock.start + 4);
  await closed.clock.pump(closed.status.finish(["one", "two"]));
  assert.ok(closed.bus.texts.includes("one") && closed.bus.texts.includes("two"));
  assert.ok(closed.log.lines.some((l) => l.message.startsWith("the refused stream could not be closed either")));
});

it("a stream still open at the chat's limit is closed with Still working, and the answer then comes as a message", async () => {
  const { clock, bus, status } = streaming();
  status.begin();
  await clock.advanceTo(clock.start + STREAM_CLOSE_SECONDS + 1);
  assert.equal(bus.streamOps.at(-1)?.text, "Still working on it; the result will follow as a new message.");
  await clock.pump(status.finish(["the answer"]));
  assert.deepEqual(bus.texts, ["the answer"]);
  const refused = streaming({ stream: { refuse: (op) => (op.op === "finish" ? 500 : undefined) } });
  refused.status.begin();
  await refused.clock.advanceTo(refused.clock.start + STREAM_CLOSE_SECONDS + 1);
  assert.ok(refused.log.lines.some((l) => l.message.startsWith("the turn's stream could not be closed before")));
});

it("a stream is closed a minute before its own chat's limit", async () => {
  const { clock, bus, status } = streaming();
  Object.assign(bus, { caps: { ...bus.caps, streamSeconds: 300 } }); // (a chat that keeps a stream five minutes)
  status.begin();
  await clock.advanceTo(clock.start + 239);
  assert.notEqual(bus.streamOps.at(-1)?.op, "finish");
  await clock.advanceTo(clock.start + 241);
  assert.equal(bus.streamOps.at(-1)?.text, "Still working on it; the result will follow as a new message.");
  assert.equal(STREAM_CLOSE_SECONDS, 540); // (Teams: ten minutes, as before)
});

it("a card waiting for the person closes the stream at once, even before it opened, and never again at the limit", async () => {
  const { clock, bus, log, status } = streaming({}, "zh");
  status.begin();
  status.awaitingChoice(); // (the stream is still opening)
  status.awaitingChoice();
  await clock.advanceTo(clock.start + 1);
  status.progress(RUNNING);
  await clock.advanceTo(clock.start + STREAM_CLOSE_SECONDS + 5);
  assert.deepEqual(
    bus.streamOps.map((o) => [o.op, o.text]),
    [
      ["open", "思考中…"],
      ["finish", "请在卡片里选择，选好后我接着做。"],
    ],
  );
  assert.ok(
    log.lines.some(
      (l) =>
        l.message.startsWith("the turn's stream was closed") && l.fields["why"] === "while a card waits for the person",
    ),
  );
  await clock.pump(status.finish(["答案"]));
  assert.deepEqual(bus.texts, ["答案"]);
  assert.equal(bus.streamOps.length, 2);
  // a refused close is only logged, and the answer still comes as a message
  const refused = streaming({ stream: { refuse: (op) => (op.op === "finish" ? 500 : undefined) } });
  refused.status.begin();
  await refused.clock.advanceTo(refused.clock.start + 0.5);
  refused.status.awaitingChoice();
  await refused.clock.advanceTo(refused.clock.start + 2);
  assert.ok(refused.log.lines.some((l) => l.message.startsWith("the turn's stream could not be closed while a card")));
  await refused.clock.pump(refused.status.finish(["the answer"]));
  assert.deepEqual(refused.bus.texts, ["the answer"]);
  // a cancel before the close is sent closes it with Interrupted instead
  const cancelled = streaming();
  cancelled.status.begin();
  cancelled.status.awaitingChoice();
  cancelled.status.close(true);
  await cancelled.clock.drain();
  assert.deepEqual(
    cancelled.bus.streamOps.map((o) => [o.op, o.text]),
    [
      ["open", "Thinking…"],
      ["finish", "Interrupted."],
    ],
  );
});

it("a card waiting for the person changes nothing on a progress message (it has no spinner)", async () => {
  const clock = new Timeline();
  const bus = new Bus(clock);
  const status = turnStatusMessage(bus, { clock, log: new RecordingLogger() });
  status.begin();
  status.awaitingChoice();
  await clock.advanceTo(clock.start + 2);
  await clock.pump(status.finish(["the answer"]));
  assert.deepEqual(bus.streamOps, []);
  assert.deepEqual(bus.texts, ["the answer"]);
});

it("a progress message whose post failed is never edited, and the answer still comes", async () => {
  const clock = new Timeline();
  const bus = new Bus(clock, { fail: (s) => Boolean(s.ack) });
  const log = new RecordingLogger();
  const status = turnStatusMessage(bus, { clock, log });
  status.begin();
  status.progress({ narration: "one" });
  await clock.advanceTo(clock.start + 2);
  await clock.pump(status.finish(["the answer"]));
  assert.deepEqual(bus.texts, ["the answer"]);
  assert.ok(!bus.sent.some((s) => s.operation === "update" || s.operation === "delete"));
  assert.ok(log.lines.some((l) => l.message === "posting the status message failed"));
});

it("a headline goes above the live view from the next edit on, once, and not after the status is closed", async () => {
  const clock = new Timeline();
  const bus = new Bus(clock);
  const status = turnStatusMessage(bus, { clock, log: new RecordingLogger(), lead: "LEAD" });
  status.begin();
  status.headline("RESULT");
  status.headline("RESULT");
  await clock.advanceTo(clock.start + 2);
  assert.deepEqual(
    bus.updates.map(([, text]) => text),
    ["LEAD\n\nRESULT\n\nWorking on it..."],
  );
  await clock.pump(status.finish(["done"]));
  status.headline("LATE");
  await clock.drain();
  assert.ok(!bus.everything().includes("LATE"));
});

it("a policy of the caller's own decides what the bubble holds and how it closes", async () => {
  const view = new LiveView();
  const inputs: unknown[] = [];
  const policy: StatusPolicy<string> = {
    view,
    applyStep: (step) => step === "grow",
    streamable: (streamed) => (streamed ? streamed : "WORDS"),
    finishStream: (input) => {
      inputs.push([input.streamed, input.streamable, input.parts]);
      return { final: plainMessage("FINAL"), rest: [plainMessage("AFTER")] };
    },
  };
  const clock = new Timeline();
  const bus = new Bus(clock);
  const status = new StatusMessage(bus, { clock, log: new RecordingLogger(), streamReplyTo: "act", policy });
  status.begin();
  status.progress("nothing");
  status.progress("grow");
  await clock.advanceTo(clock.start + 2);
  assert.equal(bus.streamOps.at(-1)?.op, "emit");
  await clock.pump(status.finish(["answer"]));
  assert.deepEqual(inputs, [["WORDS", "WORDS", ["answer"]]]);
  assert.equal(bus.streamOps.at(-1)?.text, "FINAL");
  assert.deepEqual(bus.texts, ["AFTER"]);
});

it("a final the chat refuses after text was streamed sends the whole answer as messages", async () => {
  const clock = new Timeline();
  const bus = new Bus(clock, { stream: { refuse: (op) => (op.op === "finish" ? 500 : undefined) } });
  const log = new RecordingLogger();
  const status = turnStatusMessage(bus, { clock, log, streamReplyTo: "act", streamText: true });
  status.begin();
  status.progress({ partial: "Hello" });
  await clock.advanceTo(clock.start + 2);
  await clock.pump(status.finish(["Hello world"], { ai: true }));
  assert.deepEqual(bus.texts, ["Hello world"]);
  assert.ok(log.lines.some((l) => l.message.startsWith("the stream's final message was refused")));
});

it("the default close keeps the streamed text, puts thumbs and replies on it when it is the whole answer, else sends the answer after it", () => {
  const replies = [{ title: "Go", value: "go" }];
  const messages: OutMessage[] = [{ ...plainMessage("Hello world"), suggestions: replies }];
  const whole = defaultStreamFinish({
    streamed: "Hello",
    streamable: "Hello world",
    messages,
    parts: ["Hello world"],
    options: { feedback: true, ai: true },
  });
  assert.deepEqual(whole, {
    final: { body: { type: "text", text: "Hello world" }, aiGenerated: true, feedback: true, suggestions: replies },
    rest: [],
  });
  const partial = defaultStreamFinish({ streamed: "Hi", streamable: "", messages, parts: ["Other"], options: {} });
  assert.deepEqual(partial, { final: plainMessage("Hi"), rest: messages });
});

it("a Claw turn's policy streams nothing without text streaming, and stops growing past the limit or off what was streamed", () => {
  const off = new TurnStatusPolicy(new LiveView(), false);
  assert.equal(off.applyStep({ narration: "x" }), true);
  assert.equal(off.streamable(""), "");
  const on = new TurnStatusPolicy(new LiveView(), true);
  on.applyStep({ narration: "First." });
  on.applyStep({ partial: "Sec" });
  assert.equal(on.streamable(""), "First.\n\nSec");
  assert.equal(on.streamable("Other"), "Other");
  on.applyStep({ narration: "y".repeat(STREAM_TEXT_MAX) });
  assert.equal(on.streamable("First."), "First.");
});

it("a status update is cut to its limits keeping the newest, never starting with a lone combining mark", () => {
  assert.equal(statusText(["a  b", " ", "c"]), "a b · c");
  const long = statusText(["x".repeat(1200)]);
  assert.equal(Array.from(long).length, 1000);
  assert.ok(long.startsWith("…x"));
  const wide = statusText(["中".repeat(500)]);
  assert.ok(new TextEncoder().encode(wide).length <= 1024 && wide.startsWith("…中"));
  // the 999 newest characters start with a combining mark: it goes, with nothing put in its place
  assert.equal(statusText([`${"a".repeat(10)}\u0301${"b".repeat(998)}`]), `…${"b".repeat(998)}`);
});

it("a stream handle refuses what its stream can no longer take", async () => {
  const clock = new Timeline();
  const bus = new Bus(clock, {
    stream: { refuse: (op) => (op.op === "inform" ? 429 : op.op === "emit" ? 500 : undefined) },
  });
  const handle = new StreamHandle(bus, "act", clock);
  assert.equal(handle.age(), 0);
  assert.equal((await handle.inform("x")).ok, false); // not open yet
  assert.equal((await handle.final(plainMessage("x"))).ok, false);
  assert.equal((await handle.start("hi")).ok, true);
  assert.equal((await handle.inform("throttled")).ok, false);
  assert.equal(handle.open, true); // a 429 leaves it usable
  assert.equal((await handle.emit("abc")).ok, false);
  assert.equal(handle.open, false); // any other refusal ends it
  assert.equal(handle.closable, true);
  assert.equal((await handle.emit("abcd")).ok, false);
  assert.equal((await handle.final(plainMessage("end"))).ok, true);
  assert.equal(handle.closable, false);
  assert.equal((await handle.final(plainMessage("again"))).ok, false);
  const growing = new StreamHandle(new Bus(clock), "act", clock);
  await growing.start("hi");
  assert.equal((await growing.emit("abc")).ok, true);
  const shrunk = await growing.emit("xyz");
  assert.equal(shrunk.ok ? "" : shrunk.error.reason, "streamed text must grow from what was streamed");
  const refusedFinal = new StreamHandle(
    new Bus(clock, { stream: { refuse: (op) => (op.op === "finish" ? 429 : undefined) } }),
    "act",
    clock,
  );
  await refusedFinal.start("hi");
  assert.equal((await refusedFinal.final(plainMessage("x"))).ok, false);
  assert.equal(refusedFinal.open, true);
  const refusedOpen = new StreamHandle(new Bus(clock, { stream: { refuse: () => 403 } }), "act", clock);
  assert.equal((await refusedOpen.start("hi")).ok, false);
});
