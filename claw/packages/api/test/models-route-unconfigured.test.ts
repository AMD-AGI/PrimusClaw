// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A deployment with no LLM gateway configured at all: `GET /v1/models` says so
 * with a 503 and a reason, not a 500 from an exception nobody caught and not an
 * empty list that reads as "you may use no models".
 *
 * Its own file because the gateway settings are read at import time; see
 * models-route-gateway-selection.test.ts.
 */
import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";

for (const k of ["BYOK_VERIFY_MODELS_URL", "BYOK_VERIFY_API_STYLE", "OPENAI_BASE_URL", "MEMORY_LLM_BASE_URL", "ANTHROPIC_BASE_URL"]) {
  delete process.env[k];
}
process.env.APP_ENV = "production";
delete process.env.CLAW_INSECURE_DEV_AUTH;
process.env.CLAW_DEPLOY_MODE = "safe";
delete process.env.LLM_KEY_SOURCE;

test("no gateway configured is a 503 llm_gateway_not_configured", async () => {
  const { registerModelsRoutes } = await import("../src/routes/models.js");
  const app = Fastify();
  app.addHook("preHandler", async (req) => {
    (req as any).user = { userId: "u-dan", userName: "Dan", roles: ["default"], platformKey: "", virtualKey: "vk-dan" };
  });
  await registerModelsRoutes(app);
  try {
    const res = await app.inject({ method: "GET", url: "/v1/models" });
    assert.equal(res.statusCode, 503);
    const body = JSON.parse(res.body) as { error: string; reason: string };
    assert.equal(body.error, "llm_gateway_not_configured");
    assert.equal(typeof body.reason, "string");
    assert.equal(res.body.includes("vk-dan"), false);
  } finally {
    await app.close();
  }
});

test("the resolver itself refuses, naming the three settings that would fix it", async () => {
  const { gatewayModelsRequest } = await import("../src/auth/byok.js");
  assert.throws(() => gatewayModelsRequest("k"), /OPENAI_BASE_URL, MEMORY_LLM_BASE_URL, or BYOK_VERIFY_MODELS_URL/);
});
