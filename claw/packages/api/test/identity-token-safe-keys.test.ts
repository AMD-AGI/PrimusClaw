// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What a caller authenticated by an identity provider's access token has once SaFE
 * has been asked about it: the platform key and the virtual key of the person the
 * token names, and nobody else's.
 *
 * SaFE is never shown the person's token. The API exchanges it at the provider (RFC 8693
 * service delegation) for a token for SaFE's audience that names the API as the party acting
 * for the person, and shows SaFE that.
 *
 * The real token path, the real identity client (against a stand-in provider on a
 * socket, tokens signed with real keys) and the real `SafeClient` run. The provider answers
 * the exchange the way primus-identity does (`answerDelegation`). SaFE is a server on a socket
 * that answers `POST /api/v1/auth/verify` the way SaFE's external-authentication mode is written
 * to (apiserver `verifyExternal` with `auth.key_actors`): the internal token is required, a
 * token for its own audience with the scope its verification needs whose actor (`act`) it was told
 * to accept is answered with the keys of the token's subject, an actor it was not told about is a
 * 403, and a token that is not for it is a 401.
 *
 *   K1  the keys of the subject are what the user carries, and SaFE was asked with the delegated token, never the user's
 *   K2  every way SaFE or the provider can answer that is not "here are the keys", and what the caller gets for each
 *   K3  nothing is exchanged or shown to SaFE for a token this API has not accepted
 *   K4  two users never share a key, and the roles are still nobody's but the operator's
 *   K5  the answer is kept per person for at most the delegated token's life, and a failure to answer is not
 *   K6  `callerAuthOf` presents the platform key for such a caller (`GET /v1/me` with it is me-route-identity-token.test.ts)
 *   K7  a delegated token has no keys, except an allow-listed service's, which may bring the person's own key: which refusals, and what is never read
 *   K9  a delegated token of a service named in CLAW_IDENTITY_TOKEN_DELEGATED_KEY_CLIENT_IDS is exchanged once more, and has its subject's keys
 */
import test, { after, before, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";

import { FakeIdentity, activeAnswer, answerDelegation, signJwt, testKey, type DelegationRequest } from "../../utils/test/identity-fake.js";
import { startFakeUpstream, sendJson, type FakeUpstream, type SeenRequest } from "./support/fake-upstream.js";
import { IDENTITY_TOKEN_METHOD, verifyIdentityAccessToken } from "../src/auth/identity-token.js";
import { startIdentityClient } from "../src/auth/identity.js";
import { SafeClient } from "../src/auth/safe-client.js";
import { callerAuthOf, safeAuthorizationOf } from "../src/auth/caller-auth.js";
import { recordRequestCredential } from "../src/auth/request-credential.js";
import type { CredentialOutcome } from "../src/auth/middleware.js";

const INTERNAL = "internal-token-for-tests";
/** The identity client's own id: the party that acts, in the delegated token, and the one SaFE is told to accept. */
const CLAW = "svc-claw";
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
/** What the provider was asked to exchange. */
let delegations: DelegationRequest[];
/** Replaceable per test; the default is SaFE with `key_actors` naming this API's client. */
let verifyAnswer: (req: SeenRequest, res: import("node:http").ServerResponse) => void;
let client: SafeClient;

/** The `ak-` keys SaFE knows, and whose they are. */
const API_KEYS: Record<string, string> = { "ak-alice-platform": "u-alice", "ak-bob-platform": "u-bob", "ak-nv-platform": "u-novirtual", "ak-nokeys": "u-nokeys" };

const defaultVerify: typeof verifyAnswer = (req, res) => {
  if (req.headers["x-internal-token"] !== INTERNAL) return sendJson(res, 403, { code: 403, message: "internal authentication required" });
  const body = JSON.parse(req.body) as { authorization?: string; apiKey?: string; includePlatformKey?: boolean; includeVirtualKey?: boolean };
  if (body.apiKey !== undefined) {
    const owner = ACCOUNTS[API_KEYS[body.apiKey] ?? ""];
    if (!owner) return sendJson(res, 401, { code: 401, message: "invalid api key" });
    return sendJson(res, 200, {
      code: 0,
      data: {
        id: API_KEYS[body.apiKey], name: owner.name, roles: owner.roles,
        ...(body.includePlatformKey ? { platformKey: owner.platformKey } : {}),
        ...(body.includeVirtualKey ? { virtualKey: owner.virtualKey } : {}),
      },
    });
  }
  const bearer = /^Bearer (\S+)$/.exec(body.authorization ?? "")?.[1] ?? "";
  const claims = payloadOf(bearer);
  const account = ACCOUNTS[claims.sub];
  if (!account || claims.aud !== "primus-safe" || !String(claims.scope ?? "").split(" ").includes("safe.api")) {
    return sendJson(res, 401, { code: 401, message: "invalid token" });
  }
  if (claims.act?.sub !== CLAW) return sendJson(res, 403, { code: 403, message: "this operation is not available with a delegated token" });
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
  "IDENTITY_EXCHANGE_REFRESH_SKEW_SECONDS",
  "CLAW_IDENTITY_TOKEN_AUTH_ENABLED", "CLAW_IDENTITY_TOKEN_AUDIENCE", "CLAW_IDENTITY_TOKEN_SCOPE", "CLAW_IDENTITY_TOKEN_INTROSPECT",
  "CLAW_IDENTITY_TOKEN_TRUSTED_ROLES", "CLAW_IDENTITY_TOKEN_DELEGATION_AUDIENCE", "CLAW_IDENTITY_TOKEN_DELEGATION_SCOPE",
  "CLAW_IDENTITY_TOKEN_OWN_KEY_CLIENT_IDS", "CLAW_IDENTITY_TOKEN_DELEGATED_KEY_CLIENT_IDS",
];

function identity(): void {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, {
    IDENTITY_CLIENT_ENABLED: "true", IDENTITY_ISSUER_URL: fake.issuer, IDENTITY_CLIENT_ID: CLAW,
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

const request = (token: string, headers: Record<string, string | string[]> = {}): FastifyRequest =>
  ({ headers: { authorization: `Bearer ${token}`, ...headers } }) as unknown as FastifyRequest;
const run = (token: string, verifier: Parameters<typeof verifyIdentityAccessToken>[1] = client, headers: Record<string, string | string[]> = {}) =>
  verifyIdentityAccessToken(request(token, headers), verifier, "/v1/sessions");
const verifyCalls = () => safe.seen.filter((r) => r.url === "/api/v1/auth/verify");
const exchangeCalls = () => fake.requests.filter((r) => r.path === "/oauth/token");

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
  delegations = answerDelegation(fake, es, { clientId: CLAW });
  identity();
  client = new SafeClient(safe.url, 2000);
  safe.seen.length = 0;
  fake.requests.length = 0;
});

describe("K1 the keys of the subject", () => {
  test("a person SaFE accepts the delegated token of gives SaFE's platform key and virtual key, and SaFE was asked with that token, not theirs", async () => {
    const token = mint();
    const u = user(await run(token));
    assert.equal(u.userId, "u-alice");
    assert.equal(u.platformKey, "ak-alice-platform");
    assert.equal(u.virtualKey, "sk-alice-virtual");

    // The provider was asked to exchange the person's token, as the API's own client, for SaFE's audience.
    assert.deepEqual(delegations, [{ subjectToken: token, audience: "primus-safe", scope: "safe.api" }]);
    const [exchange] = exchangeCalls();
    assert.equal(exchange!.form.get("grant_type"), "urn:ietf:params:oauth:grant-type:token-exchange");
    assert.equal(exchange!.form.get("subject_token_type"), "urn:ietf:params:oauth:token-type:access_token");
    assert.equal(exchange!.headers.authorization, `Basic ${Buffer.from(`${CLAW}:s3cret`).toString("base64")}`);

    // SaFE was asked once, with the token the provider issued, and nothing in the question is the person's own token.
    const [call, ...rest] = verifyCalls();
    assert.equal(rest.length, 0, "one question");
    assert.equal(call!.headers["x-internal-token"], INTERNAL);
    const asked = JSON.parse(call!.body) as { includePlatformKey: boolean; includeVirtualKey: boolean; authorization: string };
    assert.deepEqual([asked.includePlatformKey, asked.includeVirtualKey], [true, true]);
    assert.notEqual(asked.authorization, `Bearer ${token}`);
    assert.ok(!call!.body.includes(token), "the person's token is not in what SaFE was sent");
    const delegated = payloadOf(asked.authorization.replace("Bearer ", ""));
    assert.deepEqual([delegated.sub, delegated.aud, delegated.scope, delegated.act], ["u-alice", "primus-safe", "safe.api", { sub: CLAW }]);
  });

  test("the audience and the scope of the delegated token are settings, with generic names", async () => {
    process.env.CLAW_IDENTITY_TOKEN_DELEGATION_AUDIENCE = "keys-service";
    process.env.CLAW_IDENTITY_TOKEN_DELEGATION_SCOPE = "keys.read keys.verify";
    verifyAnswer = (_r, res) => sendJson(res, 200, { code: 0, data: { id: "u-alice", platformKey: "ak-x", virtualKey: "sk-x" } });
    assert.equal(user(await run(mint())).platformKey, "ak-x");
    assert.deepEqual(delegations.map((d) => [d.audience, d.scope]), [["keys-service", "keys.read keys.verify"]]);
  });

  test("a user SaFE holds only a platform key for is that user, with a virtual key of none", async () => {
    const u = user(await run(mint({ sub: "u-novirtual" })));
    assert.equal(u.platformKey, "ak-nv-platform");
    assert.equal(u.virtualKey, "");
  });
});

describe("K2 every other way SaFE or the provider can answer", () => {
  // [name, SaFE's answer, what the caller gets, the reason logged is not asserted here]
  const cases: Array<[string, typeof verifyAnswer, "keyless" | "503"]> = [
    ["401: SaFE does not accept this issuer or audience (builtin mode)", (_r, res) => sendJson(res, 401, { code: 401, message: "invalid token" }), "keyless"],
    ["403: SaFE was not told to accept this API as an actor", (_r, res) => sendJson(res, 403, { code: 403, message: "refused" }), "keyless"],
    ["400", (_r, res) => sendJson(res, 400, { code: 400, message: "bad request" }), "keyless"],
    ["an id that is not the token's subject: those keys are somebody else's", (_r, res) =>
      sendJson(res, 200, { code: 0, data: { id: "u-bob", platformKey: "ak-bob-platform", virtualKey: "sk-bob-virtual" } }), "keyless"],
    ["a user SaFE holds nothing for, answered with the id only", (_r, res) => sendJson(res, 200, { code: 0, data: { id: "u-alice" } }), "keyless"],
    ["a user SaFE holds no keys for", (_r, res) => sendJson(res, 200, { code: 0, data: { id: "u-nokeys" } }), "keyless"],
    // A 2xx that is not an answer is SaFE (or what is in front of it) failing, not a decision about the token.
    ["an answer with no id at all", (_r, res) => sendJson(res, 200, { code: 0, data: { platformKey: "ak-x" } }), "503"],
    ["a 200 whose body is a proxy's page, not JSON", (_r, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<html>bad gateway</html>"); }, "503"],
    ["a 200 whose body is cut off", (_r, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"code":0,"data":{"id":"u-al'); }, "503"],
    ["a 200 whose body is JSON but not an object", (_r, res) => sendJson(res, 200, "ok"), "503"],
    ["a 200 whose user id is a number", (_r, res) => sendJson(res, 200, { code: 0, data: { id: 42, platformKey: "ak-x" } }), "503"],
    ["a 200 whose user id is an object", (_r, res) => sendJson(res, 200, { code: 0, data: { id: { x: 1 }, platformKey: "ak-x" } }), "503"],
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
        assert.match(e.message, /SaFE/);
        return;
      }
      const u = user(outcome);
      assert.equal(u.userId, name.startsWith("a user SaFE holds no keys") ? "u-nokeys" : "u-alice");
      assert.equal(u.platformKey, "", "never a key that is not the subject's");
      assert.equal(u.virtualKey, "");
    });
  }

  // The provider's side of the same question: it can refuse the exchange, refuse this API's client, or not answer.
  const providerCases: Array<[string, () => void, "keyless" | "503"]> = [
    ["the provider refuses the exchange (this client may not exchange access tokens)", () => { fake.token = () => ({ status: 400, body: { error: "unauthorized_client" } }); }, "keyless"],
    ["the provider says the token's grant is gone", () => { fake.token = () => ({ status: 400, body: { error: "invalid_grant" } }); }, "keyless"],
    ["the provider refuses an audience this client does not have", () => { fake.token = () => ({ status: 400, body: { error: "invalid_target" } }); }, "keyless"],
    ["the provider refuses this API's own client credentials", () => { fake.token = () => ({ status: 401, body: { error: "invalid_client" } }); }, "503"],
    ["the provider answers 500", () => { fake.token = () => ({ status: 500, body: "boom" }); }, "503"],
    ["the provider answers with no token", () => { fake.token = () => ({ body: { token_type: "Bearer" } }); }, "503"],
    ["the provider drops the connection", () => { fake.token = () => ({ destroy: true }); }, "503"],
  ];
  for (const [name, arrange, expected] of providerCases) {
    test(name, async () => {
      arrange();
      const outcome = await run(mint());
      if (expected === "503") {
        const e = refused(outcome);
        assert.equal(e.status, 503);
        assert.equal(e.legacyError, "authentication_service_unavailable");
        assert.match(e.message, /identity provider/);
      } else {
        const u = user(outcome);
        assert.equal(u.userId, "u-alice");
        assert.equal(u.platformKey, "");
        assert.equal(u.virtualKey, "");
      }
      assert.equal(verifyCalls().length, 0, "SaFE is not asked with a token the provider did not issue");
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

  test("a delegated token (RFC 8693 act) is not exchanged again or shown to SaFE, and has no keys (no service is named to bring its own: K7)", async () => {
    const u = user(await run(mint({ act: { sub: "svc-chat" } })));
    assert.equal(u.platformKey, "");
    assert.equal(u.virtualKey, "");
    assert.equal(verifyCalls().length, 0);
    assert.equal(exchangeCalls().length, 0);
  });

  test("with no SaFE to ask (Kubernetes mode) the user has no keys and nothing is asked", async () => {
    const u = user(await run(mint(), null));
    assert.equal(u.userId, "u-alice");
    assert.equal(u.platformKey, "");
    assert.equal(u.virtualKey, "");
    assert.equal(verifyCalls().length, 0);
    assert.equal(exchangeCalls().length, 0);
  });

  test("a verifier that cannot verify access tokens (a test stub, an older client) leaves the user keyless without failing", async () => {
    const u = user(await run(mint(), { }));
    assert.equal(u.platformKey, "");
    assert.equal(verifyCalls().length, 0);
    assert.equal(exchangeCalls().length, 0);
  });
});

describe("K3 nothing is exchanged or shown to SaFE for a token this API did not accept", () => {
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
      assert.equal(exchangeCalls().length, 0, "the provider was never asked to exchange it");
    });
  }

  test("a token the provider says is revoked is refused before it is exchanged (introspection on)", async () => {
    process.env.CLAW_IDENTITY_TOKEN_INTROSPECT = "true";
    fake.introspect = () => ({ body: { active: false } });
    assert.equal((await run(mint())).status, "rejected");
    assert.equal(verifyCalls().length, 0);
    assert.equal(exchangeCalls().length, 0);
  });
});

describe("K4 nobody else's keys, and no roles from anywhere", () => {
  test("two users each get their own keys, in either order and in parallel", async () => {
    const [a, b] = await Promise.all([run(mint({ sub: "u-alice" })), run(mint({ sub: "u-bob" }))]);
    assert.deepEqual([user(a).platformKey, user(a).virtualKey], ["ak-alice-platform", "sk-alice-virtual"]);
    assert.deepEqual([user(b).platformKey, user(b).virtualKey], ["ak-bob-platform", "sk-bob-virtual"]);
    const again = user(await run(mint({ sub: "u-bob" })));
    assert.equal(again.platformKey, "ak-bob-platform");
    assert.equal(delegations.length, 2, "one exchange per person");
  });

  test("a delegated token for another person is not what SaFE's keys are taken from: a subject that differs is keyless", async () => {
    // A provider (or a bug) that answers an exchange with a token for somebody else: SaFE then gives that person's
    // keys, and they are not used because they are not the token's subject.
    const real = fake.token;
    fake.token = (r) => real({ ...r, form: new URLSearchParams({ ...Object.fromEntries(r.form), subject_token: mint({ sub: "u-bob" }) }) });
    const u = user(await run(mint({ sub: "u-alice" })));
    assert.equal(u.userId, "u-alice");
    assert.equal(u.platformKey, "");
    assert.equal(u.virtualKey, "");
  });

  test("SaFE's roles for the user (system-admin for Alice) are not the caller's", async () => {
    assert.deepEqual(user(await run(mint())).roles, ["default"]);
  });

  test("the token's own roles claim is still not copied", async () => {
    assert.deepEqual(user(await run(mint({ roles: ["default", "system-admin"] }))).roles, ["default"]);
  });
});

describe("K5 how long an answer is kept", () => {
  test("the same token is exchanged and asked about once", async () => {
    const token = mint();
    for (let i = 0; i < 3; i++) assert.equal(user(await run(token)).platformKey, "ak-alice-platform");
    assert.equal(verifyCalls().length, 1);
    assert.equal(delegations.length, 1);
  });

  test("the person's token being replaced (they get a new one every few minutes) does not ask again: the answer is the person's", async () => {
    assert.equal(user(await run(mint())).platformKey, "ak-alice-platform");
    assert.equal(user(await run(mint())).platformKey, "ak-alice-platform");
    assert.equal(user(await run(mint({ jti: "another" }))).platformKey, "ak-alice-platform");
    assert.equal(verifyCalls().length, 1);
    assert.equal(delegations.length, 1);
  });

  test("concurrent requests of one person share one exchange and one question", async () => {
    const users = await Promise.all(Array.from({ length: 6 }, () => run(mint())));
    for (const o of users) assert.equal(user(o).platformKey, "ak-alice-platform");
    assert.equal(verifyCalls().length, 1);
    assert.equal(delegations.length, 1);
  });

  test("an answer is kept for at most the life the delegated token has: when it ends, the next request asks again", async () => {
    // A delegated token that lives one second, and an exchange client that does not replace one early.
    process.env.IDENTITY_EXCHANGE_REFRESH_SKEW_SECONDS = "0";
    delegations = answerDelegation(fake, es, { clientId: CLAW, lifetimeSeconds: 1 });
    startIdentityClient(log);
    assert.equal(user(await run(mint())).platformKey, "ak-alice-platform");
    assert.equal(user(await run(mint())).platformKey, "ak-alice-platform");
    assert.equal(verifyCalls().length, 1, "inside its life it is kept");
    await new Promise((r) => setTimeout(r, 1100));
    assert.equal(user(await run(mint())).platformKey, "ak-alice-platform");
    assert.equal(verifyCalls().length, 2, "past its life it is asked again");
    assert.equal(delegations.length, 2, "with a new delegated token");
  });

  test("a provider that states no lifetime has nothing to bound an answer by, so none is kept", async () => {
    const real = fake.token;
    fake.token = (r) => {
      const reply = real(r);
      const body = { ...(reply.body as Record<string, unknown>) };
      delete body.expires_in;
      return { ...reply, body };
    };
    for (let i = 0; i < 2; i++) assert.equal(user(await run(mint())).platformKey, "ak-alice-platform");
    assert.equal(verifyCalls().length, 2);
  });

  test("a refusal is remembered briefly, so a SaFE that does not know the issuer is not asked on every request", async () => {
    verifyAnswer = (_r, res) => sendJson(res, 401, { code: 401, message: "invalid token" });
    const token = mint();
    for (let i = 0; i < 3; i++) assert.equal(user(await run(token)).platformKey, "");
    assert.equal(verifyCalls().length, 1);
    assert.equal(delegations.length, 1);
  });

  test("a provider's refusal is remembered briefly too, so a client it does not know is not a question per request", async () => {
    fake.token = () => ({ status: 400, body: { error: "unauthorized_client" } });
    for (let i = 0; i < 3; i++) assert.equal(user(await run(mint())).platformKey, "");
    assert.equal(exchangeCalls().length, 1);
  });

  test("a refusal of one device's token (its grant is signed out) is not the person's: another device's token still gets keys", async () => {
    // Two devices of Alice. The provider refuses the exchange of the signed-out device's token (invalid_grant) and
    // exchanges the other's. With introspection off (the default) the signed-out token passes verification until it expires.
    const signedOut = mint({ jti: "signed-out-device" });
    const phone = mint({ jti: "phone" });
    const real = fake.token;
    fake.token = (r) => (r.form.get("subject_token") === signedOut ? { status: 400, body: { error: "invalid_grant" } } : real(r));
    assert.equal(user(await run(signedOut)).platformKey, "", "the refused token runs keyless");
    assert.equal(user(await run(phone)).platformKey, "ak-alice-platform", "the other device is not made keyless by it");
    assert.equal(user(await run(phone)).virtualKey, "sk-alice-virtual");
    assert.equal(delegations.length, 1, "only the good token was exchanged for SaFE's audience");
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

  test("a 200 that is not an answer is not remembered: the next request asks again, and gets the keys", async () => {
    let up = false;
    verifyAnswer = (r, res) => { if (up) return defaultVerify(r, res); res.writeHead(200, { "content-type": "text/html" }); res.end("<html>"); };
    const token = mint();
    assert.equal(refused(await run(token)).status, 503);
    up = true;
    assert.equal(user(await run(token)).platformKey, "ak-alice-platform");
    assert.equal(verifyCalls().length, 2);
  });

  test("the provider not answering is not remembered either", async () => {
    let up = false;
    const real = fake.token;
    fake.token = (r) => (up ? real(r) : { status: 503, body: "down" });
    const token = mint();
    assert.equal(refused(await run(token)).status, 503);
    up = true;
    assert.equal(user(await run(token)).platformKey, "ak-alice-platform");
  });
});

describe("K5b SaFE's client keeps only what it is told it may", () => {
  test("a verification asked for without its cache neither reads nor writes it: not an answer, not a refusal", async () => {
    const delegated = signJwt({
      key: es, claims: { iss: fake.issuer, aud: "primus-safe", sub: "u-alice", scope: "safe.api", act: { sub: CLAW }, jti: "d1", iat: nowSec(), exp: nowSec() + 300 },
    });
    for (let i = 0; i < 2; i++) assert.equal((await client.verifyAccessToken(delegated, { cache: false })).userId, "u-alice");
    assert.equal(verifyCalls().length, 2);
    verifyAnswer = (_r, res) => sendJson(res, 401, { code: 401, message: "invalid token" });
    for (let i = 0; i < 2; i++) await assert.rejects(client.verifyAccessToken(delegated, { cache: false }));
    assert.equal(verifyCalls().length, 4, "a refusal is not kept either");
  });

  test("by default it still keeps both, as it does for a cookie and a key", async () => {
    const delegated = signJwt({
      key: es, claims: { iss: fake.issuer, aud: "primus-safe", sub: "u-alice", scope: "safe.api", act: { sub: CLAW }, jti: "d2", iat: nowSec(), exp: nowSec() + 300 },
    });
    for (let i = 0; i < 2; i++) assert.equal((await client.verifyAccessToken(delegated)).userId, "u-alice");
    assert.equal(verifyCalls().length, 1);
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

  test("a route that forwards the caller's own Authorization header to SaFE sends an identity-token caller's platform key, never the token", () => {
    const token = "eyJ.a.b";
    assert.equal(safeAuthorizationOf(withMethod(IDENTITY_TOKEN_METHOD, alice, { authorization: `Bearer ${token}` })), "Bearer ak-alice-platform");
    assert.equal(safeAuthorizationOf(withMethod(IDENTITY_TOKEN_METHOD, { ...alice, platformKey: "" }, { authorization: `Bearer ${token}` })), "", "keyless: nothing, not the token");
  });

  test("what is sent is the credential that won authentication, not whatever Authorization header the request carries", () => {
    assert.equal(safeAuthorizationOf(withMethod("api_key", alice, { authorization: "Bearer ak-presented" })), "Bearer ak-presented");
    assert.equal(safeAuthorizationOf(withMethod("api_key", alice, { "x-api-key": "ak-in-the-other-header" })), "Bearer ak-in-the-other-header");
    assert.equal(safeAuthorizationOf(withMethod(null, alice, {})), "");
    // A cookie that won, with an identity token beside it: the token is not sent.
    const both = { headers: { cookie: "Token=ck", authorization: "Bearer eyJ.a.b" }, cookies: { Token: "ck" }, user: alice } as any;
    recordRequestCredential(both, "cookie");
    assert.equal(safeAuthorizationOf(both), "");
    // An identity provider's token next to an ak- key that did not win is not what is sent either.
    assert.equal(safeAuthorizationOf(withMethod(IDENTITY_TOKEN_METHOD, alice, { authorization: "Bearer eyJ.a.b", "x-api-key": "ak-someone-else" })), "Bearer ak-alice-platform");
  });

  test("a caller authenticated another way is unchanged: the credential it presented", () => {
    assert.deepEqual(callerAuthOf(withMethod("api_key", alice, { authorization: "Bearer ak-presented" })), { authorization: "Bearer ak-presented" });
    assert.deepEqual(callerAuthOf(withMethod(null, alice, { authorization: "Bearer eyJ.a.b" })), {});
  });
});

describe("K7 a delegated token has no keys, except an allow-listed service's, which may bring the person's own", () => {
  const SERVICE = "svc-chat";
  /** A token as the provider issues it to a service that acts for the person: `sub` the person, `act` and `client_id` the service. */
  const delegatedBy = (service: string, over: Record<string, unknown> = {}) => mint({ act: { sub: service }, client_id: service, ...over });
  const asService = (over: Record<string, unknown> = {}) => delegatedBy(SERVICE, over);
  const asked = () => verifyCalls().map((c) => JSON.parse(c.body) as { apiKey?: string; authorization?: string });
  beforeEach(() => { process.env.CLAW_IDENTITY_TOKEN_OWN_KEY_CLIENT_IDS = SERVICE; });

  test("the person's own key is what SaFE is asked about and the keys SaFE answers are the caller's; the provider is not asked to exchange anything", async () => {
    const u = user(await run(asService(), client, { "x-api-key": "ak-alice-platform" }));
    assert.equal(u.userId, "u-alice");
    assert.equal(u.platformKey, "ak-alice-platform");
    assert.equal(u.virtualKey, "sk-alice-virtual");
    assert.deepEqual(u.roles, ["default"], "SaFE's roles for the user are nobody's but the operator's, here too");
    assert.deepEqual(u.delegation, { actorSub: SERVICE, clientId: SERVICE }, "still the caller it was: a service acting for the person");
    const [call, ...rest] = verifyCalls();
    assert.equal(rest.length, 0, "one question");
    assert.equal(call!.headers["x-internal-token"], INTERNAL);
    assert.deepEqual(asked(), [{ includePlatformKey: true, includeVirtualKey: true, apiKey: "ak-alice-platform" }]);
    assert.equal(exchangeCalls().length, 0, "a delegated token is not exchanged again");
  });

  test("the header's value is trimmed, and a key with no virtual key is that user's all the same", async () => {
    const u = user(await run(asService({ sub: "u-novirtual" }), client, { "x-api-key": "  ak-nv-platform  " }));
    assert.deepEqual([u.userId, u.platformKey, u.virtualKey], ["u-novirtual", "ak-nv-platform", ""]);
  });

  // [name, the key sent, the token's subject, SaFE's answer, status, error code, whether SaFE is asked at all]
  const refusals: Array<[string, string, string, typeof verifyAnswer | null, number, string, boolean]> = [
    ["a key that is another person's is not served as theirs, and not as the token's user keyless either", "ak-bob-platform", "u-alice", null, 401, "key_subject_mismatch", true],
    ["a key SaFE does not know", "ak-nobody", "u-alice", null, 401, "invalid_api_key", true],
    ["a key SaFE has no keys for", "ak-nokeys", "u-nokeys", null, 401, "invalid_api_key", true],
    ["SaFE's 403 (it does not accept this API's own credential) is not a verdict that is told as a person's key being fine", "ak-alice-platform", "u-alice", (_r, res) => sendJson(res, 403, { code: 403, message: "refused" }), 401, "invalid_api_key", true],
    ["a value that is not an ak- key", "sk-alice-virtual", "u-alice", null, 401, "invalid_api_key", false],
    ["an Authorization-style value", "Bearer ak-alice-platform", "u-alice", null, 401, "invalid_api_key", false],
    ["a header that is there and empty is a key asked for and not given", "", "u-alice", null, 401, "invalid_api_key", false],
    ["a header of blanks", "   ", "u-alice", null, 401, "invalid_api_key", false],
    ["SaFE answers 500", "ak-alice-platform", "u-alice", (_r, res) => sendJson(res, 500, { code: 500, message: "boom" }), 503, "authentication_service_unavailable", true],
    ["SaFE answers 503", "ak-alice-platform", "u-alice", (_r, res) => sendJson(res, 503, { code: 503, message: "down" }), 503, "authentication_service_unavailable", true],
    ["a 200 that is a proxy's page", "ak-alice-platform", "u-alice", (_r, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<html>bad gateway</html>"); }, 503, "authentication_service_unavailable", true],
    ["a connection that is dropped", "ak-alice-platform", "u-alice", (r, res) => { res.destroy(); void r; }, 503, "authentication_service_unavailable", true],
  ];
  for (const [name, key, sub, answer, status, code, asksSafe] of refusals) {
    test(`refused, never served keyless: ${name}`, async () => {
      if (answer) verifyAnswer = answer;
      const e = refused(await run(asService({ sub }), client, { "x-api-key": key }));
      assert.deepEqual([e.status, e.legacyError], [status, code]);
      assert.equal(verifyCalls().length, asksSafe ? 1 : 0);
      assert.equal(exchangeCalls().length, 0, "the keys of the delegation path are not a fallback for a key that was asked for");
      assert.ok(!JSON.stringify(e).includes(key.trim() || "\u0000"), "the refusal does not repeat the key");
    });
  }

  test("no AUTH_INTERNAL_TOKEN to ask SaFE with is a 500 authentication_misconfigured, as for any key, and SaFE is not asked", async () => {
    const saved = process.env.AUTH_INTERNAL_TOKEN;
    delete process.env.AUTH_INTERNAL_TOKEN;
    try {
      const e = refused(await run(asService(), client, { "x-api-key": "ak-alice-platform" }));
      assert.deepEqual([e.status, e.legacyError], [500, "authentication_misconfigured"]);
      assert.equal(verifyCalls().length, 0);
    } finally {
      process.env.AUTH_INTERNAL_TOKEN = saved;
    }
  });

  test("with no SaFE to verify the key (Kubernetes mode, or a verifier that cannot) it is a 500 authentication_misconfigured, never keyless", async () => {
    for (const verifier of [null, {}, { verifyAccessToken: client.verifyAccessToken.bind(client) }] as const) {
      const e = refused(await run(asService(), verifier, { "x-api-key": "ak-alice-platform" }));
      assert.deepEqual([e.status, e.legacyError], [500, "authentication_misconfigured"]);
      assert.match(e.message, /CLAW_IDENTITY_TOKEN_OWN_KEY_CLIENT_IDS/);
    }
    assert.equal(verifyCalls().length, 0);
  });

  // The header is read only for a delegated token of a named service. Everywhere else it is not read at all: today's behaviour.
  // [name, the environment's list (null: unset; undefined: the service of this suite), the token, the key sent]: each is what it was
  // before this setting, and the caller has no keys of its own.
  const ignored: Array<[string, string | null | undefined, () => string, string | null]> = [
    ["no service is named (the default)", null, () => asService(), "ak-alice-platform"],
    ["an empty list", "", () => asService(), "ak-alice-platform"],
    ["another service is named", "svc-other", () => asService(), "ak-alice-platform"],
    ["a client id that differs by a trailing space", undefined, () => delegatedBy(`${SERVICE} `), "ak-alice-platform"],
    ["a client id that differs by case", undefined, () => delegatedBy("SVC-CHAT"), "ak-alice-platform"],
    ["a client id that merely begins with a named one", undefined, () => delegatedBy(`${SERVICE}-2`), "ak-alice-platform"],
    ["a delegated token that names no client", undefined, () => asService({ client_id: undefined }), "ak-alice-platform"],
    ["a named service that sent no key", undefined, () => asService(), null],
  ];
  for (const [name, list, token, key] of ignored) {
    test(`not read, no keys of the person's own (as before): ${name}`, async () => {
      if (list === null) delete process.env.CLAW_IDENTITY_TOKEN_OWN_KEY_CLIENT_IDS;
      else if (list !== undefined) process.env.CLAW_IDENTITY_TOKEN_OWN_KEY_CLIENT_IDS = list;
      const u = user(await run(token(), client, key === null ? {} : { "x-api-key": key }));
      assert.equal(u.userId, "u-alice");
      assert.equal(u.platformKey, "");
      assert.equal(u.virtualKey, "");
      assert.equal(verifyCalls().length, 0, "the key was not shown to SaFE");
      assert.equal(exchangeCalls().length, 0);
    });
  }

  test("a token that is not delegated has the keys SaFE holds for its subject by delegation, whatever key rides along and whoever sent it", async () => {
    // The named service's own plain token (no act): the header is not read, so a key that is somebody else's gets nobody anything.
    const u = user(await run(mint({ client_id: SERVICE }), client, { "x-api-key": "ak-bob-platform" }));
    assert.deepEqual([u.userId, u.platformKey, u.virtualKey], ["u-alice", "ak-alice-platform", "sk-alice-virtual"]);
    assert.deepEqual(asked().map((q) => Object.keys(q).includes("apiKey")), [false], "SaFE was asked about the delegated token, never about the key");
    assert.equal(delegations.length, 1);
  });

  test("a token that does not verify is refused before the key is looked at", async () => {
    for (const token of [mint({ aud: "someone-else", act: { sub: SERVICE }, client_id: SERVICE }), mint({ scope: "openid", act: { sub: SERVICE }, client_id: SERVICE })]) {
      assert.equal((await run(token, client, { "x-api-key": "ak-alice-platform" })).status, "rejected");
    }
    assert.equal(verifyCalls().length, 0);
  });

  test("a value that is not an ak- key is refused here, whatever the verifier would have said of it", async () => {
    // Not left to the SaFE client's own check of the shape: a verifier that says yes to everything is asked about nothing that is not a key.
    const yes = { verifyApiKey: async () => ({ userId: "u-alice", userName: "Alice", roles: [], platformKey: "p", virtualKey: "v" }) };
    for (const key of ["sk-alice-virtual", "", "  ", "Bearer ak-alice-platform"]) {
      const e = refused(await run(asService(), yes, { "x-api-key": key }));
      assert.deepEqual([e.status, e.legacyError], [401, "invalid_api_key"], JSON.stringify(key));
    }
    assert.equal(user(await run(asService(), yes, { "x-api-key": "ak-anything" })).platformKey, "p", "and a key is what the verifier is asked about");
  });

  test("the setting's value is a list of client ids, as signed: commas or white space, and each is compared whole", async () => {
    process.env.CLAW_IDENTITY_TOKEN_OWN_KEY_CLIENT_IDS = ` first ,${SERVICE}\n  third,${SERVICE}`;
    assert.equal(user(await run(asService(), client, { "x-api-key": "ak-alice-platform" })).platformKey, "ak-alice-platform");
    assert.equal(user(await run(delegatedBy("fir"), client, { "x-api-key": "ak-alice-platform" })).platformKey, "");
  });
});

describe("K9 a named chat service's delegated token has the keys SaFE holds for its subject (CLAW_IDENTITY_TOKEN_DELEGATED_KEY_CLIENT_IDS)", () => {
  const CHAT = "svc-chatbot";
  /** As the provider issues it to a chat service for a person it has a binding of: `sub` the person, `act` and `client_id` the service. */
  const byChat = (over: Record<string, unknown> = {}) => mint({ act: { sub: CHAT }, client_id: CHAT, ...over });
  const asked = () => verifyCalls().map((c) => JSON.parse(c.body) as { apiKey?: string; authorization?: string });
  beforeEach(() => { process.env.CLAW_IDENTITY_TOKEN_DELEGATED_KEY_CLIENT_IDS = CHAT; });

  test("the service's token is exchanged once more, SaFE is shown the result (this API acting, the service kept in the chain), and the keys are the subject's", async () => {
    const token = byChat();
    const u = user(await run(token));
    assert.deepEqual([u.userId, u.platformKey, u.virtualKey], ["u-alice", "ak-alice-platform", "sk-alice-virtual"]);
    assert.deepEqual(u.roles, ["default"], "SaFE's roles are still nobody's but the operator's");
    assert.deepEqual(u.delegation, { actorSub: CHAT, clientId: CHAT }, "still a service acting for the person");
    assert.deepEqual(delegations.map((d) => [d.subjectToken, d.audience, d.scope]), [[token, "primus-safe", "safe.api"]]);
    const [shown] = asked();
    assert.equal(asked().length, 1);
    assert.equal(shown!.apiKey, undefined);
    const delegated = payloadOf(shown!.authorization!.replace("Bearer ", ""));
    assert.deepEqual([delegated.sub, delegated.aud, delegated.act], ["u-alice", "primus-safe", { sub: CLAW, act: { sub: CHAT } }]);
    assert.notEqual(shown!.authorization, `Bearer ${token}`, "SaFE never sees the service's token itself");
  });

  test("two people through the same service never share keys", async () => {
    const a = user(await run(byChat()));
    const b = user(await run(byChat({ sub: "u-bob", name: "Bob" })));
    assert.deepEqual([a.virtualKey, b.virtualKey], ["sk-alice-virtual", "sk-bob-virtual"]);
  });

  test("an answer for another subject than the token's is not taken", async () => {
    verifyAnswer = (req, res) => sendJson(res, 200, { code: 0, data: { id: "u-bob", name: "Bob", platformKey: "ak-bob-platform", virtualKey: "sk-bob-virtual" } });
    const u = user(await run(byChat()));
    assert.deepEqual([u.userId, u.platformKey, u.virtualKey], ["u-alice", "", ""]);
  });

  test("a key the service brings for the person is still the one used, and nothing is exchanged", async () => {
    process.env.CLAW_IDENTITY_TOKEN_OWN_KEY_CLIENT_IDS = CHAT;
    const u = user(await run(byChat(), client, { "x-api-key": "ak-alice-platform" }));
    assert.deepEqual([u.platformKey, u.virtualKey], ["ak-alice-platform", "sk-alice-virtual"]);
    assert.equal(exchangeCalls().length, 0);
    assert.deepEqual(asked().map((q) => q.apiKey), ["ak-alice-platform"]);
  });

  test("the provider or SaFE not answering is a 503, as for a token that is not delegated, never a keyless caller", async () => {
    verifyAnswer = (_r, res) => sendJson(res, 503, { code: 503, message: "down" });
    const e = refused(await run(byChat()));
    assert.deepEqual([e.status, e.legacyError], [503, "authentication_service_unavailable"]);
  });

  // [name, the environment's list (null: unset; undefined: this suite's), the token]: keyless, nothing exchanged, SaFE not asked, as before.
  const keyless: Array<[string, string | null | undefined, () => string]> = [
    ["no service is named (the default)", null, () => byChat()],
    ["an empty list", "", () => byChat()],
    ["another service is named", "svc-other", () => byChat()],
    ["a client id that differs by case", undefined, () => mint({ act: { sub: CHAT }, client_id: "SVC-CHATBOT" })],
    ["a client id that merely begins with the named one", undefined, () => mint({ act: { sub: CHAT }, client_id: `${CHAT}-2` })],
    ["a client id that differs by a trailing space", undefined, () => mint({ act: { sub: CHAT }, client_id: `${CHAT} ` })],
    ["a delegated token that names no client (its act names the service)", undefined, () => byChat({ client_id: undefined })],
  ];
  for (const [name, list, token] of keyless) {
    test(`not exchanged, no keys (as before): ${name}`, async () => {
      if (list === null) delete process.env.CLAW_IDENTITY_TOKEN_DELEGATED_KEY_CLIENT_IDS;
      else if (list !== undefined) process.env.CLAW_IDENTITY_TOKEN_DELEGATED_KEY_CLIENT_IDS = list;
      const u = user(await run(token()));
      assert.deepEqual([u.userId, u.platformKey, u.virtualKey], ["u-alice", "", ""]);
      assert.equal(exchangeCalls().length, 0);
      assert.equal(verifyCalls().length, 0);
    });
  }

  test("the setting is a list of client ids as signed, separated by commas or white space", async () => {
    process.env.CLAW_IDENTITY_TOKEN_DELEGATED_KEY_CLIENT_IDS = ` first ,${CHAT}\n third`;
    assert.equal(user(await run(byChat())).virtualKey, "sk-alice-virtual");
  });
});

describe("K8 the credentials a service brings for the person a review is asked of (`verifyActingAsCredentials`)", () => {
  const BOB_DELEGATED = () => mint({ sub: "u-bob", name: "Bob", act: { sub: "svc-chat" }, client_id: "svc-reviews" });
  const ask = async (token: string, apiKey: string, over: { actingAs?: string; allowed?: string[] } = {}) => {
    const { verifyActingAsCredentials } = await import("../src/auth/identity-token.js");
    return verifyActingAsCredentials({ token, apiKey, actingAs: over.actingAs ?? "u-bob", allowedClients: over.allowed ?? ["svc-reviews"] }, client);
  };
  beforeEach(() => { process.env.CLAW_IDENTITY_TOKEN_OWN_KEY_CLIENT_IDS = "svc-reviews"; });

  test("the person's delegated token from a service on both lists, and their own key: that person, with their own keys", async () => {
    const r = await ask(BOB_DELEGATED(), "ak-bob-platform");
    assert.equal(r.ok, true, JSON.stringify(r));
    if (!r.ok) return;
    assert.deepEqual([r.user.userId, r.user.userName, r.user.platformKey, r.user.virtualKey, r.user.delegation],
      ["u-bob", "Bob", "ak-bob-platform", "sk-bob-virtual", { actorSub: "svc-chat", clientId: "svc-reviews" }]);
    assert.deepEqual(verifyCalls().map((c) => JSON.parse(c.body).apiKey), ["ak-bob-platform"], "SaFE judged the key");
    assert.equal(exchangeCalls().length, 0, "nothing is exchanged for it");
  });

  test("every other combination is refused, and says which", async () => {
    const cases: Array<[string, () => Promise<Awaited<ReturnType<typeof ask>>>, number, string]> = [
      ["no token", () => ask("", "ak-bob-platform"), 401, "acting_as_credentials_required"],
      ["no key", () => ask(BOB_DELEGATED(), ""), 401, "acting_as_credentials_required"],
      ["the person's token with the requester's key", () => ask(BOB_DELEGATED(), "ak-alice-platform"), 401, "key_subject_mismatch"],
      ["a key SaFE does not know", () => ask(BOB_DELEGATED(), "ak-nobody"), 401, "invalid_acting_as_api_key"],
      ["someone else's token", () => ask(mint({ sub: "u-alice", act: { sub: "svc-chat" }, client_id: "svc-reviews" }), "ak-bob-platform"), 403, "acting_as_mismatch"],
      ["the person's own sign-in, not a service's", () => ask(mint({ sub: "u-bob", client_id: "svc-reviews" }), "ak-bob-platform"), 403, "acting_as_not_delegated"],
      ["a service not allowed to speak for a person", () => ask(BOB_DELEGATED(), "ak-bob-platform", { allowed: ["other"] }), 403, "service_client_not_allowed"],
      ["a forged signature", () => ask(mint({ sub: "u-bob", act: { sub: "svc-chat" }, client_id: "svc-reviews" }, testKey("ES256", "k-es", true)), "ak-bob-platform"), 401, "invalid_acting_as_token"],
      ["a token without the API scope", () => ask(mint({ sub: "u-bob", act: { sub: "svc-chat" }, client_id: "svc-reviews", scope: "openid" }), "ak-bob-platform"), 401, "invalid_acting_as_token"],
      ["an ak- key as the token", () => ask("ak-bob-platform", "ak-bob-platform"), 401, "invalid_acting_as_token"],
    ];
    for (const [what, run, status, error] of cases) {
      const r = await run();
      assert.equal(r.ok, false, what);
      if (!r.ok) assert.deepEqual([r.status, r.error], [status, error], what);
    }
    // A service on the decision list that may not bring a person's own key is refused as well.
    process.env.CLAW_IDENTITY_TOKEN_OWN_KEY_CLIENT_IDS = "someone-else";
    const r = await ask(BOB_DELEGATED(), "ak-bob-platform");
    assert.deepEqual(r.ok ? null : [r.status, r.error], [403, "service_client_not_allowed"]);
  });

  test("without the identity-token path there is nothing to verify with: 503, never a yes", async () => {
    process.env.CLAW_IDENTITY_TOKEN_AUTH_ENABLED = "false";
    const r = await ask(BOB_DELEGATED(), "ak-bob-platform");
    assert.deepEqual(r.ok ? null : [r.status, r.error], [503, "acting_as_unverifiable"]);
  });
});
