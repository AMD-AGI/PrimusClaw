// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/** The `inbound message` line says when the client sent the message, from the activity's own timestamps. */
import assert from "node:assert/strict";
import { test } from "node:test";

import type { JsonObject } from "../../src/cards/json.js";
import { FakeClock, flushMicrotasks } from "../../../../test-support/clock.js";
import { clientTiming, InboundConsumer, MAX_CLIENT_LAG_MS } from "../../src/servicebus/consumer.js";
import { RecordingLogger } from "../../../../test-support/recording-logger.js";
import { FakeBus, FakeReceiver, received } from "./fakes.js";

const USER_ID = "29:1XJKJMvc5GBtc2JwZq0oj8tHZmzrQgFmB39ATiQWA85gQtHieVkKilBZ9XHoq9j7Zaqt7CZ-NJWi7me2kHTL3Bw";
const AAD_ID = "7faf8ab2-3d56-4244-b585-20c8a42ed2b8";
const CONVERSATION =
  "a:17I0kl9EkpE1O9PH5TWrzrLNwnWWcfrU7QZjKR0WSfOpzbfcAg2IaydGElSo10tVr4C7Fc6GtieTJX663WuJCc1uA83n4CSrHSgGBj5XNYLcVlJ";

/**
 * A message in a 1:1 chat as Teams posts it to the bot (Bot Framework activity schema, personal scope): the service's
 * `timestamp` in UTC with seven fractional digits, the client's `localTimestamp` with its zone offset, the message id
 * the epoch milliseconds the service took it at, and a `clientInfo` entity naming the client's platform.
 */
function personalMessage(fields: {
  id: string;
  timestamp?: string;
  localTimestamp?: string;
  platform: string;
  channelData?: JsonObject;
}): JsonObject {
  const activity: JsonObject = {
    text: "SECRET-TEXT what I asked",
    textFormat: "plain",
    attachments: [{ contentType: "text/html", content: "<p>SECRET-TEXT what I asked</p>" }],
    type: "message",
    id: fields.id,
    channelId: "msteams",
    serviceUrl: "https://smba.trafficmanager.net/amer/",
    from: { id: USER_ID, name: "Megan Bowen", aadObjectId: AAD_ID },
    conversation: { conversationType: "personal", tenantId: "72f988bf-86f1-41af-91ab-2d7cd011db47", id: CONVERSATION },
    recipient: { id: "28:c9e8c047-2a74-40a2-b28a-b162d5f5327c", name: "Assistant" },
    entities: [
      { locale: "zh-CN", country: "CN", platform: fields.platform, timezone: "Asia/Shanghai", type: "clientInfo" },
    ],
    channelData: fields.channelData ?? { tenant: { id: "72f988bf-86f1-41af-91ab-2d7cd011db47" } },
    locale: "zh-CN",
    localTimezone: "Asia/Shanghai",
  };
  if (fields.timestamp !== undefined) activity["timestamp"] = fields.timestamp;
  if (fields.localTimestamp !== undefined) activity["localTimestamp"] = fields.localTimestamp;
  return activity;
}

// The desktop client sent at 15:00:00.123 local (+08:00); the service took it 16.0004567 s later.
const DESKTOP = personalMessage({
  id: "1794985216123",
  timestamp: "2026-11-18T07:00:16.1234567Z",
  localTimestamp: "2026-11-18T15:00:00.123+08:00",
  platform: "Windows",
});
// The mobile client writes the same fields with seven fractional digits on both.
const MOBILE = personalMessage({
  id: "1794985201500",
  timestamp: "2026-11-18T07:00:01.5001234Z",
  localTimestamp: "2026-11-18T15:00:00.7509876+08:00",
  platform: "Android",
});

test("a 1:1 message from Teams desktop and mobile: client send time, service time and the lag between them", () => {
  assert.deepEqual(clientTiming(DESKTOP), {
    client_ts: "2026-11-18T15:00:00.123+08:00",
    server_ts: "2026-11-18T07:00:16.1234567Z",
    client_lag_raw_ms: 16_000,
    client_lag_ms: 16_000,
  });
  assert.deepEqual(clientTiming(MOBILE), {
    client_ts: "2026-11-18T15:00:00.7509876+08:00",
    server_ts: "2026-11-18T07:00:01.5001234Z",
    client_lag_raw_ms: 750,
    client_lag_ms: 750,
  });
});

test("the client's own message id comes from channelData when the client set one", () => {
  const webChat = personalMessage({
    id: "1794985216123",
    timestamp: "2026-11-18T07:00:16.123Z",
    localTimestamp: "2026-11-18T15:00:16.000+08:00",
    platform: "Web",
    channelData: { tenant: { id: "t" }, clientActivityID: "1794985216000vq4mf3k2p0" },
  });
  assert.equal(clientTiming(webChat).client_msg_id, "1794985216000vq4mf3k2p0");
  const teams = personalMessage({
    ...{ id: "1", platform: "Windows" },
    channelData: { clientmessageid: "8234598720934" },
  });
  assert.equal(clientTiming(teams).client_msg_id, "8234598720934");
  // Anything but a short id of plain characters is not logged.
  const odd = personalMessage({
    id: "1",
    platform: "Windows",
    channelData: { clientActivityID: "SECRET-TEXT what I asked" },
  });
  assert.equal(clientTiming(odd).client_msg_id, undefined);
});

test("without a timestamp, a 1:1 message id gives the service time", () => {
  const noStamp = { ...DESKTOP };
  delete noStamp["timestamp"];
  assert.deepEqual(clientTiming(noStamp), {
    client_ts: "2026-11-18T15:00:00.123+08:00",
    server_ts: "2026-11-18T07:00:16.123Z",
    client_lag_raw_ms: 16_000,
    client_lag_ms: 16_000,
  });
});

test("clock skew: a negative or absurd lag is kept raw only, and a malformed time is not logged", () => {
  const ahead = { ...DESKTOP, localTimestamp: "2026-11-18T15:00:20.123+08:00" };
  assert.deepEqual(clientTiming(ahead), {
    client_ts: "2026-11-18T15:00:20.123+08:00",
    server_ts: "2026-11-18T07:00:16.1234567Z",
    client_lag_raw_ms: -4_000,
  });
  const dayBehind = { ...DESKTOP, localTimestamp: "2026-11-17T07:00:16.122Z" };
  assert.equal(clientTiming(dayBehind).client_lag_raw_ms, MAX_CLIENT_LAG_MS + 1);
  assert.equal(clientTiming(dayBehind).client_lag_ms, undefined);
  const atLimit = { ...DESKTOP, localTimestamp: "2026-11-17T07:00:16.123Z" };
  assert.equal(clientTiming(atLimit).client_lag_ms, MAX_CLIENT_LAG_MS);
  const garbage = { ...DESKTOP, localTimestamp: "SECRET-TEXT 15:00", timestamp: 1794985216123 };
  assert.deepEqual(clientTiming(garbage), { server_ts: "2026-11-18T07:00:16.123Z" });
  assert.deepEqual(clientTiming({ type: "message" }), {});
});

test("the inbound message line carries the client timing and still neither the text nor who sent it", async () => {
  const now = Date.UTC(2026, 10, 18, 7, 0, 17);
  const clock = new FakeClock(now);
  const logger = new RecordingLogger();
  const bus = new FakeBus();
  bus.sessions = [
    new FakeReceiver([
      [received(JSON.stringify(DESKTOP), new Date(now - 800), "1794985216123", 1)],
      [received("not json SECRET-TEXT", new Date(now - 100), "m-2", 1)],
    ]),
  ];
  const consumer = new InboundConsumer({
    client: bus,
    queue: "q",
    receivers: 1,
    clock,
    logger,
    handle: () => Promise.resolve(),
  });
  const running = consumer.run();
  await flushMicrotasks();
  consumer.stop();
  await clock.runAll();
  await running;
  const lines = logger.lines.filter((l) => l.message === "inbound message");
  assert.deepEqual(
    lines.map((l) => l.fields),
    [
      {
        id: "1794985216123",
        delivery: 1,
        outcome: "completed",
        lag_ms: 800,
        ms: 0,
        client_ts: "2026-11-18T15:00:00.123+08:00",
        server_ts: "2026-11-18T07:00:16.1234567Z",
        client_lag_raw_ms: 16_000,
        client_lag_ms: 16_000,
      },
      { id: "m-2", delivery: 1, outcome: "dead_lettered", lag_ms: 100, ms: 0 },
    ],
  );
  const dump = logger.dump();
  for (const secret of ["SECRET-TEXT", USER_ID, AAD_ID, CONVERSATION, "Megan Bowen"])
    assert.ok(!dump.includes(secret), secret);
});
