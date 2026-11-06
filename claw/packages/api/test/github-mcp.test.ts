// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The GitHub tools over the wire, the way Brain uses them: an MCP client with the signed session token against
 * the API's own route, a real PostgreSQL engine (PGlite) holding the session and the owner's encrypted vault, and a
 * stand-in for GitHub as a `fetch`.
 *
 *   A  who may call: the token (and what it was minted for), the session row, its owner, the owner's GitHub token
 *   B  what a call does: which token goes where, refusals before any request, errors as errors, nothing secret; the
 *      searches and lists a question needs (the user's open pull requests, their repositories, a pull request's reviews)
 *   C  the entry a turn is given: only for an owner who keeps a token, never for a session acting as someone else,
 *      and a policy Brain reads as "every write waits, the reads run"
 */
import assert from "node:assert/strict";
import test, { after, afterEach, before, beforeEach, describe } from "node:test";
import { randomBytes } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

process.env.USER_ENV_ENCRYPTION_KEY = randomBytes(32).toString("base64");

const { encryptUserEnvValue, initUserEnvCrypto } = await import("../src/crypto/user-env.js");
const { githubMcpServers, registerGithubMcpRoutes } = await import("../src/github-mcp/mcp.js");
const { READ_TOOLS, MAX_LOG_BYTES } = await import("../src/github-mcp/tools.js");
const { mintSessionToolToken, verifySessionToolToken } = await import("../src/github-review/token.js");
const { approvalPolicyFromMcp } = await import("../../brain/src/agent/approval-policy.js");
const { readGithubMcpSettings } = await import("../src/github-mcp/settings.js");
const { isPlatformMcpServer } = await import("@claw/protocol");
initUserEnvCrypto();

const SECRET = "g".repeat(40);
const GH_TOKEN = "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
const API = "https://github.api.test";
const settings = (over: Record<string, unknown> = {}) => ({ enabled: true, secret: SECRET, mcpUrl: "http://api.test/v1/internal/github/mcp", apiUrl: API, ...over });

const pg = new PGlite();
const db = {
  query: async (text: string, params?: unknown[]) => {
    const r = await pg.query(text, params);
    return { rows: r.rows as unknown[], rowCount: r.affectedRows ?? null };
  },
};
const sql = (text: string, params?: unknown[]) => pg.query(text, params);

interface Seen { method: string; url: string; authorization: string; body: unknown }
let seen: Seen[] = [];
let respond: (url: URL, init: RequestInit) => Response = () => new Response("{}", { status: 404 });
const fakeFetch = (async (input: URL | string, init: RequestInit = {}) => {
  const url = new URL(String(input));
  const headers = new Headers(init.headers);
  seen.push({ method: init.method ?? "GET", url: url.toString(), authorization: headers.get("authorization") ?? "", body: init.body ? JSON.parse(String(init.body)) : undefined });
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
  await registerGithubMcpRoutes(app, { settings: () => settings(), db, fetchImpl: fakeFetch });
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
  await pg.exec("DELETE FROM claw_sessions; DELETE FROM claw_user_env_vars");
  await sql("INSERT INTO claw_sessions (session_id, user_id) VALUES ('s-1', 'u-alice')");
  await sql("INSERT INTO claw_user_env_vars VALUES ('u-alice', 'GH_TOKEN', $1)", [encryptUserEnvValue(GH_TOKEN)]);
});
afterEach(async () => { for (const c of clients.splice(0)) await c.close().catch(() => undefined); });

const token = (over: Partial<{ sessionId: string; requesterUserId: string; actorUserId: string }> = {}, opts: { ttl?: number; purpose?: "claw-github-mcp" | "claw-github-review" } = {}) =>
  mintSessionToolToken({ sessionId: "s-1", requesterUserId: "u-alice", actorUserId: "u-alice", ...over }, SECRET, opts.ttl ?? 600, Date.now(), opts.purpose ?? "claw-github-mcp");

async function connect(bearer: string): Promise<Client> {
  const client = new Client({ name: "test", version: "1" });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/v1/internal/github/mcp`), { requestInit: { headers: { Authorization: `Bearer ${bearer}` } } }));
  return client;
}
/** The answer's status, and for a refusal its `error`: which check refused, not only that one did. */
async function status(bearer: string): Promise<number | string> {
  const r = await fetch(`${base}/v1/internal/github/mcp`, {
    method: "POST", headers: { Authorization: `Bearer ${bearer}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const text = await r.text();
  if (r.status < 400) return r.status;
  return `${r.status} ${(JSON.parse(text) as { error?: string }).error}`;
}
const call = async (client: Client, name: string, args: Record<string, unknown>) => {
  const r = await client.callTool({ name, arguments: args }) as { content: Array<{ type: string; text: string }>; isError?: boolean };
  return { isError: r.isError === true, text: r.content[0]?.text ?? "" };
};

const WRITE_TOOLS = ["issue_comment", "issue_create", "pr_create", "pr_update", "review_thread_reply", "review_thread_resolve"];

describe("A who may call", () => {
  test("A1 a valid token lists the read and the write tools", async () => {
    const c = await connect(token());
    const names = (await c.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(names, [...READ_TOOLS, ...WRITE_TOOLS].sort());
  });

  test("A2 a token minted for the review tools, under the same secret, is not accepted", async () => {
    assert.equal(await status(token({}, { purpose: "claw-github-review" })), "401 invalid_token");
    assert.equal(await status(token({}, { ttl: -5 })), "401 invalid_token", "expired");
    assert.equal(await status(`${token()}x`), "401 invalid_token", "bad signature");
  });

  test("A3 the session row decides: gone, another owner, or acting as someone else is refused", async () => {
    // Mallory keeps a token of her own, so only the owner check can refuse her.
    await sql("INSERT INTO claw_user_env_vars VALUES ('u-mallory', 'GH_TOKEN', $1)", [encryptUserEnvValue("ghp_mallory")]);
    assert.equal(await status(token()), 200, "the owner");
    assert.equal(await status(token({ requesterUserId: "u-mallory", actorUserId: "u-mallory" })), "403 session_mismatch", "not the owner");
    assert.equal(await status(token({ actorUserId: "u-bob" })), "403 session_mismatch", "a token naming another actor");
    await sql("UPDATE claw_sessions SET config = $1::jsonb WHERE session_id = 's-1'", [JSON.stringify({ acting_as: "u-bob" })]);
    assert.equal(await status(token()), "403 session_mismatch", "acting as another user");
    await sql("UPDATE claw_sessions SET config = '{}'::jsonb, deleted_at = now() WHERE session_id = 's-1'");
    assert.equal(await status(token()), "403 session_mismatch", "deleted");
  });

  test("A4 an owner who keeps no GitHub token is refused", async () => {
    await pg.exec("DELETE FROM claw_user_env_vars");
    assert.equal(await status(token()), "403 no_github_token");
  });
});

describe("B what a call does", () => {
  test("B1 a read goes to the configured GitHub with the owner's own token", async () => {
    respond = (url) => url.pathname === "/repos/AMD-AGI/demo/pulls/7"
      ? json({ number: 7, title: "t", state: "open", user: { login: "alice" }, head: { sha: "abc", ref: "feat" }, base: { ref: "main" }, body: "b" })
      : json({}, 404);
    const r = await call(await connect(token()), "pr_get", { repo: "AMD-AGI/demo", number: 7 });
    assert.equal(r.isError, false);
    assert.deepEqual([seen.length, seen[0].method, seen[0].url, seen[0].authorization], [1, "GET", `${API}/repos/AMD-AGI/demo/pulls/7`, `Bearer ${GH_TOKEN}`]);
    const pr = JSON.parse(r.text);
    assert.deepEqual([pr.number, pr.author, pr.head_sha, pr.base], [7, "alice", "abc", "main"]);
  });

  test("B2 arguments that could aim the call elsewhere are refused before any request", async () => {
    const c = await connect(token());
    for (const [tool, args] of [
      ["pr_get", { repo: "../../user", number: 1 }],
      ["pr_get", { repo: "evil.example/x/y", number: 1 }],
      ["repo_get_file", { repo: "o/r", path: "a/../../secrets" }],
      ["checks_list", { repo: "o/r", ref: "../../x" }],
    ] as const) {
      const r = await call(c, tool, args as Record<string, unknown>);
      assert.equal(r.isError, true, `${tool} ${JSON.stringify(args)}`);
    }
    assert.equal(seen.length, 0);
  });

  test("B3 GitHub's refusal comes back as an error, with the token taken out of it", async () => {
    respond = () => json({ message: `Bad credentials for ${GH_TOKEN}` }, 401);
    const r = await call(await connect(token()), "issue_get", { repo: "o/r", number: 3 });
    assert.equal(r.isError, true);
    assert.match(r.text, /GitHub answered 401/);
    assert.ok(!r.text.includes(GH_TOKEN));
  });

  test("B4 a job log follows GitHub's signed address without the token, and returns the end", async () => {
    respond = (url) => url.hostname === "github.api.test"
      ? new Response(null, { status: 302, headers: { location: "https://logs.blob.test/job/9?sig=x" } })
      : new Response(Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n"), { status: 200 });
    const r = await call(await connect(token()), "job_logs", { repo: "o/r", job_id: 9, tail_lines: 2 });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.text, "[298 earlier lines not shown]\nline 298\nline 299");
    assert.deepEqual(seen.map((s) => [s.url, s.authorization]), [
      [`${API}/repos/o/r/actions/jobs/9/logs`, `Bearer ${GH_TOKEN}`],
      ["https://logs.blob.test/job/9?sig=x", ""],
    ]);
  });

  test("B4b a log longer than the kept tail is read as a stream, never whole, and its end comes back intact", async () => {
    const line = (i: number) => `line ${String(i).padStart(9, "0")} ${"x".repeat(48)}\n`;
    const perChunk = 1024;
    const chunks = Math.ceil((3 * MAX_LOG_BYTES) / (perChunk * line(0).length));
    let pulled = 0;
    let buffered = "";
    const body = () => new ReadableStream<Uint8Array>({
      pull(c) {
        if (pulled === chunks) { c.close(); return; }
        const first = pulled++ * perChunk;
        c.enqueue(Buffer.from(Array.from({ length: perChunk }, (_, i) => line(first + i)).join("")));
      },
    });
    respond = (url) => {
      if (url.hostname === "github.api.test") return new Response(null, { status: 302, headers: { location: "https://logs.blob.test/job/9?sig=x" } });
      const res = new Response(body(), { status: 200 });
      for (const whole of ["arrayBuffer", "text", "blob", "bytes", "json", "formData"]) {
        Object.defineProperty(res, whole, { value: () => { buffered = whole; throw new Error(`the whole log was buffered (${whole})`); } });
      }
      return res;
    };
    const r = await call(await connect(token()), "job_logs", { repo: "o/r", job_id: 9, tail_lines: 3 });
    assert.equal(buffered, "", "the log body was read whole");
    assert.equal(r.isError, false, r.text);
    const last = chunks * perChunk - 1;
    const keptLines = Math.floor(MAX_LOG_BYTES / line(0).length);
    assert.equal(pulled, chunks, "the whole log was read");
    // The kept tail starts on a line boundary and ends with a newline, so the last of the 3 lines is the empty one after it.
    assert.equal(r.text, `[${keptLines - 2} earlier lines not shown]\n${line(last - 1)}${line(last)}`);
  });

  test("B4c one chunk larger than the kept tail is cut to its end", async () => {
    const line = (i: number) => `line ${String(i).padStart(9, "0")} ${"y".repeat(48)}\n`;
    const n = (2 * MAX_LOG_BYTES) / line(0).length + 5;
    const big = Buffer.from(Array.from({ length: n }, (_, i) => line(i)).join(""));
    respond = (url) => url.hostname === "github.api.test"
      ? new Response(null, { status: 302, headers: { location: "https://logs.blob.test/job/9?sig=x" } })
      : new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(big); c.enqueue(Buffer.from("tail\n")); c.close(); } }), { status: 200 });
    const r = await call(await connect(token()), "job_logs", { repo: "o/r", job_id: 9, tail_lines: 3 });
    assert.equal(r.isError, false, r.text);
    // 5 bytes of "tail\n" push the cut 5 bytes into a line, which comes back as a partial first line.
    assert.equal(r.text, `[${MAX_LOG_BYTES / line(0).length - 1} earlier lines not shown]\n${line(n - 1)}tail\n`);
  });

  test("B5 a write sends exactly what was asked", async () => {
    respond = () => json({ number: 7, title: "new", state: "closed", head: { sha: "abc" }, base: { ref: "main" } });
    const r = await call(await connect(token()), "pr_update", { repo: "o/r", number: 7, title: "new", state: "closed" });
    assert.equal(r.isError, false);
    assert.deepEqual([seen[0].method, seen[0].url, seen[0].body], ["PATCH", `${API}/repos/o/r/pulls/7`, { title: "new", state: "closed" }]);
  });
});

describe("B the reads a question needs", () => {
  test("B6 issue_search asks GitHub's search as the user and answers with the count and each match's repository", async () => {
    respond = (url) => url.pathname === "/search/issues"
      ? json({
          total_count: 3, incomplete_results: false,
          items: [
            { number: 300, title: "router reads", state: "open", user: { login: "alice" }, html_url: "https://github.com/AMD-AGI/PrimusClaw/pull/300", repository_url: `${API}/repos/AMD-AGI/PrimusClaw`, pull_request: {}, draft: false, comments: 2, labels: [{ name: "enhancement" }] },
            { number: 12, title: "fix", state: "open", user: { login: "alice" }, html_url: "https://github.com/o/r/pull/12", repository_url: `${API}/repos/o/r`, pull_request: {}, draft: true, comments: 0, labels: [] },
            { number: 5, title: "an issue", state: "open", user: { login: "alice" }, html_url: "https://github.com/o/r/issues/5", repository_url: `${API}/repos/o/r`, comments: 0, labels: [] },
          ],
        })
      : json({}, 404);
    const r = await call(await connect(token()), "issue_search", { query: "is:pr is:open author:@me" });
    assert.equal(r.isError, false, r.text);
    assert.equal(seen.length, 1);
    const url = new URL(seen[0].url);
    assert.deepEqual([url.origin + url.pathname, seen[0].authorization], [`${API}/search/issues`, `Bearer ${GH_TOKEN}`]);
    assert.deepEqual(Object.fromEntries(url.searchParams), { q: "is:pr is:open author:@me", sort: "updated", order: "desc", per_page: "20", page: "1" });
    const found = JSON.parse(r.text);
    assert.equal(found.total_count, 3);
    assert.deepEqual(found.items.map((i: any) => [i.repo, i.number, i.is_pull_request, i.draft]), [
      ["AMD-AGI/PrimusClaw", 300, true, false], ["o/r", 12, true, true], ["o/r", 5, false, undefined],
    ]);
  });

  test("B7 repo_list: the user's own repositories, an organization's, or a user's when the login is not an organization", async () => {
    const repo = (full: string) => ({ full_name: full, private: true, archived: false, fork: false, default_branch: "main", html_url: `https://github.com/${full}`, pushed_at: "2026-11-06T00:00:00Z", open_issues_count: 4 });
    respond = (url) => {
      if (url.pathname === "/user/repos") return json([repo("alice/mine")]);
      if (url.pathname === "/orgs/AMD-AGI/repos") return json([repo("AMD-AGI/PrimusClaw")]);
      if (url.pathname === "/users/bob/repos") return json([repo("bob/theirs")]);
      return json({ message: "Not Found" }, 404);
    };
    const c = await connect(token());
    const names = async (args: Record<string, unknown>) => {
      const r = await call(c, "repo_list", args);
      assert.equal(r.isError, false, r.text);
      return JSON.parse(r.text).map((x: any) => x.repo);
    };
    assert.deepEqual(await names({}), ["alice/mine"]);
    assert.deepEqual(await names({ owner: "AMD-AGI" }), ["AMD-AGI/PrimusClaw"]);
    assert.deepEqual(await names({ owner: "bob" }), ["bob/theirs"]);
    assert.deepEqual(seen.map((x) => new URL(x.url).pathname), ["/user/repos", "/orgs/AMD-AGI/repos", "/orgs/bob/repos", "/users/bob/repos"]);
    assert.ok(seen.every((x) => x.authorization === `Bearer ${GH_TOKEN}` && new URL(x.url).searchParams.get("sort") === "pushed"));
    seen = [];
    const bad = await call(c, "repo_list", { owner: "../user" });
    assert.equal(bad.isError, true);
    assert.equal(seen.length, 0, "a login that could aim the call elsewhere is refused before any request");
  });

  test("B8 pr_reviews: each review's author, verdict, time, commit and text", async () => {
    respond = (url) => url.pathname === "/repos/o/r/pulls/7/reviews"
      ? json([
          { id: 1, user: { login: "carol" }, state: "CHANGES_REQUESTED", submitted_at: "2026-11-05T01:00:00Z", commit_id: "abc", body: "fix the test" },
          { id: 2, user: { login: "dave" }, state: "APPROVED", submitted_at: "2026-11-05T02:00:00Z", commit_id: "def", body: null },
        ])
      : json({}, 404);
    const r = await call(await connect(token()), "pr_reviews", { repo: "o/r", number: 7 });
    assert.equal(r.isError, false, r.text);
    assert.deepEqual(JSON.parse(r.text).map((x: any) => [x.author, x.state, x.commit, x.body]), [
      ["carol", "CHANGES_REQUESTED", "abc", "fix the test"], ["dave", "APPROVED", "def", ""],
    ]);
    assert.equal(seen[0].authorization, `Bearer ${GH_TOKEN}`);
  });
});

describe("C the entry a turn is given", () => {
  test("C1 for an owner who keeps a token: signed for these tools only, every write held, the reads released", async () => {
    const servers = await githubMcpServers("s-1", { settings: () => settings(), db });
    const entry = servers.github as Record<string, unknown>;
    assert.ok(entry);
    assert.deepEqual([entry.type, entry.url, entry.requires_approval], ["http", "http://api.test/v1/internal/github/mcp", true]);
    assert.ok(verifySessionToolToken(entry.token as string, SECRET, Date.now(), "claw-github-mcp").ok);
    assert.equal(verifySessionToolToken(entry.token as string, SECRET).ok, false, "not a review token");
    // Brain's own reading of the entry.
    const policy = approvalPolicyFromMcp(servers);
    for (const t of [...READ_TOOLS, ...WRITE_TOOLS]) assert.equal(policy.requiresApproval(`mcp__github__${t}`), true, t);
    for (const t of READ_TOOLS) assert.notEqual(policy.autoApprovalRule(`mcp__github__${t}`, {}), null, t);
    for (const t of [...WRITE_TOOLS, "a_tool_added_later"]) assert.equal(policy.autoApprovalRule(`mcp__github__${t}`, {}), null, t);
    // The platform's hold, like the trigger tools': it does not make HITL_ENABLED ask about every other call of the turn.
    assert.equal(policy.operatorActive, false);
  });

  test("C1b the default address is one Brain knows as the platform's GitHub server", () => {
    const { mcpUrl } = readGithubMcpSettings({ CLAW_GITHUB_MCP_ENABLED: "true", INTERNAL_BACKEND_URL: "http://claw-api:3000" });
    assert.equal(isPlatformMcpServer("github", { url: mcpUrl }), true, mcpUrl);
  });

  test("C2 nothing for an owner without a token, a session acting as someone else, or the feature off", async () => {
    await pg.exec("DELETE FROM claw_user_env_vars");
    assert.deepEqual(await githubMcpServers("s-1", { settings: () => settings(), db }), {});
    await sql("INSERT INTO claw_user_env_vars VALUES ('u-alice', 'GH_TOKEN', $1)", [encryptUserEnvValue(GH_TOKEN)]);
    assert.deepEqual(await githubMcpServers("s-1", { settings: () => settings({ enabled: false }), db }), {});
    assert.deepEqual(await githubMcpServers("s-1", { settings: () => settings({ secret: "short" }), db }), {});
    await sql("UPDATE claw_sessions SET config = $1::jsonb WHERE session_id = 's-1'", [JSON.stringify({ acting_as: "u-bob" })]);
    assert.deepEqual(await githubMcpServers("s-1", { settings: () => settings(), db }), {});
  });
});
