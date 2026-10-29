// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a caller authenticated by an identity provider's access token has once SaFE
 * has been asked about it: the platform key and the virtual key of the person the
 * token names, and nobody else's.
 *
 * The real token path, the real identity client (against a stand-in provider on a
 * socket, tokens signed with real keys) and the real `SafeClient` run; SaFE is a
 * server on a socket that answers `POST /api/v1/auth/verify` the way SaFE's
 * external-authentication mode is written to (apiserver `verifyExternal`): the
 * internal token is required, a token it accepts is answered with the person's id and
 * keys, a token that carries an actor (RFC 8693 `act`) is a 403, and a token it does
 * not accept is a 401.
 *
 *   K1  the keys of the subject are what the user carries, and the token is what SaFE was asked with
 *   K2  every way SaFE can answer that is not "here are the keys", and what the caller gets for each
 *   K3  SaFE is only ever shown a token this API has already accepted
 *   K4  two users never share a key, and the roles are still nobody's but the operator's
 *   K5  the answer is cached per token and a failure to answer is not
 *   K6  `callerAuthOf` presents the platform key for such a caller (`GET /v1/me` with it is me-route-identity-token.test.ts)
 */
import test, { after, before, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";

import { FakeIdentity, activeAnswer, signJwt, testKey } from "../../utils/test/identity-fake.js";
import { startFakeUpstream, sendJson, type FakeUpstream, type SeenRequest } from "./support/fake-upstream.js";
import { IDENTITY_TOKEN_METHOD, verifyIdentityAccessToken } from "../src/auth/identity-token.js";
import { startIdentityClient } from "../src/auth/identity.js";
import { SafeClient } from "../src/auth/safe-client.js";
import { callerAuthOf } from "../src/auth/caller-auth.js";
import { recordRequestCredential } from "../src/auth/request-credential.js";
import type { CredentialOutcome } from "../src/auth/middleware.js";

const INTERNAL = "internal-token-for-tests";
const nowSec = () => Math.floor(Date.now() / 1000);
const payloadOf = (token: string) => JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8") || "{}");
const es = testKey("ES256", "k-es");
const log = { info() {}, warn() {}, error() {} };

/** What SaFE holds, by user id. */
const ACCOUNTS: Record<string, { name: string; roles: string[]; platformKey: string; virtualKey: string }> = {
  "u-alice": { name: "Alice", roles: ["default", "system-admin"], platformKey: "ak-alice-platform", virtualKey: "sk-alice-virtual" },
  "u-bob": { name: "Bob", roles: ["default"], platformKey: "ak-bob-platform", virtualKey: "sk-bob-virtual" },
  "u-novirtual": { name: "No Virtual", roles: ["default"], platformKey: "ak-nv-platform", virtualKey: "" },
  "u-nokeys": { name: "No Keys", roles: ["default"], platformKey: "", virtualKey: "" },
};

let fake: FakeIdentity;
let safe: FakeUpstream;
/** Replaceable per test; the default is SaFE with an authenticator for this issuer and audience. */
let verifyAnswer: (req: SeenRequest, res: import("node:http").ServerResponse) => void;
let client: SafeClient;

const defaultVerify: typeof verifyAnswer = (req, res) => {
  if (req.headers["x-internal-token"] !== INTERNAL) return sendJson(res, 403, { code: 403, message: "internal authentication required" });
  const body = JSON.parse(req.body) as { authorization?: string; includePlatformKey?: boolean; includeVirtualKey?: boolean };
  const bearer = /^Bearer (\S+)$/.exec(body.authorization ?? "")?.[1] ?? "";
  const claims = payloadOf(bearer);
  const account = ACCOUNTS[claims.sub];
  if (!account || claims.aud !== "claw-api") return sendJson(res, 401, { code: 401, message: "invalid token" });
  if (claims.act !== undefined) return sendJson(res, 403, { code: 403, message: "this operation is not available with a delegated token" });
  return sendJson(res, 200, {
    code: 0,
    data: {
      id: claims.sub, name: account.name, roles: account.roles,
      ...(body.includePlatformKey ? { platformKey: account.platformKey } : {}),
      ...(body.includeVirtualKey ? { virtualKey: account.virtualKey } : {}),
    },
  });
};

const ENV_KEYS = [
  "IDENTITY_CLIENT_ENABLED", "IDENTITY_ISSUER_URL", "IDENTITY_CLIENT_ID", "IDENTITY_CLIENT_SECRET",
  "IDENTITY_INTROSPECTION_CACHE_SECONDS", "IDENTITY_INTROSPECTION_NEGATIVE_CACHE_SECONDS", "IDENTITY_STALE_IF_ERROR_SECONDS",
  "CLAW_IDENTITY_TOKEN_AUTH_ENABLED", "CLAW_IDENTITY_TOKEN_AUDIENCE", "CLAW_IDENTITY_TOKEN_SCOPE", "CLAW_IDENTITY_TOKEN_INTROSPECT",
  "CLAW_IDENTITY_TOKEN_TRUSTED_ROLES",
];

function identity(): void {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, {
    IDENTITY_CLIENT_ENABLED: "true", IDENTITY_ISSUER_URL: fake.issuer, IDENTITY_CLIENT_ID: "svc-claw",
    IDENTITY_CLIENT_SECRET: "s3cret", IDENTITY_INTROSPECTION_CACHE_SECONDS: "0",
    IDENTITY_INTROSPECTION_NEGATIVE_CACHE_SECONDS: "0", IDENTITY_STALE_IF_ERROR_SECONDS: "0",
    CLAW_IDENTITY_TOKEN_AUTH_ENABLED: "true",
  });
  startIdentityClient(log);
}

/** An access token as the provider's authorization code flow issues it to a browser application. */
function mint(over: Record<string, unknown> = {}, signed = es): string {
  const claims: Record<string, unknown> = {
    iss: fake.issuer, aud: "claw-api", sub: "u-alice", client_id: "claw-web", gid: "g-1",
    scope: "openid profile email claw.api", email: "alice@example.com", name: "Alice",
    roles: ["default"], groups: [], jti: randomUUID(), iat: nowSec(), nbf: nowSec() - 1, exp: nowSec() + 300, ...over,
  };
  for (const k of Object.keys(claims)) if (claims[k] === undefined) delete claims[k];
  return signJwt({ key: signed, claims });
}

const request = (token: string): FastifyRequest => ({ headers: { authorization: `Bearer ${token}` } }) as unknown as FastifyRequest;
const run = (token: string, verifier: Parameters<typeof verifyIdentityAccessToken>[1] = client) =>
  verifyIdentityAccessToken(request(token), verifier, "/v1/sessions");
const verifyCalls = () => safe.seen.filter((r) => r.url === "/api/v1/auth/verify");

function user(o: CredentialOutcome) {
  assert.equal(o.status, "verified", JSON.stringify(o));
  return (o as Extract<CredentialOutcome, { status: "verified" }>).user;
}
function refused(o: CredentialOutcome) {
  assert.equal(o.status, "rejected", JSON.stringify(o));
  return (o as Extract<CredentialOutcome, { status: "rejected" }>).error;
}

before(async () => {
  process.env.AUTH_INTERNAL_TOKEN = INTERNAL;
  fake = await FakeIdentity.start();
  fake.jwks = () => ({ body: { keys: [es.jwk] } });
  safe = await startFakeUpstream((req, res) => {
    if (req.method === "POST" && req.url === "/api/v1/auth/verify") return verifyAnswer(req, res);
    return sendJson(res, 404, { message: "no such route" });
  });
});
after(async () => {
  await fake.close();
  await safe.close();
});
beforeEach(() => {
  verifyAnswer = defaultVerify;
  fake.introspect = (r) => ({ body: activeAnswer({ sub: payloadOf(r.form.get("token") ?? "").sub }) });
  identity();
  client = new SafeClient(safe.url, 2000);
  safe.seen.length = 0;
  fake.requests.length = 0;
});

describe("K1 the keys of the subject", () => {
  test("a token SaFE accepts gives its user SaFE's platform key and virtual key, and SaFE was asked with the token itself", async () => {
    const token = mint();
    const u = user(await run(token));
    assert.equal(u.userId, "u-alice");
    assert.equal(u.platformKey, "ak-alice-platform");
    assert.equal(u.virtualKey, "sk-alice-virtual");
    const [call, ...rest] = verifyCalls();
    assert.equal(rest.length, 0, "one question");
    assert.equal(call!.headers["x-internal-token"], INTERNAL);
    assert.deepEqual(JSON.parse(call!.body), {
      includePlatformKey: true, includeVirtualKey: true, authorization: `Bearer ${token}`,
    });
  });

  test("a user SaFE holds only a platform key for is that user, with a virtual key of none", async () => {
    const u = user(await run(mint({ sub: "u-novirtual" })));
    assert.equal(u.platformKey, "ak-nv-platform");
    assert.equal(u.virtualKey, "");
  });
});

describe("K2 every other way SaFE can answer", () => {
  // [name, SaFE's answer, what the caller gets, the reason logged is not asserted here]
  const cases: Array<[string, typeof verifyAnswer, "keyless" | "503"]> = [
    ["401: SaFE does not accept this issuer or audience (builtin mode)", (_r, res) => sendJson(res, 401, { code: 401, message: "invalid token" }), "keyless"],
    ["403: SaFE refuses the credential", (_r, res) => sendJson(res, 403, { code: 403, message: "refused" }), "keyless"],
    ["400", (_r, res) => sendJson(res, 400, { code: 400, message: "bad request" }), "keyless"],
    ["an id that is not the token's subject: those keys are somebody else's", (_r, res) =>
      sendJson(res, 200, { code: 0, data: { id: "u-bob", platformKey: "ak-bob-platform", virtualKey: "sk-bob-virtual" } }), "keyless"],
    ["an answer with no id at all", (_r, res) => sendJson(res, 200, { code: 0, data: { platformKey: "ak-x" } }), "keyless"],
    ["a user SaFE holds no keys for", (_r, res) => sendJson(res, 200, { code: 0, data: { id: "u-nokeys" } }), "keyless"],
    ["500", (_r, res) => sendJson(res, 500, { code: 500, message: "boom" }), "503"],
    ["503", (_r, res) => sendJson(res, 503, { code: 503, message: "the authentication service is unavailable" }), "503"],
    ["a connection that is dropped", (r, res) => { res.destroy(); void r; }, "503"],
  ];
  for (const [name, answer, expected] of cases) {
    test(name, async () => {
      verifyAnswer = answer;
      // The "no id" and "no keys" cases are about u-nokeys / no id, whatever the default accounts say.
      const token = mint({ sub: name.startsWith("a user SaFE holds no keys") ? "u-nokeys" : "u-alice" });
      const outcome = await run(token);
      if (expected === "503") {
        const e = refused(outcome);
        assert.equal(e.status, 503);
        assert.equal(e.legacyError, "authentication_service_unavailable");
        return;
      }
      const u = user(outcome);
      assert.equal(u.userId, name.startsWith("a user SaFE holds no keys") ? "u-nokeys" : "u-alice");
      assert.equal(u.platformKey, "", "never a key that is not the subject's");
      assert.equal(u.virtualKey, "");
    });
  }

  test("no AUTH_INTERNAL_TOKEN to ask SaFE with is a 500 authentication_misconfigured, as for a key, and SaFE is not asked", async () => {
    const saved = process.env.AUTH_INTERNAL_TOKEN;
    delete process.env.AUTH_INTERNAL_TOKEN;
    try {
      const e = refused(await run(mint()));
      assert.equal(e.status, 500);
      assert.equal(e.legacyError, "authentication_misconfigured");
      assert.equal(verifyCalls().length, 0);
    } finally {
      process.env.AUTH_INTERNAL_TOKEN = saved;
    }
  });

  test("a delegated token (RFC 8693 act) is not shown to SaFE, which would refuse it, and has no keys", async () => {
    const u = user(await run(mint({ act: { sub: "svc-teams" } })));
    assert.equal(u.platformKey, "");
    assert.equal(u.virtualKey, "");
    assert.equal(verifyCalls().length, 0);
  });

  test("with no SaFE to ask (Kubernetes mode) the user has no keys and nothing is asked", async () => {
    const u = user(await run(mint(), null));
    assert.equal(u.userId, "u-alice");
    assert.equal(u.platformKey, "");
    assert.equal(u.virtualKey, "");
    assert.equal(verifyCalls().length, 0);
  });

  test("a verifier that cannot verify access tokens (a test stub, an older client) leaves the user keyless without failing", async () => {
    const u = user(await run(mint(), { }));
    assert.equal(u.platformKey, "");
    assert.equal(verifyCalls().length, 0);
  });
});

describe("K3 SaFE is only shown a token this API accepted", () => {
  const bad: Array<[string, () => string]> = [
    ["a forged signature", () => mint({}, testKey("ES256", "k-es", true))],
    ["an expired token", () => mint({ exp: nowSec() - 600, nbf: nowSec() - 900, iat: nowSec() - 900 })],
    ["another audience", () => mint({ aud: "someone-else" })],
    ["a token without the API scope", () => mint({ scope: "openid profile" })],
    ["a subject that is reserved", () => mint({ sub: "dev-user" })],
  ];
  for (const [name, token] of bad) {
    test(name, async () => {
      assert.equal((await run(token())).status, "rejected");
      assert.equal(verifyCalls().length, 0, "SaFE was never asked");
    });
  }

  test("a token the provider says is revoked is refused before SaFE is asked (introspection on)", async () => {
    process.env.CLAW_IDENTITY_TOKEN_INTROSPECT = "true";
    fake.introspect = () => ({ body: { active: false } });
    assert.equal((await run(mint())).status, "rejected");
    assert.equal(verifyCalls().length, 0);
  });
});

describe("K4 nobody else's keys, and no roles from anywhere", () => {
  test("two users each get their own keys, in either order and in parallel", async () => {
    const [a, b] = await Promise.all([run(mint({ sub: "u-alice" })), run(mint({ sub: "u-bob" }))]);
    assert.deepEqual([user(a).platformKey, user(a).virtualKey], ["ak-alice-platform", "sk-alice-virtual"]);
    assert.deepEqual([user(b).platformKey, user(b).virtualKey], ["ak-bob-platform", "sk-bob-virtual"]);
    const again = user(await run(mint({ sub: "u-bob" })));
    assert.equal(again.platformKey, "ak-bob-platform");
  });

  test("SaFE's roles for the user (system-admin for Alice) are not the caller's", async () => {
    assert.deepEqual(user(await run(mint())).roles, ["default"]);
  });

  test("the token's own roles claim is still not copied", async () => {
    assert.deepEqual(user(await run(mint({ roles: ["default", "system-admin"] }))).roles, ["default"]);
  });
});

describe("K5 caching", () => {
  test("the same token is asked about once", async () => {
    const token = mint();
    for (let i = 0; i < 3; i++) assert.equal(user(await run(token)).platformKey, "ak-alice-platform");
    assert.equal(verifyCalls().length, 1);
  });

  test("a refusal is remembered briefly, so a SaFE that does not know the issuer is not asked on every request", async () => {
    verifyAnswer = (_r, res) => sendJson(res, 401, { code: 401, message: "invalid token" });
    const token = mint();
    for (let i = 0; i < 3; i++) assert.equal(user(await run(token)).platformKey, "");
    assert.equal(verifyCalls().length, 1);
  });

  test("SaFE not answering is not remembered: the next request asks again, and gets the keys", async () => {
    let up = false;
    verifyAnswer = (r, res) => (up ? defaultVerify(r, res) : sendJson(res, 503, { code: 503, message: "down" }));
    const token = mint();
    assert.equal(refused(await run(token)).status, 503);
    up = true;
    assert.equal(user(await run(token)).platformKey, "ak-alice-platform");
    assert.equal(verifyCalls().length, 2);
  });
});

describe("K6 what the rest of the API presents to SaFE for such a caller", () => {
  const withMethod = (method: string | null, userRecord: unknown, headers: Record<string, unknown> = {}) => {
    const req = { headers, cookies: {}, user: userRecord } as any;
    if (method) recordRequestCredential(req, method);
    return req;
  };
  const alice = { userId: "u-alice", userName: "Alice", roles: ["default"], platformKey: "ak-alice-platform", virtualKey: "sk-alice-virtual" };

  test("an identity-token caller presents its platform key, never the token", () => {
    assert.deepEqual(callerAuthOf(withMethod(IDENTITY_TOKEN_METHOD, alice, { authorization: "Bearer eyJ.a.b" })), { authorization: "Bearer ak-alice-platform" });
  });

  test("without a platform key there is nothing to present, and no other header stands in for it", () => {
    const keyless = { ...alice, platformKey: "" };
    assert.deepEqual(callerAuthOf(withMethod(IDENTITY_TOKEN_METHOD, keyless, { authorization: "Bearer eyJ.a.b", "x-api-key": "ak-someone-else" })), {});
  });

  test("a caller authenticated another way is unchanged: the credential it presented", () => {
    assert.deepEqual(callerAuthOf(withMethod("api_key", alice, { authorization: "Bearer ak-presented" })), { authorization: "Bearer ak-presented" });
    assert.deepEqual(callerAuthOf(withMethod(null, alice, { authorization: "Bearer eyJ.a.b" })), {});
  });
});
