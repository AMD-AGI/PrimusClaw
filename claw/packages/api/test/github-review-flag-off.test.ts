// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * With `CLAW_GITHUB_REVIEW_ENABLED` unset nothing about the deployment changes: a
 * session that asks for `acting_as` is refused rather than silently going without
 * the tools it asked for, no tools are offered, and no route exists.
 */
import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import Fastify from "fastify";
import { registerGithubReviewRoutes } from "../src/github-review/mcp.js";
import { githubReviewConfigErrors, readGithubReviewSettings } from "../src/github-review/settings.js";
import { githubReviewMcpServers } from "../src/github-review/session-tools.js";
import { db } from "../src/infra/db.js";
import { registerSessionRoutes } from "../src/routes/sessions.js";
import { startHarness, type Harness } from "./scenario-harness.js";

let h: Harness;
let originalConnect: typeof db.pool.connect;

before(async () => {
  delete process.env.CLAW_GITHUB_REVIEW_ENABLED;
  h = await startHarness();
  originalConnect = db.pool.connect;
  db.pool.connect = (async () => ({ query: (text: string, params?: unknown[]) => db.query(text, params), release: () => {} })) as unknown as typeof db.pool.connect;
});
beforeEach(async () => { await h.reset(); });
after(async () => { db.pool.connect = originalConnect; await h?.close(); });

test("a session that asks for acting_as is refused, and leaves nothing behind", async () => {
  const app = Fastify();
  app.addHook("preHandler", async (req) => { (req as unknown as { user: unknown }).user = { userId: "u-1", userName: "u-1", roles: ["default"], platformKey: "pk", virtualKey: "vk" }; });
  await registerSessionRoutes(app);
  await app.ready();
  const res = await app.inject({ method: "POST", url: "/v1/sessions", payload: { name: "s", config: { acting_as: "u-2" } } });
  assert.equal(res.statusCode, 400);
  assert.equal((res.json() as { error: string }).error, "config.acting_as is not enabled on this deployment");
  assert.equal(Number((await h.sql("SELECT count(*)::int AS n FROM claw_sessions"))[0]?.n), 0);
  // Without it a session is created as before.
  const plain = await app.inject({ method: "POST", url: "/v1/sessions", payload: { name: "s", config: {} } });
  assert.equal(plain.statusCode, 200);
  await app.close();
});

test("no tools are offered, even to a row that has acting_as", async () => {
  await h.sql("INSERT INTO claw_sessions (session_id, user_id, config) VALUES ('s-1', 'u-1', $1::jsonb)", [JSON.stringify({ acting_as: "u-2" })]);
  assert.deepEqual(await githubReviewMcpServers("s-1"), {});
});

test("no route exists and no table is made", async () => {
  const app = Fastify();
  await registerGithubReviewRoutes(app);
  await app.ready();
  assert.equal(app.printRoutes().includes("github-review"), false);
  assert.equal((await app.inject({ method: "POST", url: "/v1/internal/github-review/mcp", payload: {} })).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: "/v1/github-review/confirmations" })).statusCode, 404);
  await app.close();
  assert.deepEqual(await h.sql("SELECT table_name FROM information_schema.tables WHERE table_name LIKE 'claw_github%'"), []);
});

test("a deployment that turns it on without what its gates are made of does not start", () => {
  const good = readGithubReviewSettings({ CLAW_GITHUB_REVIEW_MCP_SECRET: "g".repeat(32) }, true);
  assert.deepEqual(githubReviewConfigErrors(good, true), []);
  assert.deepEqual(githubReviewConfigErrors(readGithubReviewSettings({}, false), false), [], "off needs nothing");
  assert.match(githubReviewConfigErrors(readGithubReviewSettings({}, true), true).join(), /CLAW_GITHUB_REVIEW_MCP_SECRET/);
  assert.match(githubReviewConfigErrors(readGithubReviewSettings({ CLAW_GITHUB_REVIEW_MCP_SECRET: "short" }, true), true).join(), /32 characters/);
  assert.match(githubReviewConfigErrors(good, false).join(), /IDENTITY_CLIENT_ENABLED/);
  assert.match(githubReviewConfigErrors(readGithubReviewSettings({ CLAW_GITHUB_REVIEW_MCP_SECRET: "g".repeat(32), CLAW_GITHUB_API_URL: "https://u:p@api.example.com" }, true), true).join(), /CLAW_GITHUB_API_URL/);
});

test("settings: defaults, and a refused number falls back and is reported", () => {
  const s = readGithubReviewSettings({}, true);
  assert.deepEqual([s.owners, s.writesEnabled, s.apiUrl, s.reviewsPerTokenPerHour, s.reviewsPerHour, s.concurrentPerRepo, s.requestsPerSession, s.confirmationTtlSeconds],
    [["amd-agi"], false, "https://api.github.com", 6, 20, 3, 60, 86_400]);
  assert.equal(s.mcpUrl, "http://127.0.0.1:8200/v1/internal/github-review/mcp");
  const t = readGithubReviewSettings({ CLAW_GITHUB_REVIEW_OWNERS: " Foo , bar ", CLAW_GITHUB_REVIEWS_PER_HOUR: "lots", CLAW_GITHUB_WRITES_ENABLED: "yes", INTERNAL_BACKEND_URL: "http://api:9000/" }, true);
  assert.deepEqual(t.owners, ["foo", "bar"]);
  assert.equal(t.reviewsPerHour, 20);
  assert.match(t.problems.join(), /CLAW_GITHUB_REVIEWS_PER_HOUR/);
  assert.equal(t.writesEnabled, true);
  assert.equal(t.mcpUrl, "http://api:9000/v1/internal/github-review/mcp");
});
