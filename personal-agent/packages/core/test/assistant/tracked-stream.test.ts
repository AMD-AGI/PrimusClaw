// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { it } from "node:test";

import { FakeClock } from "../../../../test-support/clock.js";
import { TrackedStream, streamOpener } from "../../src/assistant/tracked-stream.js";
import type { Conversation, LiveStream } from "../../src/ports/surface.js";
import { err, ok } from "../../src/result.js";

const refused = { kind: "stream_refused" as const, reason: "no", status: 403, code: "x" };

function live(refuse = false, id = "stream-1"): LiveStream & { calls: string[] } {
  const calls: string[] = [];
  const answer = () => Promise.resolve(refuse ? err(refused) : ok(undefined));
  return {
    id,
    calls,
    inform: (t) => (calls.push(`inform ${t}`), answer()),
    emit: (t) => (calls.push(`emit ${t}`), answer()),
    finish: () => (calls.push("finish"), answer()),
  };
}

it("the tracked stream keeps what was streamed its age and whether it is open", async () => {
  const clock = new FakeClock();
  const stream = new TrackedStream(live(), {} as Conversation, "act-1", clock);
  await clock.advance(3000);
  assert.equal(stream.ageSeconds(), 3);
  await stream.inform("step");
  await stream.emit("words");
  assert.equal(stream.streamed, "words");
  assert.equal(stream.streamId, "stream-1");
  assert.equal(stream.closable, true);
  await stream.final({ body: { type: "text", text: "words!" } });
  assert.equal(stream.open, false);
  assert.equal(stream.closable, false);
});

it("a stream the channel gave no id is never closable", () => {
  const stream = new TrackedStream(live(false, ""), {} as Conversation, "act-1", new FakeClock());
  assert.equal(stream.open, true);
  assert.equal(stream.streamId, "");
  assert.equal(stream.closable, false);
});

it("a refused update changes nothing it tracks", async () => {
  const stream = new TrackedStream(live(true), {} as Conversation, "act-1", new FakeClock());
  assert.equal((await stream.emit("words")).ok, false);
  assert.equal(stream.streamed, "");
  assert.equal((await stream.final({ body: { type: "text", text: "x" } })).ok, false);
  assert.equal(stream.open, true);
  assert.equal(stream.closable, true);
});

it("edits and deletes go to the conversation", async () => {
  const calls: string[] = [];
  const conversation = {
    update: (id: string) => Promise.resolve(void calls.push(`update ${id}`)),
    delete: (id: string) =>
      Promise.resolve(id === "bad" ? err({ kind: "delete_unsupported" as const, reason: "no" }) : ok(undefined)),
  } as unknown as Conversation;
  const stream = new TrackedStream(live(), conversation, "act-1", new FakeClock());
  await stream.update("m1", { body: { type: "text", text: "x" } });
  await stream.delete("m1");
  await assert.rejects(stream.delete("bad"), /no/);
  assert.deepEqual(calls, ["update m1"]);
});

it("the opener opens under the persons message and gives nothing when refused", async () => {
  const opened = live();
  const conversation = {
    openStream: (replyTo: string, status: string) =>
      Promise.resolve(replyTo === "act-1" && status === "Got it" ? ok(opened) : err(refused)),
  } as unknown as Conversation;
  const clock = new FakeClock();
  assert.ok((await streamOpener(conversation, "act-1", clock)("Got it")) instanceof TrackedStream);
  assert.equal(await streamOpener(conversation, "act-2", clock)("Got it"), undefined);
  assert.equal(await streamOpener(conversation, "", clock)("Got it"), undefined);
});
