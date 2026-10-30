// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The MCP tool that lists models asks SaFE with the caller's own `Authorization` header. For a caller authenticated by
 * an identity provider's access token that header is the token, which is good for this API's audience: SaFE must be
 * sent the person's platform key instead, and never the token. Through the real middleware and the real `/mcp` route,
 * with a stand-in provider and a SaFE on a socket that records what it is sent.
 *
 *   MM1  an identity-token caller: SaFE's models endpoint gets the platform key, and nothing SaFE sees carries the token
 *   MM2  an identity-token caller SaFE has no keys for: SaFE's models endpoint gets no Authorization at all
 *   MM3  an `ak-` key caller: the header it sent is the one SaFE gets, as before
 */
import test, { after, before, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import Fastify, { type FastifyInstance } from "fastify";

import { FakeIdentity, activeAnswer, answerDelegation, signJwt, testKey } from "../../utils/test/identity-fake.js";
import { sendJson, startFakeUpstream, type FakeUpstream } from "./support/fake-upstream.js";

const nowSec = () => Math.floor(Date.now() / 1000);
const payloadOf = (token: string) => JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8") || "{}");
const es = testKey("ES256", "k-es");
const log = { info() {}, warn() {}, error() {} };
const INTERNAL = "t";
const CLAW = "svc-claw";

describe("the models tool and an identity token", () => {
  let fake: FakeIdentity;
  let safe: FakeUpstream;
  let app: FastifyInstance;
  let base = "";
  let hasKeys = true;
  let startIdentityClient: typeof import("../src/auth/identity.js").startIdentityClient;

  const modelsCalls = () => safe.seen.filter((r) => r.url.startsWith("/playground/models"));
  function mint(over: Record<string, unknown> = {}): string {
    return signJwt({
      key: es,
      claims: {
        iss: fake.issuer, aud: "claw-api", sub: "web-user", client_id: "claw-web", gid: "g", scope: "openid claw.api",
        name: "Web User", jti: randomUUID(), iat: nowSec(), nbf: nowSec() - 1, exp: nowSec() + 300, ...over,
      },
    });
  }
  function identity(): void {
    for (const k of ["IDENTITY_CLIENT_ENABLED", "IDENTITY_ISSUER_URL", "IDENTITY_CLIENT_ID", "IDENTITY_CLIENT_SECRET"]) delete process.env[k];
    Object.assign(process.env, {
      IDENTITY_CLIENT_ENABLED: "true", IDENTITY_ISSUER_URL: fake.issuer, IDENTITY_CLIENT_ID: CLAW, IDENTITY_CLIENT_SECRET: "s3cret",
      IDENTITY_INTROSPECTION_CACHE_SECONDS: "0", IDENTITY_INTROSPECTION_NEGATIVE_CACHE_SECONDS: "0", IDENTITY_STALE_IF_ERROR_SECONDS: "0",
      CLAW_IDENTITY_TOKEN_AUTH_ENABLED: "true",
    });
    startIdentityClient(log);
  }

  /** `tools/call claw_list_models` over the stateless streamable HTTP transport; the answer is JSON or one SSE event. */
  async function listModels(headers: Record<string, string>): Promise<{ status: number; result: any }> {
    const r = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "claw_list_models", arguments: {} } }),
    });
    const text = await r.text();
    const data = /^data: (.*)$/m.exec(text)?.[1] ?? text;
    let json: any = null; try { json = JSON.parse(data); } catch { /* not JSON: the status says */ }
    return { status: r.status, result: json?.result };
  }

  before(async () => {
    fake = await FakeIdentity.start();
    fake.jwks = () => ({ body: { keys: [es.jwk] } });
    fake.introspect = (r) => ({ body: activeAnswer({ sub: payloadOf(r.form.get("token") ?? "").sub }) });
    answerDelegation(fake, es, { clientId: CLAW });
    safe = await startFakeUpstream((req, res) => {
      const path = req.url.split("?")[0];
      if (req.method === "POST" && path === "/api/v1/auth/verify") {
        const q = JSON.parse(req.body) as { apiKey?: string; authorization?: string };
        if (q.apiKey === "ak-direct") return sendJson(res, 200, { data: { id: "direct-user", name: "Direct", roles: ["default"], platformKey: "ak-direct", virtualKey: "sk-direct" } });
        const claims = payloadOf((q.authorization ?? "").replace("Bearer ", ""));
        if (!hasKeys || claims.aud !== "primus-safe" || claims.act?.sub !== CLAW) return sendJson(res, 401, { message: "invalid token" });
        return sendJson(res, 200, { data: { id: claims.sub, name: "SaFE's name", roles: ["default"], platformKey: "ak-web-user-platform", virtualKey: "sk-web-user" } });
      }
      if (req.method === "GET" && path === "/playground/models") return sendJson(res, 200, { data: { items: [] } });
      return sendJson(res, 404, { message: "no such route" });
    });
    Object.assign(process.env, { SAFE_API_URL: safe.url, AUTH_INTERNAL_TOKEN: INTERNAL });
    delete process.env.CLAW_DEPLOY_MODE;
    ({ startIdentityClient } = await import("../src/auth/identity.js"));
    const { authMiddleware } = await import("../src/auth/middleware.js");
    const { registerMcpRoutes } = await import("../src/routes/mcp.js");
    app = Fastify();
    await app.register((await import("@fastify/cookie")).default);
    app.addHook("preHandler", authMiddleware);
    await registerMcpRoutes(app);
    await app.listen({ port: 0, host: "127.0.0.1" });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });
  after(async () => {
    await app?.close();
    await fake?.close();
    await safe?.close();
  });
  beforeEach(() => {
    hasKeys = true;
    safe.seen.length = 0;
    identity();
  });

  test("MM1 SaFE's models endpoint is sent the person's platform key, and nothing SaFE sees carries the token", async () => {
    const token = mint();
    const { status, result } = await listModels({ authorization: `Bearer ${token}` });
    assert.equal(status, 200);
    assert.ok(!result?.isError, JSON.stringify(result));
    const calls = modelsCalls();
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.headers.authorization, "Bearer ak-web-user-platform");
    for (const r of safe.seen) {
      assert.ok(!JSON.stringify(r.headers).includes(token) && !r.body.includes(token), `SaFE was shown the person's token in ${r.method} ${r.url}`);
    }
  });

  test("MM2 a person SaFE holds no keys for has nothing sent: no Authorization header at all, and never the token", async () => {
    hasKeys = false;
    const token = mint({ sub: "stranger" });
    const { status } = await listModels({ authorization: `Bearer ${token}` });
    assert.equal(status, 200);
    const calls = modelsCalls();
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.headers.authorization, undefined);
    for (const r of safe.seen) assert.ok(!JSON.stringify(r.headers).includes(token) && !r.body.includes(token));
  });

  test("MM3 an ak- key caller's own header is what SaFE gets, as before", async () => {
    const { status, result } = await listModels({ authorization: "Bearer ak-direct" });
    assert.equal(status, 200);
    assert.ok(!result?.isError, JSON.stringify(result));
    const calls = modelsCalls();
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.headers.authorization, "Bearer ak-direct");
  });
});
