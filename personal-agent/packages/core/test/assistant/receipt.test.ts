// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import { it } from "node:test";

import { FakeClock, flushMicrotasks } from "../../../../test-support/clock.js";
import { INFORMATIVE_MAX_BYTES, INFORMATIVE_MAX_CHARS, informativeText } from "../../src/assistant/informative.js";
import { RECEIPT_CLOSE_SECONDS, STREAM_SAY_MAX } from "../../src/assistant/receipt.js";
import { ReceiptConversation, Receipts, withPostscript } from "../../src/assistant/receipts.js";
import { silentLogger } from "../../src/ports/logger.js";
import type { Conversation, OutMessage } from "../../src/ports/surface.js";
import { FakeReceiptStream } from "./receipt-fakes.js";

const text = (t: string): OutMessage => ({ body: { type: "text", text: t } });

async function opened(lang: "zh" | "en" = "zh") {
  const clock = new FakeClock();
  const receipts = new Receipts(clock, silentLogger);
  const stream = new FakeReceiptStream();
  let status = "";
  const receipt = await receipts.openIn("c1", lang, (s) => {
    status = s;
    return Promise.resolve(stream);
  });
  assert.ok(receipt);
  return { clock, receipts, stream, receipt, status };
}

it("the receipt opens with got it and only once per conversation", async () => {
  const { receipts, status } = await opened();
  assert.equal(status, "收到，处理中");
  assert.equal(await receipts.openIn("c1", "en", () => Promise.resolve(new FakeReceiptStream())), undefined);
  assert.equal(await receipts.openIn("c2", "en", () => Promise.resolve(undefined)), undefined);
  const off = new Receipts(new FakeClock(), silentLogger, () => false);
  assert.equal(await off.openIn("c3", "en", () => Promise.resolve(new FakeReceiptStream())), undefined);
});

it("the receipt shows the steps then streams the words and the reply closes it with them whole", async () => {
  const { stream, receipt, receipts } = await opened();
  receipt.showStep("查询 SaFE 节点…");
  await flushMicrotasks();
  receipt.showText("节点：12 个");
  await flushMicrotasks();
  receipt.showStep("ignored once words show");
  receipt.showText("节点：12 个就绪");
  await flushMicrotasks();
  const taken = receipts.take("c1");
  assert.equal(taken, receipt);
  assert.ok(
    await receipt.deliver({ ...text("节点：12 个就绪，3 个忙。"), aiGenerated: true }, "节点：12 个就绪，3 个忙。"),
  );
  assert.deepEqual(
    stream.ops.map((o) => o.op),
    ["inform", "emit", "emit", "final"],
  );
  assert.deepEqual(stream.finals(), ["节点：12 个就绪，3 个忙。"]);
  const final = stream.ops.at(-1);
  assert.ok(final?.op === "final" && final.message.aiGenerated === true);
  assert.equal(receipts.take("c1"), undefined);
});

it("without words the reply closes the receipt as it is", async () => {
  const { stream, receipt } = await opened();
  receipt.showStep("step");
  await flushMicrotasks();
  assert.ok(
    await receipt.deliver({ body: { type: "view", view: { name: "question", model: {} as never }, fallbackText: "" } }),
  );
  assert.deepEqual(stream.finals(), ["view:question"]);
});

it("a reply that is not what was streamed replaces those words", async () => {
  const { stream, receipt } = await opened();
  receipt.showText("已把 Primus");
  await flushMicrotasks();
  assert.ok(await receipt.deliver(text("这个 review 交给了 Robin。"), "这个 review 交给了 Robin。"));
  assert.deepEqual(stream.finals(), ["这个 review 交给了 Robin。"]);
});

it("a refused replacing final is edited into place and deleted when it cannot be", async () => {
  const { stream, receipt } = await opened();
  stream.refuseShrinkingFinal = true;
  receipt.showText("words");
  await flushMicrotasks();
  assert.ok(await receipt.deliver(text("other"), "other"));
  assert.deepEqual(stream.finals(), ["words"]);
  assert.deepEqual(stream.ops.at(-1), { op: "update", id: "stream-1", message: text("other") });

  const second = await opened();
  second.stream.refuseShrinkingFinal = true;
  second.stream.refuseUpdates = true;
  second.receipt.showText("words");
  await flushMicrotasks();
  assert.equal(await second.receipt.deliver(text("other"), "other"), false);
  assert.deepEqual(second.stream.ops.at(-1), { op: "delete", id: "stream-1" });
});

it("a long reply streamed whole with a trailing blank is not said again", async () => {
  const { stream, receipt } = await opened();
  receipt.showText("answer ");
  await flushMicrotasks();
  assert.ok(await receipt.deliver(text("answer"), "answer"));
  assert.deepEqual(stream.finals(), ["answer "]);
});

it("a view after streamed words closes the stream with the words and is a message of its own", async () => {
  const { stream, receipt } = await opened();
  receipt.showText("result");
  await flushMicrotasks();
  const card: OutMessage = {
    body: { type: "view", view: { name: "question", model: {} as never }, fallbackText: "result" },
  };
  assert.equal(await receipt.deliver(card, "result"), false);
  assert.deepEqual(stream.finals(), ["result"]);
});

it("words known not to be said are not streamed and not closed in", async () => {
  const { stream, receipt, clock } = await opened("en");
  receipt.showText("half a refused say");
  await flushMicrotasks();
  receipt.voidText();
  receipt.showText("half a refused say and more");
  await clock.advance(RECEIPT_CLOSE_SECONDS * 1000);
  assert.deepEqual(stream.finals(), ["This is running in the background; I will message you here when it is done."]);
});

it("a receipt that hears nothing closes itself in time keeping what it showed", async () => {
  const { stream, receipt, clock, receipts } = await opened();
  receipt.showText("部分");
  await flushMicrotasks();
  await clock.advance(RECEIPT_CLOSE_SECONDS * 1000 - 1);
  assert.equal(stream.finals().length, 0);
  await clock.advance(1);
  assert.deepEqual(stream.finals(), ["部分\n\n已转为后台处理，完成后在这里通知你。"]);
  assert.equal(receipts.openOf("c1"), undefined);
  assert.equal(receipt.done, true);
});

it("a receipt closes itself a minute before its channel would close the stream", async () => {
  const clock = new FakeClock();
  const receipts = new Receipts(clock, silentLogger);
  const stream = Object.assign(new FakeReceiptStream(), { lifetimeSeconds: 300 });
  const receipt = await receipts.openIn("c1", "en", () => Promise.resolve(stream));
  assert.ok(receipt);
  await clock.advance(240 * 1000 - 1);
  assert.equal(stream.finals().length, 0);
  await clock.advance(1);
  assert.equal(stream.finals().length, 1);
  assert.equal(RECEIPT_CLOSE_SECONDS, 540); // (a channel that keeps a stream 10 minutes, Teams: as before)
});

it("words that do not grow or pass the limit are not shown", async () => {
  const { stream, receipt } = await opened();
  receipt.head = "💬 **Clawy**";
  receipt.showText("abc");
  await flushMicrotasks();
  receipt.showText("xyz");
  receipt.showText("abc".repeat(STREAM_SAY_MAX));
  await flushMicrotasks();
  assert.deepEqual(
    stream.ops.map((o) => (o.op === "emit" ? o.text : o.op)),
    ["💬 **Clawy**\n\nabc"],
  );
});

it("a refused update ends showing and the reply still closes the receipt", async () => {
  const { stream, receipt } = await opened();
  stream.refuseAll = true;
  receipt.showStep("one");
  await flushMicrotasks();
  receipt.showStep("two");
  await flushMicrotasks();
  stream.refuseAll = false;
  assert.ok(await receipt.deliver(text("done")));
  assert.deepEqual(stream.finals(), ["done"]);
});

it("a reserved receipt is taken only by the answer it is kept for", async () => {
  const { receipts, receipt, stream } = await opened();
  assert.equal(receipts.reserve("c1", "other"), undefined);
  assert.equal(receipts.reserve("c1", "act-1"), receipt);
  receipt.showText("ignored");
  assert.equal(receipts.take("c1"), undefined);
  const sent: OutMessage[] = [];
  const inner = { send: (m: OutMessage) => Promise.resolve(void sent.push(m)) } as unknown as Conversation;
  const answer = new ReceiptConversation(inner, receipts, receipt, ["也看看 #12"]);
  await answer.send({ body: { type: "view", view: { name: "question", model: {} as never }, fallbackText: "" } });
  await answer.send(text("已开始代审 #7。"));
  assert.deepEqual(stream.finals(), ["已开始代审 #7。\n\n另外：也看看 #12"]);
  await answer.send(text("later"));
  assert.equal(sent.length, 2);
  await answer.sayPostscript();
  assert.equal(sent.length, 2);
});

it("a released answer gives the receipt back and the postscript is said on its own", async () => {
  const { receipts, receipt } = await opened();
  receipts.reserve("c1", "act-1");
  const sent: OutMessage[] = [];
  const inner = { send: (m: OutMessage) => Promise.resolve(void sent.push(m)) } as unknown as Conversation;
  const answer = new ReceiptConversation(inner, receipts, receipt, ["note"]);
  answer.release();
  assert.equal(receipt.reserved, false);
  await answer.sayPostscript();
  assert.deepEqual(sent, [text("note")]);
  assert.equal(receipts.take("c1"), receipt);
});

it("with postscript keeps the format and picks the lead by language", () => {
  assert.deepEqual(withPostscript(text("Started #7.  "), ["see #12"]), text("Started #7.\n\nAlso: see #12"));
  assert.deepEqual(withPostscript({ body: { type: "rich", markdown: "a", lead: true } }, ["b", "c"]), {
    body: { type: "rich", markdown: "a\n\nAlso: b\n\nc", lead: true },
  });
});

it("informative text keeps the newest end within both limits", () => {
  assert.equal(informativeText(["a  b", " ", "c"]), "a b · c");
  const long = informativeText(["x".repeat(2000)]);
  assert.equal(Array.from(long).length, INFORMATIVE_MAX_CHARS);
  assert.ok(long.startsWith("…x"));
  const wide = informativeText(["节".repeat(600)]);
  assert.ok(new TextEncoder().encode(wide).length <= INFORMATIVE_MAX_BYTES && wide.startsWith("…节"));
  assert.equal(informativeText(["á".repeat(600)]).charAt(1), "a");
});

it("the answer of a handed back review passes everything else to its conversation", async () => {
  const { FakeSurface, testConversation } = await import("../../../../test-support/surface.js");
  const surface = new FakeSurface();
  const inner = surface.conversation(testConversation("c9"));
  const receipts = new Receipts(new FakeClock(), silentLogger);
  const answer = new ReceiptConversation(inner, receipts, undefined);
  assert.equal(answer.ref.id, "c9");
  assert.equal(answer.edited, inner.edited);
  await answer.typing();
  const id = await answer.post(text("posted"));
  assert.ok(id);
  await answer.update(id, text("edited"));
  assert.equal((await answer.delete(id)).ok, true);
  const envelope = answer.outgoing(text("queued"));
  await answer.deliver(envelope);
  assert.equal((await answer.openStream("act-1", "status")).ok, true);
  assert.deepEqual(
    surface.outbox.map((r) => r.op),
    ["typing", "post", "update", "delete", "send", "stream.open"],
  );
});
