// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The two access-token credentials through the real authentication hook with both
 * of them switched on: a user's access token (identity-token.ts, scope
 * `claw.api`) and a connector's (connector-token.ts, scope `claw.connector`).
 * What is pinned is how they divide the routes: the connector side of remote
 * agents is the connector path's, whole and final; everywhere else the token path
 * judges a JWT-shaped Bearer value, and a connector's token is refused there for
 * its scope instead of being taken for a user's. Needs no database.
 *
 * `CLAW_REMOTE_AGENTS_ENABLED` is read once when the config loads, so it is set
 * before anything is imported.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import test, { after, before, describe } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";

import { FakeIdentity, signJwt, testKey } from "../../utils/test/identity-fake.js";

const nowSec = () => Math.floor(Date.now() / 1000);
const es = testKey("ES256", "k-es");

describe("a user's access token and a connector's, both switched on", () => {
  let fake: FakeIdentity;
  let app: FastifyInstance;
  let base = "";

  const mint = (over: Record<string, unknown>): string =>
    signJwt({
      key: es,
      claims: {
        iss: fake.issuer, aud: "claw-api", sub: "web-user", name: "Web User", roles: ["default", "system-admin"],
        jti: randomUUID(), iat: nowSec(), nbf: nowSec() - 1, exp: nowSec() + 300, ...over,
      },
    });
  const userToken = () => mint({ scope: "openid claw.api" });
  const connectorToken = () => mint({ scope: "claw.connector", sub: "u1", name: "Connector", roles: ["system-admin"] });

  async function call(method: string, path: string, token: string): Promise<{ status: number; body: any }> {
    const r = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${token}` } });
    return { status: r.status, body: await r.json().catch(() => null) };
  }

  before(async () => {
    process.env.CLAW_REMOTE_AGENTS_ENABLED = "true";
    fake = await FakeIdentity.start();
    fake.jwks = () => ({ body: { keys: [es.jwk] } });
    Object.assign(process.env, {
      // Never called: no request here carries a credential SaFE could judge.
      SAFE_API_URL: "http://127.0.0.1:9", AUTH_INTERNAL_TOKEN: "t",
      IDENTITY_CLIENT_ENABLED: "true", IDENTITY_ISSUER_URL: fake.issuer, IDENTITY_CLIENT_ID: "svc-claw", IDENTITY_CLIENT_SECRET: "s3cret",
      CLAW_IDENTITY_TOKEN_AUTH_ENABLED: "true",
    });
    delete process.env.CLAW_DEPLOY_MODE;
    delete process.env.CLAW_IDENTITY_TOKEN_INTROSPECT;
    delete process.env.CLAW_CONNECTOR_TOKEN_INTROSPECT;
    const { CLAW_REMOTE_AGENTS_ENABLED } = await import("../src/config.js");
    assert.equal(CLAW_REMOTE_AGENTS_ENABLED, true, "remote agents are on in this process");
    const { startIdentityClient } = await import("../src/auth/identity.js");
    startIdentityClient({ info() {}, warn() {}, error() {} });
    const { authMiddleware, getUser } = await import("../src/auth/middleware.js");
    const { getAuthMethod } = await import("../src/auth/request-credential.js");

    app = Fastify();
    await app.register((await import("@fastify/cookie")).default);
    app.addHook("preHandler", authMiddleware);
    const who = async (req: any) => ({ user: getUser(req), method: getAuthMethod(req) });
    app.get("/v1/whoami", who);
    // One route of the connector side's table (connector-routes.ts), and a user-side route beside it.
    app.post("/v1/remote-agents/connectors", who);
    app.get("/v1/remote-agents/connectors", who);
    await app.listen({ port: 0, host: "127.0.0.1" });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });
  after(async () => {
    await app?.close();
    await fake?.close();
  });

  test("a connector's token on the connector side is the connector path's: the `default` role, whatever the token says", async () => {
    const r = await call("POST", "/v1/remote-agents/connectors", connectorToken());
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.method, "connector_token");
    assert.deepEqual(r.body.user, { userId: "u1", userName: "Connector", roles: ["default"], platformKey: "", virtualKey: "" });
  });

  test("a user's token on the connector side is refused for its scope by the connector path, never taken as a connector", async () => {
    const r = await call("POST", "/v1/remote-agents/connectors", userToken());
    assert.equal(r.status, 403);
    assert.equal(r.body.error, "insufficient_scope");
    assert.match(r.body.message, /claw\.connector/);
  });

  test("a user's token on any other route is the token path's: its subject and roles, and the method it is recorded under", async () => {
    for (const path of ["/v1/whoami", "/v1/remote-agents/connectors"]) {
      const r = await call("GET", path, userToken());
      assert.equal(r.status, 200, `${path}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.method, "identity_token");
      assert.deepEqual(r.body.user, { userId: "web-user", userName: "Web User", roles: ["default", "system-admin"], platformKey: "", virtualKey: "" });
    }
  });

  test("a connector's token on any other route is refused for its scope (the token path judges it), never taken as a user's", async () => {
    for (const path of ["/v1/whoami", "/v1/remote-agents/connectors"]) {
      const r = await call("GET", path, connectorToken());
      assert.equal(r.status, 403, `${path}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.error, "insufficient_scope");
      assert.match(r.body.message, /claw\.api/);
    }
  });
});
