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

test("openPersonal opens a 1:1 only with a reachable person; members lists only a known roster", async () => {
  const member = {
    channelUserId: "29:1",
    userId: "u1",
    name: "Ada Lovelace",
    givenName: "Ada",
    surname: "Lovelace",
    email: "ada@example.com",
    userPrincipalName: "ada@example.com",
  };
  const surface = new FakeSurface({ reachable: ["u1"], rosters: { g1: [member] } });
  const group = testConversation("g1", "group");
  const personal = await surface.openPersonal(group, { channelUserId: "29:1", userId: "u1" });
  assert.equal(personal?.ref.id, "personal:u1");
  assert.equal(personal.ref.kind, "personal");
  assert.equal(personal.ref.tenantId, "tenant-1");
  assert.equal(await surface.openPersonal(group, { channelUserId: "29:2", userId: "u2" }), undefined);
  assert.deepEqual(await surface.members(group), [member]);
  assert.equal(await surface.members(testConversation("g2", "group")), undefined);
});

test("an update aborted before it is sent is not recorded and rejects with the reason", async () => {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const surface = new FakeSurface({ beforeUpdate: () => held });
  const c = surface.conversation(testConversation());
  await assert.rejects(
    c.update("m1", textMessage("late"), { signal: AbortSignal.abort(new Error("stopped before")) }),
    /stopped before/,
  );
  const controller = new AbortController();
  const inFlight = c.update("m1", textMessage("progress"), { signal: controller.signal });
  const other = c.update("m2", textMessage("kept"));
  controller.abort(new Error("stopped"));
  release();
  await assert.rejects(inFlight, /stopped/);
  await other;
  assert.deepEqual(
    surface.outbox.map((r) => (r.op === "update" ? r.id : r.op)),
    ["m2"],
  );
});

test("a channel that cannot edit refuses the update", async () => {
  const surface = new FakeSurface({ caps: { edit: false } });
  await assert.rejects(surface.conversation(testConversation()).update("m1", textMessage("x")), /cannot edit/);
  assert.deepEqual(surface.outbox, []);
});

test("markSettled counts a message as settled without editing it", () => {
  const surface = new FakeSurface();
  const c = surface.conversation(testConversation());
  assert.equal(c.edited.has("m7"), false);
  c.markSettled("m7");
  assert.equal(c.edited.has("m7"), true);
  assert.deepEqual(surface.outbox, []);
});

test("without a hold, an update is recorded at the call, in the order of the calls", () => {
  const surface = new FakeSurface();
  const c = surface.conversation(testConversation());
  void c.update("m1", textMessage("edited"));
  void c.send(textMessage("after"));
  assert.deepEqual(
    surface.outbox.map((r) => r.op),
    ["update", "send"],
  );
});

test("an update aborted while it is held rejects at once, before the hold ends, and is never recorded", async () => {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const surface = new FakeSurface({ beforeUpdate: () => held });
  const controller = new AbortController();
  const inFlight = surface.conversation(testConversation()).update("m1", textMessage("x"), {
    signal: controller.signal,
  });
  controller.abort(new Error("stopped while held"));
  await assert.rejects(inFlight, /stopped while held/);
  release();
  await held;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(surface.outbox, []);
});
