// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A session that acts as a named user, with GitHub review on:
 * `POST /v1/sessions` with `config.acting_as`, and the tools that the session's turn
 * is then offered, against the real routes and a real PostgreSQL engine (PGlite).
 *
 *   V  what the create route accepts and refuses, and what it records, and who may ask for it: a session that acts as a user is
 *      the person's say, so the key a sandbox holds (or the cookie that key signs in to) cannot start one
 *   T  the `mcp_servers` entry a turn carries: only for such a session, signed, reserved
 */
import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import type { FastifyInstance } from "fastify";

// Before anything reads the configuration, which is read when its module loads.
process.env.CLAW_GITHUB_REVIEW_ENABLED = "true";
process.env.CLAW_GITHUB_REVIEW_MCP_SECRET = "t".repeat(40);
process.env.CLAW_GITHUB_REVIEW_MCP_URL = "http://api.internal.example:8200/v1/internal/github-review/mcp";

type Mod<T> = T extends Promise<infer U> ? U : never;
let h: Mod<ReturnType<typeof import("./scenario-harness.js").startHarness>>;
let db: typeof import("../src/infra/db.js").db;
let published: Record<string, unknown>[] = [];
let originalConnect: unknown;
let pristinePorts: Record<string, unknown> = {};
type Caller = { userId: string; userName: string; delegation?: { actorSub?: string; clientId?: string } };
let appAs: (user: Caller, method?: string | null) => Promise<FastifyInstance>;
let verify: typeof import("../src/github-review/token.js").verifySessionToolToken;
let tools: typeof import("../src/github-review/session-tools.js");
let applyAppMcpToTask: typeof import("../src/sessions/app-mcp.js").applyAppMcpToTask;

const ALICE = { userId: "u-alice", userName: "Alice A" };

before(async () => {
  const harness = await import("./scenario-harness.js");
  h = await harness.startHarness();
  db = (await import("../src/infra/db.js")).db;
  const { sessionDispatchPorts } = await import("../src/sessions/dispatch.js");
  pristinePorts = { ...sessionDispatchPorts };
  originalConnect = db.pool.connect;
  db.pool.connect = (async () => ({ query: (text: string, params?: unknown[]) => db.query(text, params), release: () => {} })) as unknown as typeof db.pool.connect;
  const { closedDoorbellBarrier } = await import("./doorbell-barrier-stub.js");
  const Fastify = (await import("fastify")).default;
  const { registerSessionRoutes } = await import("../src/routes/sessions.js");
  // `method` is what the global authentication hook records beside the user (auth/request-credential.ts): an identity-provider token
  // unless a test says otherwise, and null for a credential the hook records no method for (a BYOK key, the development bypass).
  appAs = async (user, method = "identity_token") => {
    const app = Fastify();
    app.addHook("preHandler", async (req) => {
      (req as unknown as { user: unknown }).user = { ...user, roles: ["default"], platformKey: "pk", virtualKey: "vk" };
      if (method !== null) (req as unknown as { authMethod: string }).authMethod = method;
    });
    await registerSessionRoutes(app);
    await app.ready();
    return app;
  };
  verify = (await import("../src/github-review/token.js")).verifySessionToolToken;
  tools = await import("../src/github-review/session-tools.js");
  applyAppMcpToTask = (await import("../src/sessions/app-mcp.js")).applyAppMcpToTask;
  (globalThis as unknown as { __closed: unknown }).__closed = closedDoorbellBarrier;
});

beforeEach(async () => {
  await h.reset();
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
  await h?.close();
});

const create = async (user: Caller, config: Record<string, unknown>, extra: Record<string, unknown> = {}, method: string | null = "identity_token") => {
  const app = await appAs(user, method);
  try {
    const res = await app.inject({ method: "POST", url: "/v1/sessions", payload: { name: "review", config, ...extra } });
    return { status: res.statusCode, body: res.json() as any };
  } finally {
    await app.close();
  }
};
const stored = async (id: string) => (await h.sql("SELECT user_id, config FROM claw_sessions WHERE session_id = $1", [id]))[0] as { user_id: string; config: Record<string, unknown> };

test("V1 a session created with acting_as records the reference and the verified caller's name, and the requester is the owner", async () => {
  const r = await create(ALICE, { acting_as: "u-bob", notify_on_finish: true });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const row = await stored(r.body.data.session_id);
  assert.equal(row.user_id, "u-alice");
  assert.deepEqual(row.config, { acting_as: "u-bob", acting_as_requester: "Alice A", notify_on_finish: true });
});

test("V2 acting_as must be a plain user id; each malformed one is a 400 that leaves no session and no turn", async () => {
  for (const bad of ["", " u-bob", "u bob", "u-bob\n", "a".repeat(129), 7, ["u-bob"], { id: "u-bob" }, "../x", "u-bob;drop"]) {
    const r = await create(ALICE, { acting_as: bad }, { message: { content: "review it" } });
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.match(r.body.error, /^config\.acting_as/);
  }
  assert.equal(Number((await h.sql("SELECT count(*)::int AS n FROM claw_sessions"))[0]?.n), 0);
  assert.equal(published.length, 0);
});

test("V3 a client cannot set the requester's name: it is server-managed, with or without acting_as", async () => {
  for (const config of [{ acting_as: "u-bob", acting_as_requester: "Someone Else" }, { acting_as_requester: "Someone Else" }]) {
    const r = await create(ALICE, config);
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "config.acting_as_requester is server-managed");
  }
});

test("V4 a session without acting_as is exactly what it was: no extra key is stored", async () => {
  const r = await create(ALICE, { notify_on_finish: true });
  assert.equal(r.status, 200);
  assert.deepEqual((await stored(r.body.data.session_id)).config, { notify_on_finish: true });
  const n = await create(ALICE, { acting_as: null });
  assert.deepEqual((await stored(n.body.data.session_id)).config, { acting_as: null });
});

const count = async (): Promise<number> => Number((await h.sql("SELECT count(*)::int AS n FROM claw_sessions"))[0]?.n);

test("V5 the key a sandbox holds, the cookie that key signs in to and every other credential that is not an identity-provider token cannot create a session that acts as a user: 403, no row, no turn", async () => {
  // A model injected in any ordinary session of Alice holds her key and could otherwise start a session that acts as her (or as a colleague who
  // allowed her) and review and merge with the account on its own.
  for (const method of ["api_key", "x_api_key", "query_token", "connector_token", "cookie", "something_new", null]) {
    for (const actingAs of ["u-alice", "u-bob"]) {
      const r = await create(ALICE, { acting_as: actingAs }, { message: { content: "review it" } }, method);
      assert.equal(r.status, 403, `${method} acting as ${actingAs}`);
      assert.equal(r.body.error, "interactive_sign_in_required", `${method} acting as ${actingAs}`);
    }
  }
  assert.equal(await count(), 0);
  assert.equal(published.length, 0);
});

test("V6 an identity-provider token creates one: a person's own, and a service's only from a client the operator named", async () => {
  const saved = process.env.CLAW_GITHUB_REVIEW_DECISION_CLIENT_IDS;
  try {
    process.env.CLAW_GITHUB_REVIEW_DECISION_CLIENT_IDS = "clawy-worker";
    assert.equal((await create(ALICE, { acting_as: "u-alice" })).status, 200, "a person's own token, acting as themselves");
    assert.equal((await create({ ...ALICE, delegation: { clientId: "claw-web" } }, { acting_as: "u-bob" })).status, 200, "a token that names a client and no actor is the person's");
    const service = { ...ALICE, delegation: { actorSub: "clawy-worker", clientId: "clawy-worker" } };
    assert.equal((await create(service, { acting_as: "u-bob" })).status, 200, "an allowed service acting for Alice");
    const other = await create({ ...ALICE, delegation: { actorSub: "other-service", clientId: "other-service" } }, { acting_as: "u-bob" });
    assert.equal(other.status, 403);
    assert.equal(other.body.error, "service_client_not_allowed");
    process.env.CLAW_GITHUB_REVIEW_DECISION_CLIENT_IDS = "";
    assert.equal((await create(service, { acting_as: "u-bob" })).body.error, "service_client_not_allowed", "every service is refused while the list is empty");
    assert.equal(await count(), 3);
  } finally {
    if (saved === undefined) delete process.env.CLAW_GITHUB_REVIEW_DECISION_CLIENT_IDS; else process.env.CLAW_GITHUB_REVIEW_DECISION_CLIENT_IDS = saved;
  }
});

test("V7 a key is still the ordinary way to use the API: a session without acting_as is created with it, and with no method at all", async () => {
  for (const method of ["api_key", "x_api_key", "cookie", null]) assert.equal((await create(ALICE, { notify_on_finish: true }, {}, method)).status, 200, String(method));
  assert.equal(await count(), 4);
});

test("T1 the first turn of such a session carries the review tools: a signed token for this session, its owner and the acting user, and no GitHub credential", async () => {
  const r = await create(ALICE, { acting_as: "u-bob" }, { message: { content: "review it" } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(published.length, 1);
  const server = (published[0]?.mcp_servers as Record<string, Record<string, unknown>>).github_review as Record<string, unknown>;
  assert.equal(server.type, "http");
  assert.equal(server.url, "http://api.internal.example:8200/v1/internal/github-review/mcp");
  const v = verify(String(server.token), "t".repeat(40));
  assert.deepEqual(v, { ok: true, claims: { sessionId: r.body.data.session_id, requesterUserId: "u-alice", actorUserId: "u-bob" } });
  assert.doesNotMatch(JSON.stringify(published[0]), /gh[pousr]_[A-Za-z0-9]{20}/);
});

test("T2 a session without acting_as is offered no review tools, and a request's own mcp_servers are left alone", async () => {
  const r = await create(ALICE, { notify_on_finish: true }, { message: { content: "hello" } });
  assert.equal(r.status, 200);
  assert.equal("mcp_servers" in (published[0] ?? {}) && "github_review" in ((published[0]?.mcp_servers as object) ?? {}), false);
});

test("T3 the server name is reserved: what a task already names github_review is replaced, and others are kept", async () => {
  const r = await create(ALICE, { acting_as: "u-bob" });
  const task: Record<string, unknown> = { mcp_servers: { github_review: { type: "http", url: "http://evil.example/mcp", token: "x" }, other: { type: "http", url: "http://o.example/mcp", token: "y" } } };
  await applyAppMcpToTask(task, r.body.data.session_id);
  const servers = task.mcp_servers as Record<string, Record<string, unknown>>;
  assert.equal(servers.github_review?.url, "http://api.internal.example:8200/v1/internal/github-review/mcp");
  assert.equal(servers.other?.url, "http://o.example/mcp");
});

test("T4 no tools for a deleted session, a missing one, or when the secret is missing; a database failure is not a failed turn", async () => {
  const r = await create(ALICE, { acting_as: "u-bob" });
  const id = r.body.data.session_id as string;
  assert.deepEqual(Object.keys(await tools.githubReviewMcpServers(id)), ["github_review"]);
  assert.deepEqual(await tools.githubReviewMcpServers("no-such-session"), {});
  await h.sql("UPDATE claw_sessions SET deleted_at = NOW() WHERE session_id = $1", [id]);
  assert.deepEqual(await tools.githubReviewMcpServers(id), {});
  await h.sql("UPDATE claw_sessions SET deleted_at = NULL WHERE session_id = $1", [id]);
  const saved = process.env.CLAW_GITHUB_REVIEW_MCP_SECRET;
  process.env.CLAW_GITHUB_REVIEW_MCP_SECRET = "";
  try { assert.deepEqual(await tools.githubReviewMcpServers(id), {}); } finally { process.env.CLAW_GITHUB_REVIEW_MCP_SECRET = saved; }
  const query = db.query;
  db.query = (async () => { throw new Error("database down"); }) as typeof db.query;
  try { assert.deepEqual(await tools.githubReviewMcpServers(id), {}); } finally { db.query = query; }
});
