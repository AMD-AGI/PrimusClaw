// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `GET /v1/models`, end to end: the real auth middleware, the real route, and two
 * real HTTP servers standing in for SaFE (who is this credential?) and the LLM
 * gateway (which models does this key reach?).
 *
 * What these pin, in order of how badly each would hurt if it broke:
 *   M1 no credential is a 401 and never reaches the gateway
 *   M2 a caller is answered with the models of THEIR key -- and the gateway is
 *      shown that key and no other, including under concurrency
 *   M3 the response is the contract (`{object, data:[{id, owned_by?}]}`) and
 *      nothing else the gateway said, and the key is not in it
 *   M4 an account with no key is a 503, not an empty list
 *   M5 every way the gateway can fail is a 502/503 with `{error, reason}`, never a 500
 *   M6 the answer is marked uncacheable
 * Gateway selection and the Anthropic protocol are in the sibling files, because
 * they need a different environment at import time.
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { sendJson, startFakeUpstream, type FakeUpstream } from "./support/fake-upstream.js";
import { AUTH_INTERNAL_TOKEN, startFakePlatform } from "./support/fake-platform.js";

let platform: FakeUpstream;
let gateway: FakeUpstream;
/** What the gateway answers next, replaceable per test. */
let gatewayAnswer: (key: string, res: import("node:http").ServerResponse) => void;
let app: FastifyInstance;

const MODELS_BY_KEY: Record<string, unknown> = {
  "vk-alice": {
    object: "list",
    data: [
      { id: "model-a1", object: "model", created: 1700000000, owned_by: "team-a", internal_cost: 12.5 },
      { id: "model-shared", object: "model", owned_by: "" },
      { object: "model", owned_by: "no-id" },
      { id: "", owned_by: "empty-id" },
      "not-an-object",
    ],
  },
  "vk-bob": { object: "list", data: [{ id: "model-b1", owned_by: "team-b" }, { id: "model-shared" }] },
};

before(async () => {
  platform = await startFakePlatform({
    alice: { id: "u-alice", name: "Alice", virtualKey: "vk-alice", platformKey: "pk-alice" },
    bob: { id: "u-bob", name: "Bob", virtualKey: "vk-bob", platformKey: "pk-bob" },
    keyless: { id: "u-keyless", virtualKey: "" },
  });
  gatewayAnswer = (key, res) => {
    const models = MODELS_BY_KEY[key];
    if (!models) return sendJson(res, 401, { error: "bad key" });
    sendJson(res, 200, models);
  };
  gateway = await startFakeUpstream((req, res) => {
    assert.equal(req.method, "GET");
    assert.equal(req.url, "/v1/models");
    gatewayAnswer(String(req.headers.authorization ?? "").replace(/^Bearer /, ""), res);
  });

  process.env.APP_ENV = "production";
  delete process.env.CLAW_INSECURE_DEV_AUTH;
  process.env.CLAW_DEPLOY_MODE = "safe";
  delete process.env.LLM_KEY_SOURCE;
  process.env.SAFE_API_URL = platform.url;
  process.env.AUTH_INTERNAL_TOKEN = AUTH_INTERNAL_TOKEN;
  process.env.OPENAI_BASE_URL = gateway.url;
  process.env.BYOK_VERIFY_API_STYLE = "openai";
  for (const k of ["BYOK_VERIFY_MODELS_URL", "MEMORY_LLM_BASE_URL", "ANTHROPIC_BASE_URL"]) delete process.env[k];

  const { authMiddleware } = await import("../src/auth/middleware.js");
  const { registerModelsRoutes } = await import("../src/routes/models.js");
  app = Fastify();
  await app.register(cookie);
  // The order src/index.ts uses: the global hook first, then the routes.
  app.addHook("preHandler", authMiddleware);
  await registerModelsRoutes(app);
  await app.ready();
});

after(async () => {
  await app?.close();
  await Promise.all([platform?.close(), gateway?.close()]);
});

const asAlice = { cookie: "Token=tok-alice; userType=default" };
const asBob = { authorization: "Bearer ak-bob" };
const get = (headers: Record<string, string> = {}) => app.inject({ method: "GET", url: "/v1/models", headers });
const ids = (body: string): string[] => (JSON.parse(body) as { data: { id: string }[] }).data.map((m) => m.id);

test("M1: without a credential the answer is 401 and the gateway is never asked", async () => {
  const before = gateway.seen.length;
  const res = await get();
  assert.equal(res.statusCode, 401);
  assert.equal(gateway.seen.length, before);
});

test("M1: a route reached with no authenticated user at all is 401, not a crash or a listing", async () => {
  // The global hook always sets a user; this is the route's own refusal should it ever not.
  const { registerModelsRoutes } = await import("../src/routes/models.js");
  const bare = Fastify();
  await registerModelsRoutes(bare);
  try {
    const before = gateway.seen.length;
    const res = await bare.inject({ method: "GET", url: "/v1/models" });
    assert.equal(res.statusCode, 401);
    assert.equal(JSON.parse(res.body).error, "authentication_required");
    assert.equal(gateway.seen.length, before);
  } finally {
    await bare.close();
  }
});

test("M1: a credential SaFE does not know is 401 and the gateway is never asked", async () => {
  const before = gateway.seen.length;
  const res = await get({ authorization: "Bearer ak-mallory" });
  assert.equal(res.statusCode, 401);
  assert.equal(gateway.seen.length, before);
});

test("M3: the answer is the contract, and carries only id and owned_by", async () => {
  const res = await get(asAlice);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), {
    object: "list",
    data: [{ id: "model-a1", owned_by: "team-a" }, { id: "model-shared" }],
  });
  assert.equal(res.body.includes("internal_cost"), false);
  assert.equal(res.body.includes("created"), false);
});

test("M3: no key (the caller's or the deployment's) appears in the response", async () => {
  for (const headers of [asAlice, asBob]) {
    const body = (await get(headers)).body;
    for (const secret of ["vk-alice", "vk-bob", "pk-alice", "pk-bob", AUTH_INTERNAL_TOKEN, "tok-alice", "ak-bob"]) {
      assert.equal(body.includes(secret), false, `${secret} must not be echoed`);
    }
  }
});

test("M2: each caller is answered with their own key's models and the gateway sees only that key", async () => {
  gateway.seen.length = 0;
  const alice = await get(asAlice);
  const bob = await get(asBob);
  assert.deepEqual(ids(alice.body), ["model-a1", "model-shared"]);
  assert.deepEqual(ids(bob.body), ["model-b1", "model-shared"]);
  assert.deepEqual(gateway.seen.map((r) => r.headers.authorization), ["Bearer vk-alice", "Bearer vk-bob"]);
  // The caller's own credential to this API is not what the gateway is shown.
  for (const r of gateway.seen) {
    assert.equal(r.headers.cookie, undefined);
    assert.equal(r.headers["x-api-key"], undefined);
  }
});

test("M2: concurrent callers never receive each other's models", async () => {
  gateway.seen.length = 0;
  const results = await Promise.all(
    Array.from({ length: 12 }, (_, i) => (i % 2 === 0 ? get(asAlice) : get(asBob))),
  );
  results.forEach((res, i) => {
    assert.equal(res.statusCode, 200);
    assert.deepEqual(ids(res.body), i % 2 === 0 ? ["model-a1", "model-shared"] : ["model-b1", "model-shared"]);
  });
  const shown = new Set(gateway.seen.map((r) => r.headers.authorization));
  assert.deepEqual([...shown].sort(), ["Bearer vk-alice", "Bearer vk-bob"]);
});

test("M2: a request carrying alice's cookie and bob's key is answered as alice", async () => {
  // The middleware authenticates the cookie first; the key must not be what the gateway is shown.
  gateway.seen.length = 0;
  const res = await get({ ...asAlice, ...asBob });
  assert.deepEqual(ids(res.body), ["model-a1", "model-shared"]);
  assert.deepEqual(gateway.seen.map((r) => r.headers.authorization), ["Bearer vk-alice"]);
});

test("M4: an account with no gateway key is a 503, not an empty list, and the gateway is not asked", async () => {
  const before = gateway.seen.length;
  const res = await get({ authorization: "Bearer ak-keyless" });
  assert.equal(res.statusCode, 503);
  assert.equal(JSON.parse(res.body).error, "llm_key_unavailable");
  assert.equal(typeof JSON.parse(res.body).reason, "string");
  assert.equal(gateway.seen.length, before);
});

test("M6: the answer is not cacheable, for a success and for a refusal alike", async () => {
  assert.equal((await get(asAlice)).headers["cache-control"], "no-store");
  assert.equal((await get({ authorization: "Bearer ak-keyless" })).headers["cache-control"], "no-store");
});

test("M5: the failure table", async (t) => {
  const cases: { name: string; answer: typeof gatewayAnswer; status: number; error: string }[] = [
    { name: "gateway 500", answer: (_k, res) => sendJson(res, 500, { error: "boom vk-alice" }), status: 502, error: "llm_gateway_error" },
    { name: "gateway 503", answer: (_k, res) => sendJson(res, 503, "down"), status: 502, error: "llm_gateway_error" },
    { name: "gateway 401", answer: (_k, res) => sendJson(res, 401, { error: "bad key" }), status: 502, error: "llm_key_rejected" },
    { name: "gateway 403", answer: (_k, res) => sendJson(res, 403, { error: "no" }), status: 502, error: "llm_key_rejected" },
    { name: "not json", answer: (_k, res) => { res.writeHead(200); res.end("<html>login</html>"); }, status: 502, error: "llm_gateway_bad_response" },
    { name: "json but not an object", answer: (_k, res) => sendJson(res, 200, "42"), status: 502, error: "llm_gateway_bad_response" },
    { name: "an object without data", answer: (_k, res) => sendJson(res, 200, { models: [] }), status: 502, error: "llm_gateway_bad_response" },
    { name: "data that is not a list", answer: (_k, res) => sendJson(res, 200, { data: "x" }), status: 502, error: "llm_gateway_bad_response" },
    { name: "connection dropped", answer: (_k, res) => { res.socket?.destroy(); }, status: 503, error: "llm_gateway_unreachable" },
  ];
  for (const c of cases) {
    await t.test(c.name, async () => {
      gatewayAnswer = c.answer;
      try {
        const res = await get(asAlice);
        assert.equal(res.statusCode, c.status);
        const body = JSON.parse(res.body) as { error: string; reason: string };
        assert.equal(body.error, c.error);
        assert.equal(typeof body.reason, "string");
        assert.deepEqual(Object.keys(body).sort(), ["error", "reason"]);
        // What the gateway said, and the key it was sent, stay out of the answer.
        assert.equal(res.body.includes("vk-alice"), false);
        assert.equal(res.body.includes("boom"), false);
      } finally {
        gatewayAnswer = (key, res) => (MODELS_BY_KEY[key] ? sendJson(res, 200, MODELS_BY_KEY[key]) : sendJson(res, 401, {}));
      }
    });
  }
});

test("M5: an empty model list is a valid answer, not a failure", async () => {
  gatewayAnswer = (_k, res) => sendJson(res, 200, { object: "list", data: [] });
  try {
    const res = await get(asAlice);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), { object: "list", data: [] });
  } finally {
    gatewayAnswer = (key, res) => (MODELS_BY_KEY[key] ? sendJson(res, 200, MODELS_BY_KEY[key]) : sendJson(res, 401, {}));
  }
});

test("M5: a gateway nobody is listening on is a 503 with the contract body", async () => {
  // Last on purpose: the module-level gateway URL cannot be swapped, so this one
  // closes the server it points at. The refusal is a real ECONNREFUSED.
  await gateway.close();
  const res = await get(asAlice);
  assert.equal(res.statusCode, 503);
  const body = JSON.parse(res.body) as { error: string; reason: string };
  assert.equal(body.error, "llm_gateway_unreachable");
  assert.equal(typeof body.reason, "string");
});
