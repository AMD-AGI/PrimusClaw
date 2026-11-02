// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The platform-role requirement in the Kubernetes/BYOK deployment mode, where
 * there is no SaFE: the caller's own LLM-gateway key (or an identity provider's
 * access token) is the credential, and neither brings platform roles. With the
 * setting on there is nothing that could satisfy it, so every caller is refused
 * (the caller `default` here is Claw's marker, not SaFE's word); with it empty
 * the mode behaves as it always did. Its own file because the deploy mode is read
 * at import.
 */
import test, { after, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import Fastify, { type FastifyInstance } from "fastify";

import { FakeIdentity, signJwt, testKey } from "../../utils/test/identity-fake.js";
import { sendJson, startFakeUpstream, type FakeUpstream } from "./support/fake-upstream.js";

const nowSec = () => Math.floor(Date.now() / 1000);
const es = testKey("ES256", "k-es");
const ENV = "CLAW_REQUIRED_PLATFORM_ROLES";

let gateway: FakeUpstream;
let fake: FakeIdentity;
let app: FastifyInstance;
let base = "";
let reached = 0;
let getCachedUserLlmKey: typeof import("../src/llm/client.js").getCachedUserLlmKey;

before(async () => {
  gateway = await startFakeUpstream((req, res) =>
    ["Bearer sk-frank", "Bearer sk-grace"].includes(String(req.headers.authorization))
      ? sendJson(res, 200, { data: [] })
      : sendJson(res, 401, { error: "bad key" }));
  fake = await FakeIdentity.start();
  fake.jwks = () => ({ body: { keys: [es.jwk] } });

  process.env.APP_ENV = "production";
  delete process.env.CLAW_INSECURE_DEV_AUTH;
  process.env.CLAW_DEPLOY_MODE = "kubernetes";
  delete process.env.LLM_KEY_SOURCE;
  delete process.env.SAFE_API_URL;
  process.env.AUTH_INTERNAL_TOKEN = "internal-token-for-tests";
  process.env.OPENAI_BASE_URL = gateway.url;
  process.env.BYOK_VERIFY_API_STYLE = "openai";
  for (const k of ["BYOK_VERIFY_MODELS_URL", "MEMORY_LLM_BASE_URL", "ANTHROPIC_BASE_URL"]) delete process.env[k];
  Object.assign(process.env, {
    IDENTITY_CLIENT_ENABLED: "true", IDENTITY_ISSUER_URL: fake.issuer, IDENTITY_CLIENT_ID: "svc-claw", IDENTITY_CLIENT_SECRET: "s3cret",
    CLAW_IDENTITY_TOKEN_AUTH_ENABLED: "true",
  });

  const { startIdentityClient } = await import("../src/auth/identity.js");
  startIdentityClient({ info() {}, warn() {}, error() {} });
  ({ getCachedUserLlmKey } = await import("../src/llm/client.js"));
  const { authMiddleware, getUser } = await import("../src/auth/middleware.js");
  const { isKubernetesMode } = await import("../src/config.js");
  assert.ok(isKubernetesMode(), "this file tests the Kubernetes mode");
  app = Fastify();
  await app.register((await import("@fastify/cookie")).default);
  app.addHook("preHandler", authMiddleware);
  app.get("/v1/whoami", async (req) => { reached++; return { user: getUser(req) }; });
  await app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});
after(async () => {
  delete process.env[ENV];
  await app?.close();
  await Promise.all([gateway?.close(), fake?.close()]);
});
beforeEach(() => {
  delete process.env[ENV];
  reached = 0;
});

const whoami = async (headers: Record<string, string>): Promise<{ status: number; body: any }> => {
  const r = await fetch(`${base}/v1/whoami`, { headers });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const byok = { authorization: "Bearer sk-frank" };
const idToken = () => ({
  authorization: `Bearer ${signJwt({
    key: es,
    claims: {
      iss: fake.issuer, aud: "claw-api", sub: "web-user", scope: "openid claw.api", name: "Web User",
      jti: randomUUID(), iat: nowSec(), nbf: nowSec() - 1, exp: nowSec() + 300,
    },
  })}`,
});

test("PK1: with the setting empty both credentials are served, as before", async () => {
  assert.equal((await whoami(byok)).status, 200);
  assert.equal((await whoami(idToken())).status, 200);
});

test("PK2: with it set a BYOK key and an identity token are refused with the 403, and do not reach the route", async () => {
  process.env[ENV] = "default";
  for (const headers of [byok, idToken()]) {
    const r = await whoami(headers);
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.deepEqual(r.body, { ok: false, error: "platform_access_required", message: "no access yet - ask an administrator" });
  }
  assert.equal(reached, 0);
});

test("PK3: a refused BYOK caller's key is not cached for background work, and a served one's is", async () => {
  const { deriveByokUserId } = await import("../src/auth/byok.js");
  const grace = await deriveByokUserId("sk-grace");
  process.env[ENV] = "default";
  assert.equal((await whoami({ authorization: "Bearer sk-grace" })).status, 403);
  assert.equal(getCachedUserLlmKey(grace), undefined, "a refused caller's key was cached");
  // The probe can see a cache entry: once the same key is served, it is there.
  delete process.env[ENV];
  assert.equal((await whoami({ authorization: "Bearer sk-grace" })).status, 200);
  assert.ok(getCachedUserLlmKey(grace));
});

test("PK4: a missing or bad credential is still 401, not 403", async () => {
  process.env[ENV] = "default";
  assert.equal((await whoami({})).status, 401);
  assert.equal((await whoami({ authorization: "Bearer sk-wrong" })).status, 401);
});
