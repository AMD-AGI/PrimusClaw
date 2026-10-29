// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A connector's access token (RFC 9068 JWT) on the connector side of remote
 * agents, over real HTTP: the real authentication hook, the real routes, a real
 * Postgres, a stand-in identity provider on a socket (the identity client's own
 * fake, so discovery, the key set and introspection travel the real client) and
 * a stand-in SaFE for the credentials the API already accepted.
 *
 * What a token must never do is as much the subject as what it may: each way a
 * token can be wrong is refused for its own reason, and the refusal leaves no
 * row behind. Skipped without DATABASE_URL, and a skip is not a pass.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import test, { after, before, beforeEach, describe } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startAdmissionCluster, type AdmissionCluster } from "./support/admission-cluster.js";
import { SseClient } from "./support/sse-client.js";
import { FakeIdentity, activeAnswer, signJwt, testKey, type TestKey } from "../../utils/test/identity-fake.js";

const skip = postgresSkipReason();
const AGENT = { agent_id: "a1", kind: "example-kind", name: "Agent One", capabilities: {} };
const NO_CONNECTOR = "00000000-0000-4000-8000-000000000000";
const nowSec = () => Math.floor(Date.now() / 1000);
const payloadOf = (token: string) => JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"));

/** SaFE as far as the API uses it: `ak-<id>` and a `Token=ck-<id>` cookie verify to user `<id>` (u1 and u2 exist). */
async function startSafe(): Promise<{ url: string; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const q = JSON.parse(body || "{}") as { apiKey?: string; cookie?: string };
      const id = q.apiKey?.startsWith("ak-") ? q.apiKey.slice(3) : /Token=ck-([^;]+)/.exec(q.cookie ?? "")?.[1];
      if (!id || !["u1", "u2"].includes(id)) { res.writeHead(401).end("{}"); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: { id, name: `User ${id}`, roles: ["default"], platformKey: "", virtualKey: "" } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: async () => { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); },
  };
}

describe("connector access tokens", { skip }, () => {
  let h: AdmissionCluster;
  let safe: Awaited<ReturnType<typeof startSafe>>;
  let fake: FakeIdentity;
  let app: FastifyInstance;
  let base = "";
  let startIdentityClient: typeof import("../src/auth/identity.js").startIdentityClient;
  const es = testKey("ES256", "k1");
  const rs = testKey("RS256", "k-rsa");
  /** Grants the provider no longer considers active, by token id; `down` makes it unreachable. */
  const revoked = new Set<string>();
  let providerDown = false;
  let streams: SseClient[] = [];
  const q = (text: string, params: unknown[] = []) => h.app.db.db.query(text, params);

  const defaultIntrospect = (r: { form: URLSearchParams }) => {
    if (providerDown) return { status: 503, body: "down" };
    const claims = payloadOf(r.form.get("token") ?? "");
    return revoked.has(claims.jti) ? { body: { active: false } } : { body: activeAnswer({ sub: claims.sub }) };
  };
  const IDENTITY_ENV = () => ({
    IDENTITY_CLIENT_ENABLED: "true", IDENTITY_ISSUER_URL: fake.issuer, IDENTITY_CLIENT_ID: "svc-claw",
    IDENTITY_CLIENT_SECRET: "s3cret", IDENTITY_INTROSPECTION_CACHE_SECONDS: "0",
    IDENTITY_INTROSPECTION_NEGATIVE_CACHE_SECONDS: "0", IDENTITY_STALE_IF_ERROR_SECONDS: "0",
  });
  const log = { info() {}, warn() {}, error() {} };
  /** Build the process's identity client against the stand-in provider (fresh caches), or switch it off. */
  function identity(on: boolean): void {
    for (const k of Object.keys(IDENTITY_ENV())) delete process.env[k];
    if (on) Object.assign(process.env, IDENTITY_ENV());
    startIdentityClient(log);
  }

  function mint(over: Record<string, unknown> = {}, opts: { key?: TestKey; header?: Record<string, unknown>; signWith?: "RS256" | "ES256" } = {}): string {
    const claims: Record<string, unknown> = {
      iss: fake.issuer, aud: "claw-api", sub: "u1", scope: "claw.connector", client_id: "claw-connector",
      jti: randomUUID(), iat: nowSec(), nbf: nowSec() - 1, exp: nowSec() + 300, ...over,
    };
    for (const k of Object.keys(claims)) if (claims[k] === undefined) delete claims[k];
    return signJwt({ key: opts.key ?? es, claims, header: opts.header, signWith: opts.signWith });
  }

  before(async () => {
    safe = await startSafe();
    fake = await FakeIdentity.start();
    fake.jwks = () => ({ body: { keys: [es.jwk, rs.jwk] } });
    fake.introspect = defaultIntrospect;
    h = await startAdmissionCluster({ SAFE_API_URL: safe.url, AUTH_INTERNAL_TOKEN: "t", CLAW_REMOTE_AGENTS_ENABLED: "true" });
    ({ startIdentityClient } = await import("../src/auth/identity.js"));
    const { authMiddleware } = await import("../src/auth/middleware.js");
    const { registerRemoteAgentRoutes } = await import("../src/routes/remote-agents.js");
    app = Fastify();
    await app.register((await import("@fastify/cookie")).default);
    app.addHook("preHandler", authMiddleware);
    await registerRemoteAgentRoutes(app, { pingMs: 150, pollMs: 40 });
    await app.listen({ port: 0, host: "127.0.0.1" });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });
  after(async () => {
    for (const s of streams) await s.closed();
    await new Promise((r) => setTimeout(r, 100));
    await app?.close();
    await h?.stop();
    await fake?.close();
    await safe?.close();
  });
  beforeEach(async () => {
    identity(true);
    delete process.env.CLAW_CONNECTOR_TOKEN_INTROSPECT;
    delete process.env.CLAW_CONNECTOR_TOKEN_AUDIENCE;
    revoked.clear();
    providerDown = false;
    fake.requests.length = 0;
    for (const s of streams) await s.closed();
    streams = [];
    await q("DELETE FROM claw_remote_audit");
    await q("DELETE FROM claw_remote_connectors");
  });

  type Res = { status: number; body: any };
  async function call(method: string, path: string, auth: Record<string, string>, body?: unknown): Promise<Res> {
    const r = await fetch(base + path, {
      method,
      headers: { ...auth, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  }
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  const key = (user: string) => ({ authorization: `Bearer ak-${user}` });
  const asToken = (token: string) => ({
    post: (p: string, b: unknown = {}) => call("POST", p, bearer(token), b),
    get: (p: string) => call("GET", p, bearer(token)),
  });
  const asKey = (user: string) => ({
    post: (p: string, b: unknown = {}) => call("POST", p, key(user), b),
    get: (p: string) => call("GET", p, key(user)),
  });
  const connectorCount = async () => Number((await q("SELECT COUNT(*) AS n FROM claw_remote_connectors")).rows[0].n);

  async function register(token: string, name = "laptop"): Promise<string> {
    const r = await asToken(token).post("/v1/remote-agents/connectors", { name });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.data.connector_id;
  }

  // ------------------------------------------------------------------ accepted

  describe("a valid token", () => {
    test("registers a connector for its subject, and the connector is that user's alone", async () => {
      const cid = await register(mint({ sub: "u1" }));
      const mine = (await asKey("u1").get("/v1/remote-agents/connectors")).body.data;
      assert.deepEqual(mine.map((c: any) => c.connector_id), [cid]);
      assert.deepEqual((await asKey("u2").get("/v1/remote-agents/connectors")).body.data, []);
      const row = (await q("SELECT owner_user_id FROM claw_remote_connectors WHERE connector_id = $1", [cid])).rows[0];
      assert.equal(row.owner_user_id, "u1");
    });

    test("reaches every connector-side route, and the stream opens with its ready frame", async () => {
      const token = mint();
      const cid = await register(token);
      const t = asToken(token);
      assert.equal((await t.post(`/v1/remote-agents/connectors/${cid}/heartbeat`, { agents: [AGENT] })).status, 200);
      assert.equal((await t.post(`/v1/remote-agents/connectors/${cid}/events`, { batch_id: "b1", events: [] })).status, 200);
      const stream = await SseClient.open(`${base}/v1/remote-agents/connectors/${cid}/commands`, bearer(token));
      streams.push(stream);
      assert.equal(stream.status, 200);
      assert.equal((await stream.nextEvent("ready")).json().connector_id, cid);
    });

    test("either signature algorithm the provider uses verifies", async () => {
      for (const k of [es, rs]) {
        const r = await asToken(mint({}, { key: k })).post("/v1/remote-agents/connectors", { name: `via-${k.alg}` });
        assert.equal(r.status, 201, `${k.alg}: ${JSON.stringify(r.body)}`);
      }
    });

    test("the scope may be one member of several, or an array; the audience may be one of several", async () => {
      for (const over of [{ scope: "openid claw.connector profile" }, { scope: ["x", "claw.connector"] }, { aud: ["other", "claw-api"] }]) {
        const r = await asToken(mint(over)).post("/v1/remote-agents/connectors", { name: "ok" });
        assert.equal(r.status, 201, `${JSON.stringify(over)}: ${JSON.stringify(r.body)}`);
      }
    });

    test("the caller has no roles beyond default, whatever the token says, so no administrator path opens", async () => {
      const { verifyConnectorToken } = await import("../src/auth/connector-token.js");
      const token = mint({ roles: ["system-admin"], groups: ["system-admin"], name: "Ada", email: "ada@example.com" });
      const req = { method: "POST", headers: { authorization: `Bearer ${token}` } } as any;
      const out = await verifyConnectorToken(req, "/v1/remote-agents/connectors");
      assert.equal(out.status, "verified");
      if (out.status !== "verified") return;
      assert.deepEqual(out.user, { userId: "u1", userName: "Ada", roles: ["default"], platformKey: "", virtualKey: "" });
      assert.equal(out.method, "connector_token");
    });

    test("the audit trail names the credential on the connector side, and only says what is known", async () => {
      const token = mint();
      const cid = await register(token);
      const viaKey = (await asKey("u1").post("/v1/remote-agents/connectors", { name: "other" })).body.data.connector_id;
      await asToken(token).post(`/v1/remote-agents/connectors/${cid}/heartbeat`, { agents: [AGENT] });
      const stream = await SseClient.open(`${base}/v1/remote-agents/connectors/${cid}/commands`, bearer(token));
      streams.push(stream);
      await stream.nextEvent("ready");
      const made = await asKey("u1").post("/v1/remote-agents/sessions", { connector_id: cid, agent_id: "a1", cwd: "/work/repo" });
      assert.equal(made.status, 201, JSON.stringify(made.body));
      const sid = made.body.data.session_id;
      const ev = (seq: number, type: string, data: Record<string, unknown>) => ({ session_id: sid, seq, type, ts: Date.now(), data });
      const posted = await asToken(token).post(`/v1/remote-agents/connectors/${cid}/events`, {
        batch_id: "b1",
        events: [
          ev(1, "permissionRequest", { actionId: "act-1", tool: "write", kind: "edit", options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] }),
          ev(2, "permission_resolved", { actionId: "act-1", optionId: "allow", by: "u1" }),
        ],
      });
      assert.equal(posted.status, 200, JSON.stringify(posted.body));
      const audit = (await asKey("u1").get("/v1/remote-agents/audit")).body.data as any[];
      const of = (action: string, connector: string) => audit.find((a) => a.action === action && a.connector_id === connector);
      assert.equal(of("connector.registered", cid).detail.credential, "connector_token");
      assert.equal(of("connector.registered", viaKey).detail.credential, "api_key");
      assert.equal(of("permission.requested", cid).detail.credential, "connector_token");
      assert.equal(of("permission.resolved", cid).detail.credential, "connector_token");
      // User-side rows are not about the connector's credential.
      assert.equal("credential" in of("session.created", cid).detail, false);
    });
  });

  describe("the audit detail", () => {
    test("says nothing about the credential when the request was not authenticated by one", async () => {
      const store = await import("../src/remote-agents/store.js");
      const row = await store.registerConnector("u1", "dev-box", null, null, 5);
      const audit = (await q("SELECT detail FROM claw_remote_audit WHERE connector_id = $1", [row!.connector_id])).rows;
      assert.deepEqual(audit.map((r: any) => r.detail), [{ name: "dev-box" }]);
    });
  });

  // ------------------------------------------------------------------ refused

  describe("a token that is wrong is refused for its own reason, and creates nothing", () => {
    const wrongKey = testKey("ES256", "k1", true);
    const cases: Array<[string, () => string, number, string, string]> = [
      ["another audience", () => mint({ aud: "someone-else" }), 401, "invalid_token", "audience_mismatch"],
      ["no audience", () => mint({ aud: undefined }), 401, "invalid_token", "audience_mismatch"],
      ["another issuer", () => mint({ iss: "https://elsewhere.example.com" }), 401, "invalid_token", "issuer_mismatch"],
      ["expired", () => mint({ exp: nowSec() - 400, nbf: nowSec() - 800 }), 401, "invalid_token", "expired"],
      ["no expiry", () => mint({ exp: undefined }), 401, "invalid_token", "missing_claim"],
      ["not yet valid", () => mint({ nbf: nowSec() + 300 }), 401, "invalid_token", "not_yet_valid"],
      ["typ JWT, not at+jwt", () => mint({}, { header: { typ: "JWT" } }), 401, "invalid_token", "typ_mismatch"],
      ["no typ", () => mint({}, { header: { typ: undefined } }), 401, "invalid_token", "typ_mismatch"],
      ["alg none", () => mint({}, { header: { alg: "none" } }), 401, "invalid_token", "alg_not_allowed"],
      ["alg HS256", () => mint({}, { header: { alg: "HS256" } }), 401, "invalid_token", "alg_not_allowed"],
      ["a key the issuer does not publish", () => mint({}, { key: testKey("ES256", "k-retired", true) }), 401, "invalid_token", "unknown_key"],
      ["a different key under a published kid", () => mint({}, { key: wrongKey }), 401, "invalid_token", "bad_signature"],
      ["a tampered payload", () => {
        const [h, , s] = mint().split(".");
        return `${h}.${Buffer.from(JSON.stringify({ iss: fake.issuer, aud: "claw-api", sub: "admin", scope: "claw.connector", exp: nowSec() + 300 })).toString("base64url")}.${s}`;
      }, 401, "invalid_token", "bad_signature"],
      ["not a token at all", () => "aaaa.bbbb.cccc", 401, "invalid_token", "malformed"],
      ["no scope", () => mint({ scope: undefined }), 403, "insufficient_scope", "claw.connector"],
      ["another scope", () => mint({ scope: "claw.read" }), 403, "insufficient_scope", "claw.connector"],
      ["a scope that only contains the name", () => mint({ scope: "claw.connector.admin xclaw.connector" }), 403, "insufficient_scope", "claw.connector"],
      ["no subject", () => mint({ sub: undefined }), 401, "invalid_token", "subject"],
      ["an empty subject", () => mint({ sub: "  " }), 401, "invalid_token", "subject"],
      ["a subject that is not a string", () => mint({ sub: 7 }), 401, "invalid_token", "subject"],
      ["an enormous subject", () => mint({ sub: "u".repeat(129) }), 401, "invalid_token", "subject"],
    ];
    for (const [name, token, status, error, why] of cases) {
      test(name, async () => {
        const r = await asToken(token()).post("/v1/remote-agents/connectors", { name: "laptop" });
        assert.deepEqual([r.status, r.body?.error], [status, error], JSON.stringify(r.body));
        assert.match(r.body.message, new RegExp(why), JSON.stringify(r.body));
        assert.equal(await connectorCount(), 0);
        assert.equal(Number((await q("SELECT COUNT(*) AS n FROM claw_remote_audit")).rows[0].n), 0);
      });
    }

    test("a token that fails is not rescued by another credential on the same request", async () => {
      const r = await call("POST", "/v1/remote-agents/connectors", { ...bearer(mint({ aud: "someone-else" })), "x-api-key": "ak-u1" }, { name: "laptop" });
      assert.equal(r.status, 401);
      assert.equal(r.body.error, "invalid_token");
      const c = await call("POST", "/v1/remote-agents/connectors", { ...bearer(mint({ aud: "someone-else" })), cookie: "Token=ck-u1" }, { name: "laptop" });
      assert.equal(c.status, 401);
      assert.equal(await connectorCount(), 0);
    });

    test("the audience is the configured one", async () => {
      process.env.CLAW_CONNECTOR_TOKEN_AUDIENCE = "claw-elsewhere";
      assert.equal((await asToken(mint()).post("/v1/remote-agents/connectors", { name: "a" })).status, 401);
      assert.equal((await asToken(mint({ aud: "claw-elsewhere" })).post("/v1/remote-agents/connectors", { name: "a" })).status, 201);
    });

    test("a published key is honoured, a retired one is not, once the client has read the issuer's set", async () => {
      const retired = testKey("ES256", "k-old", true);
      const current = testKey("ES256", "k-new", true);
      fake.jwks = () => ({ body: { keys: [retired.jwk, current.jwk] } });
      identity(true);
      assert.equal((await asToken(mint({}, { key: retired })).post("/v1/remote-agents/connectors", { name: "a" })).status, 201);
      assert.equal((await asToken(mint({}, { key: current })).post("/v1/remote-agents/connectors", { name: "b" })).status, 201);
      fake.jwks = () => ({ body: { keys: [current.jwk] } });
      identity(true);
      const r = await asToken(mint({}, { key: retired })).post("/v1/remote-agents/connectors", { name: "c" });
      assert.deepEqual([r.status, r.body.error], [401, "invalid_token"]);
      assert.match(r.body.message, /unknown_key/);
      assert.equal((await asToken(mint({}, { key: current })).post("/v1/remote-agents/connectors", { name: "d" })).status, 201);
      fake.jwks = () => ({ body: { keys: [es.jwk, rs.jwk] } });
    });

    test("a provider that cannot be reached is a 503, not a verdict on the token", async () => {
      const down = await FakeIdentity.start();
      down.jwks = () => ({ status: 500, body: "boom" });
      Object.assign(process.env, IDENTITY_ENV(), { IDENTITY_ISSUER_URL: down.issuer });
      startIdentityClient(log);
      try {
        const token = signJwt({ key: es, claims: { iss: down.issuer, aud: "claw-api", sub: "u1", scope: "claw.connector", exp: nowSec() + 300 } });
        const r = await asToken(token).post("/v1/remote-agents/connectors", { name: "laptop" });
        assert.deepEqual([r.status, r.body.error], [503, "authentication_service_unavailable"]);
        assert.equal(await connectorCount(), 0);
      } finally {
        await down.close();
      }
    });
  });

  // ------------------------------------------------------------------ ownership

  describe("ownership", () => {
    test("another user's token reaches nothing of a connector it does not own, exactly as a missing id", async () => {
      const cid = await register(mint({ sub: "u1" }));
      const intruder = asToken(mint({ sub: "u2" }));
      const probe = async (id: string) => [
        await intruder.post(`/v1/remote-agents/connectors/${id}/heartbeat`, { agents: [AGENT] }),
        await intruder.post(`/v1/remote-agents/connectors/${id}/events`, { batch_id: "b", events: [] }),
        await intruder.get(`/v1/remote-agents/connectors/${id}/commands`),
      ].map((r) => [r.status, r.body]);
      assert.deepEqual(await probe(cid), await probe(NO_CONNECTOR));
      assert.equal((await probe(cid))[0]![0], 404);
      // Nothing was changed on the owner's side.
      const row = (await q("SELECT heartbeat_at FROM claw_remote_connectors WHERE connector_id = $1", [cid])).rows[0];
      assert.equal(row.heartbeat_at, null);
    });
  });

  // ------------------------------------------------------------------ legacy credentials

  describe("the credentials the API already accepted", () => {
    test("still work on the connector side while tokens are on", async () => {
      assert.equal((await asKey("u1").post("/v1/remote-agents/connectors", { name: "a" })).status, 201);
      const viaHeader = await call("POST", "/v1/remote-agents/connectors", { "x-api-key": "ak-u1" }, { name: "b" });
      assert.equal(viaHeader.status, 201);
      const viaCookie = await call("POST", "/v1/remote-agents/connectors", { cookie: "Token=ck-u1" }, { name: "c" });
      assert.equal(viaCookie.status, 201);
      const rows = (await q("SELECT DISTINCT owner_user_id FROM claw_remote_connectors")).rows;
      assert.deepEqual(rows.map((r: any) => r.owner_user_id), ["u1"]);
      assert.equal((await call("POST", "/v1/remote-agents/connectors", { authorization: "Bearer ak-nope" }, { name: "d" })).status, 401);
    });

    test("with no identity client configured a token is just an unknown credential, and nothing is asked of the provider", async () => {
      identity(false);
      // The client that was just replaced may still be reading discovery and keys in the background.
      await new Promise((r) => setTimeout(r, 150));
      const before = fake.requests.length;
      const r = await asToken(mint()).post("/v1/remote-agents/connectors", { name: "laptop" });
      assert.deepEqual([r.status, r.body.error], [401, "authentication_required"]);
      assert.equal(fake.requests.length, before, "the provider was not asked anything");
      assert.equal(await connectorCount(), 0);
      assert.equal((await asKey("u1").post("/v1/remote-agents/connectors", { name: "a" })).status, 201);
    });
  });

  // ------------------------------------------------------------------ nothing else

  describe("on the user side", () => {
    test("a token authenticates nothing, and a refused request changes nothing", async () => {
      const token = mint();
      const cid = await register(token);
      const t = asToken(token);
      const refusals = [
        await t.get("/v1/remote-agents/connectors"),
        await call("DELETE", `/v1/remote-agents/connectors/${cid}`, bearer(token)),
        await t.post("/v1/remote-agents/sessions", { connector_id: cid, agent_id: "a1", cwd: "/work" }),
        await t.get("/v1/remote-agents/sessions"),
        await t.get("/v1/remote-agents/audit"),
      ];
      for (const r of refusals) assert.deepEqual([r.status, r.body.error], [401, "authentication_required"], JSON.stringify(r.body));
      const row = (await q("SELECT revoked_at FROM claw_remote_connectors WHERE connector_id = $1", [cid])).rows[0];
      assert.equal(row.revoked_at, null);
      assert.equal(Number((await q("SELECT COUNT(*) AS n FROM claw_remote_sessions")).rows[0].n), 0);
    });

    test("a route that merely looks like a connector route is not one", async () => {
      const token = mint();
      const cid = await register(token);
      for (const [method, path] of [
        ["GET", `/v1/remote-agents/connectors/${cid}/heartbeat`],
        ["POST", `/v1/remote-agents/connectors/${cid}/commands`],
        ["GET", `/v1/remote-agents/connectors/${cid}/events`],
        ["GET", "/v1/remote-agents/connectors"],
        ["POST", `/v1/remote-agents/connectors/${cid}`],
        ["HEAD", `/v1/remote-agents/connectors/${cid}/commands`],
        ["POST", `/v1/remote-agents/connectors/${cid}/heartbeat/`],
        ["POST", `/v1/remote-agents/connectors/${cid}/heartbeat/extra`],
      ] as const) {
        const r = await fetch(base + path, { method, headers: { ...bearer(token), "content-type": "application/json" }, body: method === "POST" ? "{}" : undefined });
        assert.ok([401, 404, 405].includes(r.status), `${method} ${path} -> ${r.status}`);
      }
    });
  });

  describe("the query string", () => {
    test("is not part of the route a token is judged on", async () => {
      const token = mint();
      const cid = await register(token);
      // `events` with an empty body is refused as a bad batch, which is after authentication.
      const onEvents = await call("POST", `/v1/remote-agents/connectors/${cid}/events?x=/sessions`, bearer(token), {});
      assert.deepEqual([onEvents.status, onEvents.body.error], [400, "invalid_batch_id"]);
      // And a connector route's name in the query does not turn a user-side route into one.
      const onSessions = await call("GET", `/v1/remote-agents/sessions?x=/connectors/${cid}/commands`, bearer(token));
      assert.deepEqual([onSessions.status, onSessions.body.error], [401, "authentication_required"]);
    });
  });

  // ------------------------------------------------------------------ revocation

  describe("a revoked grant", () => {
    test("is honoured until the token expires when the provider is not asked", async () => {
      const token = mint();
      const cid = await register(token);
      revoked.add(payloadOf(token).jti);
      assert.equal((await asToken(token).post(`/v1/remote-agents/connectors/${cid}/heartbeat`, { agents: [AGENT] })).status, 200);
      assert.equal(fake.count("/oauth/introspect"), 0);
    });

    test("stops at once when introspection is on, and the provider is asked as the service client", async () => {
      process.env.CLAW_CONNECTOR_TOKEN_INTROSPECT = "true";
      const token = mint();
      const cid = await register(token);
      assert.equal((await asToken(token).post(`/v1/remote-agents/connectors/${cid}/heartbeat`, { agents: [AGENT] })).status, 200);
      const asked = fake.last("/oauth/introspect");
      assert.equal(asked.form.get("token"), token);
      assert.equal(asked.form.get("token_type_hint"), "access_token");
      assert.match(String(asked.headers.authorization), /^Basic /);

      revoked.add(payloadOf(token).jti);
      const r = await asToken(token).post(`/v1/remote-agents/connectors/${cid}/heartbeat`, { agents: [AGENT] });
      assert.deepEqual([r.status, r.body.error], [401, "invalid_token"]);
      assert.match(r.body.message, /no longer active/);
    });

    test("an answer for another subject is no answer for this token", async () => {
      process.env.CLAW_CONNECTOR_TOKEN_INTROSPECT = "true";
      fake.introspect = () => ({ body: activeAnswer({ sub: "someone-else" }) });
      try {
        const r = await asToken(mint()).post("/v1/remote-agents/connectors", { name: "a" });
        assert.deepEqual([r.status, r.body.error], [401, "invalid_token"]);
      } finally {
        fake.introspect = defaultIntrospect;
      }
    });

    test("an expired token is refused locally without asking the provider", async () => {
      process.env.CLAW_CONNECTOR_TOKEN_INTROSPECT = "true";
      const r = await asToken(mint({ exp: nowSec() - 400, nbf: nowSec() - 800 })).post("/v1/remote-agents/connectors", { name: "a" });
      assert.equal(r.status, 401);
      assert.equal(fake.count("/oauth/introspect"), 0);
    });

    test("a provider that cannot be asked is a 503 rather than a yes", async () => {
      process.env.CLAW_CONNECTOR_TOKEN_INTROSPECT = "true";
      providerDown = true;
      const r = await asToken(mint()).post("/v1/remote-agents/connectors", { name: "a" });
      assert.deepEqual([r.status, r.body.error], [503, "authentication_service_unavailable"]);
      assert.equal(await connectorCount(), 0);
    });
  });

  // ------------------------------------------------------------------ the open stream

  describe("a command stream opened with a token", () => {
    test("ends with token_expired when the token does, and the connector can reconnect with a fresh one", async () => {
      const token = mint({ exp: nowSec() + 1 });
      const cid = await register(token);
      const stream = await SseClient.open(`${base}/v1/remote-agents/connectors/${cid}/commands`, bearer(token));
      streams.push(stream);
      await stream.nextEvent("ready");
      const frame = await stream.nextEvent("token_expired", 4000);
      assert.equal(frame.id, undefined, "carries no id, so it can never be a resume position");
      assert.equal(frame.json().connector_id, cid);
      await stream.waitEnded();
      // Not a revocation: the connector is still registered and may reconnect.
      const again = await SseClient.open(`${base}/v1/remote-agents/connectors/${cid}/commands`, bearer(mint()));
      streams.push(again);
      assert.equal(again.status, 200);
      await again.nextEvent("ready");
    });

    test("ends with revoked when the provider revokes the grant, within a ping, when introspection is on", async () => {
      process.env.CLAW_CONNECTOR_TOKEN_INTROSPECT = "true";
      const token = mint();
      const cid = await register(token);
      const stream = await SseClient.open(`${base}/v1/remote-agents/connectors/${cid}/commands`, bearer(token));
      streams.push(stream);
      await stream.nextEvent("ready");
      assert.equal(await stream.quiet(300, (f) => f.event === "revoked"), true);
      revoked.add(payloadOf(token).jti);
      assert.equal((await stream.nextEvent("revoked", 3000)).json().connector_id, cid);
      await stream.waitEnded();
    });

    test("is not cut by a provider that cannot be asked while it is running", async () => {
      process.env.CLAW_CONNECTOR_TOKEN_INTROSPECT = "true";
      const token = mint();
      const cid = await register(token);
      const stream = await SseClient.open(`${base}/v1/remote-agents/connectors/${cid}/commands`, bearer(token));
      streams.push(stream);
      await stream.nextEvent("ready");
      providerDown = true;
      assert.equal(await stream.quiet(600, (f) => f.event === "revoked" || f.event === "token_expired"), true);
      assert.equal(stream.ended, false);
    });

    test("a stream opened with a key has no end of its own", async () => {
      const cid = (await asKey("u1").post("/v1/remote-agents/connectors", { name: "a" })).body.data.connector_id;
      const stream = await SseClient.open(`${base}/v1/remote-agents/connectors/${cid}/commands`, key("u1"));
      streams.push(stream);
      await stream.nextEvent("ready");
      assert.equal(await stream.quiet(500, (f) => f.event === "token_expired" || f.event === "revoked"), true);
    });
  });

  // ------------------------------------------------------------------ abstaining

  describe("this path abstains, so the request is judged by the credentials it already had", () => {
    test("for anything that is not a token on a connector-side route, and asks the provider nothing", async () => {
      const { verifyConnectorToken } = await import("../src/auth/connector-token.js");
      const valid = mint();
      const table: Array<[string, string, string, string | undefined]> = [
        ["a token on a user-side route", "POST", "/v1/remote-agents/sessions", `Bearer ${valid}`],
        ["a token on another part of the API", "GET", "/v1/sessions", `Bearer ${valid}`],
        ["an api key", "POST", "/v1/remote-agents/connectors", "Bearer ak-u1"],
        ["a basic credential", "POST", "/v1/remote-agents/connectors", "Basic dTE6eA=="],
        ["no credential", "POST", "/v1/remote-agents/connectors", undefined],
        ["a lower-case scheme, which no path of the hook reads", "POST", "/v1/remote-agents/connectors", `bearer ${valid}`],
        ["a value with two segments", "POST", "/v1/remote-agents/connectors", "Bearer aaaa.bbbb"],
        ["a value with four segments", "POST", "/v1/remote-agents/connectors", "Bearer aa.bb.cc.dd"],
        ["a value with a character no segment has", "POST", "/v1/remote-agents/connectors", "Bearer aa.b+b.cc"],
      ];
      await new Promise((r) => setTimeout(r, 150));
      const asked = fake.requests.length;
      for (const [name, method, path, authorization] of table) {
        const out = await verifyConnectorToken({ method, headers: authorization ? { authorization } : {} } as any, path);
        assert.deepEqual(out, { status: "absent" }, name);
      }
      assert.equal(fake.requests.length, asked, "the provider was not asked anything");
    });
  });

  // ------------------------------------------------------------------ defence in depth

  describe("the user side of remote agents refuses a connector principal on its own", () => {
    test("every user-side route says 403, and the connector-side routes are not among them", async () => {
      const { recordRequestCredential } = await import("../src/auth/request-credential.js");
      const { CONNECTOR_SIDE_ROUTES: connectorSide } = await import("../src/remote-agents/connector-routes.js");
      const { registerRemoteAgentRoutes } = await import("../src/routes/remote-agents.js");
      const routes: Array<{ method: string; url: string }> = [];
      const stub = Fastify();
      stub.addHook("onRoute", (route) => {
        for (const method of Array.isArray(route.method) ? route.method : [route.method]) routes.push({ method, url: route.url });
      });
      // Stands in for a hook that, by some change, had authenticated a connector token on any route at all.
      stub.addHook("preHandler", async (req) => {
        (req as any).user = { userId: "u1", userName: "u1", roles: ["default"], platformKey: "", virtualKey: "" };
        recordRequestCredential(req, "connector_token", Date.now() + 60_000);
      });
      await registerRemoteAgentRoutes(stub);
      await stub.ready();
      try {
        assert.ok(routes.length >= 12, `only ${routes.length} routes`);
        // The router also serves HEAD for a GET route, through the same handler.
        const userSide = routes.filter((r) => !Object.values(connectorSide).some(
          (c) => c.url === r.url && (c.method === r.method || (c.method === "GET" && r.method === "HEAD"))));
        assert.ok(userSide.length >= 9, `only ${userSide.length} user-side routes`);
        for (const { method, url } of userSide) {
          const res = await stub.inject({
            method: method as "GET", url: url.replace(/:([A-Za-z0-9_]+)/g, () => randomUUID()),
            ...(method === "POST" ? { payload: {} } : {}),
          });
          // A HEAD answer has no body to read; its status is the same refusal.
          const error = method === "HEAD" ? "connector_token_not_accepted" : res.json().error;
          assert.deepEqual([res.statusCode, error], [403, "connector_token_not_accepted"], `${method} ${url}`);
        }
        const reg = await stub.inject({ method: "POST", url: connectorSide.register.url, payload: { name: "laptop" } });
        assert.equal(reg.statusCode, 201, reg.body);
        // Nothing the refused routes were asked to do was done.
        assert.equal(Number((await q("SELECT COUNT(*) AS n FROM claw_remote_sessions")).rows[0].n), 0);
      } finally {
        await stub.close();
      }
    });
  });
});
