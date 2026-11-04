// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * With `CLAW_REMOTE_AGENTS_ENABLED` unset nothing about the deployment changes:
 * no tables and no routes, so the paths answer as if they never existed.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after, before, describe } from "node:test";
import Fastify from "fastify";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startAdmissionCluster, type AdmissionCluster } from "./support/admission-cluster.js";

const skip = postgresSkipReason();

describe("remote agents flag off", { skip }, () => {
  let h: AdmissionCluster;
  before(async () => {
    delete process.env.CLAW_REMOTE_AGENTS_ENABLED;
    h = await startAdmissionCluster({});
  });
  after(async () => { await h?.stop(); });

  test("initDb creates none of the remote-agent tables", async () => {
    const r = await h.app.db.db.query("SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'claw_remote%'");
    assert.deepEqual(r.rows, []);
  });

  test("no route is registered, whatever the method or the caller", async () => {
    const app = Fastify();
    app.addHook("preHandler", async (req) => { (req as any).user = { userId: "u1", userName: "u1", roles: ["default", "system-admin"], platformKey: "", virtualKey: "" }; });
    await (await import("../src/routes/remote-agents.js")).registerRemoteAgentRoutes(app);
    await app.ready();
    assert.equal(app.printRoutes().includes("remote-agents"), false);
    const id = "00000000-0000-4000-8000-000000000000";
    for (const [method, url] of [
      ["POST", "/v1/remote-agents/connectors"], ["GET", "/v1/remote-agents/connectors"],
      ["GET", `/v1/remote-agents/connectors/${id}/commands`], ["POST", `/v1/remote-agents/connectors/${id}/events`],
      ["POST", "/v1/remote-agents/sessions"], ["GET", `/v1/remote-agents/sessions/${id}/events`], ["GET", "/v1/remote-agents/audit"],
    ] as const) {
      assert.equal((await app.inject({ method, url, payload: method === "POST" ? {} : undefined })).statusCode, 404, `${method} ${url}`);
    }
    await app.close();
  });
});

test("the schema and the routes are wired behind the flag, and nothing else starts", () => {
  const db = readFileSync(new URL("../src/infra/db.ts", import.meta.url), "utf8");
  assert.match(db, /if \(CLAW_REMOTE_AGENTS_ENABLED\) await ensureRemoteAgentSchema\(client\)/);
  const routes = readFileSync(new URL("../src/routes/remote-agents.ts", import.meta.url), "utf8");
  assert.match(routes, /if \(!CLAW_REMOTE_AGENTS_ENABLED\) return;/);
  const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(index, /await registerRemoteAgentRoutes\(app\)/);
  const config = readFileSync(new URL("../src/config.ts", import.meta.url), "utf8");
  assert.match(config, /CLAW_REMOTE_AGENTS_ENABLED = envBool\("CLAW_REMOTE_AGENTS_ENABLED", false\)/);
});
