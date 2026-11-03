// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A session that acts as a named user, with GitHub review on:
 * `POST /v1/sessions` with `config.acting_as`, and the tools that the session's turn
 * is then offered, against the real routes and a real PostgreSQL engine (PGlite).
 *
 *   V  what the create route accepts and refuses, and what it records, and who may ask for it: a session that acts as a user is
 *      the person's say, so the key a sandbox holds (or the cookie that key signs in to) cannot start one
 *   T  the `mcp_servers` entry a turn carries: only for such a session, signed, reserved; and the `withhold_sandbox_keys` mark that keeps
 *      its owner's keys out of the sandbox (T6-T8; the other ways a turn reaches Brain are github-review-acting-dispatch-keys.test.ts)
 *   M  the model and the reasoning effort such a session reviews with: the review's, unless its creator named a model (M1-M2)
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

test("V8 config.review_target binds the session to one pull request: it is recorded as sent, and only a well-formed reference with acting_as is accepted", async () => {
  const target = { owner: "AMD-AGI", repo: "demo", number: 7 };
  const r = await create(ALICE, { acting_as: "u-bob", review_target: target });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual((await stored(r.body.data.session_id)).config, { acting_as: "u-bob", acting_as_requester: "Alice A", review_target: target });
  const bad: unknown[] = [
    "AMD-AGI/demo#7", 7, [], [target], { owner: "AMD-AGI", repo: "demo" }, { ...target, number: "7" }, { ...target, number: 0 }, { ...target, number: -1 }, { ...target, number: 1.5 },
    { ...target, number: 1e10 }, { ...target, owner: "a b" }, { ...target, owner: "../x" }, { ...target, owner: "" }, { ...target, repo: ".." }, { ...target, repo: "a/b" },
    { ...target, repo: "demo#8" }, { ...target, extra: "x" }, { ...target, pr: "AMD-AGI/other#1" },
  ];
  for (const review_target of bad) {
    const refused = await create(ALICE, { acting_as: "u-bob", review_target }, { message: { content: "review it" } });
    assert.equal(refused.status, 400, JSON.stringify(review_target));
    assert.match(refused.body.error, /^config\.review_target must be \{owner, repo, number\}/, JSON.stringify(review_target));
  }
  const alone = await create(ALICE, { review_target: target }, { message: { content: "review it" } });
  assert.equal(alone.status, 400);
  assert.equal(alone.body.error, "config.review_target needs config.acting_as");
  const nulled = await create(ALICE, { acting_as: "u-bob", review_target: null });
  assert.equal(nulled.status, 200, "null is no target, as it is for acting_as");
  assert.equal(await count(), 2, "only the two that were accepted left a session");
  assert.equal(published.length, 0);
});

test("V9 asking for a bound session needs the same credentials as any session that acts as a user", async () => {
  for (const method of ["api_key", "x_api_key", "cookie", null]) {
    const r = await create(ALICE, { acting_as: "u-bob", review_target: { owner: "AMD-AGI", repo: "demo", number: 7 } }, {}, method);
    assert.equal(r.status, 403, String(method));
    assert.equal(r.body.error, "interactive_sign_in_required", String(method));
  }
  assert.equal(await count(), 0);
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
    process.env.CLAW_GITHUB_REVIEW_DECISION_CLIENT_IDS = "chat-worker";
    assert.equal((await create(ALICE, { acting_as: "u-alice" })).status, 200, "a person's own token, acting as themselves");
    assert.equal((await create({ ...ALICE, delegation: { clientId: "claw-web" } }, { acting_as: "u-bob" })).status, 200, "a token that names a client and no actor is the person's");
    const service = { ...ALICE, delegation: { actorSub: "chat-worker", clientId: "chat-worker" } };
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

test("T5 a bound session is offered the tools, and one whose stored target cannot be read is offered none rather than the tools without the binding", async () => {
  const r = await create(ALICE, { acting_as: "u-bob", review_target: { owner: "AMD-AGI", repo: "demo", number: 7 } });
  const id = r.body.data.session_id as string;
  assert.deepEqual(Object.keys(await tools.githubReviewMcpServers(id)), ["github_review"]);
  for (const unreadable of [{ owner: "AMD-AGI" }, "AMD-AGI/demo#7", { owner: "AMD-AGI", repo: "demo", number: 0 }, []]) {
    await h.sql("UPDATE claw_sessions SET config = config || $2::jsonb WHERE session_id = $1", [id, JSON.stringify({ review_target: unreadable })]);
    assert.deepEqual(await tools.githubReviewMcpServers(id), {}, JSON.stringify(unreadable));
  }
});

test("T6 the first turn of a session that acts as a user is marked so that its sandbox holds none of its owner's keys, and any other turn is not", async () => {
  const acting = await create(ALICE, { acting_as: "u-bob" }, { message: { content: "review it" } });
  assert.equal(acting.status, 200, JSON.stringify(acting.body));
  assert.equal(published[0]?.withhold_sandbox_keys, true);
  assert.equal(published[0]?.platform_key, "pk", "Brain is still given the keys: it asks the model and SaFE with them");
  assert.equal(published[0]?.llm_api_key, "vk");
  const plain = await create(ALICE, { notify_on_finish: true }, { message: { content: "hello" } });
  assert.equal(plain.status, 200);
  assert.equal("withhold_sandbox_keys" in (published[1] ?? {}), false, "an ordinary session's turn is exactly what it was");
});

test("T7 the mark is read from the live row at the time the turn is built, as the tools are, and a row that cannot be read is not a turn with keys", async () => {
  const id = (await create(ALICE, { acting_as: "u-bob" })).body.data.session_id as string;
  const marked = async (sessionId: string): Promise<unknown> => {
    const task: Record<string, unknown> = {};
    await tools.applySandboxKeyPolicyToTask(task, sessionId);
    return task.withhold_sandbox_keys;
  };
  assert.equal(await marked(id), true);
  // The same reading of `acting_as` as the tools and the turn gate: only a well-formed id counts.
  for (const [config, expected] of [
    [{ acting_as: "u-bob" }, true], [{ acting_as: "has space" }, undefined], [{ acting_as: 7 }, undefined], [{ acting_as: null }, undefined], [{}, undefined],
  ] as const) {
    await h.sql("UPDATE claw_sessions SET config = $2::jsonb WHERE session_id = $1", [id, JSON.stringify(config)]);
    assert.equal(await marked(id), expected, JSON.stringify(config));
    assert.equal(tools.withholdsSandboxKeys(config), expected === true, JSON.stringify(config));
  }
  assert.equal(await marked("no-such-session"), undefined);
  // Unlike the tools, which a turn does not depend on, a failure to read is not swallowed: the turn is not built.
  const query = db.query;
  db.query = (async () => { throw new Error("database down"); }) as typeof db.query;
  try { await assert.rejects(marked(id), /database down/); } finally { db.query = query; }
});

test("T8 the mark does not depend on the tools being offered: a session that acts as a user is marked without a secret to sign the tools with", async () => {
  const id = (await create(ALICE, { acting_as: "u-bob" })).body.data.session_id as string;
  const saved = process.env.CLAW_GITHUB_REVIEW_MCP_SECRET;
  process.env.CLAW_GITHUB_REVIEW_MCP_SECRET = "";
  try {
    assert.deepEqual(await tools.githubReviewMcpServers(id), {}, "no tools");
    const task: Record<string, unknown> = {};
    await applyAppMcpToTask(task, id);
    assert.equal(task.withhold_sandbox_keys, true, "and still no keys in the sandbox");
    assert.equal("mcp_servers" in task, false);
  } finally {
    process.env.CLAW_GITHUB_REVIEW_MCP_SECRET = saved;
  }
});

test("M1 a session that acts as a user and names no model runs on the review model, with no effort unless one is set; one that names a model keeps it; an ordinary chat session has neither", async () => {
  const cases: Array<[string, Record<string, unknown>, Record<string, unknown>, string | null, string | undefined]> = [
    ["acting, no model", { acting_as: "u-bob" }, {}, "claude-sonnet-5.5", undefined],
    ["acting, model null", { acting_as: "u-bob" }, { model: null }, "claude-sonnet-5.5", undefined],
    ["acting, own model", { acting_as: "u-bob" }, { model: "claude-opus-5.5" }, "claude-opus-5.5", undefined],
    ["ordinary", { notify_on_finish: true }, {}, null, undefined],
  ];
  for (const [what, config, extra, model, effort] of cases) {
    published = [];
    const r = await create(ALICE, config, { ...extra, message: { content: "review it" } });
    assert.equal(r.status, 200, `${what}: ${JSON.stringify(r.body)}`);
    const [row] = await h.sql("SELECT model FROM claw_sessions WHERE session_id = $1", [r.body.data.session_id]);
    assert.equal(row?.model ?? null, model, `${what}: the stored model`);
    assert.equal(published[0]?.model, model ?? undefined, `${what}: the turn's model`);
    assert.equal(published[0]?.effort, effort, `${what}: the turn's effort`);
  }
});

test("M2 the operator chooses both: another model and an effort for every turn of a review (an ordinary session gets neither), or the deployment's model with `default` and no effort", async () => {
  const saved = { m: process.env.CLAW_GITHUB_REVIEW_MODEL, e: process.env.CLAW_GITHUB_REVIEW_EFFORT };
  const restore = () => {
    for (const [k, v] of [["CLAW_GITHUB_REVIEW_MODEL", saved.m], ["CLAW_GITHUB_REVIEW_EFFORT", saved.e]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  };
  try {
    for (const [m, e, model, effort] of [["glm-5-3", "high", "glm-5-3", "high"], ["default", "", null, undefined]] as const) {
      process.env.CLAW_GITHUB_REVIEW_MODEL = m;
      process.env.CLAW_GITHUB_REVIEW_EFFORT = e;
      published = [];
      const r = await create(ALICE, { acting_as: "u-bob" }, { message: { content: "review it" } });
      assert.equal(r.status, 200);
      const [row] = await h.sql("SELECT model FROM claw_sessions WHERE session_id = $1", [r.body.data.session_id]);
      assert.equal(row?.model ?? null, model, m);
      assert.equal(published[0]?.effort, effort, e);
      assert.equal("effort" in (published[0] ?? {}), effort !== undefined, `${e}: no field at all for the model's default`);
      published = [];
      const plain = await create(ALICE, { notify_on_finish: true }, { message: { content: "hello" } });
      assert.equal(plain.status, 200);
      assert.deepEqual([published[0]?.model, "effort" in (published[0] ?? {})], [undefined, false], `${m}/${e}: an ordinary chat session is untouched`);
      published = [];
      const own = await create(ALICE, { acting_as: "u-bob" }, { model: "gpt-4o", message: { content: "review it" } });
      assert.equal(own.status, 200);
      assert.deepEqual([published[0]?.model, "effort" in (published[0] ?? {})], ["gpt-4o", false], `${m}/${e}: a model the creator named is not sent the review effort, which it may refuse`);
    }
  } finally {
    restore();
  }
});
