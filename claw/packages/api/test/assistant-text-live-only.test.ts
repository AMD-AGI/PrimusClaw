// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Brain's live-only text events (`assistantTextDelta`, `assistantTextVoid`, `@claw/protocol`) on the API's two paths: the consumer
 * acks them and stores nothing, and the turn's `AssistantMessage`, which carries the whole text and names the stream (`text_id`),
 * is stored as before. The SSE stream forwards both verbatim under their own event names (`historySegment` frames a stored row
 * exactly as the live loop frames a live one).
 */
import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";

import { ASSISTANT_TEXT_DELTA_EVENT, ASSISTANT_TEXT_VOID_EVENT } from "@claw/protocol";
import { consumeEventDelivery, tombstoneReader, LIVE_ONLY_EVENTS } from "../src/events/consumer.js";
import { historySegment, StreamVoided } from "../src/routes/events.js";
import { startHarness, type Harness } from "./scenario-harness.js";

let harness: Harness;
let originalHas: typeof tombstoneReader.has;

before(async () => {
  harness = await startHarness();
  originalHas = tombstoneReader.has;
  tombstoneReader.has = async () => false;
});
beforeEach(async () => { await harness.reset(); });
after(async () => {
  tombstoneReader.has = originalHas;
  await harness.close();
});

async function deliver(event: Record<string, unknown>, seq: number): Promise<string[]> {
  const verdicts: string[] = [];
  await consumeEventDelivery({
    subject: "events.s1",
    data: new TextEncoder().encode(JSON.stringify(event)),
    seq,
    ack: () => { verdicts.push("ack"); },
    nak: (ms?: number) => { verdicts.push(`nak:${ms ?? "none"}`); },
  });
  return verdicts;
}

const rows = () => harness.sql("SELECT event, data FROM claw_session_events ORDER BY id");

test("text deltas and their void are acked and never stored; the AssistantMessage that ends them is", async () => {
  assert.deepEqual([...LIVE_ONLY_EVENTS].sort(), [ASSISTANT_TEXT_DELTA_EVENT, ASSISTANT_TEXT_VOID_EVENT].sort());
  const id = "txt_abc_1_0";
  assert.deepEqual(await deliver({ type: ASSISTANT_TEXT_DELTA_EVENT, text_id: id, seq: 0, delta: "Hel", turn: 1, message_id: "m1" }, 1), ["ack"]);
  assert.deepEqual(await deliver({ type: ASSISTANT_TEXT_VOID_EVENT, text_id: id, reason: "retry", message_id: "m1" }, 2), ["ack"]);
  assert.equal((await rows()).length, 0);
  const message = { type: "AssistantMessage", data: { content: [{ type: "text", text: "Hello" }] }, text_id: id, message_id: "m1" };
  assert.deepEqual(await deliver(message, 3), ["ack"]);
  const stored = await rows();
  assert.equal(stored.length, 1);
  assert.equal(stored[0]!.event, "AssistantMessage");
  assert.equal((stored[0]!.data as Record<string, unknown>).text_id, id, "the stored message still names its stream");
});

test("the SSE stream frames a text delta under its own event name, and the say-preview void does not touch it", () => {
  const delta = { type: ASSISTANT_TEXT_DELTA_EVENT, text_id: "t", seq: 0, delta: "Hi", turn: 1, message_id: "m1" };
  const seg = historySegment([{ event_id: "claw-7", data: delta }], { foldSubagents: false });
  assert.equal(seg.frames[0], `id: claw-7\nevent: ${ASSISTANT_TEXT_DELTA_EVENT}\ndata: ${JSON.stringify(delta)}\n\n`);
  const voided = new StreamVoided();
  assert.equal(voided.forward({ type: "toolTextVoid", tool: "mcp__assistant__say", message_id: "m1", reason: "refused" }), true);
  assert.equal(voided.forward(delta), true, "a void of the turn's say is about the say only");
});
