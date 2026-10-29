// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `GET /v1/models` lists with the key a chat run would get as `llm_api_key`, and
 * that key depends on LLM_KEY_SOURCE (llm/key-source.ts): the virtual key by
 * default, the platform key in proxy mode. A route that read `user.virtualKey`
 * directly would list the wrong key's models in proxy mode -- or be refused by a
 * gateway that only knows the platform key -- while every default-mode test
 * stayed green. So this is the proxy-mode half, in its own process because the
 * setting is read at import.
 */
import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { sendJson, startFakeUpstream } from "./support/fake-upstream.js";

test("in proxy mode the gateway is shown the platform key, not the virtual key", async () => {
  const gateway = await startFakeUpstream((req, res) =>
    req.headers.authorization === "Bearer pk-erin"
      ? sendJson(res, 200, { data: [{ id: "proxy-model" }] })
      : sendJson(res, 401, { error: "wrong key" }));
  process.env.APP_ENV = "production";
  delete process.env.CLAW_INSECURE_DEV_AUTH;
  process.env.CLAW_DEPLOY_MODE = "safe";
  process.env.LLM_KEY_SOURCE = "platformKey";
  process.env.OPENAI_BASE_URL = gateway.url;
  process.env.BYOK_VERIFY_API_STYLE = "openai";
  for (const k of ["BYOK_VERIFY_MODELS_URL", "MEMORY_LLM_BASE_URL", "ANTHROPIC_BASE_URL"]) delete process.env[k];

  const { registerModelsRoutes } = await import("../src/routes/models.js");
  const app = Fastify();
  app.addHook("preHandler", async (req) => {
    (req as any).user = { userId: "u-erin", userName: "Erin", roles: ["default"], platformKey: "pk-erin", virtualKey: "vk-erin" };
  });
  await registerModelsRoutes(app);
  try {
    const res = await app.inject({ method: "GET", url: "/v1/models" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { object: "list", data: [{ id: "proxy-model" }] });
    assert.deepEqual(gateway.seen.map((r) => r.headers.authorization), ["Bearer pk-erin"]);
  } finally {
    await app.close();
    await gateway.close();
  }
});
