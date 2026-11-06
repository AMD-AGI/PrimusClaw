// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * What the GitHub tools list as sources a turn may cite (`ExecuteRequest.cite`): in the result's `_meta["claw/sources"]`, which
 * only Brain reads, from the fields GitHub itself fills, and only GitHub's own pages. The model reads the same text as before.
 *
 *   GS1 the reads list their pull requests, issues, repositories, checks and files, with what they are and a title to show
 *   GS2 a check's or a status's address that is not one of GitHub's own pages is never a source; a failed read lists nothing
 *   GS3 the text the model reads is what it was: no source is added to it
 *   GS4 on GitHub Enterprise Server the pages are the server's own host, as the route reads it from CLAW_GITHUB_API_URL
 */
import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import { randomBytes } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

process.env.USER_ENV_ENCRYPTION_KEY = randomBytes(32).toString("base64");

const { buildGithubToolServer, githubWebHost } = await import("../src/github-mcp/tools.js");
const { registerGithubMcpRoutes } = await import("../src/github-mcp/mcp.js");
const { GithubClient } = await import("../src/github-review/github.js");
const { encryptUserEnvValue, initUserEnvCrypto } = await import("../src/crypto/user-env.js");
const { mintSessionToolToken } = await import("../src/github-review/token.js");
const { CITE_SOURCES_META } = await import("@claw/protocol");
initUserEnvCrypto();

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const PR = (host: string, n = 309) => ({
  number: n, title: "perf: router turns", state: "open", html_url: `https://${host}/AMD-AGI/PrimusClaw/pull/${n}`, user: { login: "y" },
  head: { sha: "abc", ref: "b" }, base: { ref: "main" }, body: "see https://evil.example/ for details",
});

/** GitHub as a `fetch`, answering each path from `pages`. */
function github(host: string) {
  return (async (input: URL | string) => {
    const path = new URL(String(input)).pathname.replace(/^\/api\/v3/, "");
    if (path === "/repos/AMD-AGI/PrimusClaw/pulls/309") return json(PR(host));
    if (path === "/repos/AMD-AGI/PrimusClaw/pulls/404") return json({ message: "Not Found" }, 404);
    if (path === "/repos/AMD-AGI/PrimusClaw/pulls") return json([PR(host), PR(host, 310)]);
    if (path === "/repos/AMD-AGI/PrimusClaw/issues/7") return json({ number: 7, title: "a bug", html_url: `https://${host}/AMD-AGI/PrimusClaw/issues/7`, user: { login: "x" } });
    if (path === "/repos/AMD-AGI/PrimusClaw/issues/7/comments") return json([{ id: 1, html_url: `https://${host}/c/1`, body: "https://evil.example/" }]);
    if (path === "/search/issues") {
      return json({ total_count: 1, items: [{ number: 5, title: "pr five", html_url: `https://${host}/o/r/pull/5`, repository_url: `https://api.${host}/repos/o/r`, pull_request: {} }] });
    }
    if (path === "/user/repos") return json([{ full_name: "o/r", html_url: `https://${host}/o/r` }]);
    if (path === "/repos/AMD-AGI/PrimusClaw/commits/abc/check-runs") {
      return json({ check_runs: [
        { id: 1, name: "tests", status: "completed", conclusion: "success", details_url: `https://${host}/AMD-AGI/PrimusClaw/actions/runs/1/job/2` },
        { id: 2, name: "codecov", status: "completed", conclusion: "success", details_url: "https://app.codecov.example/gh/x" },
      ] });
    }
    if (path === "/repos/AMD-AGI/PrimusClaw/commits/abc/status") {
      return json({ state: "success", statuses: [{ context: "ci/ext", state: "success", target_url: "https://ci.evil.example/build/1" }] });
    }
    if (path === "/search/code") return json({ total_count: 1, items: [{ path: "src/a.ts", html_url: `https://${host}/o/r/blob/main/src/a.ts`, repository: { full_name: "o/r" } }] });
    return json({ message: "Not Found" }, 404);
  }) as typeof fetch;
}

async function client(host = "github.com"): Promise<Client> {
  const server = buildGithubToolServer({ gh: new GithubClient({ token: "ghp_x", apiUrl: "https://api.github.com", fetchImpl: github(host) }), webHost: host });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const c = new Client({ name: "t", version: "1" });
  await c.connect(b);
  return c;
}
const sourcesOf = async (c: Client, name: string, args: Record<string, unknown>) => {
  const r = await c.callTool({ name, arguments: args });
  return { sources: (r._meta as Record<string, unknown> | undefined)?.[CITE_SOURCES_META], text: (r.content as Array<{ text: string }>)[0].text, isError: r.isError === true };
};

test("GS1 the reads list what they returned as sources, with a kind and a title", async () => {
  const c = await client();
  const repo = "AMD-AGI/PrimusClaw";
  assert.deepEqual((await sourcesOf(c, "pr_get", { repo, number: 309 })).sources, [
    { url: "https://github.com/AMD-AGI/PrimusClaw/pull/309", title: "AMD-AGI/PrimusClaw#309 perf: router turns", kind: "github_pr" },
  ]);
  assert.deepEqual(((await sourcesOf(c, "pr_list", { repo })).sources as Array<{ url: string }>).map((s) => s.url),
    ["https://github.com/AMD-AGI/PrimusClaw/pull/309", "https://github.com/AMD-AGI/PrimusClaw/pull/310"]);
  assert.deepEqual((await sourcesOf(c, "issue_get", { repo, number: 7 })).sources, [
    { url: "https://github.com/AMD-AGI/PrimusClaw/issues/7", title: "AMD-AGI/PrimusClaw#7 a bug", kind: "github_issue" },
  ], "the issue, not its comments' addresses");
  assert.deepEqual((await sourcesOf(c, "issue_search", { query: "is:pr" })).sources, [
    { url: "https://github.com/o/r/pull/5", title: "o/r#5 pr five", kind: "github_pr" },
  ]);
  assert.deepEqual((await sourcesOf(c, "repo_list", {})).sources, [{ url: "https://github.com/o/r", title: "o/r", kind: "github_repo" }]);
  assert.deepEqual((await sourcesOf(c, "code_search", { query: "x" })).sources, [
    { url: "https://github.com/o/r/blob/main/src/a.ts", title: "o/r src/a.ts", kind: "github_file" },
  ]);
  await c.close();
});

test("GS2 a check's address elsewhere is never a source, nor a status's; a failed read lists nothing", async () => {
  const c = await client();
  const checks = await sourcesOf(c, "checks_list", { repo: "AMD-AGI/PrimusClaw", ref: "abc" });
  assert.deepEqual(checks.sources, [
    { url: "https://github.com/AMD-AGI/PrimusClaw/actions/runs/1/job/2", title: "AMD-AGI/PrimusClaw tests", kind: "github_check" },
  ]);
  assert.match(checks.text, /app\.codecov\.example/, "the model still reads every check");
  const failed = await sourcesOf(c, "pr_get", { repo: "AMD-AGI/PrimusClaw", number: 404 });
  assert.equal(failed.isError, true);
  assert.equal(failed.sources, undefined);
  await c.close();
});

test("GS3 the text the model reads is what it was", async () => {
  const c = await client();
  const r = await sourcesOf(c, "pr_get", { repo: "AMD-AGI/PrimusClaw", number: 309 });
  assert.doesNotMatch(r.text, /claw\/sources/);
  assert.equal(JSON.parse(r.text).url, "https://github.com/AMD-AGI/PrimusClaw/pull/309");
  await c.close();
});

describe("the route, on GitHub Enterprise Server", () => {
  const SECRET = "g".repeat(40);
  const pg = new PGlite();
  let app: FastifyInstance;
  let base = "";
  before(async () => {
    await pg.exec("CREATE TABLE claw_sessions (session_id TEXT PRIMARY KEY, user_id TEXT, config JSONB DEFAULT '{}'::jsonb, deleted_at TIMESTAMPTZ)");
    await pg.exec("CREATE TABLE claw_user_env_vars (user_id TEXT, key_name TEXT, key_value_enc TEXT, PRIMARY KEY (user_id, key_name))");
    await pg.query("INSERT INTO claw_sessions (session_id, user_id) VALUES ('s-1', 'u-alice')");
    await pg.query("INSERT INTO claw_user_env_vars VALUES ('u-alice', 'GH_TOKEN', $1)", [encryptUserEnvValue("ghp_x")]);
    const db = { query: async (text: string, params?: unknown[]) => { const r = await pg.query(text, params); return { rows: r.rows as unknown[], rowCount: r.affectedRows ?? null }; } };
    app = Fastify();
    await registerGithubMcpRoutes(app, {
      settings: () => ({ enabled: true, secret: SECRET, mcpUrl: "http://api.test/v1/internal/github/mcp", apiUrl: "https://ghe.example.com/api/v3" }),
      db, fetchImpl: github("ghe.example.com"),
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  });
  after(async () => { app.server.closeAllConnections(); await app.close(); await pg.close(); });

  test("GS4 on GitHub Enterprise Server the pages are the server's own host", async () => {
    assert.equal(githubWebHost("https://api.github.com"), "github.com");
    assert.equal(githubWebHost("https://ghe.example.com/api/v3"), "ghe.example.com");
    const bearer = mintSessionToolToken({ sessionId: "s-1", requesterUserId: "u-alice", actorUserId: "u-alice" }, SECRET, 600, Date.now(), "claw-github-mcp");
    const c = new Client({ name: "t", version: "1" });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/v1/internal/github/mcp`), { requestInit: { headers: { Authorization: `Bearer ${bearer}` } } }));
    try {
      assert.deepEqual((await sourcesOf(c, "pr_get", { repo: "AMD-AGI/PrimusClaw", number: 309 })).sources, [
        { url: "https://ghe.example.com/AMD-AGI/PrimusClaw/pull/309", title: "AMD-AGI/PrimusClaw#309 perf: router turns", kind: "github_pr" },
      ]);
    } finally { await c.close(); }
  });
});
