// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `GET /v1/admin/sandbox/{templates,sessions}`: the console's read-only way into
 * the Router's management API, which answers everything to a caller it does not
 * know. What is asserted is what a client receives and what the Router is sent:
 * only an admin role gets through, the Router sees a fixed set of query fields
 * and none of the caller's headers, and an unhealthy Router is a 502, not a
 * silent empty list.
 *
 * `globalThis.fetch` is replaced for the Router; nothing else is stubbed.
 */
import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";

import type { UserInfo } from "../src/auth/models.js";
import { SANDBOX_ADMIN_URL } from "../src/config.js";
import { buildUpstreamQuery, registerSandboxAdminRoutes } from "../src/routes/sandbox-admin.js";

function user(userId: string, roles: string[]): UserInfo {
  return { userId, userName: userId, roles, platformKey: "", virtualKey: `vk-${userId}` };
}

const MEMBER = user("u-member", ["default"]);
const READONLY_ADMIN = user("u-ops", ["system-admin-readonly"]);
const FULL_ADMIN = user("u-admin", ["system-admin"]);

interface RouterCall { url: string; init: RequestInit | undefined }

const originalFetch = globalThis.fetch;
after(() => { globalThis.fetch = originalFetch; });

let calls: RouterCall[] = [];
let answer: () => Promise<Response> = async () => Response.json({ totalCount: 0, items: [] });

beforeEach(() => {
  calls = [];
  answer = async () => Response.json({ totalCount: 0, items: [] });
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return answer();
  }) as typeof fetch;
});

async function appAs(caller: UserInfo | null): Promise<FastifyInstance> {
  const app = Fastify();
  // src/index.ts authenticates in one global preHandler; the routes never do.
  app.addHook("onRequest", async (req) => { (req as unknown as { user: unknown }).user = caller; });
  await registerSandboxAdminRoutes(app);
  await app.ready();
  return app;
}

const BASE = SANDBOX_ADMIN_URL.replace(/\/+$/, "");

test("an ordinary user is refused and the Router is never asked", async () => {
  const app = await appAs(MEMBER);
  for (const route of ["templates", "sessions"]) {
    const res = await app.inject({ method: "GET", url: `/v1/admin/sandbox/${route}` });
    assert.equal(res.statusCode, 403);
  }
  assert.equal(calls.length, 0);
  await app.close();
});

test("a caller the middleware did not identify is refused", async () => {
  const app = await appAs(null);
  const res = await app.inject({ method: "GET", url: "/v1/admin/sandbox/sessions" });
  assert.equal(res.statusCode, 401);
  assert.equal(calls.length, 0);
  await app.close();
});

test("both admin roles can list templates and sandboxes, each from its own Router path", async () => {
  for (const admin of [READONLY_ADMIN, FULL_ADMIN]) {
    calls = [];
    answer = async () => Response.json({ totalCount: 1, items: [{ sessionId: "s1" }] });
    const app = await appAs(admin);
    const t = await app.inject({ method: "GET", url: "/v1/admin/sandbox/templates" });
    const s = await app.inject({ method: "GET", url: "/v1/admin/sandbox/sessions" });
    assert.equal(t.statusCode, 200);
    assert.equal(s.statusCode, 200);
    assert.deepEqual(s.json(), { ok: true, data: { totalCount: 1, items: [{ sessionId: "s1" }] } });
    assert.deepEqual(calls.map((c) => c.url), [`${BASE}/v1/templates?`, `${BASE}/v1/code-interpreter/sessions?`]);
    await app.close();
  }
});

test("only the documented filters reach the Router, and none of the caller's headers", async () => {
  const app = await appAs(READONLY_ADMIN);
  const res = await app.inject({
    method: "GET",
    url: "/v1/admin/sandbox/sessions?sessionId=abc&status=running&offset=20&limit=10&sortBy=createdAt&order=asc&evil=1&name=x",
    headers: { cookie: "Token=secret", authorization: "Bearer ak-secret", "x-user-id": "u-ops" },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 1);
  const u = new URL(calls[0].url);
  assert.equal(u.pathname, "/v1/code-interpreter/sessions");
  assert.deepEqual(
    [...u.searchParams.keys()].sort(),
    ["limit", "offset", "order", "sessionId", "sortBy", "status"],
  );
  assert.equal(calls[0].init?.headers, undefined);
  await app.close();
});

test("a malformed paging or sorting value is a 400 and the Router is not asked", async () => {
  const app = await appAs(FULL_ADMIN);
  for (const q of ["limit=0", "limit=abc", "limit=1001", "offset=-1", "order=sideways", "sortBy=a;b", "userId=" + "x".repeat(201)]) {
    const res = await app.inject({ method: "GET", url: `/v1/admin/sandbox/templates?${q}` });
    assert.equal(res.statusCode, 400, q);
  }
  assert.equal(calls.length, 0);
  await app.close();
});

test("a Router that is down, unhealthy or not speaking JSON is a 502, not an empty list", async () => {
  const app = await appAs(FULL_ADMIN);
  const cases: Array<[string, () => Promise<Response>]> = [
    ["refused", async () => { throw new TypeError("fetch failed"); }],
    ["500", async () => new Response("boom", { status: 500 })],
    // A JSON error body parses fine; only the status says it is not a list.
    ["500 json", async () => Response.json({ error: "store unavailable" }, { status: 500 })],
    ["401 json", async () => Response.json({ error: "unauthorized" }, { status: 401 })],
    ["404 html", async () => new Response("<html></html>", { status: 404 })],
    ["200 html", async () => new Response("<html></html>", { status: 200 })],
  ];
  for (const [label, fn] of cases) {
    answer = fn;
    const res = await app.inject({ method: "GET", url: "/v1/admin/sandbox/sessions" });
    assert.equal(res.statusCode, 502, label);
    assert.equal(res.json().ok, false, label);
  }
  await app.close();
});

test("buildUpstreamQuery keeps filters per endpoint", () => {
  const q = { userName: "al", public: "true", sandboxName: "x" };
  assert.deepEqual([...(buildUpstreamQuery("/v1/templates", q) as URLSearchParams).keys()].sort(), ["public", "userName"]);
  assert.deepEqual([...(buildUpstreamQuery("/v1/code-interpreter/sessions", q) as URLSearchParams).keys()].sort(), ["sandboxName", "userName"]);
});
