// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The GitHub tools for an owner who keeps no `GH_TOKEN` but bound a GitHub account at the identity provider (`/github bind`), with
 * `CLAW_GITHUB_MCP_BINDING_ENABLED` on: over the wire as Brain calls them (an MCP client with the signed session token), a real
 * PostgreSQL engine (PGlite) holding the session, the vault and GitHub review's audit log, a stand-in identity provider (the resolve
 * call) and a stand-in GitHub (`fetch`).
 *
 *   D1 the entry a turn is given: offered for a working binding, not for none, an expired one, the switch off, or an unreachable provider
 *   D2 the vault comes first: a GH_TOKEN is used and the identity provider is not asked
 *   D3 a read with the binding: the bound token goes to GitHub, the provider is told which tool, the call is in the audit log
 *   D4 a write with the binding: the same entry policy (held for the user), and an audit row that keeps no body text
 *   D5 a call whose audit row cannot be written is not made
 *   D6 refusals: expired, not bound, provider down
 *   D7 GET /v1/github/connection: which token the user's tools would use
 *   D8 the configuration a binding needs, and the router's line for a user without GitHub tools
 */
import assert from "node:assert/strict";
import test, { after, afterEach, before, beforeEach, describe } from "node:test";
import { randomBytes } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { IdentityCredentialRefusedError, IdentityUnavailableError, type ResolveCredentialRequest, type ResolvedCredential } from "@claw/utils";

process.env.USER_ENV_ENCRYPTION_KEY = randomBytes(32).toString("base64");

const { encryptUserEnvValue, initUserEnvCrypto } = await import("../src/crypto/user-env.js");
const { githubMcpServers, registerGithubMcpRoutes } = await import("../src/github-mcp/mcp.js");
const { READ_TOOLS } = await import("../src/github-mcp/tools.js");
const { githubMcpConfigErrors, readGithubMcpSettings } = await import("../src/github-mcp/settings.js");
const { mintSessionToolToken } = await import("../src/github-review/token.js");
const { GITHUB_REVIEW_SCHEMA_SQL } = await import("../src/github-review/store.js");
const { approvalPolicyFromMcp } = await import("../../brain/src/agent/approval-policy.js");
const { renderRouterReadSection } = await import("../src/assistant/prompts.js");
initUserEnvCrypto();

const SECRET = "g".repeat(40);
const VAULT_TOKEN = "ghp_VaultVaultVaultVaultVaultVaultVault1";
const BOUND_TOKEN = "gho_BoundBoundBoundBoundBoundBoundBound1";
const API = "https://github.api.test";
const settings = (over: Record<string, unknown> = {}) => ({
  enabled: true, binding: true, secret: SECRET, mcpUrl: "http://api.test/v1/internal/github/mcp", apiUrl: API, ...over,
});

const pg = new PGlite();
const db = {
  query: async (text: string, params?: unknown[]) => {
    const r = await pg.query(text, params);
    return { rows: r.rows as unknown[], rowCount: r.affectedRows ?? null };
  },
};
const sql = (text: string, params?: unknown[]) => pg.query(text, params);

// --- the identity provider: one binding per user, or a refusal, or an outage --------------------------------------------------

type Binding = { token: string; login: string; expiresAt: number | null } | "not_bound" | "expired" | "down";
let bindings: Record<string, Binding> = {};
let asked: ResolveCredentialRequest[] = [];
const resolveBinding = async (req: ResolveCredentialRequest): Promise<ResolvedCredential> => {
  asked.push(req);
  const b = bindings[req.userId] ?? "not_bound";
  if (b === "down") throw new IdentityUnavailableError("credential", "network");
  if (b === "not_bound" || b === "expired") throw new IdentityCredentialRefusedError(b, 400);
  return { token: b.token, providerLogin: b.login, kind: "oauth", scopes: ["public_repo"], delegation: false, expiresAt: b.expiresAt };
};

// --- GitHub ---------------------------------------------------------------------------------------------------------------------

interface Seen { method: string; url: string; authorization: string }
let seen: Seen[] = [];
let respond: (url: URL, init: RequestInit) => Response = () => new Response("{}", { status: 404 });
const fakeFetch = (async (input: URL | string, init: RequestInit = {}) => {
  const url = new URL(String(input));
  seen.push({ method: init.method ?? "GET", url: url.toString(), authorization: new Headers(init.headers).get("authorization") ?? "" });
  return respond(url, init);
}) as typeof fetch;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let app: FastifyInstance;
let base = "";
const clients: Client[] = [];

before(async () => {
  await pg.exec("CREATE TABLE claw_sessions (session_id TEXT PRIMARY KEY, user_id TEXT, config JSONB DEFAULT '{}'::jsonb, deleted_at TIMESTAMPTZ)");
  await pg.exec("CREATE TABLE claw_user_env_vars (user_id TEXT, key_name TEXT, key_value_enc TEXT, PRIMARY KEY (user_id, key_name))");
  app = Fastify();
  // What the API's auth middleware leaves on a request, for GET /v1/github/connection.
  app.addHook("onRequest", async (req) => {
    const who = req.headers["x-test-user"];
    if (typeof who === "string") (req as unknown as { user: unknown }).user = { userId: who };
  });
  await registerGithubMcpRoutes(app, { settings: () => settings(), db, fetchImpl: fakeFetch, resolveBinding });
  await app.listen({ port: 0, host: "127.0.0.1" });
  base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
});
after(async () => {
  app.server.closeAllConnections();
  await app.close();
  await pg.close();
});
beforeEach(async () => {
  seen = [];
  asked = [];
  bindings = { "u-alice": { token: BOUND_TOKEN, login: "alice-gh", expiresAt: Date.now() + 3600_000 } };
  await pg.exec("DROP TABLE IF EXISTS claw_github_audit");
  for (const stmt of GITHUB_REVIEW_SCHEMA_SQL) await pg.exec(stmt);
  await pg.exec("DELETE FROM claw_sessions; DELETE FROM claw_user_env_vars");
  await sql("INSERT INTO claw_sessions (session_id, user_id) VALUES ('s-1', 'u-alice')");
});
afterEach(async () => { for (const c of clients.splice(0)) await c.close().catch(() => undefined); });

const token = () => mintSessionToolToken({ sessionId: "s-1", requesterUserId: "u-alice", actorUserId: "u-alice" }, SECRET, 600, Date.now(), "claw-github-mcp");

async function connect(): Promise<Client> {
  const client = new Client({ name: "test", version: "1" });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/v1/internal/github/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token()}` } } }));
  return client;
}
async function status(): Promise<number | string> {
  const r = await fetch(`${base}/v1/internal/github/mcp`, {
    method: "POST", headers: { Authorization: `Bearer ${token()}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const text = await r.text();
  return r.status < 400 ? r.status : `${r.status} ${(JSON.parse(text) as { error?: string }).error}`;
}
const call = async (client: Client, name: string, args: Record<string, unknown>) => {
  const r = await client.callTool({ name, arguments: args }) as { content: Array<{ type: string; text: string }>; isError?: boolean };
  return { isError: r.isError === true, text: r.content[0]?.text ?? "" };
};
const auditRows = async () => (await sql(
  "SELECT requester_user_id, actor_user_id, session_id, tool, arguments, github_requests, write, result, repo, pr FROM claw_github_audit ORDER BY id",
)).rows as Array<Record<string, unknown>>;
const searchAnswer = (url: URL) => url.pathname === "/search/issues"
  ? json({ total_count: 2, incomplete_results: false, items: [
      { number: 1, title: "a", state: "open", html_url: "https://github.com/o/r/pull/1", repository_url: `${API}/repos/o/r`, user: { login: "alice-gh" }, pull_request: {} },
      { number: 2, title: "b", state: "open", html_url: "https://github.com/o/r/pull/2", repository_url: `${API}/repos/o/r`, user: { login: "alice-gh" }, pull_request: {} },
    ] })
  : json({}, 404);

describe("D a GitHub binding serves an owner who keeps no GH_TOKEN", () => {
  test("D1 the entry a turn is given: a working binding gets it; none, an expired one, the switch off or an unreachable provider do not", async () => {
    const servers = await githubMcpServers("s-1", { settings: () => settings(), db, resolveBinding });
    const entry = servers.github as Record<string, unknown>;
    assert.ok(entry, "offered for the binding");
    assert.deepEqual([entry.type, entry.url, entry.requires_approval], ["http", "http://api.test/v1/internal/github/mcp", true]);
    assert.ok(!JSON.stringify(entry).includes(BOUND_TOKEN), "the entry carries no GitHub credential");
    assert.deepEqual(asked.map((r) => [r.userId, r.provider, r.requesterUserId, r.purpose]), [["u-alice", "github", "u-alice", "github_mcp:offer"]]);

    assert.deepEqual(await githubMcpServers("s-1", { settings: () => settings({ binding: false }), db, resolveBinding }), {}, "the switch off");
    for (const b of ["not_bound", "expired", "down"] as const) {
      bindings["u-alice"] = b;
      assert.deepEqual(await githubMcpServers("s-1", { settings: () => settings(), db, resolveBinding }), {}, b);
    }
    bindings["u-alice"] = { token: BOUND_TOKEN, login: "alice-gh", expiresAt: Date.now() - 1000 };
    assert.deepEqual(await githubMcpServers("s-1", { settings: () => settings(), db, resolveBinding }), {}, "expiresAt passed");
  });

  test("D2 the vault comes first: a GH_TOKEN is used and the identity provider is not asked, nor the call audited here", async () => {
    await sql("INSERT INTO claw_user_env_vars VALUES ('u-alice', 'GH_TOKEN', $1)", [encryptUserEnvValue(VAULT_TOKEN)]);
    respond = searchAnswer;
    const r = await call(await connect(), "issue_search", { query: "is:pr is:open author:@me" });
    assert.equal(r.isError, false, r.text);
    assert.deepEqual(seen.map((s) => s.authorization), [`Bearer ${VAULT_TOKEN}`]);
    assert.deepEqual(asked, []);
    assert.deepEqual(await auditRows(), []);
    assert.ok((await githubMcpServers("s-1", { settings: () => settings(), db, resolveBinding })).github);
    assert.deepEqual(asked, [], "the dispatch did not ask either");
  });

  test("D3 a read with the binding: the bound token goes to GitHub, the provider is told which tool, and the call is audited", async () => {
    respond = searchAnswer;
    const r = await call(await connect(), "issue_search", { query: "is:pr is:open author:@me" });
    assert.equal(r.isError, false, r.text);
    assert.equal(JSON.parse(r.text).total_count, 2);
    assert.deepEqual(seen.map((s) => [s.method, new URL(s.url).pathname, s.authorization]), [["GET", "/search/issues", `Bearer ${BOUND_TOKEN}`]]);
    assert.ok(asked.some((q) => q.purpose === "github_mcp:issue_search" && q.userId === "u-alice" && q.requesterUserId === "u-alice"),
      JSON.stringify(asked.map((q) => q.purpose)));
    const rows = await auditRows();
    assert.equal(rows.length, 1);
    assert.deepEqual(
      [rows[0].requester_user_id, rows[0].actor_user_id, rows[0].session_id, rows[0].tool, rows[0].github_requests, rows[0].write, rows[0].result],
      ["u-alice", "u-alice", "s-1", "github_mcp.issue_search", 1, false, "ok"],
    );
    assert.equal((rows[0].arguments as Record<string, unknown>).query, "is:pr is:open author:@me");
  });

  test("D4 a write with the binding is held for the user like any other, and its audit row keeps no body text", async () => {
    // The entry Brain is given for a binding is the same policy as for a GH_TOKEN: every write waits, the reads run.
    const policy = approvalPolicyFromMcp(await githubMcpServers("s-1", { settings: () => settings(), db, resolveBinding }));
    for (const t of READ_TOOLS) assert.notEqual(policy.autoApprovalRule(`mcp__github__${t}`, {}), null, t);
    for (const t of ["issue_comment", "pr_create", "pr_update", "a_tool_added_later"]) {
      assert.equal(policy.requiresApproval(`mcp__github__${t}`), true, t);
      assert.equal(policy.autoApprovalRule(`mcp__github__${t}`, {}), null, t);
    }
    // Once the user approved it, the call is made with the binding and written down.
    respond = (url) => url.pathname === "/repos/o/r/issues/7/comments" ? json({ id: 99, html_url: "https://github.com/o/r/pull/7#c" }, 201) : json({}, 404);
    const body = "a private remark that must not be copied into the audit log";
    const r = await call(await connect(), "issue_comment", { repo: "o/r", number: 7, body });
    assert.equal(r.isError, false, r.text);
    assert.deepEqual(seen.map((s) => [s.method, s.authorization]), [["POST", `Bearer ${BOUND_TOKEN}`]]);
    const rows = await auditRows();
    assert.deepEqual([rows.length, rows[0].tool, rows[0].write, rows[0].result, rows[0].repo, rows[0].pr], [1, "github_mcp.issue_comment", true, "ok", "o/r", 7]);
    assert.equal((rows[0].arguments as Record<string, unknown>).body, `[${body.length} characters]`);
    assert.ok(!JSON.stringify(rows).includes("private remark"));
    // It is the owner's own write, not a review: GitHub review's hourly count and its session budget do not see it.
    const { recentWrites, sessionRequestCount } = await import("../src/github-review/store.js");
    assert.equal((await recentWrites(db, "u-alice", 3_600_000)).count, 0);
    assert.equal((await recentWrites(db, null, 3_600_000)).count, 0);
    assert.equal(await sessionRequestCount(db, "s-1"), 0);
    await sql("INSERT INTO claw_github_audit (requester_user_id, actor_user_id, session_id, tool, write, github_requests, head_sha) VALUES ('u-alice', 'u-alice', 's-1', 'gh_review_submit', TRUE, 2, 'abc')");
    assert.equal((await recentWrites(db, "u-alice", 3_600_000)).count, 1, "a review still counts");
    assert.equal(await sessionRequestCount(db, "s-1"), 2);
  });

  test("D4b a call GitHub refuses is audited as refused", async () => {
    respond = () => json({ message: "Not Found" }, 404);
    const r = await call(await connect(), "pr_get", { repo: "o/r", number: 5 });
    assert.equal(r.isError, true);
    const rows = await auditRows();
    assert.deepEqual([rows.length, rows[0].tool, rows[0].result, rows[0].write], [1, "github_mcp.pr_get", "refused", false]);
  });

  test("D5 a call whose audit row cannot be written is not made", async () => {
    await pg.exec("DROP TABLE claw_github_audit");
    respond = searchAnswer;
    const r = await call(await connect(), "issue_search", { query: "is:pr is:open author:@me" });
    assert.equal(r.isError, true);
    assert.match(r.text, /could not be recorded/);
    assert.deepEqual(seen, [], "GitHub was not asked");
  });

  test("D6 refused without the token: an expired binding, none, or a provider that cannot be asked", async () => {
    assert.equal(await status(), 200, "a working binding");
    bindings["u-alice"] = "expired";
    assert.equal(await status(), "403 github_binding_expired");
    bindings["u-alice"] = { token: BOUND_TOKEN, login: "alice-gh", expiresAt: Date.now() - 1 };
    assert.equal(await status(), "403 github_binding_expired", "expiresAt passed");
    bindings["u-alice"] = "not_bound";
    assert.equal(await status(), "403 no_github_token");
    bindings["u-alice"] = "down";
    assert.equal(await status(), "503 unavailable", "unknown is not 'not bound'");
    assert.deepEqual(seen, []);
  });

  test("D7 GET /v1/github/connection says which token the user's tools would use, and never the token", async () => {
    const ask = async (user?: string) => {
      const r = await fetch(`${base}/v1/github/connection`, { headers: user ? { "x-test-user": user } : {} });
      return { status: r.status, text: await r.text() };
    };
    assert.equal((await ask()).status, 401);
    let r = await ask("u-alice");
    assert.deepEqual(JSON.parse(r.text).data, { reads_with: "binding", login: "alice-gh", missing: null, binding_reads: true });
    assert.ok(!r.text.includes(BOUND_TOKEN));
    assert.equal(asked.at(-1)?.purpose, "github_mcp:connection");
    bindings["u-alice"] = "expired";
    assert.deepEqual(JSON.parse((await ask("u-alice")).text).data, { reads_with: null, login: "", missing: "expired", binding_reads: true });
    bindings["u-alice"] = "not_bound";
    assert.deepEqual(JSON.parse((await ask("u-alice")).text).data, { reads_with: null, login: "", missing: "none", binding_reads: true });
    await sql("INSERT INTO claw_user_env_vars VALUES ('u-alice', 'GH_TOKEN', $1)", [encryptUserEnvValue(VAULT_TOKEN)]);
    r = await ask("u-alice");
    assert.deepEqual(JSON.parse(r.text).data, { reads_with: "env", login: "", missing: null, binding_reads: true });
    assert.ok(!r.text.includes(VAULT_TOKEN));
    bindings["u-alice"] = "down";
    await pg.exec("DELETE FROM claw_user_env_vars");
    assert.equal((await ask("u-alice")).status, 503);
  });
});

describe("D8 configuration and the router's words", () => {
  test("D8a the binding is off unless both switches are on, and on it needs the identity client and GitHub review", () => {
    assert.equal(readGithubMcpSettings({}, false, true).binding, false, "the tools off");
    assert.equal(readGithubMcpSettings({}, true, false).binding, false);
    const on = { ...readGithubMcpSettings({ CLAW_GITHUB_MCP_SECRET: SECRET }, true, true) };
    assert.equal(on.binding, true);
    assert.deepEqual(githubMcpConfigErrors(on, true, true), []);
    assert.match(githubMcpConfigErrors(on, false, true).join(";"), /IDENTITY_CLIENT_ENABLED/);
    assert.match(githubMcpConfigErrors(on, true, false).join(";"), /CLAW_GITHUB_REVIEW_ENABLED/);
    assert.deepEqual(githubMcpConfigErrors({ ...on, binding: false }), [], "without the binding nothing more is needed");
  });

  test("D8b a router turn without GitHub tools names /github bind where a binding counts (never as a fact to a user whose binding could not be read), and says what it said before where not", () => {
    const withBinding = renderRouterReadSection({ servers: [], github: [], githubBinding: true });
    assert.match(withBinding, /\/github bind/);
    assert.doesNotMatch(withBinding, /may not have linked a GitHub token/);
    // The turn has no GitHub tools either when the identity provider could not be asked (githubMcpServers offers none then): a bound
    // user is not told as a fact that they never connected GitHub.
    assert.match(withBinding, /could not be read just now/);
    assert.match(withBinding, /if they have not connected it/);
    const without = renderRouterReadSection({ servers: [], github: [] });
    assert.doesNotMatch(without, /\/github bind/);
    assert.match(without, /may not have linked a GitHub token/);
    assert.doesNotMatch(renderRouterReadSection({ servers: [], github: ["issue_search"], githubBinding: true }), /\/github bind/, "a user with the tools");
  });
});
