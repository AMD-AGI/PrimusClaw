// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * With `CLAW_NOTIFICATIONS_ENABLED` unset nothing about the deployment changes:
 * no tables, no routes, and the completion handler never reaches the outbox.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after, before, describe } from "node:test";
import Fastify from "fastify";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startAdmissionCluster, type AdmissionCluster } from "./support/admission-cluster.js";

const skip = postgresSkipReason();

describe("notifications flag off", { skip }, () => {
  let h: AdmissionCluster;
  before(async () => {
    delete process.env.CLAW_NOTIFICATIONS_ENABLED;
    h = await startAdmissionCluster({});
  });
  after(async () => { await h?.stop(); });

  test("initDb creates neither notification table", async () => {
    const r = await h.app.db.db.query(
      "SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'claw_notification%'",
    );
    assert.deepEqual(r.rows, []);
  });

  test("the subscription routes are not registered", async () => {
    const app = Fastify();
    await (await import("../src/routes/notification-subscriptions.js")).registerNotificationSubscriptionRoutes(app);
    await app.ready();
    assert.equal(app.printRoutes().includes("notification-subscriptions"), false);
    assert.equal((await app.inject({ method: "POST", url: "/v1/notification-subscriptions", payload: {} })).statusCode, 404);
    await app.close();
  });
});

test("the completion handler reaches the outbox only behind the flag, and the worker starts only behind it", () => {
  const consumer = readFileSync(new URL("../src/events/consumer.ts", import.meta.url), "utf8");
  assert.match(consumer, /if \(CLAW_NOTIFICATIONS_ENABLED && !interrupted && endedRunIds\.length\) \{\s*try \{\s*await completionPorts\.recordRunFinished/);
  const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(index, /if \(CLAW_NOTIFICATIONS_ENABLED\) startNotificationWorker\(\)/);
  const db = readFileSync(new URL("../src/infra/db.ts", import.meta.url), "utf8");
  assert.match(db, /if \(CLAW_NOTIFICATIONS_ENABLED\) await ensureNotificationSchema\(client\)/);
});
