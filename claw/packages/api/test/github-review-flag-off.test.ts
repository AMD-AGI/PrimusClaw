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

test("no turn is gated for a session that has acting_as, and the gate asks the database nothing", async () => {
  // Nothing is offered to such a row, so it is an ordinary session, and the statements of every route are the ones they were.
  const { actingTurnRefusal, actingTurnRefusalFor } = await import("../src/github-review/acting-turns.js");
  const req = { user: { userId: "u-1", userName: "u-1", roles: ["default"] }, authMethod: "api_key" } as never;
  const query = db.query;
  const asked: string[] = [];
  db.query = (async (text: string) => { asked.push(text); return { rows: [{ acting_as: "u-2" }], rowCount: 1 }; }) as unknown as typeof db.query;
  try {
    assert.equal(await actingTurnRefusalFor(req, "s-1"), null);
    assert.equal(actingTurnRefusal(req, "u-2"), null);
  } finally {
    db.query = query;
  }
  assert.deepEqual(asked, []);
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

test("the sandbox's keys are left alone, and the database is asked nothing, for a row that has acting_as", async () => {
  // Nothing is offered to such a row, so it is an ordinary session, and an ordinary session's sandbox holds its owner's keys as it always did.
  const { applySandboxKeyPolicyToTask, sessionWithholdsSandboxKeys, withholdsSandboxKeys } = await import("../src/github-review/session-tools.js");
  const { applyAppMcpToTask } = await import("../src/sessions/app-mcp.js");
  assert.equal(withholdsSandboxKeys({ acting_as: "u-2" }), false);
  const query = db.query;
  const asked: string[] = [];
  db.query = (async (text: string) => { asked.push(text); return { rows: [{ acting_as: "u-2", user_id: "u-1", config: { acting_as: "u-2" } }], rowCount: 1 }; }) as unknown as typeof db.query;
  try {
    const task: Record<string, unknown> = {};
    await applySandboxKeyPolicyToTask(task, "s-1");
    assert.deepEqual(task, {});
    assert.equal(await sessionWithholdsSandboxKeys("s-1"), false, "and a hosted application run is asked for as it always was");
    // The whole of what is added to a turn built for a session: the application servers' own statements, and none about acting_as.
    await applyAppMcpToTask(task, "s-1");
    assert.equal("withhold_sandbox_keys" in task, false);
  } finally {
    db.query = query;
  }
  assert.equal(asked.some((sql) => /acting_as/.test(sql)), false);
});

test("the services that may bring a user's own key must be ones that may speak for the user, or an enabled deployment does not start", () => {
  const settings = (decision: string, enabled = true) => readGithubReviewSettings({ CLAW_GITHUB_REVIEW_MCP_SECRET: "g".repeat(32), CLAW_GITHUB_REVIEW_DECISION_CLIENT_IDS: decision }, enabled);
  // [decision list, own-key list, what the error names (null: none)]
  const cases: Array<[string, string[], string[] | null]> = [
    ["svc-a svc-b", ["svc-a"], null],
    ["svc-a,svc-b", ["svc-a", "svc-b"], null],
    ["svc-a", [], null],
    ["", [], null],
    ["svc-a svc-answers-only", ["svc-a"], null],
    ["", ["svc-a"], ["svc-a"]],
    ["svc-a", ["svc-a", "svc-x"], ["svc-x"]],
    ["svc-a", ["svc-x", "svc-y"], ["svc-x", "svc-y"]],
    ["svc-a", ["SVC-A"], ["SVC-A"]],
    ["svc-a", ["svc-a "], ["svc-a "]],
  ];
  for (const [decision, own, named] of cases) {
    const errors = githubReviewConfigErrors(settings(decision), true, own);
    if (named === null) {
      assert.deepEqual(errors, [], `${decision} / ${own.join()}`);
      continue;
    }
    assert.equal(errors.length, 1, `${decision} / ${own.join()}: ${errors.join(" | ")}`);
    assert.match(errors[0]!, /CLAW_IDENTITY_TOKEN_OWN_KEY_CLIENT_IDS/);
    assert.match(errors[0]!, /CLAW_GITHUB_REVIEW_DECISION_CLIENT_IDS/);
    for (const id of named) assert.ok(errors[0]!.includes(JSON.stringify(id)), `${errors[0]} names ${id}`);
    for (const id of own.filter((o) => !named.includes(o))) assert.ok(!errors[0]!.includes(JSON.stringify(id)), `${errors[0]} does not name ${id}`);
  }
  // Without the feature there is no list to check it against and no flow that uses the key.
  assert.deepEqual(githubReviewConfigErrors(settings("", false), true, ["svc-x"]), []);
  // It comes with the other reasons not to start, and does not replace them.
  assert.equal(githubReviewConfigErrors(readGithubReviewSettings({ CLAW_GITHUB_REVIEW_MCP_SECRET: "short" }, true), false, ["svc-x"]).length, 3);
  // A caller that does not pass the list (every one before this setting) is asked nothing about it.
  assert.deepEqual(githubReviewConfigErrors(settings("svc-a"), true), []);
});

test("the lists of client ids are read the same way: commas or white space, each as signed, once", () => {
  const s = readGithubReviewSettings({ CLAW_GITHUB_REVIEW_DECISION_CLIENT_IDS: " first ,Second\n first  third\t,", CLAW_GITHUB_REVIEW_MCP_SECRET: "g".repeat(32) }, true);
  assert.deepEqual(s.decisionClientIds, ["first", "Second", "third"]);
  assert.deepEqual(readGithubReviewSettings({}, true).decisionClientIds, []);
});
