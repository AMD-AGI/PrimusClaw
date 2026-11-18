// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * W7 of sandbox-allowed-namespaces.test.ts, on a real Postgres: an A2A send
 * whose `metadata.workspace_id` names a workspace the deployment does not
 * isolate (SANDBOX_ALLOWED_NAMESPACES) is refused as invalid params before any
 * session or task is opened; one naming a listed workspace is not refused for it.
 *
 * Nothing that opens the database is imported at the top of this file: the
 * pool is built from DATABASE_URL when it is first imported, and
 * startAdmissionCluster points that at this file's own database first.
 */
import test, { after, before, describe } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startAdmissionCluster, type AdmissionCluster } from "./support/admission-cluster.js";

const LISTED = { SANDBOX_ALLOWED_NAMESPACES: "ws-isolated, ws-gpu" };

async function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved = process.env.SANDBOX_ALLOWED_NAMESPACES;
  delete process.env.SANDBOX_ALLOWED_NAMESPACES;
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.SANDBOX_ALLOWED_NAMESPACES;
    else process.env.SANDBOX_ALLOWED_NAMESPACES = saved;
  }
}

describe("W7 A2A sends", { skip: postgresSkipReason() }, () => {
  const CALLER = { userId: "u-a2a", userName: "u-a2a", roles: ["user"], platformKey: "pk", virtualKey: "vk" };
  let harness: AdmissionCluster;
  let app: FastifyInstance;
  const q = (text: string, params: unknown[] = []) => harness.app.db.db.query(text, params);
  const send = (workspace: string) => app.inject({
    method: "POST",
    url: "/a2a",
    headers: { "a2a-version": "1.0" },
    payload: {
      jsonrpc: "2.0", id: 1, method: "SendMessage",
      params: {
        message: { messageId: `m-${workspace}`, role: "user", parts: [{ text: "hello" }] },
        metadata: { workspace_id: workspace },
        configuration: { returnImmediately: true },
      },
    },
  });
  const errorOf = (raw: string) => (JSON.parse(raw) as { error?: { message?: string } }).error?.message ?? "";

  before(async () => {
    harness = await startAdmissionCluster({});
    const a2a = await import("../src/routes/a2a.js");
    app = Fastify();
    app.addHook("onRequest", async (req) => { (req as unknown as { user: unknown }).user = CALLER; });
    await a2a.registerA2ARoutes(app);
    await app.ready();
  });
  after(async () => {
    await app?.close();
    await harness?.stop();
  });

  test("a workspace off the list is refused as invalid params and opens nothing; a listed one is not refused for it", async () => {
    await withEnv(LISTED, async () => {
      const refused = await send("ws-open");
      assert.match(errorOf(refused.body), /ws-open workspace is not one of them/, refused.body);
      assert.equal((await q("SELECT 1 FROM claw_tasks")).rowCount, 0, "a refused send wrote a task");
      assert.equal((await q("SELECT 1 FROM claw_sessions")).rowCount, 0, "a refused send minted a session");

      const listed = await send("ws-isolated");
      assert.doesNotMatch(errorOf(listed.body), /not one of them/, listed.body);
    });
  });
});
