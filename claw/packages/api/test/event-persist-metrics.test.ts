// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";

import { consumeEventDelivery, tombstoneReader } from "../src/events/consumer.js";
import { db } from "../src/infra/db.js";
import { registry } from "../src/infra/metrics.js";
import { startHarness, type Harness } from "./scenario-harness.js";

let harness: Harness;
let originalTombstoneRead: typeof tombstoneReader.has;

async function persistedEvents(outcome: "ok" | "error"): Promise<number> {
  const text = await registry.metrics();
  const line = text.split("\n").find((sample) =>
    sample.startsWith("claw_api_event_persisted_total{")
    && sample.includes(`outcome="${outcome}"`));
  return line ? Number(line.slice(line.lastIndexOf(" ") + 1)) : 0;
}

function delivery(event: Record<string, unknown>) {
  const verdicts: string[] = [];
  return {
    verdicts,
    message: {
      subject: "events.s1",
      data: new TextEncoder().encode(JSON.stringify(event)),
      seq: 17,
      ack: () => { verdicts.push("ack"); },
      nak: (millis?: number) => { verdicts.push(`nak:${millis ?? "none"}`); },
    },
  };
}

before(async () => {
  harness = await startHarness();
  originalTombstoneRead = tombstoneReader.has;
  tombstoneReader.has = async () => false;
});

beforeEach(async () => { await harness.reset(); });

after(async () => {
  tombstoneReader.has = originalTombstoneRead;
  await harness.close();
});

test("persisting an event increments the success counter at the consumer", async () => {
  const before = await persistedEvents("ok");
  const { message, verdicts } = delivery({ type: "AssistantMessage", message_id: "m-1" });

  await consumeEventDelivery(message);

  assert.deepEqual(verdicts, ["ack"]);
  assert.equal(await persistedEvents("ok") - before, 1);
  assert.equal((await harness.sql("SELECT COUNT(*)::int AS n FROM claw_session_events"))[0].n, 1);
});

test("a failed event insert increments the error counter and remains retryable", async () => {
  const original = db.query;
  db.query = (async (text: string, params?: unknown[]) => {
    if (/INSERT INTO claw_session_events/.test(text)) throw new Error("database unavailable");
    return original(text, params);
  }) as typeof db.query;
  const before = await persistedEvents("error");
  const { message, verdicts } = delivery({ type: "AssistantMessage", message_id: "m-2" });
  try {
    await consumeEventDelivery(message);
  } finally {
    db.query = original;
  }

  assert.deepEqual(verdicts, ["nak:5000"]);
  assert.equal(await persistedEvents("error") - before, 1);
});
