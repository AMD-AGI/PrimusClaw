// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The real Teams `buildWorker` starts on an environment written for an older release (`TEAMS_` names of the worker's own
 * settings) and on one written with the `PA_` names: each opens its store where its own name says and answers /healthz;
 * only the older one logs the warning, once, naming the `PA_` replacements and no value.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { FakeHttpServer } from "../../../../test-support/http-server.js";
import { RecordingLogger } from "../../../../test-support/recording-logger.js";
import { RecordingConnector } from "../../../../test-support/recording-connector.js";
import { buildWorker } from "../../src/assembly/worker.js";

const KEY = "x".repeat(43) + "=";

let dir: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "setting-names-"));
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

async function fakeClaw(): Promise<FakeHttpServer> {
  return FakeHttpServer.start([
    { method: "GET", path: "/v1/work-items", handle: () => ({ status: 200, json: { ok: true, data: [] } }) },
    {
      method: "GET",
      path: "/v1/notification-subscriptions",
      handle: () => ({ status: 200, json: { ok: true, data: [] } }),
    },
  ]);
}

/** The worker's own settings under `prefix`; the rest (Claw, the test entry, ports) as any deployment writes them. */
async function workerEnv(
  prefix: "TEAMS_" | "PA_",
  dbPath: string,
  clawUrl: string,
  connectorUrl: string,
  port: number,
): Promise<Record<string, string>> {
  return {
    [`${prefix}ENCRYPTION_KEYS`]: KEY,
    [`${prefix}DB_PATH`]: dbPath,
    [`${prefix}USER_MESSAGE_LIMIT`]: "7",
    [`${prefix}LIMIT_PR_MERGE`]: "3/600",
    PUBLIC_BASE_URL: "https://claw.example.com",
    CLAW_API_URL: clawUrl,
    SAFE_API_URL: "http://safe.invalid/api/v1",
    OUTBOUND_MODE: "direct",
    BOT_MSI_CLIENT_ID: "x",
    SECRETS_SOURCE: "env",
    TEAMS_GATE_ENTRY: "1",
    GATE_RUN_ID: "setting-names-test",
    TEAMS_GATE_CONNECTOR_URL: connectorUrl,
    TEAMS_AI_LABEL: "on",
    PORT: String(port),
    METRICS_PORT: String(await freePort()),
  };
}

/** Build and run the worker until /healthz answers, then stop it; what it logged. */
async function startAndStop(prefix: "TEAMS_" | "PA_", dbPath: string): Promise<RecordingLogger> {
  const claw = await fakeClaw();
  const connector = await RecordingConnector.start();
  const port = await freePort();
  const logger = new RecordingLogger();
  try {
    const worker = await buildWorker(await workerEnv(prefix, dbPath, claw.url, connector.url, port), () => ({}), {
      logger,
    });
    const running = worker.run();
    try {
      let status = 0;
      for (let i = 0; i < 100 && status !== 200; i++) {
        status = await fetch(`http://127.0.0.1:${String(port)}/healthz`).then(
          (r) => r.status,
          () => 0,
        );
        if (status !== 200) await delay(50);
      }
      assert.equal(status, 200, logger.dump());
    } finally {
      await worker.stop();
      await running;
    }
  } finally {
    await claw.close();
    await connector.close();
  }
  return logger;
}

const deprecations = (logger: RecordingLogger): string[] =>
  logger.lines.filter((l) => l.message.startsWith("deprecated setting names")).map((l) => l.message);

it("an environment with the older TEAMS_ names starts unchanged and says once which PA_ names replace them", async () => {
  const db = join(dir, "older.db");
  const logger = await startAndStop("TEAMS_", db);
  assert.ok(existsSync(db), "the store is where TEAMS_DB_PATH says");
  assert.deepEqual(deprecations(logger), [
    "deprecated setting names: TEAMS_DB_PATH (now PA_DB_PATH), TEAMS_ENCRYPTION_KEYS (now PA_ENCRYPTION_KEYS), " +
      "TEAMS_USER_MESSAGE_LIMIT (now PA_USER_MESSAGE_LIMIT), TEAMS_LIMIT_PR_MERGE (now PA_LIMIT_PR_MERGE); " +
      "they still work, the PA_ names take precedence",
  ]);
  assert.ok(!logger.dump().includes(KEY), "no value is logged");
  assert.ok(!logger.dump().includes("TEAMS_AI_LABEL"), "a Teams setting is no deprecated name");
});

it("an environment with the PA_ names starts with no warning about names", async () => {
  const db = join(dir, "neutral.db");
  const logger = await startAndStop("PA_", db);
  assert.ok(existsSync(db), "the store is where PA_DB_PATH says");
  assert.deepEqual(deprecations(logger), []);
  assert.ok(!logger.lines.some((l) => l.message.includes("is ignored")), logger.dump());
});
