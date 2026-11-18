// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * SANDBOX_ALLOWED_NAMESPACES: a request naming a workspace the deployment does
 * not isolate is refused with 400 before anything is queued or written.
 *
 *   W1 the setting: unset or empty allows every workspace; set, the list plus
 *      the deployment's own sandbox workspaces
 *   W2 a message (`workspaceId`) and a session's first message: 400, nothing
 *      sent to Brain; the same request naming a listed workspace goes through
 *   W3 (sandbox-allowed-namespaces-dag.test.ts, on a real Postgres) a DAG whose
 *      node sandbox names a workspace off the list: 400 on /tasks and /v1/batches
 *   W4 the dispatcher refuses a rendered spec Brain would place off the list
 *   W5 a managed-agents session pinned to a workspace off the list is not created
 *   W6 the MCP one-shot pipeline refuses before it creates its session
 *   W7 (sandbox-allowed-namespaces-a2a.test.ts) an A2A send naming a workspace off the list: invalid params
 *
 * The application run (and its grant) is covered in app-run-create.test.ts.
 * Every refusal has a positive control: a route that refused everything, or
 * that ignored the setting, would otherwise pass.
 */
import test, { after, before, beforeEach, describe } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";

import {
  SANDBOX_WORKSPACE_NOT_ALLOWED,
  allowedSandboxWorkspaces,
  firstDisallowedSandboxWorkspace,
  sandboxWorkspaceAllowed,
} from "@claw/protocol";
import { db } from "../src/infra/db.js";
import type { UserInfo } from "../src/auth/models.js";
import { sandboxWorkspaceRefusal } from "../src/tasks/sandbox-workspaces.js";
import { dagSandboxWorkspaces } from "../src/tasks/dag-expander.js";
import { assertSandboxWorkspaceAllowed, SandboxWorkspaceNotAllowedError } from "../src/tasks/dispatcher.js";
import { startHarness, type Harness } from "./scenario-harness.js";
import { closedDoorbellBarrier } from "./doorbell-barrier-stub.js";
import { stubDb } from "./support/db-stub.js";

const ENV_KEYS = ["SANDBOX_ALLOWED_NAMESPACES", "SANDBOX_NAMESPACE", "SANDBOX_CPU_NAMESPACE", "AGENT_SANDBOX_NAMESPACE"] as const;

/** Run `fn` with exactly these settings, and put the process's own back afterwards. */
async function withEnv<T>(env: Partial<Record<(typeof ENV_KEYS)[number], string>>, fn: () => Promise<T> | T): Promise<T> {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  try {
    return await fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const LISTED = { SANDBOX_ALLOWED_NAMESPACES: "ws-isolated, ws-gpu" };

describe("W1 the setting", () => {
  test("unset, empty or only separators allows every workspace", () => {
    for (const value of [undefined, "", " ", " , ,"]) {
      const env = value === undefined ? {} : { SANDBOX_ALLOWED_NAMESPACES: value };
      assert.equal(allowedSandboxWorkspaces(env), null, JSON.stringify(value));
      assert.equal(sandboxWorkspaceRefusal(["anything"], env), null, JSON.stringify(value));
    }
  });

  test("set, it is the list plus the deployment's own sandbox workspaces", () => {
    const allowed = allowedSandboxWorkspaces({
      SANDBOX_ALLOWED_NAMESPACES: "a,b c",
      SANDBOX_NAMESPACE: "gpu-default",
      SANDBOX_CPU_NAMESPACE: " cpu-default ",
      AGENT_SANDBOX_NAMESPACE: "",
    });
    assert.deepEqual([...allowed!].sort(), ["a", "b", "c", "cpu-default", "gpu-default"]);
    assert.equal(sandboxWorkspaceAllowed("a", allowed), true);
    assert.equal(sandboxWorkspaceAllowed(" cpu-default ", allowed), true);
    assert.equal(sandboxWorkspaceAllowed("other", allowed), false);
    // No name is "the deployment's default", which is on the list.
    assert.equal(sandboxWorkspaceAllowed("", allowed), true);
    assert.equal(sandboxWorkspaceAllowed(undefined, allowed), true);
    assert.equal(firstDisallowedSandboxWorkspace(["a", undefined, "x", "y"], allowed), "x");
  });

  test("the refusal names the workspace, the reason and where sandboxes may run", () => {
    const body = sandboxWorkspaceRefusal(["ws-open"], { ...LISTED, SANDBOX_CPU_NAMESPACE: "ws-cpu" });
    assert.ok(body);
    assert.equal(body.ok, false);
    assert.equal(body.error, SANDBOX_WORKSPACE_NOT_ALLOWED);
    assert.equal(body.workspace, "ws-open");
    assert.deepEqual(body.allowed, ["ws-cpu", "ws-gpu", "ws-isolated"]);
    assert.match(body.message, /ws-open workspace is not one of them/);
    assert.match(body.message, /ws-cpu, ws-gpu, ws-isolated/);
  });
});

describe("W2 messages and a session's first message", () => {
  const OWNER: UserInfo = {
    userId: "u-1", userName: "u-1", roles: ["default"], platformKey: "pk", virtualKey: "vk-u-1",
  };
  let h: Harness;
  let pristinePorts: Record<string, unknown> | null = null;
  let originalConnect: typeof db.pool.connect;
  let published: Record<string, unknown>[] = [];

  before(async () => {
    h = await startHarness();
    for (const column of [
      "plugin_id INTEGER", "tool_ids JSONB DEFAULT '[]'::jsonb", "workspace_id TEXT",
      "platform_key TEXT", "llm_api_key TEXT", "credentials_blob TEXT", "image TEXT",
      "resources JSONB", "timeout INTEGER", "topology JSONB", "tools_allowlist JSONB",
      "user_env JSONB DEFAULT '{}'::jsonb", "session_env JSONB DEFAULT '{}'::jsonb",
    ]) {
      await h.sql(`ALTER TABLE claw_pending_messages ADD COLUMN IF NOT EXISTS ${column}`);
    }
    const { sessionDispatchPorts } = await import("../src/sessions/dispatch.js");
    pristinePorts = { ...sessionDispatchPorts };
    originalConnect = db.pool.connect;
    db.pool.connect = (async () => ({
      query: (text: string, params?: unknown[]) => db.query(text, params),
      release: () => {},
    })) as unknown as typeof db.pool.connect;
  });

  beforeEach(async () => {
    await h.reset();
    const { sessionDispatchPorts } = await import("../src/sessions/dispatch.js");
    Object.assign(sessionDispatchPorts, pristinePorts);
    published = [];
    sessionDispatchPorts.doorbellDispatch = closedDoorbellBarrier;
    sessionDispatchPorts.publishSse = () => {};
    sessionDispatchPorts.publishTask = async (_subject: string, payload: string) => {
      published.push(JSON.parse(payload) as Record<string, unknown>);
      return published.length;
    };
  });

  after(async () => {
    const { sessionDispatchPorts } = await import("../src/sessions/dispatch.js");
    if (pristinePorts) Object.assign(sessionDispatchPorts, pristinePorts);
    db.pool.connect = originalConnect;
    await h?.close();
  });

  async function withApp(fn: (app: FastifyInstance) => Promise<void>): Promise<void> {
    const app = Fastify();
    app.addHook("preHandler", async (req) => {
      (req as unknown as { user: UserInfo }).user = OWNER;
    });
    const { registerSessionRoutes } = await import("../src/routes/sessions.js");
    await registerSessionRoutes(app);
    await app.ready();
    try {
      await fn(app);
    } finally {
      await app.close();
    }
  }

  const newSession = async (app: FastifyInstance, payload: Record<string, unknown> = { name: "s" }) =>
    app.inject({ method: "POST", url: "/v1/sessions", payload });
  const sessionId = (res: { json: () => unknown }) => (res.json() as { data: { session_id: string } }).data.session_id;
  const send = (app: FastifyInstance, sid: string, payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: `/v1/sessions/${sid}/messages`, payload: { content: "go", ...payload } });

  test("a message naming a workspace off the list is refused 400 and nothing reaches Brain", async () => {
    await withEnv(LISTED, () => withApp(async (app) => {
      const created = await newSession(app);
      assert.equal(created.statusCode, 200, created.body);
      const sid = sessionId(created);
      for (const key of ["workspaceId", "workspace_id"]) {
        const res = await send(app, sid, { [key]: "ws-open" });
        assert.equal(res.statusCode, 400, `${key}: ${res.body}`);
        const body = res.json() as { error: string; workspace: string; allowed: string[] };
        assert.equal(body.error, SANDBOX_WORKSPACE_NOT_ALLOWED);
        assert.equal(body.workspace, "ws-open");
        assert.deepEqual(body.allowed, ["ws-gpu", "ws-isolated"]);
      }
      assert.equal(published.length, 0, "a refused message was sent to Brain");
      const queued = await h.sql("SELECT COUNT(*)::int AS n FROM claw_pending_messages WHERE session_id = $1", [sid]);
      assert.equal(Number(queued[0].n), 0, "a refused message was queued");
    }));
  });

  test("the same message naming a listed workspace, or none, goes through", async () => {
    await withEnv(LISTED, () => withApp(async (app) => {
      const sid = sessionId(await newSession(app));
      const res = await send(app, sid, { workspaceId: "ws-isolated" });
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(published.length, 1);
      assert.equal(published[0].workspace_id, "ws-isolated");
    }));
    await h.reset();
    published = [];
    await withEnv(LISTED, () => withApp(async (app) => {
      const sid = sessionId(await newSession(app));
      const res = await send(app, sid, {});
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(published.length, 1);
    }));
  });

  test("with no list, any workspace goes through as before", async () => {
    await withEnv({}, () => withApp(async (app) => {
      const sid = sessionId(await newSession(app));
      const res = await send(app, sid, { workspaceId: "ws-open" });
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(published[0].workspace_id, "ws-open");
    }));
  });

  test("a session whose first message names a workspace off the list is not created", async () => {
    await withEnv(LISTED, () => withApp(async (app) => {
      const res = await newSession(app, { name: "s", message: { content: "go", workspaceId: "ws-open" } });
      assert.equal(res.statusCode, 400, res.body);
      assert.equal((res.json() as { error: string }).error, SANDBOX_WORKSPACE_NOT_ALLOWED);
      const sessions = await h.sql("SELECT COUNT(*)::int AS n FROM claw_sessions");
      assert.equal(Number(sessions[0].n), 0, "the refused session was created anyway");
      assert.equal(published.length, 0);

      const ok = await newSession(app, { name: "s", message: { content: "go", workspaceId: "ws-gpu" } });
      assert.equal(ok.statusCode, 200, ok.body);
    }));
  });
});

describe("W4 the dispatcher's line behind the routes", () => {
  test("names nodes' literal workspaces, leaving templates for the rendered spec", () => {
    assert.deepEqual(dagSandboxWorkspaces([
      { id: "a", sandbox: { handle: "h", namespace: " ws-a " } },
      { id: "b", sandbox: "none" },
      { id: "c", sandbox: { use: "h" } },
      { id: "d", sandbox: { handle: "h", namespace: "{{input.ws}}" } },
      { id: "e", sandbox: { handle: "h", namespace: 7 } },
    ] as never), ["ws-a"]);
  });

  test("a rendered spec off the list throws before anything is published; listed, none or no sandbox passes", async () => {
    await withEnv(LISTED, () => {
      assert.throws(
        () => assertSandboxWorkspaceAllowed({ sandbox_spec: { handle: "ws" } as never, workspace_id: "ws-open" }),
        (e: unknown) => e instanceof SandboxWorkspaceNotAllowedError && e.workspace === "ws-open" && e.code === SANDBOX_WORKSPACE_NOT_ALLOWED,
      );
      // An app run's child sandboxes go to `sandbox_workspace`.
      assert.throws(
        () => assertSandboxWorkspaceAllowed({ sandbox_spec: { handle: "app", sandbox_workspace: "ws-open" } as never, workspace_id: "ws-gpu" }),
        SandboxWorkspaceNotAllowedError,
      );
      assertSandboxWorkspaceAllowed({ sandbox_spec: { handle: "ws" } as never, workspace_id: "ws-isolated" });
      assertSandboxWorkspaceAllowed({ sandbox_spec: { handle: "ws" } as never, workspace_id: undefined });
      assertSandboxWorkspaceAllowed({ sandbox_spec: "none", workspace_id: "ws-open" });
    });
    await withEnv({}, () => {
      assertSandboxWorkspaceAllowed({ sandbox_spec: { handle: "ws" } as never, workspace_id: "ws-open" });
    });
  });
});

describe("W5 managed-agents sessions", () => {
  const OWNER: UserInfo = { userId: "u-1", userName: "u-1", roles: ["default"], platformKey: "pk", virtualKey: "vk-u-1" };
  const create = async (workspace: string) => {
    const stub = stubDb();
    const app = Fastify();
    app.addHook("preHandler", async (req) => { (req as unknown as { user: UserInfo }).user = OWNER; });
    const { registerAnthropicManagedAgentsRoutes } = await import("../src/routes/anthropic-managed-agents.js");
    await registerAnthropicManagedAgentsRoutes(app);
    await app.ready();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/anthropic/v1/sessions",
        payload: {
          agent: "agent_default",
          environment_id: "env_default",
          metadata: { primus_claw: JSON.stringify({ workspace_id: workspace }) },
        },
      });
      return { res, inserted: stub.ran(/INSERT INTO claw_sessions/) };
    } finally {
      stub.restore();
      await app.close();
    }
  };

  test("a pin off the list is refused 400 before the session row is written; a listed one is written", async () => {
    await withEnv(LISTED, async () => {
      const refused = await create("ws-open");
      assert.equal(refused.res.statusCode, 400, refused.res.body);
      assert.match(refused.res.body, /ws-open workspace is not one of them/);
      assert.equal(refused.inserted, false, "the refused session was written");

      const listed = await create("ws-isolated");
      assert.notEqual(listed.res.statusCode, 400, listed.res.body);
      assert.equal(listed.inserted, true, "the listed pin never reached the insert");
    });
  });
});

describe("W6 the MCP one-shot pipeline", () => {
  const OWNER: UserInfo = { userId: "u-1", userName: "u-1", roles: ["default"], platformKey: "pk", virtualKey: "vk-u-1" };

  /** `tools/call claw_run_pipeline` against /mcp, with POST /v1/sessions stubbed to record the call and return no id. */
  async function runPipeline(workspace: string): Promise<{ result: any; sessionCreates: number }> {
    let sessionCreates = 0;
    const app = Fastify();
    app.addHook("preHandler", async (req) => { (req as unknown as { user: UserInfo }).user = OWNER; });
    app.post("/v1/sessions", async () => { sessionCreates++; return { ok: true, data: {} }; });
    const { registerMcpRoutes } = await import("../src/routes/mcp.js");
    await registerMcpRoutes(app);
    await app.listen({ port: 0, host: "127.0.0.1" });
    try {
      const { port } = app.server.address() as { port: number };
      const r = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "tools/call",
          params: { name: "claw_run_pipeline", arguments: { prompt: "go", workspace_id: workspace, timeout: 1 } },
        }),
      });
      const text = await r.text();
      const data = /^data: (.*)$/m.exec(text)?.[1] ?? text;
      return { result: JSON.parse(data).result, sessionCreates };
    } finally {
      await app.close();
    }
  }

  test("a workspace off the list is refused before the session is created; a listed one goes on to create it", async () => {
    await withEnv(LISTED, async () => {
      const refused = await runPipeline("ws-open");
      assert.equal(refused.result?.isError, true, JSON.stringify(refused.result));
      assert.match(JSON.stringify(refused.result), /ws-open workspace is not one of them/);
      assert.equal(refused.sessionCreates, 0, "the session was created before the refusal");

      const listed = await runPipeline("ws-isolated");
      assert.equal(listed.sessionCreates, 1, JSON.stringify(listed.result));
    });
  });
});
