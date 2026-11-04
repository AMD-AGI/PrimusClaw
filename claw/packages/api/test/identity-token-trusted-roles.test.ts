// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * When an identity provider's access token may confer a platform role.
 *
 * By default it never does (identity-token.test.ts pins that). With
 * CLAW_IDENTITY_TOKEN_TRUSTED_ROLES naming `system-admin` and/or
 * `system-admin-readonly`, a role is adopted only when the operator named it,
 * the token (already verified as the configured issuer's) claims it, and the
 * provider's RFC 7662 answer for that token, now, is active, names the same
 * subject and lists it. Everything else is a plain user, and a token the
 * provider calls inactive is refused.
 *
 * The provider is a stand-in on a socket and the client is the real one, so
 * "the provider was asked" and "the provider was not asked" are counts of
 * requests that arrived, not inferences. The last describe block runs the real
 * authentication hook in front of the real sandbox admin routes: the page an
 * administrator signing in through the provider could not reach.
 */
import test, { after, before, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { FastifyRequest } from "fastify";
import Fastify, { type FastifyInstance } from "fastify";

import { FakeIdentity, activeAnswer, signJwt, testKey, type Reply, type TestKey } from "../../utils/test/identity-fake.js";
import { sendJson, startFakeUpstream } from "./support/fake-upstream.js";
import type { CredentialOutcome } from "../src/auth/middleware.js";
import { canAccessSessionAsOperator, getUserRole, isAdmin, isSystemAdmin } from "../src/auth/models.js";

// config.ts reads SAFE_API_URL and AUTH_INTERNAL_TOKEN when it is first imported, and the modules below import it, so the
// environment the authentication hook needs is set first and they are imported after (a static import would run before this).
// SaFE is asked what keys the token's subject has (auth/identity-token.ts); this one is a SaFE that does not know the
// issuer, which is the deployment the roles below are for, so every caller here is a plain user without keys.
const safe = await startFakeUpstream((_req, res) => sendJson(res, 401, { code: 401, message: "invalid token" }));
Object.assign(process.env, { SAFE_API_URL: safe.url, AUTH_INTERNAL_TOKEN: "t" });
delete process.env.CLAW_DEPLOY_MODE;
const { ADOPTABLE_ROLES, identityTokenSettings, verifyIdentityAccessToken } = await import("../src/auth/identity-token.js");
const { startIdentityClient } = await import("../src/auth/identity.js");

const nowSec = () => Math.floor(Date.now() / 1000);
const payloadOf = (token: string) => JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8") || "{}");
const es = testKey("ES256", "k-es");
const stranger = testKey("ES256", "k-es", true);
const log = { info() {}, warn() {}, error() {} };
const TRUSTED = "CLAW_IDENTITY_TOKEN_TRUSTED_ROLES";
const SA = "system-admin";
const RO = "system-admin-readonly";

let fake: FakeIdentity;

const ENV_KEYS = [
  "IDENTITY_CLIENT_ENABLED", "IDENTITY_ISSUER_URL", "IDENTITY_CLIENT_ID", "IDENTITY_CLIENT_SECRET",
  "IDENTITY_INTROSPECTION_CACHE_SECONDS", "IDENTITY_INTROSPECTION_NEGATIVE_CACHE_SECONDS", "IDENTITY_STALE_IF_ERROR_SECONDS",
  "CLAW_IDENTITY_TOKEN_AUTH_ENABLED", "CLAW_IDENTITY_TOKEN_AUDIENCE", "CLAW_IDENTITY_TOKEN_SCOPE", "CLAW_IDENTITY_TOKEN_INTROSPECT", TRUSTED,
];

/** A fresh client against the stand-in provider, with no answer cached (unless a test asks for one). */
function identity(extra: Record<string, string> = {}): void {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, {
    IDENTITY_CLIENT_ENABLED: "true", IDENTITY_ISSUER_URL: fake.issuer, IDENTITY_CLIENT_ID: "svc-claw",
    IDENTITY_CLIENT_SECRET: "s3cret", IDENTITY_INTROSPECTION_CACHE_SECONDS: "0",
    IDENTITY_INTROSPECTION_NEGATIVE_CACHE_SECONDS: "0", IDENTITY_STALE_IF_ERROR_SECONDS: "0",
    CLAW_IDENTITY_TOKEN_AUTH_ENABLED: "true", ...extra,
  });
  startIdentityClient(log);
}

function mint(over: Record<string, unknown> = {}, opts: { key?: TestKey; header?: Record<string, unknown> } = {}): string {
  const claims: Record<string, unknown> = {
    iss: fake.issuer, aud: "claw-api", sub: "u-admin-1", client_id: "claw-web", scope: "openid profile claw.api", name: "Ada Admin",
    roles: ["default"], groups: [], jti: randomUUID(), iat: nowSec(), nbf: nowSec() - 1, exp: nowSec() + 300, ...over,
  };
  for (const k of Object.keys(claims)) if (claims[k] === undefined) delete claims[k];
  return signJwt({ key: opts.key ?? es, claims, header: opts.header });
}

/** What the provider says about a token. By default: active, the token's own subject, and exactly the roles the token claims. */
type Answer = (claims: Record<string, any>) => Reply;
const confirmsWhatItClaims: Answer = (c) => ({ body: activeAnswer({ sub: c.sub, roles: Array.isArray(c.roles) ? c.roles : [] }) });
let answer: Answer = confirmsWhatItClaims;
let providerDown = false;

function wireProvider(): void {
  fake.discovery = () => ({ body: fake.discoveryDocument() });
  fake.jwks = () => ({ body: { keys: [es.jwk] } });
  fake.introspect = (r) => (providerDown ? { status: 503, body: "down" } : answer(payloadOf(r.form.get("token") ?? "")));
}

const request = (authorization: string): FastifyRequest => ({ headers: { authorization } }) as unknown as FastifyRequest;
const verify = (token: string): Promise<CredentialOutcome> => verifyIdentityAccessToken(request(`Bearer ${token}`), null, "/v1/sessions");
const asked = () => fake.count("/oauth/introspect");

function verified(o: CredentialOutcome) {
  assert.equal(o.status, "verified", JSON.stringify(o));
  return (o as Extract<CredentialOutcome, { status: "verified" }>);
}
function refused(o: CredentialOutcome) {
  assert.equal(o.status, "rejected", JSON.stringify(o));
  return (o as Extract<CredentialOutcome, { status: "rejected" }>).error;
}

before(async () => { fake = await FakeIdentity.start(); });
after(async () => { await fake.close(); await safe.close(); });
beforeEach(() => {
  providerDown = false;
  answer = confirmsWhatItClaims;
  wireProvider();
  identity();
  fake.requests.length = 0;
});

describe("the setting names the roles, and only the adoptable ones", () => {
  const cases: Array<[string, string | undefined, string[]]> = [
    ["unset is none", undefined, []],
    ["empty is none", "", []],
    ["blank is none", "  ,, ", []],
    ["system-admin", SA, [SA]],
    ["system-admin-readonly", RO, [RO]],
    ["both, comma separated", `${SA},${RO}`, [SA, RO]],
    ["both, in the other order and padded, come out in the canonical order", ` ${RO} , ${SA} `, [SA, RO]],
    ["both, space separated", `${SA} ${RO}`, [SA, RO]],
    ["a repeated name counts once", `${SA},${SA}`, [SA]],
    ["`default` is not adoptable", "default", []],
    ["a wildcard is not a role", "*", []],
    ["`all` is not a role", "all", []],
    ["a role of this API's own naming is not a role of the provider's: `admin`", "admin", []],
    ["names are exact: case", "System-Admin", []],
    ["names are exact: a prefix", "system-admin-", []],
    ["names are exact: an underscore", "system_admin", []],
    ["names are exact: a suffix", "system-admin-readonly2", []],
    ["a list that mixes in names that are not adoptable keeps only those that are", `default,${SA},ops`, [SA]],
  ];
  for (const [name, raw, want] of cases) {
    test(name, () => {
      if (raw === undefined) delete process.env[TRUSTED]; else process.env[TRUSTED] = raw;
      assert.deepEqual(identityTokenSettings().trustedRoles, want);
    });
  }

  test("the adoptable roles are exactly the two platform administrator roles", () => {
    assert.deepEqual([...ADOPTABLE_ROLES], [SA, RO]);
  });
});

describe("which roles the caller gets", () => {
  interface Case {
    name: string;
    /** CLAW_IDENTITY_TOKEN_TRUSTED_ROLES; undefined leaves it unset (the default). */
    trusted?: string;
    /** The token's `roles` claim; undefined leaves it out. */
    claim?: unknown;
    groups?: unknown;
    provider?: Answer;
    roles: string[];
    /** How many times the provider was asked. */
    asked: number;
  }
  const lists = (roles: unknown, over: Record<string, unknown> = {}): Answer => (c) => ({ body: activeAnswer({ sub: c.sub, roles, ...over }) });
  const cases: Case[] = [
    // The default: the setting is not there, so nothing changes and nobody is asked.
    { name: "default: setting unset, token claims system-admin, provider would confirm it -> default only, provider not asked", claim: [SA], roles: ["default"], asked: 0 },
    { name: "default: setting empty -> the same", trusted: "", claim: [SA, RO], roles: ["default"], asked: 0 },
    { name: "default: a setting naming nothing adoptable -> the same", trusted: "default,admin,*", claim: [SA, RO], roles: ["default"], asked: 0 },
    // Adopted: named, claimed, confirmed.
    { name: "system-admin named, claimed and confirmed -> adopted", trusted: SA, claim: ["default", SA], roles: ["default", SA], asked: 1 },
    { name: "system-admin as the only role claimed -> adopted, and `default` is still there", trusted: SA, claim: [SA], roles: ["default", SA], asked: 1 },
    { name: "system-admin-readonly named, claimed and confirmed -> adopted", trusted: RO, claim: [RO], roles: ["default", RO], asked: 1 },
    { name: "both named, both claimed, both confirmed -> both", trusted: `${SA},${RO}`, claim: [RO, SA], roles: ["default", SA, RO], asked: 1 },
    // The three conditions are each needed.
    { name: "named but not claimed -> default, and the provider is not asked for a user with no role to confirm", trusted: SA, claim: ["default"], roles: ["default"], asked: 0 },
    { name: "named but the token has no roles claim -> default, not asked", trusted: SA, claim: undefined, roles: ["default"], asked: 0 },
    { name: "named but the claim is empty -> default, not asked", trusted: SA, claim: [], roles: ["default"], asked: 0 },
    { name: "named but the claim is a string, not a list -> default, not asked", trusted: SA, claim: SA, roles: ["default"], asked: 0 },
    { name: "named but the role is only in `groups` -> default, not asked", trusted: SA, claim: undefined, groups: [SA], roles: ["default"], asked: 0 },
    { name: "claimed but not named: only the readonly role is named -> default, not asked", trusted: RO, claim: [SA], roles: ["default"], asked: 0 },
    { name: "claimed and named, the provider does not list it -> default (the claim alone is not enough)", trusted: SA, claim: [SA], provider: lists(["default"]), roles: ["default"], asked: 1 },
    { name: "claimed and named, the provider lists no roles -> default", trusted: SA, claim: [SA], provider: lists([]), roles: ["default"], asked: 1 },
    { name: "claimed and named, the provider's roles are not a list -> default", trusted: SA, claim: [SA], provider: lists(SA), roles: ["default"], asked: 1 },
    { name: "claimed and named, the provider names no subject -> nothing is confirmed, default (and not refused)", trusted: SA, claim: [SA], provider: lists([SA], { sub: undefined }), roles: ["default"], asked: 1 },
    // Each role on its own.
    { name: "both named and claimed, the provider lists only readonly (a downgrade since the token was issued) -> readonly only", trusted: `${SA},${RO}`, claim: [SA, RO], provider: lists([RO]), roles: ["default", RO], asked: 1 },
    { name: "both named and claimed, the provider lists only system-admin -> system-admin only", trusted: `${SA},${RO}`, claim: [SA, RO], provider: lists([SA]), roles: ["default", SA], asked: 1 },
    { name: "both claimed, only system-admin named -> system-admin only", trusted: SA, claim: [SA, RO], roles: ["default", SA], asked: 1 },
    { name: "both claimed, only readonly named -> readonly only", trusted: RO, claim: [SA, RO], roles: ["default", RO], asked: 1 },
    { name: "both named, only readonly claimed, the provider lists both -> readonly only (the token bounds it)", trusted: `${SA},${RO}`, claim: [RO], provider: lists([SA, RO]), roles: ["default", RO], asked: 1 },
    // Roles that are not adoptable are never adopted, however well confirmed.
    { name: "other roles that the token claims and the provider lists are not copied", trusted: SA, claim: ["ops", "billing", SA], provider: lists(["ops", "billing", SA]), roles: ["default", SA], asked: 1 },
    { name: "`default` in the setting does not make a claim of it adoptable twice", trusted: `default,${SA}`, claim: ["default", SA], roles: ["default", SA], asked: 1 },
  ];
  for (const c of cases) {
    test(c.name, async () => {
      if (c.trusted !== undefined) process.env[TRUSTED] = c.trusted;
      if (c.provider) answer = c.provider;
      const v = verified(await verify(mint({ roles: c.claim, groups: c.groups })));
      assert.deepEqual(v.user.roles, c.roles);
      assert.equal(asked(), c.asked, "how many times the provider was asked");
      assert.equal(v.user.platformKey, "");
      assert.equal(v.user.virtualKey, "");
    });
  }

  test("what the roles mean to the rest of the API", async () => {
    process.env[TRUSTED] = `${SA},${RO}`;
    const full = verified(await verify(mint({ roles: [SA] }))).user;
    assert.equal(getUserRole(full), SA);
    assert.ok(isAdmin(full) && isSystemAdmin(full));
    assert.equal(canAccessSessionAsOperator("another-tenant", full), true);

    const readonly = verified(await verify(mint({ roles: [RO] }))).user;
    assert.equal(getUserRole(readonly), RO);
    assert.ok(isAdmin(readonly));
    assert.equal(isSystemAdmin(readonly), false, "readonly is not a system-admin");

    const plain = verified(await verify(mint({ roles: ["default"] }))).user;
    assert.equal(getUserRole(plain), "default");
    assert.equal(isAdmin(plain), false);
    assert.equal(canAccessSessionAsOperator("another-tenant", plain), false);
  });

  test("the role belongs to that request's token and subject: the next token of another user is judged on its own", async () => {
    process.env[TRUSTED] = SA;
    answer = (c) => ({ body: activeAnswer({ sub: c.sub, roles: c.sub === "u-admin-1" ? [SA] : ["default"] }) });
    assert.deepEqual(verified(await verify(mint({ sub: "u-admin-1", roles: [SA] }))).user.roles, ["default", SA]);
    assert.deepEqual(verified(await verify(mint({ sub: "u-other", roles: [SA] }))).user.roles, ["default"]);
  });
});

describe("a token the provider does not stand behind", () => {
  beforeEach(() => { process.env[TRUSTED] = `${SA},${RO}`; });

  test("inactive: refused, not downgraded", async () => {
    answer = () => ({ body: { active: false } });
    const e = refused(await verify(mint({ roles: [SA] })));
    assert.equal(e.status, 401);
    assert.equal(e.legacyError, "invalid_token");
    assert.equal(asked(), 1);
  });

  test("an answer for another subject: refused", async () => {
    answer = () => ({ body: activeAnswer({ sub: "someone-else", roles: [SA] }) });
    const e = refused(await verify(mint({ roles: [SA] })));
    assert.equal(e.status, 401);
    assert.equal(e.legacyError, "invalid_token");
  });

  test("a user with no role to confirm is not refused for what the provider says about tokens: it is not asked", async () => {
    answer = () => ({ body: { active: false } });
    const v = verified(await verify(mint({ roles: ["default"] })));
    assert.deepEqual(v.user.roles, ["default"]);
    assert.equal(asked(), 0);
  });
});

describe("a provider that cannot be asked: a plain user, never the claim, and not a 503", () => {
  beforeEach(() => { process.env[TRUSTED] = `${SA},${RO}`; });
  const failures: Array<[string, () => Reply]> = [
    ["503", () => ({ status: 503, body: "down" })],
    ["500", () => ({ status: 500, body: "boom" })],
    ["429", () => ({ status: 429, body: "slow down", headers: { "retry-after": "1" } })],
    ["the provider turns this client away (401)", () => ({ status: 401, body: { error: "invalid_client" } })],
    ["the provider turns this client away (403)", () => ({ status: 403, body: { error: "forbidden" } })],
    ["an answer that is not JSON", () => ({ status: 200, body: "<html>maintenance</html>" })],
    ["an answer with no `active` member", () => ({ status: 200, body: { sub: "u-admin-1", roles: [SA] } })],
    ["an `active` that is not a boolean", () => ({ status: 200, body: { active: "true", sub: "u-admin-1", roles: [SA] } })],
    ["a dropped connection", () => ({ destroy: true })],
  ];
  for (const [name, reply] of failures) {
    test(name, async () => {
      fake.introspect = () => reply();
      const v = verified(await verify(mint({ roles: [SA, RO] })));
      assert.deepEqual(v.user.roles, ["default"]);
      assert.equal(isAdmin(v.user), false);
      assert.ok(asked() >= 1, "the provider was asked");
    });
  }

  test("a discovery document with no introspection endpoint is the same", async () => {
    // Pin nothing and advertise nothing: the client cannot name where to ask.
    fake.discovery = () => {
      const doc = fake.discoveryDocument();
      delete doc.introspection_endpoint;
      return { body: doc };
    };
    identity();
    const v = verified(await verify(mint({ roles: [SA] })));
    assert.deepEqual(v.user.roles, ["default"]);
    assert.equal(asked(), 0);
  });

  test("and once the provider is back the same token is an administrator again (nothing is remembered against it)", async () => {
    const token = mint({ roles: [SA] });
    providerDown = true;
    assert.deepEqual(verified(await verify(token)).user.roles, ["default"]);
    providerDown = false;
    assert.deepEqual(verified(await verify(token)).user.roles, ["default", SA]);
  });
});

describe("a token that is not the configured issuer's is never an administrator, and never reaches the provider", () => {
  // The provider here would confirm any token it is shown. What these tests pin is that it is not shown the token:
  // issuer, signature, audience, type and lifetime are judged first, by the identity client, from the issuer's own key set.
  beforeEach(() => {
    process.env[TRUSTED] = `${SA},${RO}`;
    answer = (c) => ({ body: activeAnswer({ sub: c.sub, roles: [SA, RO] }) });
  });
  const admin = { roles: [SA, RO] };
  const foreign: Array<[string, () => string, number, string]> = [
    ["a self-signed token (a key the issuer does not publish)", () => mint(admin, { key: stranger }), 401, "invalid_token"],
    ["a self-signed token that carries its own public key in the header", () => mint(admin, { key: stranger, header: { jwk: stranger.jwk } }), 401, "invalid_token"],
    ["a self-signed token that names a key the issuer does not publish", () => mint(admin, { key: stranger, header: { kid: "k-mine" } }), 401, "invalid_token"],
    ["another issuer's token (iss)", () => mint({ ...admin, iss: "https://idp.elsewhere.example.com" }), 401, "invalid_token"],
    ["the right issuer's name signed by someone else", () => mint({ ...admin, iss: fake.issuer }, { key: stranger }), 401, "invalid_token"],
    ["another audience", () => mint({ ...admin, aud: "another-application" }), 401, "invalid_token"],
    ["an ID token (typed JWT)", () => mint(admin, { header: { typ: "JWT" } }), 401, "invalid_token"],
    ["alg none", () => mint(admin, { header: { alg: "none" } }), 401, "invalid_token"],
    ["an unsigned token", () => mint(admin).split(".").slice(0, 2).join(".") + ".", 401, "invalid_token"],
    ["HS256", () => mint(admin, { header: { alg: "HS256" } }), 401, "invalid_token"],
    ["an expired token", () => mint({ ...admin, exp: nowSec() - 3600 }), 401, "invalid_token"],
    ["no API scope", () => mint({ ...admin, scope: "openid" }), 403, "insufficient_scope"],
    ["a subject the API reserves for itself", () => mint({ ...admin, sub: "default" }), 401, "invalid_token"],
  ];
  for (const [name, token, status, legacyError] of foreign) {
    test(name, async () => {
      const e = refused(await verify(token()));
      assert.equal(e.status, status);
      assert.equal(e.legacyError, legacyError);
      assert.equal(asked(), 0, "the provider was never shown the token");
    });
  }
});

describe("with CLAW_IDENTITY_TOKEN_INTROSPECT on as well", () => {
  beforeEach(() => { process.env.CLAW_IDENTITY_TOKEN_INTROSPECT = "true"; });

  test("one question to the provider serves both the active check and the role", async () => {
    process.env[TRUSTED] = SA;
    assert.deepEqual(verified(await verify(mint({ roles: [SA] }))).user.roles, ["default", SA]);
    assert.equal(asked(), 1);
  });

  test("a user with nothing to adopt is still asked about (the active check), and is a plain user", async () => {
    process.env[TRUSTED] = SA;
    assert.deepEqual(verified(await verify(mint({ roles: ["default"] }))).user.roles, ["default"]);
    assert.equal(asked(), 1);
  });

  test("without the setting the role is not adopted though the provider confirms it", async () => {
    assert.deepEqual(verified(await verify(mint({ roles: [SA] }))).user.roles, ["default"]);
    assert.equal(asked(), 1);
  });

  test("inactive is refused", async () => {
    process.env[TRUSTED] = SA;
    answer = () => ({ body: { active: false } });
    assert.equal(refused(await verify(mint({ roles: [SA] }))).status, 401);
  });

  test("a provider that cannot be asked is still a 503 here: required introspection is not relaxed by the setting", async () => {
    process.env[TRUSTED] = SA;
    providerDown = true;
    const e = refused(await verify(mint({ roles: [SA] })));
    assert.equal(e.status, 503);
    assert.equal(e.legacyError, "authentication_service_unavailable");
  });
});

describe("the identity client's own caching decides how fresh the confirmation is", () => {
  const pastFreshness = () => new Promise((r) => setTimeout(r, 1100));

  test("a cached confirmation is reused: one question for two requests", async () => {
    identity({ IDENTITY_INTROSPECTION_CACHE_SECONDS: "60", [TRUSTED]: SA });
    const token = mint({ roles: [SA] });
    assert.deepEqual(verified(await verify(token)).user.roles, ["default", SA]);
    assert.deepEqual(verified(await verify(token)).user.roles, ["default", SA]);
    assert.equal(asked(), 1);
  });

  test("with no cache, a role the provider has since taken away is gone on the next request", async () => {
    process.env[TRUSTED] = SA;
    const token = mint({ roles: [SA] });
    assert.deepEqual(verified(await verify(token)).user.roles, ["default", SA]);
    answer = (c) => ({ body: activeAnswer({ sub: c.sub, roles: ["default"] }) });
    assert.deepEqual(verified(await verify(token)).user.roles, ["default"]);
  });

  test("with no cache, a token the provider has since revoked is refused on the next request", async () => {
    process.env[TRUSTED] = SA;
    const token = mint({ roles: [SA] });
    verified(await verify(token));
    answer = () => ({ body: { active: false } });
    assert.equal(refused(await verify(token)).status, 401);
  });

  test("through an outage a confirmation still inside the stale window holds (the client's rule), and a token never seen is a plain user", async () => {
    identity({ IDENTITY_INTROSPECTION_CACHE_SECONDS: "1", IDENTITY_STALE_IF_ERROR_SECONDS: "1800", [TRUSTED]: SA });
    const seen = mint({ roles: [SA] });
    assert.deepEqual(verified(await verify(seen)).user.roles, ["default", SA]);
    await pastFreshness();
    providerDown = true;
    assert.deepEqual(verified(await verify(seen)).user.roles, ["default", SA]);
    assert.deepEqual(verified(await verify(mint({ roles: [SA] }))).user.roles, ["default"]);
  });

  test("with the stale window at zero an outage drops the role at once, even for a token confirmed a moment ago", async () => {
    identity({ IDENTITY_INTROSPECTION_CACHE_SECONDS: "1", IDENTITY_STALE_IF_ERROR_SECONDS: "0", [TRUSTED]: SA });
    const seen = mint({ roles: [SA] });
    assert.deepEqual(verified(await verify(seen)).user.roles, ["default", SA]);
    await pastFreshness();
    providerDown = true;
    assert.deepEqual(verified(await verify(seen)).user.roles, ["default"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The product path: an administrator who signed in through the provider, and the sandbox admin page.
// ---------------------------------------------------------------------------------------------------------------------
describe("an administrator signed in through the provider reaches the admin page (real authentication hook, real route)", () => {
  let app: FastifyInstance;
  let base = "";
  let routerCalls: string[] = [];
  const originalFetch = globalThis.fetch;
  let sandboxBase = "";

  before(async () => {
    const { authMiddleware, getUser } = await import("../src/auth/middleware.js");
    const { registerSandboxAdminRoutes } = await import("../src/routes/sandbox-admin.js");
    const { SANDBOX_ADMIN_URL } = await import("../src/config.js");
    sandboxBase = SANDBOX_ADMIN_URL.replace(/\/+$/, "");
    // The Router is the only thing replaced; the identity provider and this server are reached for real.
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      if (String(input).startsWith(sandboxBase)) {
        routerCalls.push(String(input));
        return Response.json({ totalCount: 1, items: [{ sandboxName: "sb-1" }] });
      }
      return originalFetch(input as Parameters<typeof fetch>[0], init);
    }) as typeof fetch;
    app = Fastify();
    await app.register((await import("@fastify/cookie")).default);
    app.addHook("preHandler", authMiddleware);
    app.get("/v1/whoami", async (req) => ({ user: getUser(req) }));
    await registerSandboxAdminRoutes(app);
    await app.listen({ port: 0, host: "127.0.0.1" });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });
  after(async () => {
    globalThis.fetch = originalFetch;
    await app?.close();
  });
  beforeEach(() => {
    routerCalls = [];
    identity();
  });

  const page = async (token: string) => {
    const r = await fetch(`${base}/v1/admin/sandbox/sessions`, { headers: { authorization: `Bearer ${token}` } });
    return { status: r.status, body: await r.json().catch(() => null) as any };
  };

  test("today's behaviour, setting off: the same administrator is a plain user and is refused the page", async () => {
    const r = await page(mint({ roles: [SA] }));
    assert.equal(r.status, 403);
    assert.deepEqual(routerCalls, []);
  });

  test("the setting names system-admin and the provider confirms: the page opens", async () => {
    process.env[TRUSTED] = SA;
    const r = await page(mint({ roles: [SA] }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(routerCalls.length, 1);
  });

  test("the setting names system-admin-readonly and the provider confirms: the read-only page opens", async () => {
    process.env[TRUSTED] = RO;
    const r = await page(mint({ roles: [RO] }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });

  test("whoami reports the adopted roles and nothing the token merely claims", async () => {
    process.env[TRUSTED] = SA;
    const r = await fetch(`${base}/v1/whoami`, { headers: { authorization: `Bearer ${mint({ roles: ["default", SA, RO, "ops"] })}` } });
    const body = await r.json() as any;
    assert.equal(r.status, 200);
    assert.deepEqual(body.user.roles, ["default", SA], "readonly and ops were claimed but not named");
  });

  test("the provider has since taken the role away: the page is closed", async () => {
    process.env[TRUSTED] = SA;
    answer = (c) => ({ body: activeAnswer({ sub: c.sub, roles: ["default"] }) });
    const r = await page(mint({ roles: [SA] }));
    assert.equal(r.status, 403);
    assert.deepEqual(routerCalls, []);
  });

  test("the provider cannot be asked: the page is closed (a 403, not a 503 and not a 200)", async () => {
    process.env[TRUSTED] = SA;
    providerDown = true;
    const r = await page(mint({ roles: [SA] }));
    assert.equal(r.status, 403);
    assert.deepEqual(routerCalls, []);
  });

  test("a self-signed token that claims system-admin is refused outright", async () => {
    process.env[TRUSTED] = SA;
    const r = await page(mint({ roles: [SA] }, { key: stranger }));
    assert.equal(r.status, 401);
    assert.equal(asked(), 0);
    assert.deepEqual(routerCalls, []);
  });

  test("another issuer's token that claims system-admin is refused outright", async () => {
    process.env[TRUSTED] = SA;
    const r = await page(mint({ roles: [SA], iss: "https://idp.elsewhere.example.com" }));
    assert.equal(r.status, 401);
    assert.equal(asked(), 0);
  });

  test("the provider calls the token inactive: refused", async () => {
    process.env[TRUSTED] = SA;
    answer = () => ({ body: { active: false } });
    const r = await page(mint({ roles: [SA] }));
    assert.equal(r.status, 401);
    assert.deepEqual(routerCalls, []);
  });
});
