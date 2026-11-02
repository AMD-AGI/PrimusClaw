// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * An identity provider's access token as a credential, judged by
 * `verifyIdentityAccessToken` with the real identity client against a stand-in
 * provider on a socket (discovery, the key set and introspection travel the
 * real client, and the tokens are signed with real RS256 and ES256 keys).
 *
 * What a token must never do is as much the subject as what it may: each way a
 * token can be wrong is refused, and none of them is `absent` (which would let
 * the next credential path judge the request) or `verified`.
 */
import test, { after, before, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";

import { FakeIdentity, activeAnswer, signJwt, testKey, type TestKey } from "../../utils/test/identity-fake.js";
import { IDENTITY_TOKEN_METHOD, identityTokenSettings, verifyIdentityAccessToken } from "../src/auth/identity-token.js";
import { startIdentityClient } from "../src/auth/identity.js";
import type { CredentialOutcome } from "../src/auth/middleware.js";
import { canAccessSessionAsOperator, getUserRole, isAdmin, isSystemAdmin } from "../src/auth/models.js";

const nowSec = () => Math.floor(Date.now() / 1000);
const payloadOf = (token: string) => JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8") || "{}");
const es = testKey("ES256", "k-es");
const rs = testKey("RS256", "k-rs");
const stranger = testKey("ES256", "k-es", true);
const log = { info() {}, warn() {}, error() {} };

let fake: FakeIdentity;
let providerDown = false;
let keysDown = false;
let inactive = new Set<string>();

const ENV_KEYS = [
  "IDENTITY_CLIENT_ENABLED", "IDENTITY_ISSUER_URL", "IDENTITY_CLIENT_ID", "IDENTITY_CLIENT_SECRET",
  "IDENTITY_INTROSPECTION_CACHE_SECONDS", "IDENTITY_INTROSPECTION_NEGATIVE_CACHE_SECONDS", "IDENTITY_STALE_IF_ERROR_SECONDS",
  "CLAW_IDENTITY_TOKEN_AUTH_ENABLED", "CLAW_IDENTITY_TOKEN_AUDIENCE", "CLAW_IDENTITY_TOKEN_SCOPE", "CLAW_IDENTITY_TOKEN_INTROSPECT",
  "CLAW_IDENTITY_TOKEN_TRUSTED_ROLES",
];

/** A fresh client against the stand-in provider (so no key or answer is carried over), or none. */
function identity(on: boolean, extra: Record<string, string> = {}): void {
  for (const k of ENV_KEYS) delete process.env[k];
  if (on) {
    Object.assign(process.env, {
      IDENTITY_CLIENT_ENABLED: "true", IDENTITY_ISSUER_URL: fake.issuer, IDENTITY_CLIENT_ID: "svc-claw",
      IDENTITY_CLIENT_SECRET: "s3cret", IDENTITY_INTROSPECTION_CACHE_SECONDS: "0",
      IDENTITY_INTROSPECTION_NEGATIVE_CACHE_SECONDS: "0", IDENTITY_STALE_IF_ERROR_SECONDS: "0", ...extra,
    });
  }
  startIdentityClient(log);
}

/** An access token as the provider's authorization code flow issues it to a browser application. */
function mint(over: Record<string, unknown> = {}, opts: { key?: TestKey; header?: Record<string, unknown>; signWith?: "RS256" | "ES256" } = {}): string {
  const claims: Record<string, unknown> = {
    iss: fake.issuer, aud: "claw-api", sub: "u-web-1", client_id: "claw-web", gid: "g-1",
    scope: "openid profile email offline_access claw.api", email: "ada@example.com", name: "Ada Lovelace",
    roles: ["default"], groups: [], jti: randomUUID(), iat: nowSec(), nbf: nowSec() - 1, exp: nowSec() + 300, ...over,
  };
  for (const k of Object.keys(claims)) if (claims[k] === undefined) delete claims[k];
  return signJwt({ key: opts.key ?? es, claims, header: opts.header, signWith: opts.signWith });
}

/** The provider as it normally is: it knows every token it issued, except those listed as inactive. */
const defaultIntrospect = (r: { form: URLSearchParams }) => {
  if (providerDown) return { status: 503, body: "down" };
  const claims = payloadOf(r.form.get("token") ?? "");
  return inactive.has(claims.jti) ? { body: { active: false } } : { body: activeAnswer({ sub: claims.sub }) };
};

const request = (authorization?: string): FastifyRequest =>
  ({ headers: authorization === undefined ? {} : { authorization } }) as unknown as FastifyRequest;
const verify = (token: string): Promise<CredentialOutcome> => verifyIdentityAccessToken(request(`Bearer ${token}`), null, "/v1/sessions");

function verified(o: CredentialOutcome) {
  assert.equal(o.status, "verified", JSON.stringify(o));
  return (o as Extract<CredentialOutcome, { status: "verified" }>);
}
function refused(o: CredentialOutcome) {
  assert.equal(o.status, "rejected", JSON.stringify(o));
  return (o as Extract<CredentialOutcome, { status: "rejected" }>).error;
}

before(async () => {
  fake = await FakeIdentity.start();
  fake.jwks = () => (keysDown ? { status: 503, body: "down" } : { body: { keys: [es.jwk, rs.jwk] } });
});
after(async () => { await fake.close(); });
beforeEach(() => {
  providerDown = false;
  keysDown = false;
  inactive = new Set();
  fake.introspect = defaultIntrospect;
  identity(true);
  process.env.CLAW_IDENTITY_TOKEN_AUTH_ENABLED = "true";
  fake.requests.length = 0;
});

describe("the path abstains unless it is switched on and the token is JWT-shaped", () => {
  const abstain: Array<[string, () => void, () => string | undefined]> = [
    ["the flag is off", () => { delete process.env.CLAW_IDENTITY_TOKEN_AUTH_ENABLED; }, () => `Bearer ${mint()}`],
    ["the flag is spelled false", () => { process.env.CLAW_IDENTITY_TOKEN_AUTH_ENABLED = "false"; }, () => `Bearer ${mint()}`],
    ["there is no identity client (the flag is on)", () => { identity(false); process.env.CLAW_IDENTITY_TOKEN_AUTH_ENABLED = "true"; }, () => `Bearer ${mint()}`],
    ["no Authorization header", () => {}, () => undefined],
    ["another scheme", () => {}, () => `Basic ${mint()}`],
    ["a lower-case scheme (the other paths are as strict)", () => {}, () => `bearer ${mint()}`],
    ["an opaque value", () => {}, () => "Bearer not-a-jwt"],
    ["two segments", () => {}, () => "Bearer aaa.bbb"],
    ["four segments", () => {}, () => "Bearer aaa.bbb.ccc.ddd"],
    ["an `ak-` key that happens to have three segments", () => {}, () => "Bearer ak-aaa.bbb.ccc"],
    ["an empty bearer value", () => {}, () => "Bearer "],
  ];
  for (const [name, setup, authorization] of abstain) {
    test(name, async () => {
      setup();
      process.env.CLAW_IDENTITY_TOKEN_INTROSPECT = "true";
      assert.deepEqual(await verifyIdentityAccessToken(request(authorization()), null, "/v1/sessions"), { status: "absent" });
      assert.equal(fake.count("/oauth/introspect"), 0, "an abstaining path asks nobody");
    });
  }
});

describe("a valid token", () => {
  const cases: Array<[string, Record<string, unknown>, { key?: TestKey }, Partial<{ userId: string; userName: string; roles: string[] }>]> = [
    ["maps sub and name, and the user is a plain user", {}, {}, { userId: "u-web-1", userName: "Ada Lovelace", roles: ["default"] }],
    ["verifies with RS256 as well", {}, { key: rs }, { userId: "u-web-1" }],
    ["does not copy system-admin from the roles claim", { roles: ["default", "system-admin"] }, {}, { roles: ["default"] }],
    ["does not copy system-admin when it is the only role", { roles: ["system-admin"] }, {}, { roles: ["default"] }],
    ["does not copy system-admin-readonly", { roles: ["system-admin-readonly"] }, {}, { roles: ["default"] }],
    ["has only default when the roles claim is missing", { roles: undefined }, {}, { roles: ["default"] }],
    ["has only default when the roles claim is empty", { roles: [] }, {}, { roles: ["default"] }],
    ["takes no role from a claim that is not an array", { roles: "system-admin" }, {}, { roles: ["default"] }],
    ["takes no role from `groups`", { roles: undefined, groups: ["system-admin"] }, {}, { roles: ["default"] }],
    ["copies no other role either", { roles: ["a", "b", "default"] }, {}, { roles: ["default"] }],
    ["names the user by preferred_username when there is no name", { name: undefined, preferred_username: "ada" }, {}, { userName: "ada" }],
    ["names the user by email when there is neither", { name: undefined, email: "ada@example.com" }, {}, { userName: "ada@example.com" }],
    ["names the user by sub when there is nothing else", { name: undefined, email: undefined }, {}, { userName: "u-web-1" }],
    ["truncates a long name", { name: "n".repeat(300) }, {}, { userName: "n".repeat(128) }],
    ["accepts the scope among others, in any position", { scope: "claw.api" }, {}, {}],
    ["accepts the scope as an array", { scope: ["openid", "claw.api"] }, {}, {}],
    ["accepts one audience of several", { aud: ["claw-web", "claw-api"] }, {}, {}],
    ["accepts a subject that is not a UUID", { sub: "user-é-42" }, {}, { userId: "user-é-42" }],
  ];
  for (const [name, over, opts, want] of cases) {
    test(name, async () => {
      const v = verified(await verify(mint(over, opts)));
      assert.equal(v.method, IDENTITY_TOKEN_METHOD);
      assert.equal(v.user.platformKey, "", "there is no session key behind a token");
      assert.equal(v.user.virtualKey, "");
      if (want.userId !== undefined) assert.equal(v.user.userId, want.userId);
      if (want.userName !== undefined) assert.equal(v.user.userName, want.userName);
      if (want.roles !== undefined) assert.deepEqual(v.user.roles, want.roles);
    });
  }

  test("a token that carries an administrator role by name does not make its subject an administrator", async () => {
    // A provider shared with other applications can define a role with this name for its own purposes.
    for (const roles of [["system-admin"], ["default", "system-admin"], ["system-admin-readonly"], ["system-admin", "system-admin-readonly"], [...Array.from({ length: 40 }, (_, i) => `r${i}`), "system-admin"]]) {
      const v = verified(await verify(mint({ roles, groups: roles })));
      assert.deepEqual(v.user.roles, ["default"], JSON.stringify(roles));
      assert.equal(getUserRole(v.user), "default");
      assert.equal(isAdmin(v.user), false);
      assert.equal(isSystemAdmin(v.user), false);
      assert.equal(canAccessSessionAsOperator("some-other-tenant", v.user), false, "no operator access to another tenant's session");
      assert.equal(canAccessSessionAsOperator(v.user.userId, v.user), true, "its own session is still its own");
    }
  });

  test("the audience and the scope are the settings', not fixed", async () => {
    process.env.CLAW_IDENTITY_TOKEN_AUDIENCE = "other-api";
    process.env.CLAW_IDENTITY_TOKEN_SCOPE = "other.scope";
    assert.equal(refused(await verify(mint())).status, 401, "the default audience no longer fits");
    verified(await verify(mint({ aud: "other-api", scope: "other.scope" })));
    assert.deepEqual(identityTokenSettings(), { enabled: true, audience: "other-api", scope: "other.scope", introspect: false, trustedRoles: [], delegationAudience: "primus-safe", delegationScope: "safe.api" });
  });

  test("the defaults are claw-api and claw.api, with introspection off and no role adopted", () => {
    for (const k of ["CLAW_IDENTITY_TOKEN_AUTH_ENABLED", "CLAW_IDENTITY_TOKEN_AUDIENCE", "CLAW_IDENTITY_TOKEN_SCOPE", "CLAW_IDENTITY_TOKEN_INTROSPECT", "CLAW_IDENTITY_TOKEN_TRUSTED_ROLES"]) delete process.env[k];
    assert.deepEqual(identityTokenSettings(), { enabled: false, audience: "claw-api", scope: "claw.api", introspect: false, trustedRoles: [], delegationAudience: "primus-safe", delegationScope: "safe.api" });
  });

  test("the answer carries no part of the token", async () => {
    const token = mint();
    assert.ok(!JSON.stringify(await verify(token)).includes(token));
  });
});

describe("a token that is wrong is refused, and never passed on", () => {
  const exp = nowSec() - 3600;
  const refusals: Array<[string, () => string, number, string]> = [
    ["another audience", () => mint({ aud: "someone-else" }), 401, "invalid_token"],
    ["the application's own audience (an ID token's)", () => mint({ aud: "claw-web" }), 401, "invalid_token"],
    ["an ID token (typed JWT)", () => mint({ aud: "claw-web", nonce: "n" }, { header: { typ: "JWT" } }), 401, "invalid_token"],
    ["an ID token that names this API too", () => mint({}, { header: { typ: "JWT" } }), 401, "invalid_token"],
    ["no typ at all", () => mint({}, { header: { typ: undefined } }), 401, "invalid_token"],
    ["no scope claim", () => mint({ scope: undefined }), 403, "insufficient_scope"],
    ["a connector's scope", () => mint({ scope: "claw.connector" }), 403, "insufficient_scope"],
    ["a scope that only starts like the required one", () => mint({ scope: "claw.api.admin xclaw.api" }), 403, "insufficient_scope"],
    ["a scope that is not a string", () => mint({ scope: 7 }), 403, "insufficient_scope"],
    ["an expired token", () => mint({ exp }), 401, "invalid_token"],
    ["a token that is not valid yet", () => mint({ nbf: nowSec() + 3600 }), 401, "invalid_token"],
    ["no exp", () => mint({ exp: undefined }), 401, "invalid_token"],
    ["a signature by a key the issuer does not publish", () => mint({}, { key: stranger }), 401, "invalid_token"],
    ["a kid the issuer does not publish", () => mint({}, { header: { kid: "k-unknown" } }), 401, "invalid_token"],
    ["another issuer", () => mint({ iss: "https://elsewhere.example.com" }), 401, "invalid_token"],
    ["alg none", () => mint({}, { header: { alg: "none" } }), 401, "invalid_token"],
    ["an unsigned token", () => mint().split(".").slice(0, 2).join(".") + ".", 401, "invalid_token"],
    ["HS256", () => mint({}, { header: { alg: "HS256" } }), 401, "invalid_token"],
    ["a header alg that does not fit the key", () => mint({}, { header: { alg: "RS256" } }), 401, "invalid_token"],
    ["segments that are not a token", () => "aaa.bbb.ccc", 401, "invalid_token"],
    ["no sub", () => mint({ sub: undefined }), 401, "invalid_token"],
    ["an empty sub", () => mint({ sub: "" }), 401, "invalid_token"],
    ["a sub that is not a string", () => mint({ sub: 42 }), 401, "invalid_token"],
    ["a sub with a leading space", () => mint({ sub: " u1" }), 401, "invalid_token"],
    ["a sub with a trailing newline", () => mint({ sub: "u1\n" }), 401, "invalid_token"],
    ["a sub with a control character inside", () => mint({ sub: "u\u00011" }), 401, "invalid_token"],
    ["a sub with DEL", () => mint({ sub: "u\u007f1" }), 401, "invalid_token"],
    ["a sub longer than 128 characters", () => mint({ sub: "s".repeat(129) }), 401, "invalid_token"],
    ["a sub that is the fallback owner `default`", () => mint({ sub: "default" }), 401, "invalid_token"],
    ["a sub that is the anonymous owner", () => mint({ sub: "anonymous" }), 401, "invalid_token"],
    ["a sub that is the development bypass user", () => mint({ sub: "dev-user" }), 401, "invalid_token"],
  ];
  for (const [name, token, status, legacyError] of refusals) {
    test(name, async () => {
      const e = refused(await verify(token()));
      assert.equal(e.status, status);
      assert.equal(e.legacyError, legacyError);
    });
  }

  test("a reserved owner is refused only whole: a subject that merely contains it is a user like any other", async () => {
    for (const sub of ["default-user", "Default", "user-default", "anonymous1"]) assert.equal(verified(await verify(mint({ sub }))).user.userId, sub);
  });

  test("a sub of exactly 128 characters is the longest accepted", async () => {
    assert.equal(verified(await verify(mint({ sub: "s".repeat(128) }))).user.userId.length, 128);
  });

  test("the reason is in the message, never the token", async () => {
    const token = mint({ aud: "someone-else" });
    const e = refused(await verify(token));
    assert.match(e.message, /audience_mismatch/);
    assert.ok(!e.message.includes(token));
  });
});

describe("when the provider cannot be asked", () => {
  test("a key set that cannot be fetched is a 503, not a refusal of the token", async () => {
    keysDown = true;
    identity(true);
    process.env.CLAW_IDENTITY_TOKEN_AUTH_ENABLED = "true";
    const e = refused(await verify(mint()));
    assert.equal(e.status, 503);
    assert.equal(e.legacyError, "authentication_service_unavailable");
    assert.equal(e.anthropicType, "api_error");
  });
});

describe("with introspection on", () => {
  beforeEach(() => { process.env.CLAW_IDENTITY_TOKEN_INTROSPECT = "true"; });

  test("an active token is accepted, and the provider is asked about exactly that token", async () => {
    const token = mint();
    verified(await verify(token));
    const asked = fake.last("/oauth/introspect");
    assert.equal(asked.form.get("token"), token);
    assert.equal(asked.form.get("token_type_hint"), "access_token");
  });

  test("a token the provider no longer considers active is refused", async () => {
    const jti = randomUUID();
    inactive.add(jti);
    const e = refused(await verify(mint({ jti })));
    assert.equal(e.status, 401);
    assert.equal(e.legacyError, "invalid_token");
  });

  test("an answer for another subject is refused", async () => {
    fake.introspect = () => ({ body: activeAnswer({ sub: "someone-else" }) });
    assert.equal(refused(await verify(mint())).status, 401);
  });

  test("an active answer that names no subject does not contradict the token", async () => {
    fake.introspect = () => ({ body: activeAnswer({ sub: undefined }) });
    verified(await verify(mint()));
  });

  test("a provider that cannot be asked is a 503, never an invalid token", async () => {
    providerDown = true;
    const e = refused(await verify(mint()));
    assert.equal(e.status, 503);
    assert.equal(e.legacyError, "authentication_service_unavailable");
  });

  // The identity client's own stale-if-error window (IDENTITY_STALE_IF_ERROR_SECONDS, default 30 minutes) applies to
  // the provider's answers, so it applies here: a token whose active answer is cached is honoured through an outage,
  // and only for as long as the token itself is valid (local checks run first, so an expired token is never asked
  // about). That is no wider than with introspection off, where an unexpired token is honoured for its whole life.
  const withCache = (extra: Record<string, string>) => {
    identity(true, { IDENTITY_INTROSPECTION_CACHE_SECONDS: "1", ...extra });
    process.env.CLAW_IDENTITY_TOKEN_AUTH_ENABLED = "true";
    process.env.CLAW_IDENTITY_TOKEN_INTROSPECT = "true";
  };
  const pastFreshness = () => new Promise((r) => setTimeout(r, 1100));

  test("through an outage a token whose active answer is cached is still honoured, and one never seen is a 503", async () => {
    withCache({ IDENTITY_STALE_IF_ERROR_SECONDS: "1800" });
    const seen = mint();
    verified(await verify(seen));
    await pastFreshness();
    providerDown = true;
    verified(await verify(seen));
    assert.equal(refused(await verify(mint())).status, 503);
  });

  test("with the stale window at zero an outage is a 503 for a token seen a moment ago too", async () => {
    withCache({ IDENTITY_STALE_IF_ERROR_SECONDS: "0" });
    const seen = mint();
    verified(await verify(seen));
    await pastFreshness();
    providerDown = true;
    const e = refused(await verify(seen));
    assert.equal(e.status, 503);
    assert.equal(e.legacyError, "authentication_service_unavailable");
  });

  test("a token that fails local checks is never sent to the provider", async () => {
    refused(await verify(mint({ aud: "someone-else" })));
    refused(await verify(mint({ scope: "claw.connector" })));
    refused(await verify(mint({ exp: nowSec() - 3600 })));
    refused(await verify(mint({ sub: " padded" })));
    refused(await verify(mint({}, { header: { typ: "JWT" } })));
    assert.equal(fake.count("/oauth/introspect"), 0);
  });

  test("with it off a revoked token is still honoured until it expires, and nobody is asked", async () => {
    delete process.env.CLAW_IDENTITY_TOKEN_INTROSPECT;
    const jti = randomUUID();
    inactive.add(jti);
    verified(await verify(mint({ jti })));
    assert.equal(fake.count("/oauth/introspect"), 0);
  });
});
