// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * "Bind once, GitHub everywhere": with CLAW_GITHUB_MCP_BINDING_ENABLED on, a user who keeps no GH_TOKEN but bound GitHub with
 * `/github bind` gets their GitHub in a router turn, exactly as a user with a GH_TOKEN does, over a real Postgres, the process's real
 * identity client and a stand-in identity provider. Skipped without DATABASE_URL, and a skip is not a pass.
 *
 *   GB1 the router turn of a bound user (no GH_TOKEN) gets the `github` server and its reads, signed for its own session, and no
 *       credential in the request; the provider was asked for that user, by the API's client, for themselves
 *   GB2 its entry answers "is:pr is:open author:@me" through the API's own route with the bound token, and the call is in GitHub
 *       review's audit log
 *   GB3 a user with no binding gets no server, and the router is told the one step that connects GitHub (/github bind)
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { FakeIdentity } from "../../utils/test/identity-fake.js";
import { postgresSkipReason } from "./support/pg-cluster.js";
import { startWorld, type World } from "./support/assistant-world.js";

const skip = postgresSkipReason();
const QUESTION = "我现在开着的pr有几个";
const SECRET = "binding-test-github-mcp-secret-0123456789";
const BOUND = "gho_BindingTest0123456789abcdefABCDEF012";
const API = "https://github.api.test";
const log = { info() {}, warn() {}, error() {} };

/** Brain's matching (`tools/allowlist.ts`): an exact name, or a prefix before a trailing `*`. */
const allows = (list: string[], name: string) => list.some((p) => (p.endsWith("*") ? name.startsWith(p.slice(0, -1)) : name === p));

describe("assistant router: a GitHub binding", { skip }, () => {
  let w: World;
  let fake: FakeIdentity;
  let dispatch: typeof import("../src/sessions/dispatch.js");
  let bob: { userId: string; routerSid: string };
  let carol: { userId: string; routerSid: string };
  const user = (id: string) => ({ userId: id, userName: id, roles: ["default"], platformKey: `pk-${id}`, virtualKey: `vk-${id}` });
  const resolved = () => fake.requests.filter((r) => r.path === "/oauth/external-credentials/resolve").map((r) => JSON.parse(r.body));

  before(async () => {
    fake = await FakeIdentity.start();
    // Bob bound GitHub; nobody else did.
    fake.resolveCredential = (r) => JSON.parse(r.body).user_id === "bob"
      ? { body: { token: BOUND, provider_login: "bob-gh", kind: "oauth", scopes: ["public_repo"], delegation: false, expires_at: new Date(Date.now() + 3_600_000).toISOString() } }
      : { status: 404, body: { error: "not_bound" } };
    w = await startWorld({
      CLAW_GITHUB_MCP_ENABLED: "true", CLAW_GITHUB_MCP_BINDING_ENABLED: "true", CLAW_GITHUB_MCP_SECRET: SECRET, CLAW_GITHUB_API_URL: API,
      CLAW_GITHUB_REVIEW_ENABLED: "true", INTERNAL_BACKEND_URL: "http://claw-api.test:8200",
      IDENTITY_CLIENT_ENABLED: "true", IDENTITY_ISSUER_URL: fake.issuer, IDENTITY_CLIENT_ID: "svc-claw", IDENTITY_CLIENT_SECRET: "s3cret",
    });
    (await import("../src/auth/identity.js")).startIdentityClient(log);
    dispatch = await import("../src/sessions/dispatch.js");
  });
  after(async () => { await w?.stop(); await fake?.close(); });
  beforeEach(async () => {
    await w.q("TRUNCATE claw_work_item_events, claw_work_items, claw_assistant_says, claw_pending_messages, claw_tasks, claw_assistants, claw_sessions, claw_conversation_turns CASCADE");
    await w.q("DELETE FROM claw_user_env_vars");
    await w.q("DELETE FROM claw_github_audit");
    bob = await w.user("bob");
    carol = await w.user("carol");
    fake.requests.length = 0;
  });

  /** Dispatch a message to the session the way the API does, with only the wire stubbed; the task Brain would be sent. */
  async function send(sessionId: string, userId: string, content: string): Promise<any> {
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
      mcpServers: undefined, capturedUserEnvSnapshot: {}, capturedSessionEnv: {},
    } as never, async () => {});
    assert.equal(result.kind, "dispatched", JSON.stringify(result));
    return JSON.parse(published[0]!);
  }

  test(`GB1 the router of a user who only bound GitHub, asked "${QUESTION}", is given their GitHub's reads`, async () => {
    const { ROUTER_GITHUB_READ_TOOLS } = await import("../src/assistant/read-tools.js");
    const { verifySessionToolToken } = await import("../src/github-review/token.js");
    const task = await send(bob.routerSid, "bob", QUESTION);
    assert.deepEqual(Object.keys(task.mcp_servers).sort(), ["assistant", "github"]);
    const verdict = verifySessionToolToken(task.mcp_servers.github.token, SECRET, Date.now(), "claw-github-mcp");
    assert.ok(verdict.ok);
    assert.deepEqual(verdict.claims, { ...verdict.claims, sessionId: bob.routerSid, requesterUserId: "bob", actorUserId: "bob" });
    assert.ok(!JSON.stringify(task).includes(BOUND), "the bound token never leaves the API");
    for (const t of ROUTER_GITHUB_READ_TOOLS) assert.ok(allows(task.tools_allowlist, `mcp__github__${t}`), t);
    assert.ok(!allows(task.tools_allowlist, "mcp__github__issue_comment"), "no write");
    assert.ok(task.system_append.includes("mcp__github__issue_search"));
    // (The dispatch builds a session's reserved servers and then the router's own: each asks once.)
    const asked = resolved();
    assert.ok(asked.length >= 1);
    for (const b of asked) assert.deepEqual([b.user_id, b.provider, b.requester_user_id, b.purpose], ["bob", "github", "bob", "github_mcp:offer"]);
  });

  describe("GB2 through the API's own GitHub route", () => {
    let app: FastifyInstance;
    let base = "";
    const seen: Array<{ url: string; authorization: string }> = [];
    const fakeFetch = (async (input: URL | string, init: RequestInit = {}) => {
      const url = new URL(String(input));
      seen.push({ url: url.toString(), authorization: new Headers(init.headers).get("authorization") ?? "" });
      return url.pathname === "/search/issues"
        ? new Response(JSON.stringify({ total_count: 1, incomplete_results: false, items: [
            { number: 7, title: "t", state: "open", user: { login: "bob-gh" }, repository_url: `${API}/repos/AMD-AGI/PrimusClaw`, pull_request: {}, draft: false },
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

    test("answers the question with the bound token, and writes the call to the audit log", async () => {
      const task = await send(bob.routerSid, "bob", QUESTION);
      const client = new Client({ name: "brain-stand-in", version: "1" });
      await client.connect(new StreamableHTTPClientTransport(
        new URL(`${base}${new URL(task.mcp_servers.github.url).pathname}`),
        { requestInit: { headers: { Authorization: `Bearer ${task.mcp_servers.github.token}` } } },
      ));
      try {
        const r = await client.callTool({ name: "issue_search", arguments: { query: "is:pr is:open author:@me" } }) as { content: Array<{ text: string }>; isError?: boolean };
        assert.notEqual(r.isError, true, r.content[0]?.text);
        assert.equal(JSON.parse(r.content[0].text).total_count, 1);
        assert.deepEqual(seen.map((s) => s.authorization), [`Bearer ${BOUND}`]);
      } finally {
        await client.close();
      }
      assert.ok(resolved().some((b) => b.user_id === "bob" && b.purpose === "github_mcp:issue_search"));
      const rows = await w.q("SELECT requester_user_id, actor_user_id, session_id, tool, write, result FROM claw_github_audit");
      assert.deepEqual(rows.map((x) => [x.requester_user_id, x.actor_user_id, x.session_id, x.tool, x.write, x.result]),
        [["bob", "bob", bob.routerSid, "github_mcp.issue_search", false, "ok"]]);
    });
  });

  test("GB3 a user with no binding gets no GitHub server, and the router is told the one step that connects it", async () => {
    const task = await send(carol.routerSid, "carol", QUESTION);
    assert.deepEqual(Object.keys(task.mcp_servers), ["assistant"]);
    assert.ok(!task.tools_allowlist.some((p: string) => p.startsWith("mcp__github__")));
    assert.match(task.system_append, /the user has not connected GitHub yet/);
    assert.match(task.system_append, /\/github bind/);
    assert.ok(resolved().length >= 1);
    for (const b of resolved()) assert.deepEqual([b.user_id, b.purpose], ["carol", "github_mcp:offer"]);
  });
});
