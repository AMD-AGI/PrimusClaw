// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A workbench run into an existing session seals the caller's keys there and
 * removes the plain key fields an earlier build left on it, through the route
 * itself against a real Postgres with the production schema. Skipped without
 * DATABASE_URL, and a skip is not a pass.
 *
 * The reader prefers plain fields over the sealed blob (they are what an older
 * replica wrote last), so a run that only merged the new blob in would leave
 * the old key in the clear and still running the session.
 *
 * Kubernetes/BYOK mode, so the caller is verified against a fake gateway by the
 * same middleware production uses. The deploy mode is read at import, hence its
 * own file.
 */
import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";

import cookie from "@fastify/cookie";
import Fastify, { type FastifyInstance } from "fastify";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startAdmissionCluster, type AdmissionCluster } from "./support/admission-cluster.js";
import { sendJson, startFakeUpstream, type FakeUpstream } from "./support/fake-upstream.js";

const skip = postgresSkipReason();

const WORKBENCH_ID = "sealed-bench";
const DAG_ID = "sealed-bench-dag";
const KEY = "sk-caller-new";

describe("workbench run into an existing session", { skip }, () => {
  let h: AdmissionCluster;
  let gateway: FakeUpstream;
  let app: FastifyInstance;
  let read: typeof import("../src/auth/sealed-session-credentials.js")["readTrustedSessionCredentials"];

  before(async () => {
    gateway = await startFakeUpstream((req, res) =>
      req.headers.authorization === `Bearer ${KEY}`
        ? sendJson(res, 200, { data: [{ id: "m", owned_by: "me" }] })
        : sendJson(res, 401, { error: "bad key" }));
    process.env.APP_ENV = "production";
    delete process.env.CLAW_INSECURE_DEV_AUTH;
    delete process.env.LLM_KEY_SOURCE;
    process.env.SAFE_API_URL = gateway.url;
    process.env.AUTH_INTERNAL_TOKEN = "internal-token-for-tests";
    process.env.OPENAI_BASE_URL = gateway.url;
    process.env.BYOK_VERIFY_API_STYLE = "openai";
    for (const k of ["BYOK_VERIFY_MODELS_URL", "MEMORY_LLM_BASE_URL", "ANTHROPIC_BASE_URL"]) delete process.env[k];
    h = await startAdmissionCluster({ CLAW_DEPLOY_MODE: "kubernetes" });
    read = (await import("../src/auth/sealed-session-credentials.js")).readTrustedSessionCredentials;

    await q(
      `INSERT INTO claw_task_dags (dag_id, name, nodes, metadata, owner_user_id, is_public)
       VALUES ($1, 'sealed bench', $2::jsonb, $3::jsonb, 'nobody', true)`,
      [
        DAG_ID,
        JSON.stringify([{ id: "n1", name: "only", prompt: "go" }]),
        JSON.stringify({ derived: { root_node_id: "n1", handle_last_user: {}, schema_digest: "d" } }),
      ],
    );
    await q("INSERT INTO plugins (name, version, status) VALUES ('sealed-plugin', '1', 'active')");

    const { workbenchRegistry } = await import("../src/workbenches/registry.js");
    const { registerWorkbenchRunRoutes } = await import("../src/workbenches/routes.js");
    workbenchRegistry.register({
      id: WORKBENCH_ID,
      title: "sealed bench",
      dag_id: DAG_ID,
      plugin_ref: { name: "sealed-plugin", version: "1" },
      runs: { normaliseInput: (body: Record<string, unknown>) => ({ ...body }) },
    } as never);
    app = Fastify();
    await app.register(cookie);
    await registerWorkbenchRunRoutes(app);
    await app.ready();
  });
  after(async () => {
    await app?.close();
    await h?.stop();
    await gateway?.close();
  });

  const q = async (text: string, params: unknown[] = []) =>
    (await h.app.db.db.query(text, params)).rows as Array<Record<string, any>>;
  const run = async (payload: Record<string, unknown>) => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/workbenches/${WORKBENCH_ID}/runs`,
      headers: { authorization: `Bearer ${KEY}` },
      payload,
    });
    assert.equal(res.statusCode, 200, res.body);
    return JSON.parse(res.body) as { ok: boolean; session_id: string };
  };

  test("W2 seals the caller's key and removes the plain fields an older build wrote", async () => {
    // The caller's own session, as a run without session_id mints it.
    const { session_id: sid } = await run({ prompt: "first" });
    // ...as an older build stamped it: the previous keys in the clear, unrelated fields beside them.
    await q(
      `UPDATE claw_sessions SET config = $2::jsonb WHERE session_id = $1`,
      [sid, JSON.stringify({
        source: WORKBENCH_ID, hidden: true, model: "m",
        platform_key: "pk-old", llm_api_key: "sk-old", virtual_key: "vk-older",
        _server_managed_credentials: true,
      })],
    );

    assert.equal((await run({ prompt: "second", session_id: sid })).session_id, sid);

    const [{ config, text }] = await q("SELECT config, config::text AS text FROM claw_sessions WHERE session_id = $1", [sid]);
    assert.deepEqual(Object.keys(config).sort(),
      ["_server_managed_credentials", "hidden", "model", "sealed_credentials", "source"]);
    assert.deepEqual(read(config), { platformKey: "", llmApiKey: KEY }, "the session runs as this caller");
    for (const key of ["pk-old", "sk-old", "vk-older", KEY]) assert.equal(text.includes(key), false, key);
  });
});
