// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Child process of test/wedged-connection.test.ts: a real Ingress on the real Service Bus client (src/servicebus.ts,
 * @azure/service-bus over AMQP on Node's built-in WebSocket), pointed at the local broker in argv[2], posts the
 * activities named in argv[3] (comma separated ids) one after another and prints one JSON line: each reply's status
 * and time, the health records and the counters. Only the token check is replaced (the broker is no Bot Framework).
 *
 * As in send-once.ts, the built-in WebSocket is subclassed to dial ws:// (the local broker has no certificate).
 */
const Native = globalThis.WebSocket;
class PlainWebSocket extends Native {
  constructor(url: string | URL, protocols?: string | string[]) {
    super(String(url).replace(/^wss:/, "ws:"), protocols);
  }
}
globalThis.WebSocket = PlainWebSocket;
const { SERVICE_BUS } = await import("../../src/servicebus.js");
const { createIngress } = await import("../../src/ingress.js");
const { HEALTH_LOGGER } = await import("../../src/health.js");
const { FULL_ENV, MESSAGE, request } = await import("../helpers.js");
type LogRecord = import("../../src/log.js").LogRecord;

const [connectionString, ids, attemptSeconds] = process.argv.slice(2) as [string, string, string];
const records: LogRecord[] = [];
const ingress = createIngress({
  env: { ...FULL_ENV, PRIMUSCLAW_SERVICEBUS_CONNECTION_STRING: connectionString },
  fetch: () => Promise.reject(new Error("no network")),
  log: (record) => records.push(record),
  serviceBus: SERVICE_BUS,
});
ingress.validate = () => Promise.resolve({});
ingress.sendAttemptSeconds = Number(attemptSeconds);
const replies: { id: string; status: number; ms: number }[] = [];
for (const id of ids.split(",")) {
  const started = performance.now();
  const reply = await ingress.messages(request({ ...MESSAGE, id }), (record) => records.push(record));
  replies.push({ id, status: reply.status, ms: Math.round(performance.now() - started) });
  // The broker wedges the connection once it has the first message; give it the moment it takes.
  await new Promise((resolve) => setTimeout(resolve, 100));
}
const health = records.filter((r) => r.logger === HEALTH_LOGGER).map((r) => JSON.parse(r.message) as unknown);
process.stdout.write(`${JSON.stringify({ replies, health, counters: ingress.health.counters })}\n`);
process.exit(0);
