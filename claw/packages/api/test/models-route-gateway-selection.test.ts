// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Which gateway `GET /v1/models` asks, and how it authenticates to it.
 *
 * The resolution is the one BYOK verification already uses (auth/byok.ts), so a
 * deployment that configured verification has configured this. These pin the
 * parts a page can see: an explicit models URL wins over the base URLs, the
 * Anthropic protocol sends `x-api-key` and not a Bearer, and a deployment with
 * no gateway at all is a 503 that says so rather than a 500 or an empty list.
 *
 * Gateway settings are read when the config module is first imported, so each
 * environment is its own process: this file is the Anthropic-protocol one with an
 * explicit models URL, and models-route-unconfigured.test.ts is the empty one.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import { sendJson, startFakeUpstream, type FakeUpstream } from "./support/fake-upstream.js";

let gateway: FakeUpstream;
let decoy: FakeUpstream;
let app: FastifyInstance;

before(async () => {
  gateway = await startFakeUpstream((req, res) => {
    if (req.headers["x-api-key"] !== "vk-carol") return sendJson(res, 401, { error: "wrong header" });
    sendJson(res, 200, { data: [{ id: "claude-x", type: "model", display_name: "Claude X" }] });
  });
  // The base URLs point here, and a call that lands here has ignored the explicit URL.
  decoy = await startFakeUpstream((_req, res) => sendJson(res, 500, { error: "decoy must not be asked" }));

  process.env.APP_ENV = "production";
  delete process.env.CLAW_INSECURE_DEV_AUTH;
  process.env.CLAW_DEPLOY_MODE = "safe";
  delete process.env.LLM_KEY_SOURCE;
  process.env.BYOK_VERIFY_MODELS_URL = `${gateway.url}/v1/models`;
  process.env.BYOK_VERIFY_API_STYLE = "anthropic";
  process.env.OPENAI_BASE_URL = decoy.url;
  process.env.MEMORY_LLM_BASE_URL = decoy.url;
  process.env.ANTHROPIC_BASE_URL = decoy.url;

  const { registerModelsRoutes } = await import("../src/routes/models.js");
  app = Fastify();
  // Stand-in for the auth middleware: this file is about the gateway, not the caller.
  app.addHook("preHandler", async (req) => {
    (req as any).user = { userId: "u-carol", userName: "Carol", roles: ["default"], platformKey: "", virtualKey: "vk-carol" };
  });
  await registerModelsRoutes(app);
  await app.ready();
});

after(async () => {
  await app?.close();
  await Promise.all([gateway?.close(), decoy?.close()]);
});

test("an explicit models URL wins over the base URLs, and the Anthropic protocol sends x-api-key", async () => {
  const res = await app.inject({ method: "GET", url: "/v1/models" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { object: "list", data: [{ id: "claude-x" }] });
  assert.equal(decoy.seen.length, 0);
  assert.equal(gateway.seen.length, 1);
  assert.equal(gateway.seen[0].headers["x-api-key"], "vk-carol");
  assert.equal(gateway.seen[0].headers["anthropic-version"], "2023-06-01");
  assert.equal(gateway.seen[0].headers.authorization, undefined);
});
