// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * An identity provider's access token through the real authentication hook, over
 * real HTTP, beside the credentials the API already accepted. What is pinned is
 * how the paths combine: the token is final once the value is shaped like one,
 * the cookie still comes first, an `ak-` key is still SaFE's to judge, and with
 * the flag off the request is judged exactly as it was before this path existed.
 */
import test, { after, before, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import Fastify, { type FastifyInstance } from "fastify";

import { FakeIdentity, activeAnswer, answerDelegation, signJwt, testKey } from "../../utils/test/identity-fake.js";
import { isAdmin } from "../src/auth/models.js";

const nowSec = () => Math.floor(Date.now() / 1000);
const es = testKey("ES256", "k-es");
const log = { info() {}, warn() {}, error() {} };

/**
 * SaFE as far as authentication uses it: `ak-<id>` and `Token=ck-<id>` verify to user `<id>`; the calls are counted.
 * An access token (`authorization`) is accepted when it names `web-user`, as SaFE's external mode would, and answered
 * with that user's keys; those questions are counted apart, in `tokenCalls`.
 */
async function startSafe(): Promise<{ url: string; calls: string[]; tokenCalls: string[]; close(): Promise<void> }> {
  const calls: string[] = [];
  const tokenCalls: string[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const q = JSON.parse(body || "{}") as { apiKey?: string; cookie?: string; authorization?: string };
      if (q.authorization !== undefined) {
        tokenCalls.push(q.authorization);
        const sub = JSON.parse(Buffer.from((q.authorization.split(".")[1] ?? ""), "base64url").toString("utf8") || "{}").sub;
        if (sub !== "web-user") { res.writeHead(401).end("{}"); return; }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: { id: sub, name: "SaFE's name", roles: ["default", "system-admin"], platformKey: "pk-web-user", virtualKey: "vk-web-user" } }));
        return;
      }
      calls.push(q.apiKey ?? q.cookie ?? "?");
      const id = q.apiKey?.startsWith("ak-") ? q.apiKey.slice(3) : /Token=ck-([^;]+)/.exec(q.cookie ?? "")?.[1];
      if (!id || !["u1", "u2"].includes(id)) { res.writeHead(401).end("{}"); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: { id, name: `User ${id}`, roles: ["default"], platformKey: "", virtualKey: `vk-${id}` } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    calls,
    tokenCalls,
    close: async () => { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); },
  };
}

describe("an identity access token through the authentication hook", () => {
  let safe: Awaited<ReturnType<typeof startSafe>>;
  let fake: FakeIdentity;
  let app: FastifyInstance;
  let base = "";
  let providerDown = false;
  let delegations: ReturnType<typeof answerDelegation>;
  let startIdentityClient: typeof import("../src/auth/identity.js").startIdentityClient;

  const payloadOf = (token: string) => JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8") || "{}");
  function identity(on: boolean): void {
    for (const k of ["IDENTITY_CLIENT_ENABLED", "IDENTITY_ISSUER_URL", "IDENTITY_CLIENT_ID", "IDENTITY_CLIENT_SECRET"]) delete process.env[k];
    if (on) {
      Object.assign(process.env, {
        IDENTITY_CLIENT_ENABLED: "true", IDENTITY_ISSUER_URL: fake.issuer, IDENTITY_CLIENT_ID: "svc-claw", IDENTITY_CLIENT_SECRET: "s3cret",
        IDENTITY_INTROSPECTION_CACHE_SECONDS: "0", IDENTITY_INTROSPECTION_NEGATIVE_CACHE_SECONDS: "0", IDENTITY_STALE_IF_ERROR_SECONDS: "0",
      });
    }
    startIdentityClient(log);
  }
  function mint(over: Record<string, unknown> = {}): string {
    return signJwt({
      key: es,
      claims: {
        iss: fake.issuer, aud: "claw-api", sub: "web-user", client_id: "claw-web", gid: "g", scope: "openid claw.api",
        name: "Web User", roles: ["default", "system-admin"], jti: randomUUID(), iat: nowSec(), nbf: nowSec() - 1, exp: nowSec() + 300, ...over,
      },
    });
  }

  before(async () => {
    safe = await startSafe();
    fake = await FakeIdentity.start();
    fake.jwks = () => ({ body: { keys: [es.jwk] } });
    fake.introspect = (r) => (providerDown ? { status: 503, body: "down" } : { body: activeAnswer({ sub: payloadOf(r.form.get("token") ?? "").sub }) });
    // SaFE is asked about the delegated token the provider issues for the user's own, never about the user's token.
    delegations = answerDelegation(fake, es, { clientId: "svc-claw" });
    Object.assign(process.env, { SAFE_API_URL: safe.url, AUTH_INTERNAL_TOKEN: "t" });
    delete process.env.CLAW_DEPLOY_MODE;
    ({ startIdentityClient } = await import("../src/auth/identity.js"));
    const { authMiddleware, getUser } = await import("../src/auth/middleware.js");
    app = Fastify();
    await app.register((await import("@fastify/cookie")).default);
    app.addHook("preHandler", authMiddleware);
    app.get("/v1/whoami", async (req) => ({ user: getUser(req) }));
    // A browser-download route: the one place the existing `?token=` key path is tried, and before any header path.
    app.get("/v1/sessions/abc/files/main.py", async (req) => ({ user: getUser(req) }));
    await app.listen({ port: 0, host: "127.0.0.1" });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });
  after(async () => {
    await app?.close();
    await fake?.close();
    await safe?.close();
  });
  beforeEach(() => {
    providerDown = false;
    safe.calls.length = 0;
    safe.tokenCalls.length = 0;
    delegations.length = 0;
    identity(true);
    process.env.CLAW_IDENTITY_TOKEN_AUTH_ENABLED = "true";
    delete process.env.CLAW_IDENTITY_TOKEN_INTROSPECT;
  });

  async function whoami(headers: Record<string, string>): Promise<{ status: number; body: any }> {
    const r = await fetch(`${base}/v1/whoami`, { headers });
    return { status: r.status, body: await r.json().catch(() => null) };
  }
  const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

  test("authenticates the request as the token's subject, with that subject's keys from SaFE and no role from SaFE", async () => {
    const token = mint();
    const r = await whoami(bearer(token));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.user, { userId: "web-user", userName: "Web User", roles: ["default"], platformKey: "pk-web-user", virtualKey: "vk-web-user" });
    assert.deepEqual(safe.calls, [], "SaFE was not asked about a cookie or a key");
    // It was asked once, and not about the user's token: about the one the provider issued the API for SaFE's audience,
    // naming the API as the party acting for the user.
    assert.equal(safe.tokenCalls.length, 1);
    assert.notEqual(safe.tokenCalls[0], `Bearer ${token}`, "SaFE was shown the user's own token");
    const asked = payloadOf((safe.tokenCalls[0] ?? "").replace("Bearer ", ""));
    assert.deepEqual([asked.sub, asked.aud, asked.scope, asked.act], ["web-user", "primus-safe", "safe.api", { sub: "svc-claw" }]);
    assert.deepEqual(delegations.map((d) => [d.subjectToken === token, d.audience, d.scope]), [[true, "primus-safe", "safe.api"]]);
  });

  test("a subject SaFE does not know is the token's user all the same, without keys", async () => {
    const r = await whoami(bearer(mint({ sub: "stranger" })));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.user, { userId: "stranger", userName: "Web User", roles: ["default"], platformKey: "", virtualKey: "" });
  });

  test("a token that carries `system-admin` in its roles claim does not make the caller an administrator (mint() carries it)", async () => {
    const r = await whoami(bearer(mint({ roles: ["system-admin", "system-admin-readonly"] })));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.user.roles, ["default"]);
    assert.equal(isAdmin(r.body.user), false);
  });

  test("with the flag off the same token is not a credential: the request is refused as one with none, and SaFE is not asked", async () => {
    delete process.env.CLAW_IDENTITY_TOKEN_AUTH_ENABLED;
    const r = await whoami(bearer(mint()));
    assert.equal(r.status, 401);
    assert.equal(r.body.error, "authentication_required");
    assert.deepEqual(safe.calls, []);
    assert.deepEqual(safe.tokenCalls, []);
  });

  test("without an identity client the flag alone does nothing", async () => {
    identity(false);
    process.env.CLAW_IDENTITY_TOKEN_AUTH_ENABLED = "true";
    const r = await whoami(bearer(mint()));
    assert.equal(r.status, 401);
    assert.equal(r.body.error, "authentication_required");
  });

  test("a token that does not verify is refused, and no other credential on the request gets to judge it", async () => {
    const r = await whoami({ ...bearer(mint({ aud: "someone-else" })), "x-api-key": "ak-u1" });
    assert.equal(r.status, 401);
    assert.equal(r.body.error, "invalid_token");
    assert.deepEqual(safe.calls, [], "the x-api-key was never tried");
    assert.deepEqual(safe.tokenCalls, [], "SaFE is not shown a token that did not verify");
  });

  test("a token without the API scope is a 403 and nothing else is tried", async () => {
    const r = await whoami({ ...bearer(mint({ scope: "claw.connector" })), "x-api-key": "ak-u1" });
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "insufficient_scope");
    assert.deepEqual(safe.calls, []);
    assert.deepEqual(safe.tokenCalls, []);
  });

  test("a provider that cannot be asked is a 503", async () => {
    process.env.CLAW_IDENTITY_TOKEN_INTROSPECT = "true";
    providerDown = true;
    const r = await whoami(bearer(mint()));
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "authentication_service_unavailable");
  });

  test("an ak- key is still SaFE's: user, virtual key and method are as before", async () => {
    const r = await whoami(bearer("ak-u1"));
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.user, { userId: "u1", userName: "User u1", roles: ["default"], platformKey: "", virtualKey: "vk-u1" });
    assert.deepEqual(safe.calls, ["ak-u1"]);
  });

  test("an ak- key shaped like a JWT is SaFE's to judge, never the token path's", async () => {
    const r = await whoami(bearer("ak-aaa.bbb.ccc"));
    assert.equal(r.status, 401);
    assert.equal(r.body.error, "invalid_api_key");
    assert.deepEqual(safe.calls, ["ak-aaa.bbb.ccc"]);
  });

  test("on a browser-download route the `?token=` key is still tried first, as before, and a token does not displace it", async () => {
    const get = async (query: string, headers: Record<string, string>) => {
      const r = await fetch(`${base}/v1/sessions/abc/files/main.py${query}`, { headers });
      return { status: r.status, body: (await r.json().catch(() => null)) as any };
    };
    // A valid key in the query authenticates its owner, whatever else is presented: the key is the credential that was verified.
    const withKey = await get("?token=ak-u1", bearer(mint({ aud: "someone-else" })));
    assert.equal(withKey.status, 200);
    assert.equal(withKey.body.user.userId, "u1");
    // Without a key the token is judged there like anywhere: valid, it authenticates; bad, it is final.
    assert.equal((await get("", bearer(mint()))).body.user.userId, "web-user");
    const bad = await get("", bearer(mint({ aud: "someone-else" })));
    assert.equal(bad.status, 401);
    assert.equal(bad.body.error, "invalid_token");
  });

  test("the cookie still comes first: a valid cookie wins over a valid token", async () => {
    const r = await whoami({ cookie: "Token=ck-u2", ...bearer(mint()) });
    assert.equal(r.status, 200);
    assert.equal(r.body.user.userId, "u2");
  });

  test("a stale cookie is refused even beside a valid token (fail closed)", async () => {
    const r = await whoami({ cookie: "Token=ck-nobody", ...bearer(mint()) });
    assert.equal(r.status, 401);
    assert.equal(r.body.error, "invalid_cookie");
  });

  test("the x-api-key path is unchanged beside a Bearer value that is not a JWT", async () => {
    const r = await whoami({ authorization: "Bearer opaque", "x-api-key": "ak-u2" });
    assert.equal(r.status, 200);
    assert.equal(r.body.user.userId, "u2");
  });
});
