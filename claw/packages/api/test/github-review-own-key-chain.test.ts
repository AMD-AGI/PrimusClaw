// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A session that acts as a user, started and driven by a service the way a chat integration does it, through the real authentication hook
 * (every credential path in its real order), the real session routes and a real PostgreSQL engine (PGlite): a service's delegated token
 * (`sub` the requester, `act` and `client_id` the service) with the requester's own `ak-` key beside it.
 *
 * The pieces are tested apart (identity-token-safe-keys.test.ts K7: what the token path does with the key; github-review-acting-turns.test.ts:
 * who may start a turn; github-review-acting-dispatch-keys.test.ts: what Brain is told). What none of them can show is that the two headers
 * of one request, judged in the order the hook judges them, give the service exactly what it is meant to have and nothing else:
 *
 *   O1  a key alone is not a person, whatever the settings: the key a sandbox holds cannot start such a session or send it a turn
 *   O2  a named service's token with the requester's own key creates the session and sends its turns, on the requester's keys
 *   O3  a key that is not the requester's is refused, and leaves nothing behind
 *   O4  without a key, or from a service that is not named for it, the token is judged as it always was: the key is not looked at
 *   O5  a key beside a plain person's token is not read at all
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test, { after, before, beforeEach } from "node:test";
import type { FastifyInstance } from "fastify";

import { FakeIdentity, activeAnswer, answerDelegation, signJwt, testKey } from "../../utils/test/identity-fake.js";

const SERVICE = "svc-chat";
const nowSec = () => Math.floor(Date.now() / 1000);
const es = testKey("ES256", "k-es");
const log = { info() {}, warn() {}, error() {} };

/** What SaFE holds: `ak-<name>` is that user's key. Only what authentication asks is answered. */
const USERS: Record<string, { platformKey: string; virtualKey: string }> = {
  "u-alice": { platformKey: "ak-alice", virtualKey: "vk-alice" },
  "u-bob": { platformKey: "ak-bob", virtualKey: "vk-bob" },
};
const KEY_OWNERS: Record<string, string> = { "ak-alice": "u-alice", "ak-bob": "u-bob" };
const verified: string[] = [];
const safe = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const q = JSON.parse(body || "{}") as { apiKey?: string; authorization?: string };
    const id = q.apiKey !== undefined
      ? KEY_OWNERS[q.apiKey]
      : (JSON.parse(Buffer.from((q.authorization ?? "").split(".")[1] ?? "", "base64url").toString("utf8") || "{}") as { sub?: string }).sub;
    if (q.apiKey !== undefined) verified.push(q.apiKey);
    const user = id ? USERS[id] : undefined;
    if (!user) { res.writeHead(401).end("{}"); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: { id, name: id, roles: ["default"], ...user } }));
  });
});
await new Promise<void>((r) => safe.listen(0, "127.0.0.1", r));

// Before anything reads the configuration, which is read when its module loads.
Object.assign(process.env, {
  CLAW_GITHUB_REVIEW_ENABLED: "true",
  CLAW_GITHUB_REVIEW_MCP_SECRET: "t".repeat(40),
  CLAW_GITHUB_REVIEW_MCP_URL: "http://api.internal.example:8200/v1/internal/github-review/mcp",
  CLAW_GITHUB_REVIEW_DECISION_CLIENT_IDS: `${SERVICE} svc-answers-only`,
  CLAW_IDENTITY_TOKEN_AUTH_ENABLED: "true",
  RUN_FAT_PREPARING_RECONCILE: "true",
  SAFE_API_URL: `http://127.0.0.1:${(safe.address() as AddressInfo).port}`,
  AUTH_INTERNAL_TOKEN: "internal-token-for-tests",
});
delete process.env.CLAW_DEPLOY_MODE;

type Mod<T> = T extends Promise<infer U> ? U : never;
let h: Mod<ReturnType<typeof import("./scenario-harness.js").startHarness>>;
let db: typeof import("../src/infra/db.js").db;
let fake: FakeIdentity;
let app: FastifyInstance;
let base = "";
let published: Record<string, unknown>[] = [];
let originalConnect: unknown;
let pristinePorts: Record<string, unknown> = {};

before(async () => {
  fake = await FakeIdentity.start();
  fake.jwks = () => ({ body: { keys: [es.jwk] } });
  fake.introspect = () => ({ body: activeAnswer({}) });
  answerDelegation(fake, es, { clientId: "svc-claw" });
  Object.assign(process.env, {
    IDENTITY_CLIENT_ENABLED: "true", IDENTITY_ISSUER_URL: fake.issuer, IDENTITY_CLIENT_ID: "svc-claw", IDENTITY_CLIENT_SECRET: "s3cret",
    IDENTITY_INTROSPECTION_CACHE_SECONDS: "0", IDENTITY_INTROSPECTION_NEGATIVE_CACHE_SECONDS: "0", IDENTITY_STALE_IF_ERROR_SECONDS: "0",
  });
  (await import("../src/auth/identity.js")).startIdentityClient(log);

  const harness = await import("./scenario-harness.js");
  h = await harness.startHarness();
  db = (await import("../src/infra/db.js")).db;
  const { sessionDispatchPorts } = await import("../src/sessions/dispatch.js");
  pristinePorts = { ...sessionDispatchPorts };
  originalConnect = db.pool.connect;
  db.pool.connect = (async () => ({ query: (text: string, params?: unknown[]) => db.query(text, params), release: () => {} })) as unknown as typeof db.pool.connect;
  const { closedDoorbellBarrier } = await import("./doorbell-barrier-stub.js");
  (globalThis as unknown as { __closed: unknown }).__closed = closedDoorbellBarrier;

  const Fastify = (await import("fastify")).default;
  const { authMiddleware } = await import("../src/auth/middleware.js");
  const { registerSessionRoutes } = await import("../src/routes/sessions.js");
  app = Fastify();
  await app.register((await import("@fastify/cookie")).default);
  app.addHook("preHandler", authMiddleware);
  await registerSessionRoutes(app);
  await app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  await h.reset();
  process.env.CLAW_IDENTITY_TOKEN_OWN_KEY_CLIENT_IDS = SERVICE;
  verified.length = 0;
  const { sessionDispatchPorts } = await import("../src/sessions/dispatch.js");
  Object.assign(sessionDispatchPorts, pristinePorts);
  published = [];
  sessionDispatchPorts.doorbellDispatch = (globalThis as unknown as { __closed: typeof sessionDispatchPorts.doorbellDispatch }).__closed;
  sessionDispatchPorts.publishSse = () => {};
  sessionDispatchPorts.publishTask = async (_subject: string, payload: string) => {
    published.push(JSON.parse(payload) as Record<string, unknown>);
    return published.length;
  };
});

after(async () => {
  const { sessionDispatchPorts } = await import("../src/sessions/dispatch.js");
  Object.assign(sessionDispatchPorts, pristinePorts);
  db.pool.connect = originalConnect as typeof db.pool.connect;
  await app?.close();
  await h?.close();
  await fake?.close();
  safe.closeAllConnections();
  await new Promise<void>((r) => safe.close(() => r()));
});

/** A token as the provider issues it: the requester's own sign-in, or (with `service`) what a service gets when it acts for them. */
function token(sub: string, service?: string): string {
  return signJwt({
    key: es,
    claims: {
      iss: fake.issuer, aud: "claw-api", sub, client_id: service ?? "claw-web", scope: "openid claw.api", name: sub, jti: randomUUID(),
      iat: nowSec(), nbf: nowSec() - 1, exp: nowSec() + 300, ...(service ? { act: { sub: service } } : {}),
    },
  });
}

type Res = { status: number; body: any };
async function post(headers: Record<string, string>, url: string, payload: unknown): Promise<Res> {
  const r = await fetch(`${base}${url}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(payload) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const bearer = (jwt: string) => ({ authorization: `Bearer ${jwt}` });
const sessions = async (): Promise<number> => Number((await h.sql("SELECT count(*)::int AS n FROM claw_sessions"))[0]?.n);
const START = { name: "review", config: { acting_as: "u-bob" }, message: { content: "review it" } };

test("O1 a key alone, in either header, cannot start such a session or send it a turn, with the setting on as it is here", async () => {
  for (const headers of [{ "x-api-key": "ak-alice" }, { authorization: "Bearer ak-alice" }]) {
    const r = await post(headers, "/v1/sessions", START);
    assert.deepEqual([r.status, r.body.error], [403, "interactive_sign_in_required"], JSON.stringify(headers));
  }
  assert.equal(await sessions(), 0);
  assert.equal(published.length, 0);
  // A session that is there, and a key sent to it: still the same refusal.
  const id = (await post({ ...bearer(token("u-alice", SERVICE)), "x-api-key": "ak-alice" }, "/v1/sessions", START)).body.data.session_id as string;
  await h.sql("UPDATE claw_sessions SET agent_status = 'idle', agent_gate_message_id = NULL WHERE session_id = $1", [id]);
  const before = published.length;
  const r = await post({ "x-api-key": "ak-alice" }, `/v1/sessions/${id}/messages`, { content: "approve it" });
  assert.deepEqual([r.status, r.body.error], [403, "interactive_sign_in_required"]);
  assert.equal(published.length, before);
});

test("O2 a named service's token with the requester's own key creates the session, and its turns run on the requester's keys, with none in the sandbox", async () => {
  const headers = { ...bearer(token("u-alice", SERVICE)), "x-api-key": "ak-alice" };
  const r = await post(headers, "/v1/sessions", START);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const id = r.body.data.session_id as string;
  const row = (await h.sql("SELECT user_id, config FROM claw_sessions WHERE session_id = $1", [id]))[0] as { user_id: string; config: Record<string, unknown> };
  assert.equal(row.user_id, "u-alice", "the requester owns it");
  assert.equal((row.config as { acting_as: string }).acting_as, "u-bob");
  assert.equal(published.length, 1);
  assert.deepEqual([published[0]?.platform_key, published[0]?.llm_api_key], ["ak-alice", "vk-alice"], "the turn runs on the requester's own keys");
  assert.equal(published[0]?.withhold_sandbox_keys, true, "and its sandbox holds none of them");
  assert.ok((published[0]?.mcp_servers as Record<string, unknown>)?.github_review, "with the review tools");

  await h.sql("UPDATE claw_sessions SET agent_status = 'idle', agent_gate_message_id = NULL WHERE session_id = $1", [id]);
  const next = await post(headers, `/v1/sessions/${id}/messages`, { content: "go on" });
  assert.equal(next.status, 200, JSON.stringify(next.body));
  assert.equal(published.length, 2);
  assert.deepEqual([published[1]?.platform_key, published[1]?.withhold_sandbox_keys], ["ak-alice", true]);
});

test("O3 a key that is not the requester's is a 401 key_subject_mismatch, and no session, row or turn is left; an unknown key is a 401 invalid_api_key", async () => {
  for (const [key, error] of [["ak-bob", "key_subject_mismatch"], ["ak-nobody", "invalid_api_key"], ["sk-not-a-key", "invalid_api_key"]] as const) {
    const r = await post({ ...bearer(token("u-alice", SERVICE)), "x-api-key": key }, "/v1/sessions", START);
    assert.deepEqual([r.status, r.body.error], [401, error], key);
  }
  assert.equal(await sessions(), 0);
  assert.equal(published.length, 0);
});

test("O4 without a key, or from a service that is not named for it, the token is judged as it always was and the key is not looked at", async () => {
  // A service that may answer for the user but was not named to bring a key (here: nobody is), with a key beside its token.
  process.env.CLAW_IDENTITY_TOKEN_OWN_KEY_CLIENT_IDS = "";
  for (const key of [{ "x-api-key": "ak-alice" }, {}]) {
    const r = await post({ ...bearer(token("u-alice", SERVICE)), ...key }, "/v1/sessions", { name: "review", config: { acting_as: "u-bob" } });
    assert.equal(r.status, 200, `the attended check is the service's own, and it passes: ${JSON.stringify(r.body)}`);
    const id = r.body.data.session_id as string;
    await h.sql("UPDATE claw_sessions SET agent_status = 'idle', agent_gate_message_id = NULL WHERE session_id = $1", [id]);
    const turn = await post({ ...bearer(token("u-alice", SERVICE)), ...key }, `/v1/sessions/${id}/messages`, { content: "review it" });
    assert.equal(turn.status, 200, JSON.stringify(turn.body));
  }
  assert.deepEqual(verified, [], "no key was ever shown to SaFE");
  assert.deepEqual(published.map((t) => [t.platform_key, t.llm_api_key]), [["", ""], ["", ""]], "the turns carry nobody's keys (Brain refuses to open a sandbox for them)");
});

test("O5 a key beside a plain person's token is not read, and a service that only answers confirmations is not given the requester's keys", async () => {
  const own = await post({ ...bearer(token("u-alice")), "x-api-key": "ak-bob" }, "/v1/sessions", { name: "plain", config: {}, message: { content: "hello" } });
  assert.equal(own.status, 200, JSON.stringify(own.body));
  assert.deepEqual([published[0]?.platform_key, published[0]?.llm_api_key], ["ak-alice", "vk-alice"], "Alice's keys by delegation, never the key that rode along");
  assert.ok(!("withhold_sandbox_keys" in published[0]!), "an ordinary session");
  const answersOnly = await post({ ...bearer(token("u-alice", "svc-answers-only")), "x-api-key": "ak-alice" }, "/v1/sessions", { name: "plain", config: {}, message: { content: "hello" } });
  assert.equal(answersOnly.status, 200, JSON.stringify(answersOnly.body));
  assert.deepEqual([published[1]?.platform_key, published[1]?.llm_api_key], ["", ""], "the key was not read: this service has no keys of the requester's to run a turn on");
  assert.deepEqual(verified, [], "SaFE was asked about no key");
});
