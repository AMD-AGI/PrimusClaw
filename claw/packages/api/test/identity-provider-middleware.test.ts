// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * CLAW_AUTH_PROVIDER=identity through the real authentication hook: the roles taken from the introspection answer
 * decide admin rights and CLAW_REQUIRED_PLATFORM_ROLES, the platform key becomes the LLM key, and the caller's
 * forwarded address is never sent as client_ip.
 */
import test, { after, before, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import Fastify, { type FastifyInstance } from "fastify";

import { FakeIdentity, activeAnswer } from "../../utils/test/identity-fake.js";

const log = { info() {}, warn() {}, error() {} };

/** Introspection answers by token. */
const ANSWERS: Record<string, Record<string, unknown>> = {
  "ak-admin": activeAnswer({ sub: "u-admin", roles: ["default", "system-admin"], token_type: "api_key" }),
  "ak-plain": activeAnswer({ sub: "u-plain", roles: ["default"], token_type: "api_key" }),
  "ak-noroles": activeAnswer({ sub: "u-noroles", roles: [], token_type: "api_key" }),
  "ak-clawuser": activeAnswer({ sub: "u-clawuser", roles: ["default", "claw-user"], token_type: "api_key" }),
  "sess-carol": activeAnswer({ sub: "u-carol", roles: ["default"], token_type: "session" }),
};

describe("CLAW_AUTH_PROVIDER=identity through the authentication hook", () => {
  let fake: FakeIdentity;
  let app: FastifyInstance;
  let base = "";

  before(async () => {
    fake = await FakeIdentity.start();
    fake.introspect = (r) => ({ body: ANSWERS[r.form.get("token") ?? ""] ?? { active: false } });
    fake.platformKey = (r) => (r.headers.authorization === "Bearer sess-carol"
      ? { body: { userId: "u-carol", apiKey: "ak-carol-platform" } }
      : { status: 404, body: { errorMessage: "this user has no primary API key" } });
    delete process.env.CLAW_DEPLOY_MODE;
    Object.assign(process.env, {
      CLAW_AUTH_PROVIDER: "identity", LLM_KEY_SOURCE: "platformKey", APP_ENV: "production",
      IDENTITY_CLIENT_ENABLED: "true", IDENTITY_ISSUER_URL: fake.issuer, IDENTITY_CLIENT_ID: "svc-claw", IDENTITY_CLIENT_SECRET: "s3cret",
      IDENTITY_INTROSPECTION_URL: `${fake.issuer}/oauth/introspect`,
      IDENTITY_INTROSPECTION_CACHE_SECONDS: "0", IDENTITY_INTROSPECTION_NEGATIVE_CACHE_SECONDS: "0", IDENTITY_STALE_IF_ERROR_SECONDS: "0",
    });
    delete process.env.CLAW_IDENTITY_TOKEN_TRUSTED_ROLES;
    (await import("../src/auth/identity.js")).startIdentityClient(log);
    const { authMiddleware, getUser } = await import("../src/auth/middleware.js");
    const { resolveUserLlmKey } = await import("../src/llm/key-source.js");
    app = Fastify();
    await app.register((await import("@fastify/cookie")).default);
    app.addHook("preHandler", authMiddleware);
    app.get("/v1/whoami", async (req) => ({ user: getUser(req), llmKey: resolveUserLlmKey(getUser(req)) }));
    await app.listen({ port: 0, host: "127.0.0.1" });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });
  after(async () => {
    await app?.close();
    await fake?.close();
  });
  beforeEach(() => {
    delete process.env.CLAW_REQUIRED_PLATFORM_ROLES;
  });

  async function whoami(headers: Record<string, string>): Promise<{ status: number; body: any }> {
    const r = await fetch(`${base}/v1/whoami`, { headers });
    return { status: r.status, body: await r.json().catch(() => null) };
  }

  test("the answer's admin role is the caller's admin role, with no trusted roles named", async () => {
    const admin = await whoami({ authorization: "Bearer ak-admin" });
    assert.equal(admin.status, 200, JSON.stringify(admin.body));
    assert.deepEqual(admin.body.user.roles, ["default", "system-admin"]);
    const plain = await whoami({ authorization: "Bearer ak-plain" });
    assert.equal(plain.status, 200);
    assert.deepEqual(plain.body.user.roles, ["default"]);
  });

  test("CLAW_REQUIRED_PLATFORM_ROLES admits callers and does not change their roles", async () => {
    process.env.CLAW_REQUIRED_PLATFORM_ROLES = "system-admin,claw-user";
    const admin = await whoami({ authorization: "Bearer ak-admin" });
    assert.equal(admin.status, 200, JSON.stringify(admin.body));
    assert.deepEqual(admin.body.user.roles, ["default", "system-admin"]);
    const user = await whoami({ authorization: "Bearer ak-clawuser" });
    assert.equal(user.status, 200, JSON.stringify(user.body));
    assert.deepEqual(user.body.user.roles, ["default", "claw-user"]);
    assert.equal((await whoami({ authorization: "Bearer ak-plain" })).status, 403);
  });

  test("CLAW_REQUIRED_PLATFORM_ROLES=default admits only callers the answer lists default for", async () => {
    process.env.CLAW_REQUIRED_PLATFORM_ROLES = "default";
    assert.equal((await whoami({ authorization: "Bearer ak-plain" })).status, 200);
    const none = await whoami({ authorization: "Bearer ak-noroles" });
    assert.equal(none.status, 403, JSON.stringify(none.body));
  });

  test("a required role the answer lists admits the caller; without it the caller is refused", async () => {
    process.env.CLAW_REQUIRED_PLATFORM_ROLES = "claw-user";
    const ok = await whoami({ authorization: "Bearer ak-clawuser" });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.ok(ok.body.user.roles.includes("claw-user"));
    assert.equal((await whoami({ authorization: "Bearer ak-plain" })).status, 403);
  });

  test("under LLM_KEY_SOURCE=platformKey a cookie user's platform key is the LLM key", async () => {
    const r = await whoami({ cookie: "Token=sess-carol" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.llmKey, "ak-carol-platform");
  });

  test("an ak- key sent with X-Forwarded-For is introspected without client_ip", async () => {
    const before = fake.requests.length;
    await whoami({ authorization: "Bearer ak-plain", "x-forwarded-for": "203.0.113.7" });
    await whoami({ "x-api-key": "ak-plain", "x-forwarded-for": "203.0.113.7" });
    const calls = fake.requests.slice(before).filter((r) => r.path === "/oauth/introspect");
    assert.equal(calls.length, 2);
    for (const c of calls) assert.equal(c.form.get("client_ip"), null);
  });
});
