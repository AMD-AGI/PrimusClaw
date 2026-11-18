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
process.env.CLAW_AUTH_PROVIDER = "identity";
delete process.env.LLM_KEY_SOURCE;
delete process.env.IDENTITY_CLIENT_ENABLED;
delete process.env.CLAW_INSECURE_DEV_AUTH;
process.env.APP_ENV = "production";

const { IdentityVerifier, IdentityUpstreamError, identityApiBase, PlatformKeyMissingError } = await import("../src/auth/identity-verifier.js");
const { AuthServiceMisconfiguredError, AuthUpstreamUnreachableError } = await import("../src/auth/safe-client.js");
const config = await import("../src/config.js");

const API = "http://identity.test";
const CLIENT = { clientId: "claw-api", clientSecret: "s3cret" };
const TRUSTED = ["system-admin", "system-admin-readonly"];

/** A verifier against `identity` and `fetchFn` with this file's client and trusted roles. */
function verifierOf(identity: unknown, fetchFn: typeof fetch, trustedRoles: string[] = TRUSTED) {
  return new IdentityVerifier(identity as never, { apiUrl: API, client: CLIENT, trustedRoles, fetchFn });
}

function active(over: Partial<Extract<IntrospectionResult, { active: true }>>): IntrospectionResult {
  return { active: true, roles: [], groups: [], audience: [], scope: [], claims: {}, ...over };
}

/** A fake identity service: introspection answers by token, the platform key endpoint by bearer session. */
function fakeIdentity(
  answers: Record<string, IntrospectionResult | Error>,
  keys: Record<string, { status: number; body?: unknown }>,
  trustedRoles: string[] = TRUSTED,
) {
  const seen = {
    introspect: [] as { token: string; params?: Record<string, string>; allowStale?: boolean }[],
    fetch: [] as { url: string; method?: string; headers: Record<string, string> }[],
  };
  const identity = {
    introspect: async (token: string, opts: { params?: Record<string, string>; allowStale?: boolean } = {}) => {
      seen.introspect.push({ token, params: opts.params, allowStale: opts.allowStale });
      const a = answers[token];
      if (a instanceof Error) throw a;
      return a ?? { active: false as const };
    },
  };
  const fetchFn = (async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    seen.fetch.push({ url, method: init.method, headers });
    const answer = keys[headers.Authorization!.replace(/^Bearer /, "")] ?? { status: 401 };
    return new Response(answer.body === undefined ? "" : JSON.stringify(answer.body), { status: answer.status });
  }) as typeof fetch;
  return { verifier: verifierOf(identity, fetchFn, trustedRoles), seen };
}

test("CLAW_AUTH_PROVIDER=identity selects the identity provider, and the default LLM key source is the virtual key", () => {
  assert.equal(config.CLAW_AUTH_PROVIDER, "identity");
  assert.equal(config.isIdentityAuthProvider(), true);
  assert.equal(config.LLM_KEY_SOURCE, "virtualKey");
});

test("the identity API base is IDENTITY_API_URL with its path, else introspection without /oauth/introspect", () => {
  assert.equal(identityApiBase("http://identity.example.test/oauth/introspect", ""), "http://identity.example.test");
  assert.equal(identityApiBase("https://id.example.test:8443/oauth/introspect", ""), "https://id.example.test:8443");
  assert.equal(identityApiBase("http://identity.example.test/prefix/oauth/introspect", ""), "http://identity.example.test/prefix");
  assert.equal(identityApiBase(undefined, ""), "");
  assert.equal(identityApiBase("ftp://id.example.test/x", ""), "");
  assert.equal(identityApiBase("http://identity.example.test/oauth/introspect", "https://api.example.test/id/"), "https://api.example.test/id");
  assert.equal(identityApiBase("http://identity.example.test/oauth/introspect", "not a url"), "");
});

test("a session cookie is the introspected user, with the platform key read with that session and kept", async () => {
  const { verifier, seen } = fakeIdentity(
    { "sess-alice": active({ sub: "u-alice", name: "Alice", email: "alice@example.test", roles: ["system-admin", "default"], tokenType: "session" }) },
    { "sess-alice": { status: 200, body: { id: 1, userId: "u-alice", apiKey: "ak-alice-platform", keyHint: "ak-a...form" } } },
  );
  const user = await verifier.verifyCookie("sess-alice", "sso");
  assert.deepEqual(user, {
    userId: "u-alice", userName: "Alice", email: "alice@example.test", roles: ["default", "system-admin"],
    platformKey: "ak-alice-platform", virtualKey: "",
  });
  assert.deepEqual(seen.introspect[0], { token: "sess-alice", params: { user_type: "sso" }, allowStale: false });
  assert.equal(seen.fetch[0]!.url, `${API}/api/v1/apikeys/platform`);
  assert.equal(seen.fetch[0]!.method, "GET");
  assert.equal(seen.fetch[0]!.headers.UserType, "sso");
  assert.equal(seen.fetch[0]!.headers["X-Internal-Token"], "claw-api:s3cret");

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

test("only the roles the operator trusts are adopted from an answer", async () => {
  const { verifier } = fakeIdentity(
    { "ak-mallory": active({ sub: "u-mallory", roles: ["system-admin", "system-admin-readonly", "root"], tokenType: "api_key" }) },
    {},
    ["system-admin-readonly"],
  );
  const user = await verifier.verifyApiKey("ak-mallory");
  assert.deepEqual(user.roles, ["default", "system-admin-readonly"]);
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

test("a session user the identity service holds no platform key for is refused with 403 platform_key_missing", async () => {
  const { default: Fastify } = await import("fastify");
  const { default: cookie } = await import("@fastify/cookie");
  const { verifySessionCookie } = await import("../src/auth/middleware.js");
  const { verifier, seen } = fakeIdentity(
    { "sess-jack": active({ sub: "u-jack", tokenType: "session" }) },
    { "sess-jack": { status: 200, body: { userId: "u-jack", apiKey: "" } } },
  );
  const app = Fastify();
  await app.register(cookie);
  app.get("/v1/ping", async (req) => verifySessionCookie(req, verifier, "/v1/ping"));
  await app.ready();
  try {
    const res = await app.inject({ method: "GET", url: "/v1/ping", headers: { cookie: "Token=sess-jack" } });
    const outcome = JSON.parse(res.body);
    assert.equal(outcome.error.status, 403);
    assert.equal(outcome.error.legacyError, "platform_key_missing");
    await app.inject({ method: "GET", url: "/v1/ping", headers: { cookie: "Token=sess-jack" } });
    assert.equal(seen.fetch.length, 2, "a missing key is not kept");
  } finally {
    await app.close();
  }
});

test("an ak- string that introspects as another token type is not an API key", async () => {
  const { verifier } = fakeIdentity({ "ak-session": active({ sub: "u-gina", tokenType: "session" }) }, {});
  await assert.rejects(verifier.verifyApiKey("ak-session"), /invalid or expired API key/);
});

test("concurrent sessions of one user each read the platform key with their own session", async () => {
  const { verifier, seen } = fakeIdentity(
    {
      "sess-stale": active({ sub: "u-hana", tokenType: "session" }),
      "sess-valid": active({ sub: "u-hana", tokenType: "session" }),
    },
    { "sess-valid": { status: 200, body: { userId: "u-hana", apiKey: "ak-hana" } } },
  );
  const [stale, valid] = await Promise.allSettled([verifier.verifyCookie("sess-stale"), verifier.verifyCookie("sess-valid")]);
  assert.equal(stale.status, "rejected");
  assert.equal(valid.status === "fulfilled" && valid.value.platformKey, "ak-hana");
  assert.equal(seen.fetch.length, 2);
});

test("a kept platform key is read again after one minute", async (t) => {
  const { verifier, seen } = fakeIdentity(
    { "sess-ivy": active({ sub: "u-ivy", tokenType: "session" }) },
    { "sess-ivy": { status: 200, body: { userId: "u-ivy", apiKey: "ak-ivy" } } },
  );
  const start = Date.now();
  const now = t.mock.method(Date, "now", () => start);
  await verifier.verifyCookie("sess-ivy");
  now.mock.mockImplementation(() => start + 59_000);
  await verifier.verifyCookie("sess-ivy");
  assert.equal(seen.fetch.length, 1);
  now.mock.mockImplementation(() => start + 61_000);
  await verifier.verifyCookie("sess-ivy");
  assert.equal(seen.fetch.length, 2);
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
  await assert.rejects(verifier.verifyCookie("sess-nokeys"), PlatformKeyMissingError);
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

test("an identity service that cannot be reached is a 503 that names the identity settings", async () => {
  const { default: Fastify } = await import("fastify");
  const { default: cookie } = await import("@fastify/cookie");
  const { verifyBearerApiKey } = await import("../src/auth/middleware.js");
  const { verifier } = fakeIdentity({ "ak-down": new IdentityUnavailableError("introspection", "network") }, {});
  const app = Fastify();
  await app.register(cookie);
  app.get("/v1/ping", async (req) => verifyBearerApiKey(req, verifier, "/v1/ping"));
  await app.ready();
  try {
    const res = await app.inject({ method: "GET", url: "/v1/ping", headers: { authorization: "Bearer ak-down" } });
    const outcome = JSON.parse(res.body);
    assert.equal(outcome.error.status, 503);
    assert.match(outcome.error.message, /identity service.*IDENTITY_INTROSPECTION_URL/);
  } finally {
    await app.close();
  }
});

test("primary auth introspects with allowStale false and sends no client address", async () => {
  const { verifier, seen } = fakeIdentity(
    { "ak-bound": active({ sub: "u-bound", tokenType: "api_key", roles: ["default"] }) },
    {},
  );
  await verifier.verifyApiKey("ak-bound");
  assert.equal(seen.introspect[0]!.allowStale, false);
  assert.deepEqual(seen.introspect[0]!.params, {});
  await verifier.verifyCookie("sess-missing", "sso").catch(() => undefined);
  const cookieCall = seen.introspect.find((c) => c.token === "sess-missing");
  assert.equal(cookieCall?.allowStale, false);
});

test("platform-key answers: 405 and a refused client are misconfigured, an expired key is missing, others are upstream failures", async () => {
  const statuses: Record<string, { status: number; body?: unknown }> = {
    "sess-405": { status: 405 },
    "sess-403": { status: 403, body: { errorCode: "Primus.00003", errorMessage: "service client authentication required" } },
    "sess-expired": { status: 403, body: { errorCode: "api_key_expired", errorMessage: "primary API key expired" } },
    "sess-401": { status: 401 },
    "sess-429": { status: 429 },
    "sess-500": { status: 500, body: { error: "boom" } },
  };
  const answers = Object.fromEntries(Object.keys(statuses).map((t) => [t, active({ sub: `u-${t}`, tokenType: "session" })]));
  const { verifier } = fakeIdentity(answers, statuses);
  await assert.rejects(verifier.verifyCookie("sess-405"), AuthServiceMisconfiguredError);
  await assert.rejects(verifier.verifyCookie("sess-403"), AuthServiceMisconfiguredError);
  await assert.rejects(verifier.verifyCookie("sess-expired"), PlatformKeyMissingError);
  for (const t of ["sess-401", "sess-429", "sess-500"]) {
    await assert.rejects(verifier.verifyCookie(t), IdentityUpstreamError, t);
  }

  const identity = { introspect: async () => active({ sub: "u-bad", tokenType: "session" }) };
  const notJson = verifierOf(identity, (async () => new Response("not-json", { status: 200 })) as typeof fetch);
  await assert.rejects(notJson.verifyCookie("sess-bad"), IdentityUpstreamError);
});

test("an identity service that answers the platform key with an error is a 503 for the cookie", async () => {
  const { default: Fastify } = await import("fastify");
  const { default: cookie } = await import("@fastify/cookie");
  const { verifySessionCookie } = await import("../src/auth/middleware.js");
  const { verifier } = fakeIdentity({ "sess-busy": active({ sub: "u-busy", tokenType: "session" }) }, { "sess-busy": { status: 502 } });
  const app = Fastify();
  await app.register(cookie);
  app.get("/v1/ping", async (req) => verifySessionCookie(req, verifier, "/v1/ping"));
  await app.ready();
  try {
    const res = await app.inject({ method: "GET", url: "/v1/ping", headers: { cookie: "Token=sess-busy" } });
    const outcome = JSON.parse(res.body);
    assert.equal(outcome.error.status, 503);
    assert.match(outcome.error.message, /^The identity service could not verify/);
  } finally {
    await app.close();
  }
});

test("the platform key cache keeps the most recently used users", async () => {
  const answers: Record<string, IntrospectionResult> = {};
  const keys: Record<string, { status: number; body?: unknown }> = {};
  for (let i = 0; i <= 1000; i++) {
    answers[`sess-${i}`] = active({ sub: `u-${i}`, tokenType: "session" });
    keys[`sess-${i}`] = { status: 200, body: { userId: `u-${i}`, apiKey: `ak-${i}` } };
  }
  const { verifier, seen } = fakeIdentity(answers, keys);
  for (let i = 0; i < 1000; i++) await verifier.verifyCookie(`sess-${i}`);
  await verifier.verifyCookie("sess-0");
  await verifier.verifyCookie("sess-1000");
  assert.equal(seen.fetch.length, 1001);
  await verifier.verifyCookie("sess-0");
  assert.equal(seen.fetch.length, 1001, "a recently used key survives eviction");
  await verifier.verifyCookie("sess-1");
  assert.equal(seen.fetch.length, 1002, "the least recently used key is evicted");
});
