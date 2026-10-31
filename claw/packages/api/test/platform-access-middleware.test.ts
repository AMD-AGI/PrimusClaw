// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The platform-role requirement through the real authentication hook, over real
 * HTTP, with a stand-in SaFE that answers verification from a table (so the shape
 * of its `roles` field is under the test's control).
 *
 *   PM1  with the setting empty every caller is served as before, whatever SaFE
 *        reported (or failed to report) for it, on every kind of credential
 *   PM2  with it set, a caller holding one of the named roles is served and any
 *        other is a 403 `platform_access_required`, on every kind of credential
 *   PM3  a refused caller never reaches the route and its LLM key is never cached
 *   PM4  the refusal is for an authenticated caller: no credential and a bad
 *        credential are still 401; probes, discovery and internal routes are not judged
 *   PM5  under /anthropic/ the refusal has Anthropic's error shape
 *   PM6  a token the identity provider issued (identity token, connector token)
 *        brings no SaFE roles, so with the setting on it is refused too
 *   PM7  the setting is read on each request
 */
import test, { after, before, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import Fastify, { type FastifyInstance } from "fastify";

import { FakeIdentity, signJwt, testKey } from "../../utils/test/identity-fake.js";
import { sendJson, startFakeUpstream, type FakeUpstream } from "./support/fake-upstream.js";

const nowSec = () => Math.floor(Date.now() / 1000);
const es = testKey("ES256", "k-es");
const log = { info() {}, warn() {}, error() {} };

const ENV = "CLAW_REQUIRED_PLATFORM_ROLES";
const DOWNLOAD = "/v1/sessions/abc/files/main.py";

/** What SaFE says about each account's roles. `undefined` leaves the field out, as a SaFE that does not send it would. */
const ACCOUNTS: Record<string, { roles?: unknown }> = {
  alice: { roles: ["default"] },
  both: { roles: ["pending", "default"] },
  reader: { roles: ["pending"] },
  bare: { roles: [] },
  silent: {},
  nulled: { roles: null },
  stringy: { roles: "default" },
  admin: { roles: ["system-admin"] },
};

/**
 * Accounts only PM3 uses. The LLM key cache is process-wide and never evicted, so an account any
 * other test has been served as would already be in it; these two are first seen inside PM3.
 */
const ISOLATED: Record<string, { roles?: unknown }> = {
  newcomer: { roles: ["pending"] },
  member: { roles: ["default"] },
  // PM7 counts the verifications SaFE is asked for, so nothing else may have cached this one.
  watcher: { roles: ["pending"] },
};

describe("the platform-role requirement through the authentication hook", () => {
  let safe: FakeUpstream;
  let fake: FakeIdentity;
  let app: FastifyInstance;
  let base = "";
  let reached: string[] = [];
  let startIdentityClient: typeof import("../src/auth/identity.js").startIdentityClient;
  let getCachedUserLlmKey: typeof import("../src/llm/client.js").getCachedUserLlmKey;

  function identity(on: boolean): void {
    for (const k of ["IDENTITY_CLIENT_ENABLED", "IDENTITY_ISSUER_URL", "IDENTITY_CLIENT_ID", "IDENTITY_CLIENT_SECRET"]) delete process.env[k];
    if (on) {
      Object.assign(process.env, {
        IDENTITY_CLIENT_ENABLED: "true", IDENTITY_ISSUER_URL: fake.issuer, IDENTITY_CLIENT_ID: "svc-claw", IDENTITY_CLIENT_SECRET: "s3cret",
      });
    }
    startIdentityClient(log);
  }
  const mint = (scope: string, sub: string): string => signJwt({
    key: es,
    claims: {
      iss: fake.issuer, aud: "claw-api", sub, scope, name: sub, roles: ["default", "system-admin"],
      jti: randomUUID(), iat: nowSec(), nbf: nowSec() - 1, exp: nowSec() + 300,
    },
  });

  before(async () => {
    safe = await startFakeUpstream((req, res) => {
      const q = JSON.parse(req.body || "{}") as { apiKey?: string; cookie?: string };
      const id = q.apiKey?.startsWith("ak-") ? q.apiKey.slice(3) : /Token=ck-([^;]+)/.exec(q.cookie ?? "")?.[1];
      const account = id === undefined ? undefined : { ...ACCOUNTS, ...ISOLATED }[id];
      if (!id || !account) return sendJson(res, 401, { message: "invalid credential" });
      sendJson(res, 200, {
        data: { id: `u-${id}`, name: id, ...(account.roles !== undefined ? { roles: account.roles } : {}), platformKey: "", virtualKey: `vk-${id}` },
      });
    });
    fake = await FakeIdentity.start();
    fake.jwks = () => ({ body: { keys: [es.jwk] } });
    Object.assign(process.env, {
      SAFE_API_URL: safe.url, AUTH_INTERNAL_TOKEN: "t", APP_ENV: "production", CLAW_REMOTE_AGENTS_ENABLED: "true",
    });
    delete process.env.CLAW_INSECURE_DEV_AUTH;
    delete process.env.CLAW_DEPLOY_MODE;
    ({ startIdentityClient } = await import("../src/auth/identity.js"));
    ({ getCachedUserLlmKey } = await import("../src/llm/client.js"));
    const { authMiddleware, getUser } = await import("../src/auth/middleware.js");
    app = Fastify();
    await app.register((await import("@fastify/cookie")).default);
    app.addHook("preHandler", authMiddleware);
    const serve = (name: string) => async (req: Parameters<typeof getUser>[0]) => { reached.push(name); return { user: getUser(req) }; };
    app.get("/v1/whoami", serve("whoami"));
    app.get(DOWNLOAD, serve("download"));
    app.get("/anthropic/v1/whoami", serve("anthropic"));
    app.post("/v1/remote-agents/connectors", serve("connector"));
    app.get("/health", async () => ({ status: "ok" }));
    app.get("/.well-known/agent-card.json", async () => ({ name: "card" }));
    app.get("/v1/internal/ping", async () => ({ ok: true }));
    await app.listen({ port: 0, host: "127.0.0.1" });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });
  after(async () => {
    delete process.env[ENV];
    await app?.close();
    await fake?.close();
    await safe?.close();
  });
  beforeEach(() => {
    delete process.env[ENV];
    delete process.env.CLAW_IDENTITY_TOKEN_AUTH_ENABLED;
    identity(false);
    reached = [];
    safe.seen.length = 0;
  });

  type Res = { status: number; body: any };
  async function call(method: string, path: string, headers: Record<string, string>): Promise<Res> {
    const r = await fetch(base + path, { method, headers });
    return { status: r.status, body: await r.json().catch(() => null) };
  }
  /** The four ways a credential SaFE verifies reaches the API, each as `[label, request]`. */
  const ways = (id: string): Array<[string, () => Promise<Res>]> => [
    ["cookie", () => call("GET", "/v1/whoami", { cookie: `Token=ck-${id}; userType=default` })],
    ["bearer ak-", () => call("GET", "/v1/whoami", { authorization: `Bearer ak-${id}` })],
    ["x-api-key", () => call("GET", "/v1/whoami", { "x-api-key": `ak-${id}` })],
    ["download ?token=", () => call("GET", `${DOWNLOAD}?token=ak-${id}`, {})],
  ];

  test("PM1: with the setting empty (or blank) every caller is served, whatever SaFE reported for it", async () => {
    for (const value of [undefined, "", "  ,  "]) {
      if (value === undefined) delete process.env[ENV]; else process.env[ENV] = value;
      for (const id of Object.keys(ACCOUNTS)) {
        for (const [label, request] of ways(id)) {
          const r = await request();
          assert.equal(r.status, 200, `${JSON.stringify(value)} ${id} via ${label}: ${JSON.stringify(r.body)}`);
        }
      }
    }
  });

  test("PM2: with the setting on a caller holding a named role is served and any other is refused, on every kind of credential", async () => {
    const table: Array<[string, string, boolean]> = [
      ["default", "alice", true],
      ["default", "both", true],
      ["default", "reader", false],
      ["default", "bare", false],
      // SaFE did not send the field, sent null, or sent a string: unknown or none, never a match.
      ["default", "silent", false],
      ["default", "nulled", false],
      ["default", "stringy", false],
      ["default", "admin", false],
      // Any one of the named roles is enough.
      ["default,system-admin", "admin", true],
      ["system-admin default", "alice", true],
      ["system-admin", "alice", false],
      // A role nobody has refuses everybody.
      ["no-such-role", "alice", false],
      ["no-such-role", "admin", false],
    ];
    for (const [setting, id, served] of table) {
      process.env[ENV] = setting;
      for (const [label, request] of ways(id)) {
        const r = await request();
        const what = `${setting} / ${id} via ${label}: ${r.status} ${JSON.stringify(r.body)}`;
        if (served) {
          assert.equal(r.status, 200, what);
        } else {
          assert.equal(r.status, 403, what);
          assert.deepEqual(r.body, { ok: false, error: "platform_access_required", message: "no access yet - ask an administrator" }, what);
        }
      }
    }
  });

  test("PM3: a refused caller never reaches the route, and its LLM key is not cached for background work", async () => {
    process.env[ENV] = "default";
    for (const [, request] of ways("newcomer")) assert.equal((await request()).status, 403);
    assert.deepEqual(reached, []);
    assert.equal(getCachedUserLlmKey("u-newcomer"), undefined, "a refused caller's key was cached");

    for (const [, request] of ways("member")) assert.equal((await request()).status, 200);
    assert.equal(reached.length, 4);
    assert.ok(getCachedUserLlmKey("u-member"), "a served caller's key is cached, as before");
  });

  test("PM4: the refusal is for an authenticated caller; probes, discovery and internal routes are not judged", async () => {
    process.env[ENV] = "default";
    const none = await call("GET", "/v1/whoami", {});
    assert.equal(none.status, 401);
    assert.equal(none.body.error, "authentication_required");
    const bad = await call("GET", "/v1/whoami", { authorization: "Bearer ak-nobody" });
    assert.equal(bad.status, 401);
    assert.equal(bad.body.error, "invalid_api_key");
    const stale = await call("GET", "/v1/whoami", { cookie: "Token=ck-nobody" });
    assert.equal(stale.status, 401);
    assert.equal(stale.body.error, "invalid_cookie");
    // A bad cookie beside a good key is still refused on the cookie, not let through on the key.
    assert.equal((await call("GET", "/v1/whoami", { cookie: "Token=ck-nobody", authorization: "Bearer ak-alice" })).status, 401);

    const asked = safe.seen.length;
    for (const path of ["/health", "/.well-known/agent-card.json", "/v1/internal/ping"]) {
      const r = await call("GET", path, {});
      assert.equal(r.status, 200, path);
    }
    assert.equal(safe.seen.length, asked, "an anonymous route asked SaFE");
  });

  test("PM5: under /anthropic/ the refusal has Anthropic's error shape", async () => {
    process.env[ENV] = "default";
    const r = await call("GET", "/anthropic/v1/whoami", { "x-api-key": "ak-reader" });
    assert.equal(r.status, 403);
    assert.deepEqual(r.body, { type: "error", error: { type: "permission_error", message: "no access yet - ask an administrator" } });
    assert.equal((await call("GET", "/anthropic/v1/whoami", { "x-api-key": "ak-alice" })).status, 200);
  });

  test("PM7: the setting is read on each request, and a held role is judged against it each time", async () => {
    const asWatcher = () => call("GET", "/v1/whoami", { authorization: "Bearer ak-watcher" });
    assert.equal((await asWatcher()).status, 200);
    process.env[ENV] = "default";
    assert.equal((await asWatcher()).status, 403);
    process.env[ENV] = "pending";
    assert.equal((await asWatcher()).status, 200);
    delete process.env[ENV];
    assert.equal((await asWatcher()).status, 200);
    // SaFE was asked once: the verification is cached, the judgement is not.
    assert.equal(safe.seen.filter((s) => s.url.startsWith("/api/v1/auth/verify")).length, 1);
  });

  describe("PM6: a token the identity provider issued carries no SaFE roles", () => {
    const identityToken = () => ({ authorization: `Bearer ${mint("openid claw.api", "web-user")}` });
    const connectorToken = () => ({ authorization: `Bearer ${mint("claw.connector", "conn-user")}` });

    test("an identity token is served while the setting is empty and refused once it is set, though its caller is `default`", async () => {
      identity(true);
      process.env.CLAW_IDENTITY_TOKEN_AUTH_ENABLED = "true";
      const served = await call("GET", "/v1/whoami", identityToken());
      assert.equal(served.status, 200, JSON.stringify(served.body));
      assert.deepEqual(served.body.user.roles, ["default"]);

      process.env[ENV] = "default";
      reached = [];
      const refused = await call("GET", "/v1/whoami", identityToken());
      assert.equal(refused.status, 403);
      assert.equal(refused.body.error, "platform_access_required");
      assert.deepEqual(reached, []);
      assert.equal(getCachedUserLlmKey("web-user"), undefined);
      // A role the provider confirmed is not SaFE's report either.
      process.env[ENV] = "system-admin";
      assert.equal((await call("GET", "/v1/whoami", identityToken())).status, 403);
      // SaFE was never asked: the token is not one of its credentials.
      assert.equal(safe.seen.length, 0);
    });

    test("a connector token is served on a connector-side route while the setting is empty and refused once it is set", async () => {
      identity(true);
      const served = await call("POST", "/v1/remote-agents/connectors", connectorToken());
      assert.equal(served.status, 200, JSON.stringify(served.body));
      process.env[ENV] = "default";
      reached = [];
      const refused = await call("POST", "/v1/remote-agents/connectors", connectorToken());
      assert.equal(refused.status, 403);
      assert.equal(refused.body.error, "platform_access_required");
      assert.deepEqual(reached, []);
    });

    test("the same user's SaFE-verified credential still passes, so the way in is a credential SaFE vouches for", async () => {
      process.env[ENV] = "default";
      assert.equal((await call("GET", "/v1/whoami", { authorization: "Bearer ak-alice" })).status, 200);
    });
  });
});
