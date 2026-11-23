// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The delivery probe's two legs in the ingress: the timer puts a probe on the inbound queue under its own session, and
 * the relay acks the worker's answer (operation `probe`) without posting anything to Teams.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { PROBE_CONVERSATION, PROBE_OPERATION, PROBE_TYPE } from "../src/outbound.js";
import { FULL_ENV, load, rejects } from "./helpers.js";
import { runOutbound } from "./wiring.js";

const NOW = Date.UTC(2026, 10, 23, 10, 0, 0, 125);
const body = (raw: Buffer): unknown => JSON.parse(raw.toString("utf8"));

test("the probe timer queues a probe under its own session, with when it was sent", async () => {
  const ids = ["probe-id-1"];
  const { ingress, bus, log } = load(FULL_ENV, { now: () => NOW, uuid: () => ids.shift() ?? "x" });
  await ingress.probe();
  assert.equal(bus.sent.length, 1);
  const [sent] = bus.sent;
  assert.ok(sent);
  assert.equal(sent.queue, "primusclaw-inbound");
  assert.deepEqual(
    { ...sent.message, body: body(sent.message.body) },
    {
      body: {
        type: PROBE_TYPE,
        id: "probe-id-1",
        sent_at: "2026-11-23T10:00:00.125Z",
        conversation: { id: PROBE_CONVERSATION },
      },
      contentType: "application/json",
      correlationId: "probe-id-1",
      sessionId: PROBE_CONVERSATION,
      messageId: "probe-id-1",
    },
  );
  assert.ok(log.text.includes("delivery probe probe-id-1 queued"));
});

test("a probe that cannot be queued fails the timer run, and is recorded as an enqueue failure", async () => {
  const { ingress, bus, log } = load(FULL_ENV, { now: () => NOW });
  bus.fail = () => {
    throw new Error("the namespace is unreachable");
  };
  await rejects(ingress.probe(), /unreachable/);
  assert.equal(bus.sent.length, 0);
  assert.match(log.text, /inbound_enqueue_failed.*"kind":"probe"/);
});

test("the relay acks the worker's probe answer on the probe's session and posts nothing to Teams", async () => {
  const ids = ["ack-msg-1"];
  const { ingress, bus, http } = load(FULL_ENV, { uuid: () => ids.shift() ?? "x" });
  await runOutbound(ingress, {
    operation: PROBE_OPERATION,
    reference: { conversation: { id: PROBE_CONVERSATION } },
    activity: { type: "typing" },
    ack: "probe-probe-id-1",
  });
  assert.equal(http.calls.length, 0);
  assert.equal(http.tokensAsked.length, 0); // (not even the bot's token)
  assert.deepEqual(
    bus.sent.map((s) => [s.message.sessionId, s.message.correlationId, s.message.messageId, body(s.message.body)]),
    [
      [
        PROBE_CONVERSATION,
        "probe-probe-id-1",
        "ack-msg-1",
        { type: "primusclaw.delivered", ack: "probe-probe-id-1", activity_id: "probe" },
      ],
    ],
  );
});

test("a probe answer for another conversation, or without an ack, is refused and nothing is sent", async () => {
  for (const envelope of [
    { operation: "probe", reference: { conversation: { id: "19:abc@thread.v2" } }, activity: {}, ack: "a" },
    { operation: "PROBE", reference: { conversation: { id: PROBE_CONVERSATION } }, activity: {} },
    { operation: "probe", reference: { conversation: { id: PROBE_CONVERSATION } }, activity: {}, ack: 5 },
  ]) {
    const { ingress, bus, http } = load(FULL_ENV);
    await rejects(runOutbound(ingress, envelope), /probe answer needs/);
    assert.equal(bus.sent.length + http.calls.length, 0);
  }
});
