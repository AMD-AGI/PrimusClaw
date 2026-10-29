// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * kubernetes/BYOK mode has no SaFE: the caller holds an LLM-gateway key and the
 * middleware verifies it against the gateway. `GET /v1/me` answers from that
 * identity alone (no SaFE call, no workspaces), and `GET /v1/models` lists with
 * the caller's own key. Its own file because the deploy mode is read at import.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { sendJson, startFakeUpstream, type FakeUpstream } from "./support/fake-upstream.js";

let gateway: FakeUpstream;
let safe: FakeUpstream;
let app: FastifyInstance;

before(async () => {
  gateway = await startFakeUpstream((req, res) =>
    req.headers.authorization === "Bearer sk-frank"
      ? sendJson(res, 200, { data: [{ id: "k8s-model", owned_by: "me" }] })
      : sendJson(res, 401, { error: "bad key" }));
  // Set so that a route that ignored the mode and called SaFE anyway would be seen.
  safe = await startFakeUpstream((_req, res) => sendJson(res, 200, { items: [] }));

  process.env.APP_ENV = "production";
  delete process.env.CLAW_INSECURE_DEV_AUTH;
  process.env.CLAW_DEPLOY_MODE = "kubernetes";
  delete process.env.LLM_KEY_SOURCE;
  process.env.SAFE_API_URL = safe.url;
  process.env.AUTH_INTERNAL_TOKEN = "internal-token-for-tests";
  process.env.OPENAI_BASE_URL = gateway.url;
  process.env.BYOK_VERIFY_API_STYLE = "openai";
  for (const k of ["BYOK_VERIFY_MODELS_URL", "MEMORY_LLM_BASE_URL", "ANTHROPIC_BASE_URL"]) delete process.env[k];

  const { authMiddleware } = await import("../src/auth/middleware.js");
  const { registerMeRoutes } = await import("../src/routes/me.js");
  const { registerModelsRoutes } = await import("../src/routes/models.js");
  app = Fastify();
  await app.register(cookie);
  app.addHook("preHandler", authMiddleware);
  await registerMeRoutes(app);
  await registerModelsRoutes(app);
  await app.ready();
});

after(async () => {
  await app?.close();
  await Promise.all([gateway?.close(), safe?.close()]);
});

const asFrank = { authorization: "Bearer sk-frank" };

test("/v1/me answers from the verified key's identity and never calls SaFE", async () => {
  const res = await app.inject({ method: "GET", url: "/v1/me", headers: asFrank });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body) as { userId: string; roles: string[]; sandbox: unknown; workspaces: unknown };
  assert.match(body.userId, /^byok-[0-9a-f]{16}$/);
  assert.deepEqual(body.roles, ["default"]);
  assert.deepEqual(body.sandbox, { available: false });
  assert.deepEqual(body.workspaces, []);
  assert.equal(res.body.includes("sk-frank"), false);
  assert.equal(safe.seen.length, 0);
});

test("/v1/me is 401 for a key the gateway refuses", async () => {
  const res = await app.inject({ method: "GET", url: "/v1/me", headers: { authorization: "Bearer sk-wrong" } });
  assert.equal(res.statusCode, 401);
});

test("/v1/models lists with the caller's own key", async () => {
  gateway.seen.length = 0;
  const res = await app.inject({ method: "GET", url: "/v1/models", headers: asFrank });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { object: "list", data: [{ id: "k8s-model", owned_by: "me" }] });
  // The listing itself, after the middleware's own verification of the same key.
  assert.equal(gateway.seen.at(-1)?.headers.authorization, "Bearer sk-frank");
});
