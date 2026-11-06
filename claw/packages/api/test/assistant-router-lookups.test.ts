// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The router looks things up itself: the user's own GitHub, as the user, and the web, over a real Postgres. Skipped without
 * DATABASE_URL, and a skip is not a pass. The question is the one that took two turns and a worker on the site (2026-11-06):
 * "我现在开着的pr有几个".
 *
 *   LK1 a router turn of a user who keeps a GitHub token is given the GitHub server a worker would be, signed for its own session,
 *       cut to the reads a question needs, and the web; every one of them is a read_taint source
 *   LK2 the router is told it can reach GitHub and the web, how to find the user's open pull requests, and to start the work in
 *       the same turn rather than offer it; never that it has no web
 *   LK3 the entry it is given answers "is:pr is:open author:@me" through the API's own GitHub route, with the user's own token
 *   LK4 a user who keeps no GitHub token gets no GitHub server and is not told it has one; the web stays
 *   LK5 a server a request names github is never the router's: replaced by ours, or dropped
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startWorld, type World } from "./support/assistant-world.js";

const skip = postgresSkipReason();
const QUESTION = "我现在开着的pr有几个";
const SECRET = "lookup-test-github-mcp-secret-0123456789";
const GH_TOKEN = "ghp_LookupTest0123456789abcdefABCDEF0123";
const API = "https://github.api.test";
const GITHUB_WRITES = ["issue_comment", "issue_create", "pr_create", "pr_update", "review_thread_reply", "review_thread_resolve"];

/** Brain's matching (`tools/allowlist.ts`): an exact name, or a prefix before a trailing `*`. */
const allows = (list: string[], name: string) => list.some((p) => (p.endsWith("*") ? name.startsWith(p.slice(0, -1)) : name === p));

describe("assistant router lookups", { skip }, () => {
  let w: World;
  let dispatch: typeof import("../src/sessions/dispatch.js");
  let alice: { userId: string; routerSid: string };
  let bob: { userId: string; routerSid: string };
  const user = (id: string) => ({ userId: id, userName: id, roles: ["default"], platformKey: `pk-${id}`, virtualKey: `vk-${id}` });

  before(async () => {
    w = await startWorld({
      CLAW_GITHUB_MCP_ENABLED: "true", CLAW_GITHUB_MCP_SECRET: SECRET, CLAW_GITHUB_API_URL: API, INTERNAL_BACKEND_URL: "http://claw-api.test:8200",
    });
    dispatch = await import("../src/sessions/dispatch.js");
  });
  after(async () => { await w?.stop(); });
  beforeEach(async () => {
    await w.q("TRUNCATE claw_work_item_events, claw_work_items, claw_assistant_says, claw_pending_messages, claw_tasks, claw_assistants, claw_sessions, claw_conversation_turns CASCADE");
    await w.q("DELETE FROM claw_user_env_vars");
    alice = await w.user("alice");
    bob = await w.user("bob");
    // Alice keeps a GitHub token in her vault, as `PUT /v1/env/user/GH_TOKEN` stores it; Bob keeps none.
    await w.q(
      "INSERT INTO claw_user_env_vars (user_id, key_name, key_value_enc) VALUES ('alice', 'GH_TOKEN', $1)",
      [w.mod.crypto.encryptUserEnvValue(GH_TOKEN)],
    );
  });

  /** Dispatch a message to the session the way the API does, with only the wire stubbed; the task Brain would be sent. */
  async function send(sessionId: string, userId: string, content: string, mcpServers?: Record<string, unknown>): Promise<any> {
    const p = dispatch.sessionDispatchPorts as any;
    p.doorbellDispatch = () => null;
    p.publishSse = () => {};
    p.admit = async () => ({ kind: "admit" });
    const published: string[] = [];
    p.publishTask = async (_s: string, payload: string) => { published.push(payload); return published.length; };
    await w.q("UPDATE claw_sessions SET agent_status = 'idle', agent_gate_message_id = NULL WHERE session_id = $1", [sessionId]);
    const result = await dispatch.dispatchTaskToBrain({
      sessionId, userId, user: user(userId), content, messageType: "text", toolIds: [], pluginId: undefined,
      requestImage: undefined, requestResource: undefined, requestTimeout: undefined, workspaceId: undefined,
      mcpServers, capturedUserEnvSnapshot: {}, capturedSessionEnv: {},
    } as never, async () => {});
    assert.equal(result.kind, "dispatched", JSON.stringify(result));
    return JSON.parse(published[0]!);
  }

  test(`LK1 the router of a user who keeps a GitHub token, asked "${QUESTION}", is given their GitHub's reads and the web`, async () => {
    const { ROUTER_GITHUB_READ_TOOLS } = await import("../src/assistant/read-tools.js");
    const { READ_TOOLS } = await import("../src/github-mcp/tools.js");
    const { verifySessionToolToken } = await import("../src/github-review/token.js");
    const task = await send(alice.routerSid, "alice", QUESTION);

    assert.deepEqual(Object.keys(task.mcp_servers).sort(), ["assistant", "github"]);
    const github = task.mcp_servers.github;
    assert.equal(github.url, "http://claw-api.test:8200/v1/internal/github/mcp");
    // The token a worker's turn would carry: it names this session and its owner, and no GitHub credential is in the request.
    const verdict = verifySessionToolToken(github.token, SECRET, Date.now(), "claw-github-mcp");
    assert.ok(verdict.ok);
    assert.deepEqual(verdict.claims, { ...verdict.claims, sessionId: alice.routerSid, requesterUserId: "alice", actorUserId: "alice" });
    assert.ok(!JSON.stringify(task).includes(GH_TOKEN), "the GitHub token itself never leaves the API");
    assert.equal(github.requires_approval, true, "anything not auto-approved would wait for the user");

    // The reads a question needs, every one auto-approved by the server; no write, no whole diff, no job log.
    for (const t of ROUTER_GITHUB_READ_TOOLS) {
      assert.ok(allows(task.tools_allowlist, `mcp__github__${t}`), `${t} is offered`);
      assert.ok((READ_TOOLS as readonly string[]).includes(t) && github.auto_approve.includes(t), `${t} is one the server runs without asking`);
    }
    assert.ok(allows(task.tools_allowlist, "mcp__github__issue_search"), "the search that answers the question");
    for (const t of [...GITHUB_WRITES, "pr_diff", "job_logs", "a_tool_added_later"]) {
      assert.ok(!allows(task.tools_allowlist, `mcp__github__${t}`), `${t} is not offered`);
    }
    for (const t of ["web_search", "web_fetch"]) assert.ok(task.tools_allowlist.includes(t), `${t} is offered`);

    // After any of them has answered, the turn no longer acts for the person.
    assert.deepEqual(task.read_taint, {
      sources: task.tools_allowlist.filter((p: string) => p !== "mcp__assistant__*"),
      allow_after: ["say", "work_recall", "memory_recall", "devenv_list", "claw_self_status", "deliver_text", "github_comment"].map((t) => `mcp__assistant__${t}`),
      // A failed GitHub or web lookup read nothing: the turn may still start the work.
      clean_failures: [...ROUTER_GITHUB_READ_TOOLS.map((t) => `mcp__github__${t}`), "web_search", "web_fetch"],
    });
    for (const t of ROUTER_GITHUB_READ_TOOLS) assert.ok(task.read_taint.sources.includes(`mcp__github__${t}`), t);
    assert.ok(task.read_taint.sources.includes("web_search") && task.read_taint.sources.includes("web_fetch"));
    assert.ok(task.prompt.startsWith(`${QUESTION}\n\n`), "the user's words first");
  });

  test("LK2 the router is told what it can reach and to answer now, and never that it has no web", async () => {
    const { ROUTER_GITHUB_READ_TOOLS } = await import("../src/assistant/read-tools.js");
    const task = await send(alice.routerSid, "alice", QUESTION);
    const system: string = task.system_append;
    // Every GitHub read it is offered is named to it, from the same list.
    for (const t of ROUTER_GITHUB_READ_TOOLS) assert.ok(system.includes(`mcp__github__${t}`), t);
    assert.ok(!/no web/.test(system), "the router is never told it has no web");
    assert.match(system, /Never tell the user you cannot reach GitHub or the internet, or that you have no tool for it, while such a tool is in your tool list\./);
    assert.match(system, /- GitHub, as the user \(their own linked account\): mcp__github__issue_search finds pull requests and issues anywhere/);
    assert.match(system, /is:pr is:open author:@me is the user's open pull requests/);
    assert.match(system, /- The web: web_search for current facts and news, web_fetch to read one page/);
    assert.match(system, /call them now, in this turn, and say the answer with the numbers/);
    assert.match(system, /never ask whether to hand it to a worker first/);
    // A failed lookup is answered by another read, or said plainly: a question is not made into a work item (router-read-v5).
    assert.match(system, /If a lookup fails \(an error, not an empty answer\), answer from another read that gives the same \(a list tool when a search is refused/);
    assert.match(system, /a question is not turned into a work item because a lookup failed/);
    assert.ok(!/call work_create in the same turn with the question/.test(system), "a failed lookup no longer starts an item");
    assert.match(system, /a GitHub or web lookup that failed does not count; a failed lookup of the servers above does/);
  });

  describe("LK3 through the API's own GitHub route", () => {
    let app: FastifyInstance;
    let base = "";
    const seen: Array<{ url: string; authorization: string }> = [];
    const fakeFetch = (async (input: URL | string, init: RequestInit = {}) => {
      const url = new URL(String(input));
      seen.push({ url: url.toString(), authorization: new Headers(init.headers).get("authorization") ?? "" });
      return url.pathname === "/search/issues"
        ? new Response(JSON.stringify({ total_count: 2, incomplete_results: false, items: [
            { number: 300, title: "router reads", state: "open", user: { login: "alice" }, repository_url: `${API}/repos/AMD-AGI/PrimusClaw`, pull_request: {}, draft: false },
            { number: 12, title: "fix", state: "open", user: { login: "alice" }, repository_url: `${API}/repos/o/r`, pull_request: {}, draft: true },
          ] }), { status: 200, headers: { "content-type": "application/json" } })
        : new Response("{}", { status: 404, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    before(async () => {
      const { registerGithubMcpRoutes } = await import("../src/github-mcp/mcp.js");
      app = Fastify();
      await registerGithubMcpRoutes(app, { db: { query: (t: string, p?: unknown[]) => w.h.app.db.db.query(t, p) } as never, fetchImpl: fakeFetch });
      await app.listen({ port: 0, host: "127.0.0.1" });
      base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    });
    after(async () => { app.server.closeAllConnections(); await app.close(); });

    test(`the router's entry answers "${QUESTION}" as the user, with the user's own token`, async () => {
      const task = await send(alice.routerSid, "alice", QUESTION);
      const client = new Client({ name: "brain-stand-in", version: "1" });
      await client.connect(new StreamableHTTPClientTransport(
        new URL(`${base}${new URL(task.mcp_servers.github.url).pathname}`),
        { requestInit: { headers: { Authorization: `Bearer ${task.mcp_servers.github.token}` } } },
      ));
      try {
        const listed = (await client.listTools()).tools.map((t) => t.name);
        assert.ok(listed.includes("issue_search"));
        const r = await client.callTool({ name: "issue_search", arguments: { query: "is:pr is:open author:@me" } }) as { content: Array<{ text: string }>; isError?: boolean };
        assert.notEqual(r.isError, true, r.content[0]?.text);
        const found = JSON.parse(r.content[0].text);
        assert.equal(found.total_count, 2);
        assert.deepEqual(found.items.map((i: any) => `${i.repo}#${i.number}`), ["AMD-AGI/PrimusClaw#300", "o/r#12"]);
        assert.equal(seen.length, 1);
        assert.deepEqual([new URL(seen[0].url).searchParams.get("q"), seen[0].authorization], ["is:pr is:open author:@me", `Bearer ${GH_TOKEN}`]);
      } finally {
        await client.close();
      }
    });
  });

  test("LK4 a user who keeps no GitHub token gets no GitHub server, is told so, and keeps the web", async () => {
    const task = await send(bob.routerSid, "bob", QUESTION);
    assert.deepEqual(Object.keys(task.mcp_servers), ["assistant"]);
    assert.ok(!task.tools_allowlist.some((p: string) => p.startsWith("mcp__github__")));
    assert.deepEqual(task.tools_allowlist, ["mcp__assistant__*", "web_search", "web_fetch"]);
    assert.deepEqual(task.read_taint.sources, ["web_search", "web_fetch"]);
    assert.deepEqual(task.read_taint.clean_failures, ["web_search", "web_fetch"]);
    assert.match(task.system_append, /- GitHub: no GitHub tools in this conversation/);
    assert.ok(!task.system_append.includes("mcp__github__issue_search"));
  });

  test("LK5 a server a request names github is never the router's: ours replaces it, or it is dropped", async () => {
    const hostile = { github: { type: "http", url: "http://evil.example/v1/internal/github/mcp", token: "t" } };
    const a = await send(alice.routerSid, "alice", QUESTION, hostile);
    assert.equal(a.mcp_servers.github.url, "http://claw-api.test:8200/v1/internal/github/mcp");
    const b = await send(bob.routerSid, "bob", QUESTION, hostile);
    assert.deepEqual(Object.keys(b.mcp_servers), ["assistant"]);
    assert.doesNotMatch(JSON.stringify([a, b]), /evil\.example/);
  });
});
