// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `GET /v1/me`, end to end: the real auth middleware, the real route, and a real
 * HTTP server standing in for SaFE, which is both the verifier the middleware asks
 * and the API the route then calls as the caller.
 *
 *   ME1  no credential is a 401 and SaFE's data endpoints are never asked
 *   ME2  the document is the contract, field for field
 *   ME3  every SaFE read is made with THE CALLER'S credential and nobody else's,
 *        including under concurrency and with two credentials on one request
 *   ME4  SaFE failing in any way is a 401/502/503 with `{error, reason}`, never a
 *        500 -- and a failed user lookup is never rendered as `admin: false`.
 *        Only SaFE's 401 is a 401 (sign in again); its 403 is a 502 `safe_forbidden`,
 *        because the session is good and signing in again would change nothing
 *   ME5  the answer is uncacheable
 *   ME6  without a credential SaFE can be shown (the dev bypass) there is no
 *        SaFE call at all
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import type http from "node:http";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { sendJson, type FakeUpstream } from "./support/fake-upstream.js";
import { AUTH_INTERNAL_TOKEN, startFakePlatform, type Account, type DataRoute } from "./support/fake-platform.js";

const DATA_PATHS = ["/api/v1/workspaces", "/api/v1/clusters", "/api/v1/users/self"];

const ALICE: Account = {
  id: "u-alice",
  name: "Alice",
  email: "alice@example.com",
  roles: ["default"],
  workspaces: {
    totalCount: 3,
    items: [
      { workspaceId: "ws-a-train", workspaceName: "A Train", clusterId: "c1", flavorId: "f-train", scopes: ["Train"], isDefault: false, currentNodeCount: 4, phase: "Running", userId: "creator" },
      { workspaceId: "ws-a-sandbox", workspaceName: "A Sandbox", clusterId: "c1", flavorId: "f-mi300", scopes: ["Train", "Sandbox"], isDefault: true, gpuProduct: "MI300X", managers: [{ id: "u-x" }] },
      { workspaceId: "ws-a-sandbox-2", workspaceName: "A Sandbox 2", clusterId: "c2", scopes: ["Sandbox"], gpuProduct: "MI325X" },
    ],
  },
  clusters: { totalCount: 2, items: [{ clusterId: "c1", phase: "Ready", isProtected: true }, { clusterId: "c2", phase: "Creating" }] },
  self: { id: "u-alice", name: "Alice", managedWorkspaces: [{ id: "ws-a-sandbox", name: "A Sandbox" }], workspaces: [] },
};
const ALICE_ME = {
  userId: "u-alice",
  name: "Alice",
  email: "alice@example.com",
  roles: ["default"],
  sandbox: { available: true, defaultWorkspaceId: "ws-a-sandbox", gpuProduct: "MI300X" },
  workspaces: [
    { id: "ws-a-train", name: "A Train", scopes: ["Train"], flavorId: "f-train", clusterId: "c1", isDefault: false, admin: false },
    { id: "ws-a-sandbox", name: "A Sandbox", scopes: ["Train", "Sandbox"], gpuProduct: "MI300X", flavorId: "f-mi300", clusterId: "c1", isDefault: true, admin: true },
    { id: "ws-a-sandbox-2", name: "A Sandbox 2", scopes: ["Sandbox"], gpuProduct: "MI325X", clusterId: "c2", admin: false },
  ],
};

const BOB: Account = {
  id: "u-bob",
  name: "Bob",
  roles: ["default", "system-admin"],
  workspaces: { totalCount: 1, items: [{ workspaceId: "ws-b", workspaceName: "B", clusterId: "c9", flavorId: "f9", scopes: ["Sandbox"], gpuProduct: "MI355X" }] },
  clusters: { totalCount: 1, items: [{ clusterId: "c9", phase: "Ready" }] },
  self: { id: "u-bob", managedWorkspaces: null },
};
const BOB_ME = {
  userId: "u-bob",
  name: "Bob",
  roles: ["default", "system-admin"],
  sandbox: { available: true, defaultWorkspaceId: "ws-b", gpuProduct: "MI355X" },
  workspaces: [{ id: "ws-b", name: "B", scopes: ["Sandbox"], gpuProduct: "MI355X", flavorId: "f9", clusterId: "c9", admin: false }],
};

let platform: FakeUpstream;
let app: FastifyInstance;
/** Replaceable per test: how the fake SaFE answers the data endpoints. */
let override: DataRoute = () => false;

before(async () => {
  platform = await startFakePlatform({ alice: ALICE, bob: BOB }, (a, req, res, raw) => override(a, req, res, raw));

  // Not the production APP_ENV: the dev bypass (ME6) needs a dev one, and with
  // CLAW_INSECURE_DEV_AUTH unset the middleware behaves exactly as in production.
  process.env.APP_ENV = "dev";
  delete process.env.CLAW_INSECURE_DEV_AUTH;
  process.env.CLAW_DEPLOY_MODE = "safe";
  process.env.SAFE_API_URL = platform.url;
  process.env.AUTH_INTERNAL_TOKEN = AUTH_INTERNAL_TOKEN;

  const { authMiddleware } = await import("../src/auth/middleware.js");
  const { registerMeRoutes } = await import("../src/routes/me.js");
  app = Fastify();
  await app.register(cookie);
  app.addHook("preHandler", authMiddleware);
  await registerMeRoutes(app);
  await app.ready();
});

after(async () => {
  delete process.env.CLAW_INSECURE_DEV_AUTH;
  await app?.close();
  await platform?.close();
});

const asAlice = { cookie: "Token=tok-alice; userType=default" };
const asBob = { authorization: "Bearer ak-bob" };
const get = (headers: Record<string, string> = {}) => app.inject({ method: "GET", url: "/v1/me", headers });
const dataCalls = () => platform.seen.filter((r) => DATA_PATHS.includes(r.url.split("?")[0]));

test("ME1: without a credential the answer is 401 and SaFE's data endpoints are not asked", async () => {
  platform.seen.length = 0;
  const res = await get();
  assert.equal(res.statusCode, 401);
  assert.equal(dataCalls().length, 0);
});

test("ME1: a credential SaFE does not know is 401 and its data endpoints are not asked", async () => {
  platform.seen.length = 0;
  const res = await get({ authorization: "Bearer ak-mallory" });
  assert.equal(res.statusCode, 401);
  assert.equal(dataCalls().length, 0);
});

test("ME1: a route reached with no authenticated user, or with a user and nothing to present to SaFE, is 401 and asks SaFE nothing", async () => {
  // The global hook guarantees both; these are the route's own refusals should it ever not.
  // The first case carries a credential SaFE would accept, so only the missing user can be what refuses it.
  const { registerMeRoutes } = await import("../src/routes/me.js");
  const someone = { userId: "u-x", userName: "X", roles: ["default"], platformKey: "", virtualKey: "" };
  for (const [name, user, headers] of [
    ["no user", null, asBob],
    ["a user but no credential", someone, { authorization: "Bearer not-an-api-key" }],
  ] as const) {
    const bare = Fastify();
    bare.addHook("preHandler", async (req) => { (req as any).user = user; });
    await registerMeRoutes(bare);
    try {
      platform.seen.length = 0;
      const res = await bare.inject({ method: "GET", url: "/v1/me", headers });
      assert.equal(res.statusCode, 401, name);
      assert.equal(JSON.parse(res.body).error, "authentication_required", name);
      assert.equal(dataCalls().length, 0, name);
    } finally {
      await bare.close();
    }
  }
});

test("ME2: the document is the contract", async () => {
  const res = await get(asAlice);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), ALICE_ME);
});

test("ME2: a system admin with no managed workspace is still admin: false on every workspace", async () => {
  const res = await get(asBob);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), BOB_ME);
});

test("ME2: email is present when SaFE's verification reported one and omitted when it did not", async () => {
  const alice = JSON.parse((await get(asAlice)).body) as Record<string, unknown>;
  const bob = JSON.parse((await get(asBob)).body) as Record<string, unknown>;
  assert.equal(alice.email, "alice@example.com");
  assert.equal("email" in bob, false, "no email is an absent field, not an empty one");
});

test("ME2: the email is the authenticated identity's, not whatever the user record says", async () => {
  override = (_a, req, res) => {
    if (req.url !== "/api/v1/users/self") return false;
    sendJson(res, 200, { id: "u-bob", email: "someone-else@example.com", managedWorkspaces: [] });
    return true;
  };
  try {
    const bob = JSON.parse((await get(asBob)).body) as Record<string, unknown>;
    assert.equal("email" in bob, false);
  } finally {
    override = () => false;
  }
});

test("ME2: nothing SaFE said beyond the contract is passed through", async () => {
  const res = await get(asAlice);
  for (const leaked of ["currentNodeCount", "phase", "creator", "managers", "isProtected", "totalCount", "u-x"]) {
    assert.equal(res.body.includes(leaked), false, `${leaked} must not be passed through`);
  }
});

test("ME3: the three reads are GET workspaces, clusters and users/self, once each, with the cookie", async () => {
  platform.seen.length = 0;
  await get(asAlice);
  const calls = dataCalls();
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`).sort(), [
    "GET /api/v1/clusters", "GET /api/v1/users/self", "GET /api/v1/workspaces",
  ]);
  for (const c of calls) {
    assert.equal(c.headers.cookie, asAlice.cookie);
    assert.equal(c.headers.authorization, undefined);
  }
});

test("ME3: a key caller's reads carry the key and no cookie", async () => {
  platform.seen.length = 0;
  await get(asBob);
  const calls = dataCalls();
  assert.equal(calls.length, 3);
  for (const c of calls) {
    assert.equal(c.headers.authorization, asBob.authorization);
    assert.equal(c.headers.cookie, undefined);
  }
});

test("ME3: with alice's cookie and bob's key on one request, the reads are alice's only", async () => {
  platform.seen.length = 0;
  const res = await get({ ...asAlice, ...asBob });
  assert.deepEqual(JSON.parse(res.body), ALICE_ME);
  const calls = dataCalls();
  assert.equal(calls.length, 3);
  for (const c of calls) {
    assert.equal(c.headers.cookie, asAlice.cookie);
    assert.equal(c.headers.authorization, undefined);
  }
  assert.equal(res.body.includes("ws-b"), false);
});

test("ME3: concurrent callers never receive each other's workspaces", async () => {
  platform.seen.length = 0;
  const results = await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? get(asAlice) : get(asBob))));
  results.forEach((res, i) => {
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), i % 2 === 0 ? ALICE_ME : BOB_ME);
  });
  assert.equal(dataCalls().length, 30);
});

test("ME5: the answer is not cacheable, whoever it is for", async () => {
  assert.equal((await get(asAlice)).headers["cache-control"], "no-store");
  assert.equal((await get(asBob)).headers["cache-control"], "no-store");
});

test("ME4: the failure table", async (t) => {
  type Case = { name: string; path: string; answer: (res: http.ServerResponse) => void; status: number; error: string };
  const failWith = (path: string, answer: Case["answer"]): DataRoute => (_a, req, res) => {
    if (req.url !== path) return false;
    answer(res);
    return true;
  };
  const cases: Case[] = [
    { name: "workspaces 500", path: "/api/v1/workspaces", answer: (r) => sendJson(r, 500, { message: "boom ak-bob" }), status: 502, error: "safe_error" },
    { name: "clusters 502", path: "/api/v1/clusters", answer: (r) => sendJson(r, 502, {}), status: 502, error: "safe_error" },
    { name: "users/self 500 is a failure, never admin:false", path: "/api/v1/users/self", answer: (r) => sendJson(r, 500, {}), status: 502, error: "safe_error" },
    { name: "users/self 404", path: "/api/v1/users/self", answer: (r) => sendJson(r, 404, {}), status: 502, error: "safe_error" },
    { name: "users/self 401 is the session lapsing", path: "/api/v1/users/self", answer: (r) => sendJson(r, 401, {}), status: 401, error: "session_rejected" },
    { name: "workspaces 401", path: "/api/v1/workspaces", answer: (r) => sendJson(r, 401, {}), status: 401, error: "session_rejected" },
    { name: "workspaces 403 is a denial, not a lapsed session", path: "/api/v1/workspaces", answer: (r) => sendJson(r, 403, {}), status: 502, error: "safe_forbidden" },
    { name: "clusters 403 (a role that may not list clusters)", path: "/api/v1/clusters", answer: (r) => sendJson(r, 403, {}), status: 502, error: "safe_forbidden" },
    { name: "users/self 403", path: "/api/v1/users/self", answer: (r) => sendJson(r, 403, {}), status: 502, error: "safe_forbidden" },
    { name: "clusters connection dropped", path: "/api/v1/clusters", answer: (r) => { r.socket?.destroy(); }, status: 503, error: "safe_unreachable" },
    { name: "workspaces connection dropped", path: "/api/v1/workspaces", answer: (r) => { r.socket?.destroy(); }, status: 503, error: "safe_unreachable" },
    { name: "workspaces items not a list", path: "/api/v1/workspaces", answer: (r) => sendJson(r, 200, { items: "x" }), status: 502, error: "safe_bad_response" },
    { name: "workspaces is a bare array", path: "/api/v1/workspaces", answer: (r) => sendJson(r, 200, []), status: 502, error: "safe_bad_response" },
    { name: "clusters not json", path: "/api/v1/clusters", answer: (r) => { r.writeHead(200); r.end("<html>"); }, status: 502, error: "safe_bad_response" },
    { name: "users/self managedWorkspaces not a list", path: "/api/v1/users/self", answer: (r) => sendJson(r, 200, { managedWorkspaces: "x" }), status: 502, error: "safe_bad_response" },
  ];
  for (const c of cases) {
    await t.test(c.name, async () => {
      override = failWith(c.path, c.answer);
      try {
        const res = await get(asAlice);
        assert.equal(res.statusCode, c.status);
        const body = JSON.parse(res.body) as { error: string; reason: string };
        assert.equal(body.error, c.error);
        assert.equal(typeof body.reason, "string");
        assert.deepEqual(Object.keys(body).sort(), ["error", "reason"]);
        assert.equal(res.body.includes("tok-alice"), false);
        assert.equal(res.body.includes("ak-bob"), false);
        assert.equal(res.body.includes("boom"), false);
      } finally {
        override = () => false;
      }
    });
  }
});

test("ME4: SaFE nulls and empty lists are a valid, empty document", async () => {
  override = (_a, req, res) => {
    if (req.url === "/api/v1/workspaces") { sendJson(res, 200, { totalCount: 0, items: null }); return true; }
    if (req.url === "/api/v1/clusters") { sendJson(res, 200, { totalCount: 0, items: [] }); return true; }
    if (req.url === "/api/v1/users/self") { sendJson(res, 200, { id: "u-alice", managedWorkspaces: null, workspaces: null }); return true; }
    return false;
  };
  try {
    const res = await get(asAlice);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), {
      userId: "u-alice", name: "Alice", email: "alice@example.com", roles: ["default"], sandbox: { available: false }, workspaces: [],
    });
  } finally {
    override = () => false;
  }
});

test("ME6: under the dev auth bypass there is no SaFE call, and the identity is the synthetic one", async () => {
  process.env.CLAW_INSECURE_DEV_AUTH = "1";
  try {
    platform.seen.length = 0;
    const res = await get();
    assert.equal(res.statusCode, 200);
    assert.deepEqual(JSON.parse(res.body), {
      userId: "dev-user", name: "Developer", roles: ["default", "system-admin"], sandbox: { available: false }, workspaces: [],
    });
    assert.equal(platform.seen.length, 0);
  } finally {
    delete process.env.CLAW_INSECURE_DEV_AUTH;
  }
});
