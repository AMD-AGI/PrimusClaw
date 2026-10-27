// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A hosted application's session-level MCP, API side (hosting design 5.8):
 * the internal routes that record and remove where it answers, and the merge
 * into a turn's `mcp_servers` at dispatch, over a real Postgres.
 *
 * The record never holds a token; the config is built at dispatch from the run's
 * sealed token. The application is a generic Streamable-HTTP stub behind a
 * stand-in Router (support/mcp-stub.ts), so the dispatched config is also used
 * the way Brain's MCP client uses it. Skipped without DATABASE_URL, and a skip
 * is not a pass.
 */
import assert from "node:assert/strict";
import test, { after, before, beforeEach, describe } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";

import { APP_MANIFEST_SCHEMA } from "@claw/protocol";
import { postgresSkipReason } from "./support/pg-cluster.js";
import { startAdmissionCluster, type AdmissionCluster } from "./support/admission-cluster.js";
import { startMcpStub, type McpStub } from "./support/mcp-stub.js";

const skip = postgresSkipReason();
const INTERNAL = "internal-test-token-0123456789";
const HEADER = "X-App-Token";
const PATH = "/mcp";
const PLATFORM_KEY = "pk-owner-0123456789";
const EPOCH = 3;

const MANIFEST = {
  schema: APP_MANIFEST_SCHEMA,
  name: "example-app",
  version: "1.0.0",
  container: {},
  state_dir: "${USER_DATA_PATH}/.claw-apps/${run_id}",
  command: ["sh", "-c", "exec app"],
  restart: { max_restarts: 2, backoff_sec: [5] },
  env_map: { mcp_token: "APP_MCP_TOKEN" },
  mcp: { port: 8765, path: PATH, token_header: HEADER },
};
const NO_MCP_MANIFEST = { ...MANIFEST, name: "plain-app", env_map: {}, mcp: undefined };
const RESOURCES = { image: "registry.example.invalid/app:1", gpus: 0, workspace: "ws-ok" };

describe("session-level app MCP", { skip }, () => {
  let h: AdmissionCluster;
  let app: FastifyInstance;
  let secrets: typeof import("../src/crypto/app-run-secrets.js");
  let appMcp: typeof import("../src/sessions/app-mcp.js");
  let dispatch: typeof import("../src/sessions/dispatch.js");
  let ports: any;
  let stub: McpStub;
  let plugin = 0;
  let noMcpPlugin = 0;
  let taskId = "";
  let token = "";
  const q = (text: string, params: unknown[] = []) => h.app.db.db.query(text, params);
  const auth = { authorization: `Bearer ${INTERNAL}` };
  const brain = (extra: Record<string, unknown> = {}) => ({ brain_id: "brain-A", claim_count: EPOCH, ...extra });
  const mcpUrl = () => `${stub.base}/v1/namespaces/ws-1/code-interpreters/wl-1/invocations/proxy/8765${PATH}`;
  const put = (body: unknown, id = taskId) =>
    app.inject({ method: "PUT", url: `/v1/internal/app-runs/${id}/mcp`, payload: body as object, headers: auth });
  const del = (query = "brain_id=brain-A&claim_count=" + EPOCH, id = taskId) =>
    app.inject({ method: "DELETE", url: `/v1/internal/app-runs/${id}/mcp?${query}`, headers: auth });
  const records = async () => (await q("SELECT * FROM claw_session_app_mcp ORDER BY name")).rows as any[];
  const register = async () => {
    const res = await put(brain({ url: mcpUrl(), sandbox_session_id: "wl-1" }));
    assert.equal(res.statusCode, 200, res.body);
  };

  before(async () => {
    process.env.CLAW_DEPLOY_MODE = "safe";
    process.env.AUTH_INTERNAL_TOKEN = INTERNAL;
    h = await startAdmissionCluster({ APP_RUNS_ENABLED: "true" });
    (await import("../src/crypto/user-env.js")).initUserEnvCrypto();
    secrets = await import("../src/crypto/app-run-secrets.js");
    appMcp = await import("../src/sessions/app-mcp.js");
    dispatch = await import("../src/sessions/dispatch.js");
    ports = (await import("../src/tasks/app-run.js")).appRunPorts;
    ports.workspaceAccess = async () => "ok";
    ports.grant = { issue: async () => undefined };
    const mk = async (manifest: object) => Number(((await q(
      `INSERT INTO plugins (name, version, resource, owner_user_id, is_public)
       VALUES ($2, '1', $1::jsonb, 'u1', true) RETURNING id`,
      [JSON.stringify({ app: { manifest } }), (manifest as any).name],
    )).rows[0] as { id: string }).id);
    plugin = await mk(MANIFEST);
    noMcpPlugin = await mk(NO_MCP_MANIFEST);
    await q("INSERT INTO claw_sessions (session_id, name, user_id, mode) VALUES ('s1', 't', 'u1', 'claw')");
    app = Fastify();
    await (await import("../src/routes/tasks.js")).registerTaskCreateRoute(app);
    await (await import("../src/routes/internal-apps.js")).registerInternalAppRoutes(app);
    app.addHook("preHandler", async (req) => {
      if (req.url.startsWith("/v1/internal/")) return;
      (req as any).user = { userId: "u1", userName: "u1", roles: ["default"], platformKey: "pk", virtualKey: "vk" };
    });
    await app.ready();
  });
  after(async () => { await app?.close(); await stub?.close(); await h?.stop(); });

  async function createRun(pluginId = plugin): Promise<string> {
    await q("DELETE FROM claw_session_app_mcp");
    await q("DELETE FROM claw_app_runs");
    await q("DELETE FROM claw_tasks");
    const res = await app.inject({
      method: "POST", url: "/v1/sessions/s1/tasks",
      payload: { mode: "app", plugin_id: pluginId, input: {}, resources: RESOURCES },
    });
    assert.equal(res.statusCode, 200, res.body);
    const id = res.json().task_id as string;
    await q(
      "UPDATE claw_tasks SET lease_owner = 'brain-A', lease_expires_at = NOW() + interval '1 hour', claim_count = $2 WHERE task_id = $1", [id, EPOCH],
    );
    return id;
  }

  beforeEach(async () => {
    await stub?.close();
    taskId = await createRun();
    token = secrets.openAppRunSecret(((await q("SELECT mcp_token_enc FROM claw_app_runs WHERE task_id = $1", [taskId])).rows[0] as any).mcp_token_enc, taskId, "mcp_token");
    stub = await startMcpStub({ tokenHeader: HEADER, token, path: PATH });
    appMcp.appMcpSettings.routerAuth = false;
  });

  describe("the record", () => {
    test("is written by the lease holder, keyed by session and the manifest's name, and holds no token", async () => {
      await register();
      const rows = await records();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].session_id, "s1");
      assert.equal(rows[0].name, "example-app");
      assert.equal(rows[0].app_task_id, taskId);
      assert.equal(rows[0].url, mcpUrl());
      assert.equal(rows[0].sandbox_session_id, "wl-1");
      // No column of the row, and nothing in its text, carries the token.
      assert.deepEqual(Object.keys(rows[0]).sort(), ["app_task_id", "name", "sandbox_session_id", "session_id", "updated_at", "url"]);
      assert.ok(!JSON.stringify(rows[0]).includes(token));
      const dump = (await q("SELECT row_to_json(m)::text AS t FROM claw_session_app_mcp m")).rows[0] as any;
      assert.ok(!dump.t.includes(token) && !dump.t.includes("cmt_"));
    });

    test("a second write is an update, not a second row", async () => {
      await register();
      assert.equal((await put(brain({ url: `${mcpUrl()}?v=2`, sandbox_session_id: "wl-2" }))).statusCode, 200);
      const rows = await records();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].sandbox_session_id, "wl-2");
    });

    test("is refused for a worker that does not hold the run, and nothing is written", async () => {
      for (const fence of [{ brain_id: "brain-B", claim_count: EPOCH }, { brain_id: "brain-A", claim_count: EPOCH + 1 }]) {
        const res = await put({ ...fence, url: mcpUrl(), sandbox_session_id: "wl-1" });
        assert.equal(res.statusCode, 409, res.body);
        assert.equal(res.json().error, "not_holder");
      }
      await q("UPDATE claw_tasks SET lease_expires_at = NOW() - interval '1 minute' WHERE task_id = $1", [taskId]);
      assert.equal((await put(brain({ url: mcpUrl(), sandbox_session_id: "wl-1" }))).statusCode, 409);
      assert.equal((await records()).length, 0);
    });

    test("is refused for bad input, and for a run whose manifest declares no mcp", async () => {
      for (const body of [
        { url: mcpUrl(), sandbox_session_id: "wl-1" },
        brain({ url: "not a url", sandbox_session_id: "wl-1" }),
        brain({ url: "ftp://x/y", sandbox_session_id: "wl-1" }),
        brain({ url: "http://user:pass@x/y", sandbox_session_id: "wl-1" }),
        brain({ url: mcpUrl(), sandbox_session_id: "" }),
        brain({ url: mcpUrl() }),
      ]) assert.equal((await put(body)).statusCode, 400, JSON.stringify(body));
      assert.equal((await records()).length, 0);
      const plain = await createRun(noMcpPlugin);
      const res = await put(brain({ url: mcpUrl(), sandbox_session_id: "wl-1" }), plain);
      assert.equal(res.statusCode, 409);
      assert.equal(res.json().error, "no_mcp");
      assert.equal((await records()).length, 0);
    });

    test("needs the internal token", async () => {
      const res = await app.inject({ method: "PUT", url: `/v1/internal/app-runs/${taskId}/mcp`, payload: brain({ url: mcpUrl(), sandbox_session_id: "wl-1" }) });
      assert.equal(res.statusCode, 401);
      assert.equal((await records()).length, 0);
    });
  });

  describe("cleanup when the run ends", () => {
    test("the unregister call removes it; a stale epoch cannot", async () => {
      await register();
      assert.equal((await del("brain_id=brain-A&claim_count=" + (EPOCH + 1))).statusCode, 409);
      assert.equal((await records()).length, 1, "a refused removal leaves the record");
      const ok = await del();
      assert.equal(ok.statusCode, 200);
      assert.equal(ok.json().removed, 1);
      assert.equal((await records()).length, 0);
      assert.equal((await del()).statusCode, 200, "removing it again is not an error");
    });

    test("the run moving to ended removes it, whoever ended it", async () => {
      await register();
      const res = await app.inject({
        method: "PATCH", url: `/v1/internal/app-runs/${taskId}`, headers: auth,
        payload: brain({ state: "ended", last_exit: { at: "t", cause: "exit", final: true, returncode: 0 } }),
      });
      assert.equal(res.statusCode, 200, res.body);
      assert.equal((await records()).length, 0);
    });

    test("another run's record of the same name survives this run's removal", async () => {
      await register();
      const other = "other-run";
      await q("UPDATE claw_session_app_mcp SET app_task_id = $1", [other]);
      assert.equal((await del()).statusCode, 200);
      assert.equal((await records()).length, 1);
    });
  });

  describe("dispatch", () => {
    const ports0 = () => dispatch.sessionDispatchPorts;
    const pristine = (() => { let p: any = null; return () => (p ??= { ...dispatch.sessionDispatchPorts }); })();

    /** A fat-branch dispatch of one turn in s1; returns the task as it was published. */
    async function turn(mcpServers?: Record<string, Record<string, unknown>>): Promise<Record<string, any>> {
      const p = ports0();
      Object.assign(p, pristine());
      p.doorbellDispatch = () => null;
      p.publishSse = () => {};
      p.admit = async () => ({ kind: "admit" } as any);
      const published: string[] = [];
      p.publishTask = async (_s: string, payload: string) => { published.push(payload); return published.length; };
      await q("DELETE FROM claw_tasks WHERE task_id <> $1", [taskId]);
      const result = await dispatch.dispatchTaskToBrain({
        sessionId: "s1", userId: "u1",
        user: { userId: "u1", userName: "u1", roles: ["default"], platformKey: PLATFORM_KEY, virtualKey: "vk" },
        content: "hello", messageType: "text", toolIds: [], pluginId: undefined, requestImage: undefined,
        requestResource: undefined, requestTimeout: undefined, workspaceId: undefined, mcpServers,
        capturedUserEnvSnapshot: {}, capturedSessionEnv: {},
      } as any, async () => {});
      assert.equal(result.kind, "dispatched", JSON.stringify(result));
      assert.equal(published.length, 1);
      return JSON.parse(published[0]!);
    }

    test("no record: the request's mcp_servers are untouched, absent stays absent", async () => {
      assert.equal((await turn()).mcp_servers, undefined);
      const mine = { mine: { type: "http", url: "http://x/mcp" } };
      assert.deepEqual((await turn(mine)).mcp_servers, mine);
    });

    test("Router auth off: token is the MCP token, the manifest's header carries it, x-session-id routes", async () => {
      await register();
      const task = await turn();
      assert.deepEqual(task.mcp_servers, {
        "example-app": {
          type: "http", url: mcpUrl(), token,
          headers: { [HEADER]: token, "x-session-id": "wl-1" },
        },
      });
    });

    test("Router auth on: token is the placeholder, and the MCP token is still the header", async () => {
      await register();
      appMcp.appMcpSettings.routerAuth = true;
      const task = await turn();
      assert.deepEqual(task.mcp_servers["example-app"], {
        type: "http", url: mcpUrl(), token: "<SAFE_API_KEY>",
        headers: { [HEADER]: token, "x-session-id": "wl-1" },
      });
      assert.ok(!JSON.stringify(task.mcp_servers).includes(PLATFORM_KEY), "the platform key is Brain's to expand, never written here");
    });

    test("lowest priority: a server of the same name in the request wins, others are kept", async () => {
      await register();
      const requested = { "example-app": { type: "http", url: "http://mine/mcp", token: "mine" }, other: { type: "sse", url: "http://o/sse" } };
      const task = await turn(requested);
      assert.deepEqual(task.mcp_servers, requested);
      const extra = await turn({ other: { type: "sse", url: "http://o/sse" } });
      assert.deepEqual(Object.keys(extra.mcp_servers).sort(), ["example-app", "other"]);
      assert.equal(extra.mcp_servers["example-app"].url, mcpUrl());
    });

    test("an ended run's record is not served, even if its removal has not landed", async () => {
      await register();
      await q("UPDATE claw_app_runs SET state = 'ended' WHERE task_id = $1", [taskId]);
      assert.equal((await records()).length, 1, "precondition: the row is still there");
      assert.equal((await turn()).mcp_servers, undefined);
    });

    test("a token that will not open drops that server and does not fail the turn", async () => {
      await register();
      await q("UPDATE claw_app_runs SET mcp_token_enc = 'garbage' WHERE task_id = $1", [taskId]);
      assert.equal((await turn()).mcp_servers, undefined);
    });

    test("the dispatched config is usable against a Streamable-HTTP server, with Router auth off and on", async () => {
      for (const routerAuth of [false, true]) {
        await stub.close();
        stub = await startMcpStub({ tokenHeader: HEADER, token, path: PATH, routerAuth: routerAuth ? { platformKey: PLATFORM_KEY } : undefined });
        await q("DELETE FROM claw_session_app_mcp");
        await register();
        appMcp.appMcpSettings.routerAuth = routerAuth;
        const cfg = (await turn()).mcp_servers["example-app"];
        // What Brain's MCP client does: expand the placeholder, bearer the token, add the headers.
        const bearer = String(cfg.token).replace("<SAFE_API_KEY>", PLATFORM_KEY);
        const resp = await fetch(cfg.url, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${bearer}`, ...cfg.headers },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } }),
        });
        assert.equal(resp.status, 200, `routerAuth=${routerAuth}`);
        assert.equal(resp.headers.get("mcp-session-id"), "stub-session");
        assert.ok((await resp.json() as any).result.serverInfo);
      }
    });
  });
});
