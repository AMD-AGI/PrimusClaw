// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The worker stops while the assistant's receipt under a message is open (its reply has not come): `stop` and `run` return
 * within a second and leave no timer behind (Python's shutdown cancels the receipt's tasks; the receipt's own close at nine
 * minutes and its followed turn must not keep the process up). The real `buildWorker` through the release gate's test entry,
 * a fake Claw and the recording Bot Connector over real HTTP.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { FakeHttpServer, type SseFrame } from "../../../../test-support/http-server.js";
import { RecordingLogger } from "../../../../test-support/recording-logger.js";
import { RecordingConnector } from "../../../../test-support/recording-connector.js";
import { buildWorker } from "../../src/assembly/worker.js";

const ALICE = "aad-a";
const SESSION = "s-assistant";

let dir: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "w5-stop-"));
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  return typeof address === "object" && address !== null ? address.port : 0;
}

/** The turn's stream: Claw has answered it and says nothing more (the reply is still being written). */
async function* silent(): AsyncIterable<SseFrame> {
  yield { event: "heartbeat", data: "{}" }; // (the response's head goes out with its first frame)
  await delay(3_600_000, undefined, { ref: false });
}

async function fakeClaw(): Promise<FakeHttpServer> {
  return FakeHttpServer.start([
    { method: "GET", path: "/v1/work-items", handle: () => ({ status: 200, json: { ok: true, data: [] } }) },
    {
      method: "GET",
      path: "/v1/notification-subscriptions",
      handle: () => ({ status: 200, json: { ok: true, data: [] } }),
    },
    {
      method: "POST",
      path: "/v1/notification-subscriptions",
      handle: (request) => {
        const body = request.json as Record<string, unknown>;
        return {
          status: 200,
          json: { ok: true, data: { subscription_id: "sub-1", secret: "whsec-test", enabled: true, ...body } },
        };
      },
    },
    {
      method: "POST",
      path: "/v1/assistant",
      handle: () => ({ status: 200, json: { ok: true, data: { session_id: SESSION, created: false } } }),
    },
    { method: "GET", path: `/v1/chat/sessions/${SESSION}/messages`, handle: () => ({ sse: silent() }) },
    {
      method: "POST",
      path: `/v1/sessions/${SESSION}/messages`,
      handle: () => ({ status: 200, json: { message_id: "m-claw" } }),
    },
    {
      method: "GET",
      path: `/v1/sessions/${SESSION}`,
      handle: () => ({ status: 200, json: { ok: true, data: { session_id: SESSION, status: "idle" } } }),
    },
  ]);
}

function timers(): number {
  return process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
}

async function workerEnv(clawUrl: string, connectorUrl: string, port: number): Promise<Record<string, string>> {
  return {
    TEAMS_ENCRYPTION_KEYS: "x".repeat(43) + "=",
    TEAMS_DB_PATH: join(dir, "state.db"),
    PUBLIC_BASE_URL: "https://claw.example.com",
    CLAW_API_URL: clawUrl,
    SAFE_API_URL: "http://safe.invalid/api/v1",
    OUTBOUND_MODE: "direct",
    BOT_MSI_CLIENT_ID: "x",
    SECRETS_SOURCE: "env",
    TEAMS_GATE_ENTRY: "1",
    GATE_RUN_ID: "stop-test",
    TEAMS_GATE_CONNECTOR_URL: connectorUrl,
    ASSISTANT_ENABLED: "1",
    PROACTIVE_ENABLED: "1",
    NOTIFY_WEBHOOK_URL: "https://claw.example.com/claw-events",
    PORT: String(port),
    METRICS_PORT: String(await freePort()),
  };
}

/** Through the test entry: Alice linked with her assistant subscription, then "hello" in her 1:1 chat. */
async function helloFromAlice(base: string, serviceUrl: string): Promise<void> {
  const up = (): Promise<boolean> =>
    fetch(`${base}/sessions`).then(
      (r) => r.ok,
      () => false,
    );
  for (let i = 0; i < 100 && !(await up()); i++) await delay(50);
  const linked = await fetch(`${base}/people/${ALICE}`, {
    method: "PUT",
    body: JSON.stringify({ name: "Alice", key: "ak-alice", claw_user_id: "u-alice", teams_id: "29:a" }),
  });
  assert.equal(linked.status, 200, await linked.text());
  const subscribed = await fetch(`${base}/people/${ALICE}/subscription`, { method: "POST" });
  assert.equal(subscribed.status, 200, await subscribed.text());
  const handled = await fetch(`${base}/activity`, {
    method: "POST",
    body: JSON.stringify({
      type: "message",
      id: "m-1",
      text: "hello",
      serviceUrl,
      channelId: "msteams",
      from: { id: "29:a", aadObjectId: ALICE, name: "Alice" },
      recipient: { id: "28:bot" },
      conversation: { id: "a:1on1", conversationType: "personal", tenantId: "t" },
      locale: "en-US",
    }),
  });
  assert.equal(handled.status, 200, await handled.text());
}

it("with a receipt open under a message, the worker's stop and run return within a second and leave no timer", async () => {
  const claw = await fakeClaw();
  const connector = await RecordingConnector.start();
  const port = await freePort();
  const logger = new RecordingLogger();
  const before = timers();
  const worker = await buildWorker(await workerEnv(claw.url, connector.url, port), () => ({}), { logger });
  const running = worker.run();
  try {
    await helloFromAlice(`http://127.0.0.1:${String(port)}/gate/v1`, `${connector.url}/`);
    // (the receipt is open under the message: its status went out, no final, and Claw took the message)
    assert.deepEqual(
      connector.recorder.records.map((r) => [r.op, r.activity["type"]]),
      [["stream", "typing"]],
    );
    assert.ok(claw.requests.some((r) => r.method === "POST" && r.path === `/v1/sessions/${SESSION}/messages`));
  } catch (error) {
    await worker.stop();
    await Promise.allSettled([running, claw.close(), connector.close()]);
    throw error;
  }
  const stopping = performance.now();
  await worker.stop();
  await running;
  const took = performance.now() - stopping;
  await claw.close();
  await connector.close();
  assert.ok(took < 1000, `stopping took ${String(Math.round(took))} ms`);
  assert.equal(timers(), before, logger.dump());
  // (dropped, not closed: the receipt said nothing more)
  assert.deepEqual(
    connector.recorder.records.map((r) => r.activity["type"]),
    ["typing"],
  );
});
