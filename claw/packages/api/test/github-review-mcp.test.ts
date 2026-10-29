// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The review tools over the wire, the way Brain uses them: an MCP client with the
 * signed session token against the API's own route, plus the confirmation routes.
 *
 *   A  who may call: the token, the session row and its owner
 *   B  what a tool call is: four tools, errors as errors, nothing secret in an answer
 *   C  the confirmation routes: only the acting user decides
 *   D  with the feature off, nothing exists
 */
import assert from "node:assert/strict";
import test, { after, afterEach, before, beforeEach, describe } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { registerGithubReviewRoutes } from "../src/github-review/mcp.js";
import { mintSessionToolToken } from "../src/github-review/token.js";
import { HEAD } from "./support/fake-github.js";
import { PR, SECRET, TOKEN, closeShared, credential, reviewEnv, type ReviewEnv } from "./support/review-env.js";

after(closeShared);

let e: ReviewEnv;
let app: FastifyInstance;
let base = "";
const clients: Client[] = [];

async function boot(opts: { enabled?: boolean } = {}): Promise<void> {
  app = Fastify();
  app.addHook("preHandler", async (req) => {
    // Stands in for the global authentication hook, as the other route tests do.
    const who = req.headers["x-test-user"];
    if (typeof who === "string") (req as unknown as { user: unknown }).user = { userId: who, userName: who, roles: ["default"], platformKey: "", virtualKey: "" };
  });
  await registerGithubReviewRoutes(app, { enabled: opts.enabled ?? true, settings: () => e.settings, db: e.db, service: e.service });
  await app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
}

beforeEach(async () => {
  e = await reviewEnv();
  await e.sql("INSERT INTO claw_sessions (session_id, user_id, config) VALUES ('s-1', 'u-alice', $1::jsonb)", [JSON.stringify({ acting_as: "u-bob", acting_as_requester: "Alice A" })]);
});
afterEach(async () => {
  // A test that failed before it closed its client must not leave the server waiting for it for ever.
  for (const c of clients.splice(0)) await c.close().catch(() => undefined);
  app?.server.closeAllConnections();
  await app?.close();
});

const token = (over: Partial<{ sessionId: string; requesterUserId: string; actorUserId: string }> = {}, ttl = 600, secret = SECRET) =>
  mintSessionToolToken({ sessionId: "s-1", requesterUserId: "u-alice", actorUserId: "u-bob", ...over }, secret, ttl);

async function connect(bearer: string): Promise<Client> {
  const client = new Client({ name: "test", version: "1" });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/v1/internal/github-review/mcp`), { requestInit: { headers: { Authorization: `Bearer ${bearer}` } } }));
  return client;
}

const call = async (client: Client, name: string, args: Record<string, unknown>) => {
  const r = await client.callTool({ name, arguments: args }) as { content: Array<{ type: string; text: string }>; isError?: boolean };
  return { isError: r.isError === true, text: r.content[0]?.text ?? "", body: JSON.parse(r.content[0]?.text ?? "null") as any };
};

describe("A who may call", () => {
  beforeEach(async () => { await boot(); });

  test("A1 a valid token lists exactly the four tools", async () => {
    const c = await connect(token());
    const tools = (await c.listTools()).tools;
    assert.deepEqual(tools.map((t) => t.name).sort(), ["gh_pr_get", "gh_pr_merge", "gh_pr_risk", "gh_review_submit"]);
    for (const t of tools) assert.ok(t.description && t.description.length > 20, t.name);
    await c.close();
  });

  test("A2 no token, another secret, an expired token and junk are all 401 and reach nothing", async () => {
    for (const bearer of ["", "junk", token({}, 600, "x".repeat(40)), token({}, -5)]) {
      const r = await fetch(`${base}/v1/internal/github-review/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: bearer ? `Bearer ${bearer}` : "" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
      assert.equal(r.status, 401, bearer.slice(0, 12));
    }
    assert.equal(e.gh.calls.length, 0);
    assert.equal(e.resolved.length, 0);
  });

  test("A3 a token is only as good as the session row: another owner, another acting user, a deleted or missing session are 403", async () => {
    const post = (bearer: string) => fetch(`${base}/v1/internal/github-review/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${bearer}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    assert.equal((await post(token({ requesterUserId: "u-mallory" }))).status, 403);
    assert.equal((await post(token({ actorUserId: "u-carol" }))).status, 403);
    assert.equal((await post(token({ sessionId: "s-missing" }))).status, 403);
    await e.sql("UPDATE claw_sessions SET deleted_at = NOW()");
    assert.equal((await post(token())).status, 403);
    await e.sql("UPDATE claw_sessions SET deleted_at = NULL, config = '{}'::jsonb");
    assert.equal((await post(token())).status, 403, "a session without acting_as has no tools");
    assert.equal(e.gh.calls.length, 0);
  });
});

describe("B a tool call", () => {
  beforeEach(async () => { await boot(); });

  test("B1 gh_pr_get through MCP answers, GitHub saw the acting user's token and the model did not", async () => {
    const c = await connect(token());
    const r = await call(c, "gh_pr_get", { pr: PR });
    assert.equal(r.isError, false);
    assert.equal(r.body.pull_request.head_sha, HEAD);
    assert.equal(r.text.includes(TOKEN), false);
    assert.equal(e.gh.calls.every((x) => x.authorization === `Bearer ${TOKEN}`), true);
    assert.deepEqual(e.resolved[0], { userId: "u-bob", provider: "github", requesterUserId: "u-alice", purpose: "gh_pr_get" });
    await c.close();
  });

  test("B2 a refusal arrives as an error the model can read, and the token never appears even when GitHub echoes it", async () => {
    e.gh.fail["/repos/AMD-AGI/demo/pulls/7"] = { status: 500, message: `echo ${TOKEN}` };
    const c = await connect(token());
    const r = await call(c, "gh_pr_get", { pr: PR });
    assert.equal(r.isError, true);
    assert.equal(r.body.reason, "github_error");
    assert.equal(r.text.includes(TOKEN), false);
    const owner = await call(c, "gh_pr_get", { pr: "evil/x#1" });
    assert.equal(owner.isError, true);
    assert.equal(owner.body.reason, "owner_not_allowed");
    await c.close();
  });

  test("B3 the footer names the requester the session recorded, and the acting user's login", async () => {
    e.identity.answer = async () => credential({ delegation: true });
    const c = await connect(token());
    const r = await call(c, "gh_review_submit", { pr: PR, head_sha: HEAD, event: "COMMENT", body: "Fine." });
    assert.equal(r.isError, false, r.text);
    assert.match(String(e.gh.writes[0]?.body.body), /Reviewed by Clawy on behalf of bob \(requested by Alice A\)/);
    await c.close();
  });

  test("B4 the schema stops what the tool would refuse anyway: a bad event or a missing head_sha never reaches the service", async () => {
    const c = await connect(token());
    const bad = await c.callTool({ name: "gh_review_submit", arguments: { pr: PR, head_sha: HEAD, event: "DISMISS", body: "x" } }) as { isError?: boolean };
    assert.equal(bad.isError, true);
    assert.equal(e.gh.calls.length, 0);
    await c.close();
  });

  test("B5 gh_pr_merge through MCP holds a high-risk change for the acting user", async () => {
    e.identity.answer = async () => credential({ delegation: true });
    e.gh.files = [{ filename: ".github/workflows/ci.yml", status: "modified", additions: 1, deletions: 0, patch: "@@ -1 +1,2 @@\n a\n+b" }];
    const c = await connect(token());
    const r = await call(c, "gh_pr_merge", { pr: PR, head_sha: HEAD });
    assert.equal(r.body.status, "confirmation_required");
    assert.equal(e.gh.writes.length, 0);
    await c.close();
  });
});

describe("C confirmations over HTTP", () => {
  beforeEach(async () => {
    await boot();
    e.identity.answer = async () => credential({ delegation: true });
    e.gh.files = [{ filename: ".github/workflows/ci.yml", status: "modified", additions: 1, deletions: 0, patch: "@@ -1 +1,2 @@\n a\n+b" }];
    e.gh.graphql.mergeStateStatus = "BLOCKED";
    e.gh.onReview = (r) => { if (r.event === "APPROVE") e.gh.graphql.mergeStateStatus = "CLEAN"; };
    const c = await connect(token());
    await call(c, "gh_pr_merge", { pr: PR, head_sha: HEAD });
    await c.close();
  });
  const http = async (user: string | null, method: string, path: string, body?: unknown) => {
    const r = await fetch(base + path, { method, headers: { ...(user ? { "x-test-user": user } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: (await r.json().catch(() => null)) as any };
  };

  test("C1 the acting user and the requester see the pending confirmation, with what a card needs; anyone else sees none; no credential is 401", async () => {
    for (const who of ["u-bob", "u-alice"]) {
      const r = await http(who, "GET", "/v1/github-review/confirmations?session_id=s-1&status=pending");
      assert.equal(r.status, 200, who);
      assert.equal(r.body.items.length, 1, who);
      const item = r.body.items[0];
      assert.deepEqual(Object.keys(item).sort(), ["actor_user_id", "author", "checks", "expires_at", "head_sha", "id", "pr", "reasons", "repo", "requester_user_id", "session_id", "status", "title"]);
      assert.equal(item.repo, "AMD-AGI/demo");
      assert.equal(item.pr, 7);
      assert.equal(item.head_sha, HEAD);
      assert.equal(item.status, "pending");
      assert.deepEqual(r.body.data.items, r.body.items);
    }
    assert.equal((await http("u-mallory", "GET", "/v1/github-review/confirmations?session_id=s-1")).body.items.length, 0);
    assert.equal((await http(null, "GET", "/v1/github-review/confirmations")).status, 401);
    assert.equal((await http("u-bob", "GET", "/v1/github-review/confirmations?status=bogus")).status, 400);
  });

  test("C2 only the acting user decides: the requester gets 403 and nothing is merged; the acting user's allow merges once", async () => {
    const id = (await http("u-bob", "GET", "/v1/github-review/confirmations")).body.items[0].id as string;
    const path = `/v1/github-review/confirmations/${id}/decision`;
    assert.equal((await http("u-alice", "POST", path, { decision: "allow" })).status, 403);
    assert.equal((await http(null, "POST", path, { decision: "allow" })).status, 401);
    assert.equal((await http("u-bob", "POST", path, { decision: "maybe" })).status, 400);
    assert.equal((await http("u-bob", "POST", "/v1/github-review/confirmations/not-a-uuid/decision", { decision: "allow" })).status, 404);
    assert.equal((await http("u-bob", "POST", "/v1/github-review/confirmations/00000000-0000-4000-8000-000000000000/decision", { decision: "allow" })).status, 404);
    assert.equal(e.gh.writes.length, 0);
    const ok = await http("u-bob", "POST", path, { decision: "allow" });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.status, "merged");
    assert.equal(ok.body.merge_sha, "m".repeat(40));
    assert.equal(e.gh.calls.filter((x) => x.method === "PUT").length, 1);
    const again = await http("u-bob", "POST", path, { decision: "allow" });
    assert.equal(again.body.status, "refused");
    assert.equal(e.gh.calls.filter((x) => x.method === "PUT").length, 1);
  });
});

describe("D with the feature off nothing exists", () => {
  test("D1 no route is registered, whatever the caller", async () => {
    e = await reviewEnv();
    await boot({ enabled: false });
    for (const [method, path] of [["POST", "/v1/internal/github-review/mcp"], ["GET", "/v1/github-review/confirmations"], ["POST", "/v1/github-review/confirmations/00000000-0000-4000-8000-000000000000/decision"]] as const) {
      const r = await fetch(base + path, { method, headers: { "x-test-user": "u-bob", "content-type": "application/json" }, body: method === "POST" ? "{}" : undefined });
      assert.equal(r.status, 404, `${method} ${path}`);
    }
  });
});
