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

const {
  IdentityAccountRefusedError, IdentityUnreachableError, IdentityVerifier, IdentityUpstreamError, identityApiBase, PlatformKeyMissingError,
} = await import("../src/auth/identity-verifier.js");
const { safeFailureOf } = await import("../src/auth/delegated-keys.js");
const { AuthServiceMisconfiguredError, AuthUpstreamUnreachableError } = await import("../src/auth/safe-client.js");
const config = await import("../src/config.js");

const API = "http://identity.test";
const CLIENT = { clientId: "claw-api", clientSecret: "s3cret" };
/** A verifier against `identity` and `fetchFn` with this file's client. */
function verifierOf(identity: unknown, fetchFn: typeof fetch) {
  return new IdentityVerifier(identity as never, { apiUrl: API, client: CLIENT, fetchFn });
}

function active(over: Partial<Extract<IntrospectionResult, { active: true }>>): IntrospectionResult {
  return { active: true, roles: [], groups: [], audience: [], scope: [], claims: {}, ...over };
}

/** A fake identity service: introspection answers by token, the platform key endpoint by bearer session. */
function fakeIdentity(
  answers: Record<string, IntrospectionResult | Error>,
  keys: Record<string, { status: number; body?: unknown }>,
) {
  const seen = {
    introspect: [] as { token: string; params?: Record<string, string>; allowStale?: boolean }[],
    fetch: [] as { url: string; method?: string; headers: Record<string, string>; redirect?: RequestRedirect }[],
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
    seen.fetch.push({ url, method: init.method, headers, redirect: init.redirect });
    const answer = keys[headers.Authorization!.replace(/^Bearer /, "")] ?? { status: 401 };
    return new Response(answer.body === undefined ? "" : JSON.stringify(answer.body), { status: answer.status });
  }) as typeof fetch;
  return { verifier: verifierOf(identity, fetchFn), seen };
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
    userId: "u-alice", userName: "Alice", email: "alice@example.test", roles: ["system-admin", "default"],
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

test("an ak- key is the introspected user, and the key is its platform key; no role is added that the answer does not list", async () => {
  const { verifier, seen } = fakeIdentity(
    { "ak-bob": active({ sub: "u-bob", username: "bob@example.test", roles: ["system-admin-readonly"], tokenType: "api_key" }) },
    {},
  );
  const user = await verifier.verifyApiKey("ak-bob");
  assert.deepEqual(user, { userId: "u-bob", userName: "bob@example.test", roles: ["system-admin-readonly"], platformKey: "ak-bob", virtualKey: "" });
  assert.equal(seen.fetch.length, 0);
});

test("the caller's roles are the answer's roles, whatever CLAW_REQUIRED_PLATFORM_ROLES names", async () => {
  const saved = process.env.CLAW_REQUIRED_PLATFORM_ROLES;
  process.env.CLAW_REQUIRED_PLATFORM_ROLES = "claw-user";
  try {
    const { verifier } = fakeIdentity(
      { "ak-dave": active({ sub: "u-dave", roles: ["system-admin", "system-admin-readonly", "team-a"], tokenType: "api_key" }) },
      {},
    );
    const user = await verifier.verifyApiKey("ak-dave");
    assert.deepEqual(user.roles, ["system-admin", "system-admin-readonly", "team-a"]);
  } finally {
    if (saved === undefined) delete process.env.CLAW_REQUIRED_PLATFORM_ROLES;
    else process.env.CLAW_REQUIRED_PLATFORM_ROLES = saved;
  }
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
    { "sess-nokeys": { status: 404, body: { errorCode: "Primus.00005", errorMessage: "this user has no primary API key" } } },
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
  await assert.rejects(verifier.verifyCookie("sess-401"), /invalid or expired cookie/);
  for (const t of ["sess-429", "sess-500"]) {
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

test("the platform key request refuses redirects, so the client secret is never sent to another host", async () => {
  const { verifier, seen } = fakeIdentity(
    { "sess-kim": active({ sub: "u-kim", tokenType: "session" }) },
    { "sess-kim": { status: 200, body: { userId: "u-kim", apiKey: "ak-kim" } } },
  );
  await verifier.verifyCookie("sess-kim");
  assert.equal(seen.fetch[0]!.redirect, "error");
});

test("only identity's own no-key answer is a missing key; any other 404 is misconfiguration", async () => {
  const statuses: Record<string, { status: number; body?: unknown }> = {
    "sess-nokey": { status: 404, body: { errorCode: "Primus.00005", errorMessage: "this user has no primary API key" } },
    "sess-notserved": { status: 404, body: { errorCode: "Primus.00005", errorMessage: "platform API keys are not served here" } },
    "sess-wrongbase": { status: 404 },
  };
  const answers = Object.fromEntries(Object.keys(statuses).map((t) => [t, active({ sub: `u-${t}`, tokenType: "session" })]));
  const { verifier } = fakeIdentity(answers, statuses);
  await assert.rejects(verifier.verifyCookie("sess-nokey"), PlatformKeyMissingError);
  await assert.rejects(verifier.verifyCookie("sess-notserved"), AuthServiceMisconfiguredError);
  await assert.rejects(verifier.verifyCookie("sess-wrongbase"), AuthServiceMisconfiguredError);
});

test("an introspection URL that does not end in /oauth/introspect gives no API base without IDENTITY_API_URL", () => {
  assert.equal(identityApiBase("https://host/identity/oauth2/introspect", ""), "");
  assert.equal(identityApiBase("https://host/idp/oauth/introspect/extra", ""), "");
  assert.equal(identityApiBase("https://host/identity/oauth2/introspect", "https://host/identity"), "https://host/identity");
});

test("a 403 for the account is a refusal of that user; an unrecognised 403 is an upstream failure", async () => {
  const statuses: Record<string, { status: number; body?: unknown }> = {
    "sess-disabled": { status: 403, body: { errorCode: "Primus.00003", errorMessage: "this account is disabled" } },
    "sess-restricted": { status: 403, body: { errorCode: "Primus.00003", errorMessage: "this account is restricted" } },
    "sess-other": { status: 403, body: { errorCode: "Primus.00003", errorMessage: "forbidden" } },
  };
  const answers = Object.fromEntries(Object.keys(statuses).map((t) => [t, active({ sub: `u-${t}`, tokenType: "session" })]));
  const { verifier } = fakeIdentity(answers, statuses);
  await assert.rejects(verifier.verifyCookie("sess-disabled"), IdentityAccountRefusedError);
  await assert.rejects(verifier.verifyCookie("sess-restricted"), IdentityAccountRefusedError);
  await assert.rejects(verifier.verifyCookie("sess-other"), IdentityUpstreamError);
});

test("an account refusal is a 403 for the cookie", async () => {
  const { default: Fastify } = await import("fastify");
  const { default: cookie } = await import("@fastify/cookie");
  const { verifySessionCookie } = await import("../src/auth/middleware.js");
  const { verifier } = fakeIdentity(
    { "sess-off": active({ sub: "u-off", tokenType: "session" }) },
    { "sess-off": { status: 403, body: { errorMessage: "this account is disabled" } } },
  );
  const app = Fastify();
  await app.register(cookie);
  app.get("/v1/ping", async (req) => verifySessionCookie(req, verifier, "/v1/ping"));
  await app.ready();
  try {
    const res = await app.inject({ method: "GET", url: "/v1/ping", headers: { cookie: "Token=sess-off" } });
    const outcome = JSON.parse(res.body);
    assert.equal(outcome.error.status, 403);
    assert.equal(outcome.error.legacyError, "account_refused");
  } finally {
    await app.close();
  }
});

test("a kept platform key is not served past its expirationTime, read as UTC in the provider's layout", async (t) => {
  const tz = process.env.TZ;
  process.env.TZ = "Asia/Shanghai";
  t.after(() => { if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz; });
  const start = Math.floor(Date.now() / 1000) * 1000;
  const layout = new Date(start + 10_000).toISOString().slice(0, 19);
  const { verifier, seen } = fakeIdentity(
    { "sess-lee": active({ sub: "u-lee", tokenType: "session" }) },
    { "sess-lee": { status: 200, body: { userId: "u-lee", apiKey: "ak-lee", expirationTime: layout } } },
  );
  const now = t.mock.method(Date, "now", () => start);
  await verifier.verifyCookie("sess-lee");
  now.mock.mockImplementation(() => start + 9_000);
  await verifier.verifyCookie("sess-lee");
  assert.equal(seen.fetch.length, 1, "kept until the expiry");
  now.mock.mockImplementation(() => start + 11_000);
  await verifier.verifyCookie("sess-lee");
  assert.equal(seen.fetch.length, 2);
});

test("a platform key body larger than the cap is an upstream failure", async () => {
  const identity = { introspect: async () => active({ sub: "u-big", tokenType: "session" }) };
  const huge = verifierOf(identity, (async () => new Response(JSON.stringify({ userId: "u-big", apiKey: "ak-big", pad: "x".repeat(2 * 1024 * 1024) }), { status: 200 })) as typeof fetch);
  await assert.rejects(huge.verifyCookie("sess-big"), IdentityUpstreamError);
});

test("an identity service that cannot be reached is attributed to identity, not SaFE", async () => {
  const { verifier } = fakeIdentity({ "ak-gone": new IdentityUnavailableError("introspection", "network") }, {});
  const err = await verifier.verifyApiKey("ak-gone").catch((e: unknown) => e);
  assert.ok(err instanceof IdentityUnreachableError);
  assert.ok(err instanceof AuthUpstreamUnreachableError);
  assert.deepEqual(safeFailureOf(err), { status: "unavailable", source: "identity" });
});

test("an active answer without a known token type is an upstream protocol failure, not an invalid credential", async () => {
  const { verifier } = fakeIdentity(
    { "ak-notype": active({ sub: "u-x" }), "sess-notype": active({ sub: "u-y", tokenType: "apikey" }) },
    {},
  );
  await assert.rejects(verifier.verifyApiKey("ak-notype"), IdentityUpstreamError);
  await assert.rejects(verifier.verifyCookie("sess-notype"), IdentityUpstreamError);
});

test("a 401 for the platform key is an invalid cookie: the session was signed out after introspection", async () => {
  const { verifier } = fakeIdentity(
    { "sess-out": active({ sub: "u-out", tokenType: "session" }) },
    { "sess-out": { status: 401, body: { errorMessage: "invalid token" } } },
  );
  const err = await verifier.verifyCookie("sess-out").catch((e: unknown) => e);
  assert.ok(err instanceof Error && !(err instanceof IdentityUpstreamError), String(err));
  assert.match((err as Error).message, /invalid or expired cookie/);
});

test("a misconfiguration message names the settings, not the identity API URL", async () => {
  const { verifier } = fakeIdentity({ "sess-mis": active({ sub: "u-mis", tokenType: "session" }) }, { "sess-mis": { status: 404 } });
  const err = await verifier.verifyCookie("sess-mis").catch((e: unknown) => e);
  assert.ok(err instanceof AuthServiceMisconfiguredError);
  assert.doesNotMatch((err as Error).message, /identity\.test/);
  assert.match((err as Error).message, /IDENTITY_API_URL/);
});
