// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test from "node:test";
import { textMessage } from "@primusclaw/personal-agent";
import { FakeSurface, testConversation } from "./index.js";

test("every outbound operation is recorded in order, per conversation", async () => {
  const surface = new FakeSurface();
  const one = surface.conversation(testConversation("c1"));
  const two = surface.conversation(testConversation("c2", "group"));
  await one.typing();
  const id = await one.post(textMessage("working"));
  await two.send(textMessage("hi all"));
  assert.equal(id, "m1");
  await one.update("m1", textMessage("done"));
  assert.deepEqual(await one.delete("m1"), { ok: true, value: undefined });
  assert.deepEqual(
    surface.outbox.map((r) => r.op),
    ["typing", "post", "send", "update", "delete"],
  );
  assert.deepEqual(
    surface.of("c2").map((r) => r.op),
    ["send"],
  );
  assert.ok(one.edited.has("m1"));
  assert.equal(one.ref.kind, "personal");
});

test("what the channel cannot do is refused: no delete, no stream, no message ids", async () => {
  const surface = new FakeSurface({ caps: { delete: false, streaming: false, messageIds: false } });
  const c = surface.conversation(testConversation());
  assert.equal(await c.post(textMessage("x")), undefined);
  const deleted = await c.delete("m1");
  assert.ok(!deleted.ok);
  assert.equal(deleted.error.kind, "delete_unsupported");
  const stream = await c.openStream("in-1", "Thinking…");
  assert.ok(!stream.ok);
  assert.equal(stream.error.kind, "stream_refused");
});

test("a stream's text only grows, and a finished stream takes nothing more", async () => {
  const surface = new FakeSurface();
  const opened = await surface.conversation(testConversation()).openStream("in-1", "Thinking…");
  assert.ok(opened.ok);
  const stream = opened.value;
  assert.ok((await stream.inform("Searching…")).ok);
  assert.ok((await stream.emit("Hel")).ok);
  assert.ok((await stream.emit("Hello")).ok);
  assert.equal((await stream.emit("Help")).ok, false);
  assert.ok((await stream.finish(textMessage("Hello."))).ok);
  for (const late of [stream.inform("x"), stream.emit("Hello again"), stream.finish(textMessage("x"))]) {
    assert.equal((await late).ok, false);
  }
  assert.deepEqual(
    surface.outbox.map((r) => r.op),
    ["stream.open", "stream.inform", "stream.emit", "stream.emit", "stream.finish"],
  );
});

test("fetchFile gives the bytes of a known file and refuses any other", async () => {
  const surface = new FakeSurface({
    files: { "a.txt": { mediaType: "text/plain", bytes: new Uint8Array([104, 105]) } },
  });
  const got = await surface.fetchFile({ name: "a.txt", type: "txt", handle: {} });
  assert.deepEqual(got, {
    ok: true,
    value: { name: "a.txt", mediaType: "text/plain", bytes: new Uint8Array([104, 105]) },
  });
  assert.deepEqual(await surface.fetchFile({ name: "b.txt", type: "txt", handle: {} }), {
    ok: false,
    error: { kind: "file_refused", reason: "unreachable" },
  });
});

test("an envelope built by outgoing is sent only when delivered, as the send it stands for", async () => {
  const surface = new FakeSurface();
  const c = surface.conversation(testConversation("c1"));
  const message = { ...textMessage("approve?"), suggestions: [{ title: "Back to Clawy", value: "back to Clawy" }] };
  const envelope = c.outgoing(message);
  assert.deepEqual(surface.outbox, []);
  const stored = JSON.parse(JSON.stringify(envelope)) as typeof envelope;
  await c.deliver(stored);
  assert.deepEqual(surface.outbox, [{ op: "send", conversation: "c1", message }]);
  const other = surface.conversation(testConversation("c2"));
  await assert.rejects(other.deliver(stored), /not an envelope of this conversation/);
});
