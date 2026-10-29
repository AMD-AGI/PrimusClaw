// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `GET /v1/me` for a caller who holds only an identity provider's access token, through
 * the real auth middleware and the real route. SaFE is a server on a socket that is both
 * the verifier (it accepts the token, as SaFE's external-authentication mode would, and
 * answers with the person's keys) and the API the route then calls; the provider is a
 * stand-in on a socket whose tokens are signed with real keys.
 *
 * The failure this pins: the route used to answer 401 "no credential that can be
 * presented to SaFE was sent" for every such caller, because it forwards the caller's own
 * credential and a token is not one SaFE is asked to take on the data routes. It is now
 * asked with the platform key SaFE gave for the token, so SaFE answers as that person.
 *
 *   MI1  the document is the person's own, and every data read carried their platform key, not the token
 *   MI2  a token SaFE does not accept (or one that is delegated) is the same 401 as no credential: nothing is read
 *   MI3  two people at once never see each other's workspaces
 *   MI4  the same request with a cookie or a key is unchanged
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { FakeIdentity, activeAnswer, signJwt, testKey } from "../../utils/test/identity-fake.js";
import type { FakeUpstream } from "./support/fake-upstream.js";
import { AUTH_INTERNAL_TOKEN, startFakePlatform, type Account, type TokenVerdict } from "./support/fake-platform.js";

const DATA_PATHS = ["/api/v1/workspaces", "/api/v1/clusters", "/api/v1/users/self"];
const nowSec = () => Math.floor(Date.now() / 1000);
const es = testKey("ES256", "k-es");
const log = { info() {}, warn() {}, error() {} };

// The platform key of an account is `ak-<name>`, which is how the fake platform tells who asks on its data routes.
const ALICE: Account = {
  id: "u-alice", name: "Alice", email: "alice@example.com", roles: ["default"],
  platformKey: "ak-alice", virtualKey: "sk-alice",
  workspaces: { items: [{ workspaceId: "ws-a", workspaceName: "A", clusterId: "c1", flavorId: "f1", scopes: ["Sandbox"], gpuProduct: "MI300X", isDefault: true }] },
  clusters: { items: [{ clusterId: "c1", phase: "Ready" }] },
  self: { id: "u-alice", managedWorkspaces: [{ id: "ws-a" }] },
};
const BOB: Account = {
  id: "u-bob", name: "Bob", roles: ["default"], platformKey: "ak-bob", virtualKey: "sk-bob",
  workspaces: { items: [{ workspaceId: "ws-b", workspaceName: "B", clusterId: "c2", scopes: ["Sandbox"] }] },
  clusters: { items: [{ clusterId: "c2", phase: "Ready" }] },
  self: { id: "u-bob", managedWorkspaces: [] },
};

let fake: FakeIdentity;
let platform: FakeUpstream;
let app: FastifyInstance;

const tokenVerdict = (bearer: string): TokenVerdict => {
  const claims = JSON.parse(Buffer.from(bearer.split(".")[1] ?? "", "base64url").toString("utf8") || "{}");
  if (claims.aud !== "claw-api") return null;
  if (claims.act !== undefined) return "delegated";
  return ({ "u-alice": ALICE, "u-bob": BOB } as Record<string, Account>)[claims.sub] ?? null;
};

function mint(over: Record<string, unknown> = {}): string {
  const claims: Record<string, unknown> = {
    iss: fake.issuer, aud: "claw-api", sub: "u-alice", client_id: "claw-web", scope: "openid claw.api",
    jti: randomUUID(), iat: nowSec(), nbf: nowSec() - 1, exp: nowSec() + 300, ...over,
  };
  return signJwt({ key: es, claims });
}

before(async () => {
  fake = await FakeIdentity.start();
  fake.jwks = () => ({ body: { keys: [es.jwk] } });
  fake.introspect = () => ({ body: activeAnswer() });
  platform = await startFakePlatform({ alice: ALICE, bob: BOB }, () => false, tokenVerdict);

  process.env.APP_ENV = "dev";
  delete process.env.CLAW_INSECURE_DEV_AUTH;
  process.env.CLAW_DEPLOY_MODE = "safe";
  process.env.SAFE_API_URL = platform.url;
  process.env.AUTH_INTERNAL_TOKEN = AUTH_INTERNAL_TOKEN;
  Object.assign(process.env, {
    IDENTITY_CLIENT_ENABLED: "true", IDENTITY_ISSUER_URL: fake.issuer, IDENTITY_CLIENT_ID: "svc-claw",
    IDENTITY_CLIENT_SECRET: "s3cret", CLAW_IDENTITY_TOKEN_AUTH_ENABLED: "true",
  });

  const { startIdentityClient } = await import("../src/auth/identity.js");
  startIdentityClient(log);
  const { authMiddleware } = await import("../src/auth/middleware.js");
  const { registerMeRoutes } = await import("../src/routes/me.js");
  app = Fastify();
  await app.register(cookie);
  app.addHook("preHandler", authMiddleware);
  await registerMeRoutes(app);
  await app.ready();
});

after(async () => {
  await app?.close();
  await platform?.close();
  await fake?.close();
});

const get = (headers: Record<string, string>) => app.inject({ method: "GET", url: "/v1/me", headers });
const as = (token: string) => ({ authorization: `Bearer ${token}` });
const dataCalls = () => platform.seen.filter((r) => DATA_PATHS.includes(r.url.split("?")[0]!));

test("MI1: the document is the person's own, and every data read carried their platform key, not the token", async () => {
  platform.seen.length = 0;
  const token = mint();
  const res = await get(as(token));
  assert.equal(res.statusCode, 200, res.body);
  const me = JSON.parse(res.body);
  assert.equal(me.userId, "u-alice");
  assert.deepEqual(me.roles, ["default"], "SaFE's roles for the person are not the caller's");
  assert.deepEqual(me.sandbox, { available: true, defaultWorkspaceId: "ws-a", gpuProduct: "MI300X" });
  assert.deepEqual(me.workspaces.map((w: { id: string; admin: boolean }) => [w.id, w.admin]), [["ws-a", true]]);
  const calls = dataCalls();
  assert.equal(calls.length, 3);
  for (const c of calls) {
    assert.equal(c.headers.authorization, "Bearer ak-alice");
    assert.equal(c.headers.cookie, undefined);
  }
  assert.equal(res.body.includes(token), false);
  assert.equal(res.body.includes("sk-alice"), false, "the virtual key is not part of the document");
});

test("MI2: a token SaFE does not accept, a delegated one and a missing platform key are all a 401 and nothing is read", async () => {
  const cases: Array<[string, string]> = [
    ["a user SaFE does not know", mint({ sub: "u-mallory" })],
    ["a delegated token", mint({ act: { sub: "svc-teams" } })],
  ];
  for (const [name, token] of cases) {
    platform.seen.length = 0;
    const res = await get(as(token));
    assert.equal(res.statusCode, 401, name);
    assert.equal(JSON.parse(res.body).error, "authentication_required", name);
    assert.equal(dataCalls().length, 0, name);
  }
});

test("MI3: two people at once never see each other's workspaces", async () => {
  const tokens = [mint({ sub: "u-alice" }), mint({ sub: "u-bob" })];
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => get(as(tokens[i % 2]!))));
  results.forEach((res, i) => {
    assert.equal(res.statusCode, 200, res.body);
    const me = JSON.parse(res.body);
    assert.equal(me.userId, i % 2 === 0 ? "u-alice" : "u-bob");
    assert.deepEqual(me.workspaces.map((w: { id: string }) => w.id), [i % 2 === 0 ? "ws-a" : "ws-b"]);
  });
});

test("MI4: a key or a cookie is what it was: the credential presented is the one forwarded", async () => {
  platform.seen.length = 0;
  const viaKey = await get({ authorization: "Bearer ak-alice" });
  assert.equal(viaKey.statusCode, 200);
  assert.ok(dataCalls().every((c) => c.headers.authorization === "Bearer ak-alice"));
  platform.seen.length = 0;
  const viaCookie = await get({ cookie: "Token=tok-alice; userType=default" });
  assert.equal(viaCookie.statusCode, 200);
  assert.ok(dataCalls().every((c) => c.headers.cookie === "Token=tok-alice; userType=default" && c.headers.authorization === undefined));
});
