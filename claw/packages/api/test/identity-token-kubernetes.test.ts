// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The same access token in the Kubernetes deployment mode, where callers present
 * their own LLM gateway key as the Bearer value and there is no SaFE. The token
 * path is judged before that key check, so a user signed in through the identity
 * provider is a user here too; with the flag off the request is judged as before.
 */
import test, { after, before, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import Fastify, { type FastifyInstance } from "fastify";

import { FakeIdentity, signJwt, testKey } from "../../utils/test/identity-fake.js";

const nowSec = () => Math.floor(Date.now() / 1000);
const es = testKey("ES256", "k-es");
const log = { info() {}, warn() {}, error() {} };

describe("an identity access token in the Kubernetes deployment mode", () => {
  let fake: FakeIdentity;
  let app: FastifyInstance;
  let base = "";
  let startIdentityClient: typeof import("../src/auth/identity.js").startIdentityClient;

  function identity(on: boolean): void {
    for (const k of ["IDENTITY_CLIENT_ENABLED", "IDENTITY_ISSUER_URL", "IDENTITY_CLIENT_ID", "IDENTITY_CLIENT_SECRET"]) delete process.env[k];
    if (on) {
      Object.assign(process.env, {
        IDENTITY_CLIENT_ENABLED: "true", IDENTITY_ISSUER_URL: fake.issuer, IDENTITY_CLIENT_ID: "svc-claw", IDENTITY_CLIENT_SECRET: "s3cret",
      });
    }
    startIdentityClient(log);
  }
  const mint = (over: Record<string, unknown> = {}): string => signJwt({
    key: es,
    claims: {
      iss: fake.issuer, aud: "claw-api", sub: "web-user", client_id: "claw-web", scope: "openid claw.api", name: "Web User",
      roles: ["default"], jti: randomUUID(), iat: nowSec(), nbf: nowSec() - 1, exp: nowSec() + 300, ...over,
    },
  });

  before(async () => {
    fake = await FakeIdentity.start();
    fake.jwks = () => ({ body: { keys: [es.jwk] } });
    // No AUTH_INTERNAL_TOKEN: a value that reaches the gateway key check is answered 500 authentication_misconfigured,
    // which is how this test tells "judged by the key path" from "judged by the token path".
    delete process.env.AUTH_INTERNAL_TOKEN;
    process.env.CLAW_DEPLOY_MODE = "kubernetes";
    ({ startIdentityClient } = await import("../src/auth/identity.js"));
    const { authMiddleware, getUser } = await import("../src/auth/middleware.js");
    const { isKubernetesMode } = await import("../src/config.js");
    assert.ok(isKubernetesMode(), "this file tests the Kubernetes mode");
    app = Fastify();
    await app.register((await import("@fastify/cookie")).default);
    app.addHook("preHandler", authMiddleware);
    app.get("/v1/whoami", async (req) => ({ user: getUser(req) }));
    await app.listen({ port: 0, host: "127.0.0.1" });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });
  after(async () => {
    await app?.close();
    await fake?.close();
  });
  beforeEach(() => {
    identity(true);
    process.env.CLAW_IDENTITY_TOKEN_AUTH_ENABLED = "true";
  });

  async function whoami(headers: Record<string, string>): Promise<{ status: number; body: any }> {
    const r = await fetch(`${base}/v1/whoami`, { headers });
    return { status: r.status, body: await r.json().catch(() => null) };
  }

  test("a valid token authenticates the request, with no gateway key", async () => {
    const r = await whoami({ authorization: `Bearer ${mint()}` });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.user, { userId: "web-user", userName: "Web User", roles: ["default"], platformKey: "", virtualKey: "" });
  });

  test("a token that does not verify is refused and never offered to the gateway key check", async () => {
    const r = await whoami({ authorization: `Bearer ${mint({ aud: "someone-else" })}` });
    assert.equal(r.status, 401);
    assert.equal(r.body.error, "invalid_token");
  });

  test("with the flag off the same value goes to the key check, as before", async () => {
    delete process.env.CLAW_IDENTITY_TOKEN_AUTH_ENABLED;
    const r = await whoami({ authorization: `Bearer ${mint()}` });
    assert.equal(r.status, 500);
    assert.equal(r.body.error, "authentication_misconfigured");
  });

  test("a value that is not a JWT goes to the key check even with the flag on", async () => {
    const r = await whoami({ authorization: "Bearer sk-not-a-jwt" });
    assert.equal(r.status, 500);
    assert.equal(r.body.error, "authentication_misconfigured");
  });

  test("with no credential the answer is the key check's, not the token's", async () => {
    const r = await whoami({});
    assert.equal(r.status, 401);
    assert.equal(r.body.error, "authentication_required");
  });
});
