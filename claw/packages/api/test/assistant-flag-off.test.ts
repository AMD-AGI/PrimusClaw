// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * With `CLAW_ASSISTANT_ENABLED` unset nothing about the deployment changes: no
 * tables and no routes, so the paths answer as if they never existed, and the
 * schema check that names those tables does not refuse to start without them.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after, before, describe } from "node:test";
import Fastify from "fastify";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startAdmissionCluster, type AdmissionCluster } from "./support/admission-cluster.js";

const skip = postgresSkipReason();
const ASSISTANT_TABLES = ["claw_assistants", "claw_work_items", "claw_work_item_events", "claw_assistant_says"];

describe("assistant flag off", { skip }, () => {
  let h: AdmissionCluster;
  before(async () => {
    delete process.env.CLAW_ASSISTANT_ENABLED;
    h = await startAdmissionCluster({});
  });
  after(async () => { await h?.stop(); });

  test("initDb starts without the assistant tables, and creates none of them", async () => {
    const r = await h.app.db.db.query(
      "SELECT table_name FROM information_schema.tables WHERE table_name = ANY($1)", [ASSISTANT_TABLES],
    );
    assert.deepEqual(r.rows, []);
  });

  test("no route is registered, whatever the method or the caller", async () => {
    const app = Fastify();
    app.addHook("preHandler", async (req) => { (req as any).user = { userId: "u1", userName: "u1", roles: ["default", "system-admin"], platformKey: "", virtualKey: "" }; });
    await (await import("../src/routes/assistant.js")).registerAssistantRoutes(app);
    await app.ready();
    assert.equal(app.printRoutes().includes("work-items"), false);
    assert.equal(app.printRoutes().includes("/v1/assistant"), false);
    for (const [method, url] of [
      ["POST", "/v1/assistant"], ["GET", "/v1/work-items"], ["GET", "/v1/work-items/x"],
      ["POST", "/v1/work-items/x/accept"], ["POST", "/v1/work-items/x/stop"],
    ] as const) {
      assert.equal((await app.inject({ method, url, payload: method === "POST" ? {} : undefined })).statusCode, 404, `${method} ${url}`);
    }
    await app.close();
  });
});

test("the schema and the routes are wired behind the flag, and nothing else starts", () => {
  const db = readFileSync(new URL("../src/infra/db.ts", import.meta.url), "utf8");
  assert.match(db, /if \(CLAW_ASSISTANT_ENABLED\) await ensureAssistantSchema\(client\)/);
  assert.match(db, /APP_RUNS_ENABLED, CLAW_ASSISTANT_ENABLED,/);
  const routes = readFileSync(new URL("../src/routes/assistant.ts", import.meta.url), "utf8");
  assert.match(routes, /if \(!CLAW_ASSISTANT_ENABLED\) return;/);
  const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(index, /await registerAssistantRoutes\(app\)/);
  const config = readFileSync(new URL("../src/config.ts", import.meta.url), "utf8");
  assert.match(config, /CLAW_ASSISTANT_ENABLED = envBool\("CLAW_ASSISTANT_ENABLED", false\)/);
});
