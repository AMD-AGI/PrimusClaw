// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * CLAW_AUTH_PROVIDER=identity: callers are verified by the identity service's introspection, and a session
 * caller's platform key is read with that session from the identity service.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { IdentityUnavailableError, type IntrospectionResult } from "@claw/utils";

delete process.env.CLAW_DEPLOY_MODE;
delete process.env.CLAW_AUTH_PROVIDER;
delete process.env.LLM_KEY_SOURCE;
delete process.env.IDENTITY_CLIENT_ENABLED;
delete process.env.CLAW_INSECURE_DEV_AUTH;
process.env.APP_ENV = "production";

const { IdentityVerifier, identityServiceOrigin } = await import("../src/auth/identity-verifier.js");
const { AuthServiceMisconfiguredError, AuthUpstreamUnreachableError } = await import("../src/auth/safe-client.js");
const config = await import("../src/config.js");

const API = "http://identity.test";

function active(over: Partial<Extract<IntrospectionResult, { active: true }>>): IntrospectionResult {
  return { active: true, roles: [], groups: [], audience: [], scope: [], claims: {}, ...over };
}

/** A fake identity service: introspection answers by token, the platform key endpoint by bearer session. */
function fakeIdentity(answers: Record<string, IntrospectionResult | Error>, keys: Record<string, { status: number; body?: unknown }>) {
  const seen = { introspect: [] as { token: string; params?: Record<string, string> }[], fetch: [] as { url: string; headers: Record<string, string> }[] };
  const identity = {
    introspect: async (token: string, opts: { params?: Record<string, string> } = {}) => {
      seen.introspect.push({ token, params: opts.params });
      const a = answers[token];
      if (a instanceof Error) throw a;
      return a ?? { active: false as const };
    },
  };
  const fetchFn = (async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    seen.fetch.push({ url, headers });
    const answer = keys[headers.Authorization!.replace(/^Bearer /, "")] ?? { status: 401 };
    return new Response(answer.body === undefined ? "" : JSON.stringify(answer.body), { status: answer.status });
  }) as typeof fetch;
  return { verifier: new IdentityVerifier(identity as never, API, fetchFn), seen };
}

test("the provider is identity by default, and LLM calls use the platform key", () => {
  assert.equal(config.CLAW_AUTH_PROVIDER, "identity");
  assert.equal(config.isIdentityAuthProvider(), true);
  assert.equal(config.LLM_KEY_SOURCE, "platformKey");
});

test("the identity service's address is the origin of its introspection endpoint", () => {
  assert.equal(identityServiceOrigin("http://primus-identity.primus-identity.svc.cluster.local/oauth/introspect"),
    "http://primus-identity.primus-identity.svc.cluster.local");
  assert.equal(identityServiceOrigin("https://id.example.test:8443/oauth/introspect"), "https://id.example.test:8443");
  assert.equal(identityServiceOrigin(undefined), "");
  assert.equal(identityServiceOrigin("ftp://id.example.test/x"), "");
});

test("a session cookie is the introspected user, with the platform key read with that session and kept", async () => {
  const { verifier, seen } = fakeIdentity(
    { "sess-alice": active({ sub: "u-alice", name: "Alice", email: "alice@example.test", roles: ["system-admin", "default"], tokenType: "session" }) },
    { "sess-alice": { status: 200, body: { id: 1, userId: "u-alice", apiKey: "ak-alice-platform", keyHint: "ak-a...form" } } },
  );
  const user = await verifier.verifyCookie("sess-alice", "sso");
  assert.deepEqual(user, {
    userId: "u-alice", userName: "Alice", email: "alice@example.test", roles: ["system-admin", "default"],
    platformKey: "ak-alice-platform", virtualKey: "",
  });
  assert.deepEqual(seen.introspect[0], { token: "sess-alice", params: { user_type: "sso" } });
  assert.equal(seen.fetch[0]!.url, `${API}/api/v1/apikeys/platform`);
  assert.equal(seen.fetch[0]!.headers.UserType, "sso");

  await verifier.verifyCookie("sess-alice", "sso");
  assert.equal(seen.fetch.length, 1, "the platform key is kept per user");
});

test("an ak- key is the introspected user, and the key is its platform key; roles always include default", async () => {
  const { verifier, seen } = fakeIdentity(
    { "ak-bob": active({ sub: "u-bob", username: "bob@example.test", roles: ["system-admin-readonly"], tokenType: "api_key" }) },
    {},
  );
  const user = await verifier.verifyApiKey("ak-bob");
  assert.deepEqual(user, { userId: "u-bob", userName: "bob@example.test", roles: ["default", "system-admin-readonly"], platformKey: "ak-bob", virtualKey: "" });
  assert.equal(seen.fetch.length, 0);
});

test("refusals: an inactive credential, a cookie that is not a session, and a platform key of another user", async () => {
  const { verifier } = fakeIdentity(
    {
      "jwt-as-cookie": active({ sub: "u-carol", tokenType: "access_token" }),
      "sess-dave": active({ sub: "u-dave", tokenType: "session" }),
    },
    { "sess-dave": { status: 200, body: { userId: "u-erin", apiKey: "ak-erin" } } },
  );
  await assert.rejects(verifier.verifyApiKey("ak-unknown"), /invalid or expired API key/);
  await assert.rejects(verifier.verifyCookie("sess-unknown"), /invalid or expired cookie/);
  await assert.rejects(verifier.verifyCookie("jwt-as-cookie"), /invalid or expired cookie/);
  await assert.rejects(verifier.verifyCookie("sess-dave"), /without the session user's key/);
});

test("an identity service that cannot answer is unavailable; one that refuses this client or serves no platform keys is misconfigured", async () => {
  const { verifier } = fakeIdentity(
    {
      "ak-down": new IdentityUnavailableError("introspection", "network"),
      "ak-refused": new IdentityUnavailableError("introspection", "client_rejected", 401),
      "sess-nokeys": active({ sub: "u-frank", tokenType: "session" }),
    },
    { "sess-nokeys": { status: 404 } },
  );
  await assert.rejects(verifier.verifyApiKey("ak-down"), AuthUpstreamUnreachableError);
  await assert.rejects(verifier.verifyApiKey("ak-refused"), AuthServiceMisconfiguredError);
  await assert.rejects(verifier.verifyCookie("sess-nokeys"), AuthServiceMisconfiguredError);
});

test("without the identity client the middleware answers 500 authentication_misconfigured", async () => {
  const { default: Fastify } = await import("fastify");
  const { default: cookie } = await import("@fastify/cookie");
  const { authMiddleware } = await import("../src/auth/middleware.js");
  const app = Fastify();
  await app.register(cookie);
  app.addHook("preHandler", authMiddleware);
  app.get("/v1/ping", async () => ({ ok: true }));
  await app.ready();
  try {
    const res = await app.inject({ method: "GET", url: "/v1/ping", headers: { authorization: "Bearer ak-x" } });
    assert.equal(res.statusCode, 500);
    assert.equal(JSON.parse(res.body).error, "authentication_misconfigured");
  } finally {
    await app.close();
  }
});
