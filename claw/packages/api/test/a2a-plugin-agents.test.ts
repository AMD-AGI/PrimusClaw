// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The A2A routes that make a Claw plugin an agent of its own, and the card URL
 * every agent advertises.
 *
 * `POST /a2a/plugins/:pluginId` is the JSON-RPC surface of `POST /a2a` with the
 * plugin fixed by the path, and `GET /a2a/plugins/:pluginId/.well-known/
 * agent-card.json` is that agent's card. Neither is anonymous, and a plugin the
 * caller cannot view is not reachable through either -- no method of it, and
 * not even the knowledge that it exists.
 *
 * The pure rules (URL derivation, card contents, binding) are tabled in
 * a2a-agent-cards.test.ts; this file drives the real routes against the real
 * admission schema, so what it proves is what a client meets.
 *
 * The NATS seam is the one `a2a-plugin-tools.test.ts` uses: `js` and `nc` are
 * module bindings `initNats` assigns, so a resolve hook points `routes/a2a.ts`
 * at this module's exports and must be registered before it loads.
 *
 * Coverage:
 *   R1 the generic card's URL: configured, forwarded, or relative as before
 *   R2 a plugin's card: who gets it, what it says, and the one answer for "no"
 *   R3 a send on a plugin's endpoint runs that plugin, not another
 *   R4 a plugin the caller cannot view is unreachable on every method
 *   R5 tasks stay the caller's: no other tenant reads or extends them
 *   R6 a streaming send is bound to the plugin too
 *   R7 the generic endpoint is what it was
 */

import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { after, before, describe } from "node:test";

import Fastify, { type FastifyInstance } from "fastify";
import { StringCodec } from "nats";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startAdmissionCluster, type AdmissionCluster } from "./support/admission-cluster.js";

const A2A_MODULE = new URL("../src/routes/a2a.ts", import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === A2A_MODULE && specifier === "../infra/nats.js") {
      return { url: import.meta.url, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

export const sc = StringCodec();

const published: Array<{ subject: string; payload: string }> = [];

export const js = {
  async publish(subject: string, payload: Uint8Array): Promise<void> {
    published.push({ subject, payload: new TextDecoder().decode(payload) });
  },
};

/** What the next stream subscription yields; a streaming send ends on a result. */
let streamEvents: Array<Record<string, unknown>> = [];

export const nc = {
  subscribe(_subject: string) {
    const events = streamEvents;
    return {
      unsubscribe(): void { /* nothing to release */ },
      async *[Symbol.asyncIterator]() {
        for (const event of events) yield { data: sc.encode(JSON.stringify(event)) };
      },
    };
  },
};

const skip = postgresSkipReason();

type User = { userId: string; userName: string; roles: string[]; platformKey: string; virtualKey: string };
const user = (id: string, roles: string[] = ["user"]): User => (
  { userId: id, userName: id, roles, platformKey: "pk", virtualKey: "vk" }
);
const ALICE = user("u-alice");
const BOB = user("u-bob");
const ADMIN = user("u-admin", ["system-admin"]);

interface StubPlugin {
  ownedBy: string;
  isPublic: boolean;
  name: string;
  description: string;
  version: string;
  toolIds: number[];
}

const TOOLS: Record<number, { id: number; type: string; name: string; description: string; config: object }> = {
  11: { id: 11, type: "skill", name: "triage-steps", description: "How to triage", config: {} },
  12: { id: 12, type: "mcp", name: "cluster", description: "Cluster access", config: { mcpServers: { cluster: { url: "http://mcp.invalid/cluster" } } } },
  13: { id: 13, type: "skill", name: "release-notes", description: "Write release notes", config: {} },
};

// plugin id -> plugin. 7 is public and Alice's; 8 is public and Bob's; 9 is
// Bob's and private; 10 is Alice's and private. 404 does not exist.
const PLUGINS: Record<number, StubPlugin> = {
  7: { ownedBy: "u-alice", isPublic: true, name: "gpu-triage", description: "Finds the failing GPU job", version: "1.4.0", toolIds: [11, 12] },
  8: { ownedBy: "u-bob", isPublic: true, name: "release-helper", description: "Drafts release notes", version: "2.0.0", toolIds: [13] },
  9: { ownedBy: "u-bob", isPublic: false, name: "bobs-secret-plugin", description: "Private to Bob", version: "1.0.0", toolIds: [12] },
  10: { ownedBy: "u-alice", isPublic: false, name: "alices-private", description: "Private to Alice", version: "1.0.0", toolIds: [11] },
};

interface Ctx {
  harness: AdmissionCluster;
  app: FastifyInstance;
  user: User | null;
}

function stubMarketplace(ctx: Ctx): void {
  const { MarketplaceDb } = ctx.harness.app.db;
  MarketplaceDb.pluginGetById = (async (id: number) => {
    const p = PLUGINS[id];
    return p
      ? {
        id, name: p.name, description: p.description, version: p.version, images: [], resource: {},
        tools: p.toolIds.map((tid) => ({ id: tid })), owner_user_id: p.ownedBy, is_public: p.isPublic,
      }
      : null;
  }) as typeof MarketplaceDb.pluginGetById;
  MarketplaceDb.toolsGetByIds = (async (ids: number[]) => ids.map((tid) => TOOLS[tid]).filter(Boolean)) as typeof MarketplaceDb.toolsGetByIds;
}

let sends = 0;

interface RpcResult { status: number; body: Record<string, any>; text: string }

async function rpc(
  ctx: Ctx, url: string, method: string, params: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<RpcResult> {
  const res = await ctx.app.inject({
    method: "POST", url, headers: { "a2a-version": "1.0", ...headers },
    payload: { jsonrpc: "2.0", id: 1, method, params },
  });
  let body: Record<string, any> = {};
  try { body = JSON.parse(res.body); } catch { /* an SSE body is not JSON */ }
  return { status: res.statusCode, body, text: res.body };
}

function send(
  ctx: Ctx, url: string, metadata?: Record<string, unknown>, extra: Record<string, unknown> = {},
  method = "SendMessage",
): Promise<RpcResult> {
  sends += 1;
  return rpc(ctx, url, method, {
    message: { messageId: `m-agent-${sends}`, role: "ROLE_USER", parts: [{ text: "ls /tmp" }], ...extra },
    configuration: { returnImmediately: true },
    ...(metadata ? { metadata } : {}),
  });
}

const executes = () => published
  .filter((m) => m.subject === "tasks.execute")
  .map((m) => JSON.parse(m.payload) as Record<string, any>);

async function reset(ctx: Ctx): Promise<void> {
  const { db } = ctx.harness.app.db;
  await db.query("DELETE FROM claw_tasks");
  await db.query("DELETE FROM claw_workspace_refs");
  await db.query("DELETE FROM claw_sessions WHERE user_id = 'a2a' OR user_id = ANY($1)", [[ALICE.userId, BOB.userId, ADMIN.userId]]);
  published.length = 0;
  // A stream that never ends is a test that never ends, whichever way the
  // behaviour under test goes wrong, so the default stream ends on its own.
  streamEvents = [{ type: "ResultMessage", data: { subtype: "success" } }];
}

async function sessionRows(ctx: Ctx): Promise<number> {
  const r = await ctx.harness.app.db.db.query("SELECT COUNT(*)::int AS n FROM claw_sessions");
  return (r.rows[0] as { n: number }).n;
}

describe("A2A agents: the card URL and one agent per plugin", { skip }, () => {
  const ctx = { user: ALICE } as Ctx;
  const savedPublicUrl = process.env.CLAW_PUBLIC_URL;

  before(async () => {
    ctx.harness = await startAdmissionCluster({ ADMIT_HARD_RUNS: "50" });
    stubMarketplace(ctx);
    const a2a = await import("../src/routes/a2a.js");
    ctx.app = Fastify();
    ctx.app.addHook("onRequest", async (req) => { (req as unknown as { user: unknown }).user = ctx.user; });
    await a2a.registerA2ARoutes(ctx.app);
    await ctx.app.ready();
  });
  after(async () => {
    if (savedPublicUrl === undefined) delete process.env.CLAW_PUBLIC_URL;
    else process.env.CLAW_PUBLIC_URL = savedPublicUrl;
    await ctx.app?.close();
    await ctx.harness?.stop();
  });

  describe("R1 the generic card's URL", () => {
    const cases: Array<{
      name: string; env?: string; headers: Record<string, string>; want: string;
    }> = [
      { name: "as before when nothing says otherwise", headers: {}, want: "/a2a" },
      { name: "configured", env: "https://claw.example.com/claw-api", headers: {}, want: "https://claw.example.com/claw-api/a2a" },
      {
        name: "forwarded by the ingress",
        headers: { "x-forwarded-host": "claw.example.com", "x-forwarded-proto": "https", "x-forwarded-prefix": "/claw-api" },
        want: "https://claw.example.com/claw-api/a2a",
      },
      {
        name: "configured beats forwarded",
        env: "https://configured.example.com",
        headers: { "x-forwarded-host": "claw.example.com", "x-forwarded-prefix": "/claw-api" },
        want: "https://configured.example.com/a2a",
      },
      {
        name: "a forwarded host that is not a host is not advertised",
        headers: { "x-forwarded-host": "evil.example.com/steal", "x-forwarded-proto": "https" },
        want: "/a2a",
      },
    ];
    const paths = [
      "/.well-known/agent-card.json",
      "/a2a/.well-known/agent-card.json",
      "/.well-known/agent.json",
      "/a2a/.well-known/agent.json",
    ];
    for (const c of cases) {
      for (const path of paths) {
        test(`${c.name}: ${path}`, async () => {
          if (c.env === undefined) delete process.env.CLAW_PUBLIC_URL;
          else process.env.CLAW_PUBLIC_URL = c.env;
          ctx.user = null; // discovery is anonymous
          const res = await ctx.app.inject({ method: "GET", url: path, headers: c.headers });
          assert.equal(res.statusCode, 200);
          const card = JSON.parse(res.body);
          assert.equal(card.name, "PrimusClaw");
          assert.equal(card.supportedInterfaces[0].url, c.want);
          assert.match(String(res.headers.vary), /X-Forwarded-Prefix/i, "a shared cache must key on what the URL came from");
        });
      }
    }
  });

  describe("R2 a plugin's card", () => {
    const cases: Array<{
      name: string; caller: User | null; id: string; status: number;
      body?: { name: string; description: string; version: string; skills: string[] };
    }> = [
      {
        name: "the owner of a private plugin", caller: ALICE, id: "10", status: 200,
        body: { name: "alices-private", description: "Private to Alice", version: "1.0.0", skills: ["skill-triage-steps"] },
      },
      {
        name: "anyone, for a public plugin", caller: BOB, id: "7", status: 200,
        body: { name: "gpu-triage", description: "Finds the failing GPU job", version: "1.4.0", skills: ["skill-triage-steps", "mcp-cluster"] },
      },
      {
        name: "an admin, for someone else's private plugin", caller: ADMIN, id: "9", status: 200,
        body: { name: "bobs-secret-plugin", description: "Private to Bob", version: "1.0.0", skills: ["mcp-cluster"] },
      },
      { name: "another user's private plugin", caller: ALICE, id: "9", status: 404 },
      { name: "a plugin that does not exist", caller: ALICE, id: "404", status: 404 },
      { name: "an id that is not a number", caller: ALICE, id: "abc", status: 404 },
      { name: "zero", caller: ALICE, id: "0", status: 404 },
      { name: "a negative id", caller: ALICE, id: "-7", status: 404 },
      { name: "a fractional id", caller: ALICE, id: "7.5", status: 404 },
      { name: "an exponent id", caller: ALICE, id: "7e0", status: 404 },
      { name: "a zero-padded id", caller: ALICE, id: "07", status: 404 },
      { name: "an id beyond a safe integer", caller: ALICE, id: "99999999999999999999", status: 404 },
      { name: "nobody at all", caller: null, id: "7", status: 401 },
    ];
    for (const c of cases) {
      test(c.name, async () => {
        delete process.env.CLAW_PUBLIC_URL;
        ctx.user = c.caller;
        const res = await ctx.app.inject({ method: "GET", url: `/a2a/plugins/${c.id}/.well-known/agent-card.json` });
        assert.equal(res.statusCode, c.status, res.body);
        assert.match(String(res.headers["cache-control"]), /no-store/, "a card that depends on the caller is not cacheable");
        if (!c.body) return;
        const card = JSON.parse(res.body);
        assert.equal(card.name, c.body.name);
        assert.equal(card.description, c.body.description);
        assert.equal(card.version, c.body.version);
        assert.deepEqual(card.skills.map((s: { id: string }) => s.id), c.body.skills);
        assert.equal(card.supportedInterfaces[0].url, `/a2a/plugins/${c.id}`);
      });
    }

    test("a private plugin and a missing one are told apart by nothing", async () => {
      ctx.user = ALICE;
      const get = async (id: number) => {
        const res = await ctx.app.inject({ method: "GET", url: `/a2a/plugins/${id}/.well-known/agent-card.json` });
        return { status: res.statusCode, body: res.body };
      };
      const privateOfBob = await get(9);
      const missing = await get(404);
      assert.equal(privateOfBob.status, 404);
      assert.deepEqual(privateOfBob, missing);
      assert.ok(!privateOfBob.body.includes("bobs-secret-plugin"), "the private plugin's name leaked");
    });

    test("its URL is the plugin's endpoint, under the public base", async () => {
      process.env.CLAW_PUBLIC_URL = "https://claw.example.com/claw-api";
      try {
        ctx.user = BOB;
        const res = await ctx.app.inject({ method: "GET", url: "/a2a/plugins/7/.well-known/agent-card.json" });
        assert.equal(JSON.parse(res.body).supportedInterfaces[0].url, "https://claw.example.com/claw-api/a2a/plugins/7");
      } finally {
        delete process.env.CLAW_PUBLIC_URL;
      }
    });

    test("the card's URL is a route that answers", async () => {
      ctx.user = BOB;
      const res = await rpc(ctx, "/a2a/plugins/7", "GetExtendedAgentCard", {});
      assert.equal(res.status, 200);
      assert.equal(res.body.error?.code, -32004, "an RPC answer, not a 404: the route exists");
    });
  });

  describe("R3 a send on a plugin's endpoint runs that plugin", () => {
    const cases: Array<{ name: string; caller: User; url: string; metadata?: Record<string, unknown>; plugin: number; tools: string[] }> = [
      { name: "plugin 7", caller: ALICE, url: "/a2a/plugins/7", plugin: 7, tools: ["triage-steps", "cluster"] },
      { name: "plugin 8 is a different agent", caller: ALICE, url: "/a2a/plugins/8", plugin: 8, tools: ["release-notes"] },
      { name: "a plugin the caller owns and keeps private", caller: ALICE, url: "/a2a/plugins/10", plugin: 10, tools: ["triage-steps"] },
      { name: "an admin, on a private plugin that is not theirs", caller: ADMIN, url: "/a2a/plugins/9", plugin: 9, tools: ["cluster"] },
      { name: "metadata naming the same plugin", caller: ALICE, url: "/a2a/plugins/7", metadata: { plugin_id: 7 }, plugin: 7, tools: ["triage-steps", "cluster"] },
      { name: "other metadata is carried", caller: ALICE, url: "/a2a/plugins/7", metadata: { workspace_id: "ws-1" }, plugin: 7, tools: ["triage-steps", "cluster"] },
    ];
    for (const c of cases) {
      test(c.name, async () => {
        await reset(ctx);
        ctx.user = c.caller;
        const res = await send(ctx, c.url, c.metadata);
        assert.equal(res.status, 200, res.text);
        assert.ok(res.body.result?.task?.id, `no task: ${res.text.slice(0, 200)}`);
        const sent = executes();
        assert.equal(sent.length, 1, "one execute request");
        assert.equal(sent[0]!.plugin_id, c.plugin);
        assert.deepEqual(
          (sent[0]!.plugin_tools as Array<{ name: string }>).map((t) => t.name), c.tools,
          "Brain is handed the plugin's own tools",
        );
        if (c.metadata?.workspace_id) assert.equal(sent[0]!.workspace_id, c.metadata.workspace_id);
      });
    }

    test("a different plugin named in metadata is refused, and nothing runs", async () => {
      await reset(ctx);
      ctx.user = ALICE;
      const before = await sessionRows(ctx);
      const res = await send(ctx, "/a2a/plugins/7", { plugin_id: 8 });
      assert.equal(res.body.error?.code, -32602, res.text);
      assert.equal(executes().length, 0);
      assert.equal(await sessionRows(ctx), before, "a refused send left a session behind");
    });
  });

  describe("R4 a plugin the caller cannot view is unreachable", () => {
    const methods: Array<{ method: string; params: Record<string, unknown> }> = [
      { method: "SendMessage", params: { message: { messageId: "m-denied", role: "ROLE_USER", parts: [{ text: "hi" }] }, configuration: { returnImmediately: true } } },
      { method: "SendStreamingMessage", params: { message: { messageId: "m-denied-s", role: "ROLE_USER", parts: [{ text: "hi" }] } } },
      { method: "GetTask", params: { id: "a2a-whatever" } },
      { method: "ListTasks", params: {} },
      { method: "CancelTask", params: { id: "a2a-whatever" } },
      { method: "SubscribeToTask", params: { id: "a2a-whatever" } },
      { method: "GetExtendedAgentCard", params: {} },
      { method: "NoSuchMethod", params: {} },
    ];
    const targets = [
      { name: "another user's private plugin", id: "9" },
      { name: "a plugin that does not exist", id: "404" },
      { name: "an id that is not a number", id: "abc" },
    ];
    for (const t of targets) {
      for (const m of methods) {
        test(`${m.method} on ${t.name}`, async () => {
          await reset(ctx);
          ctx.user = ALICE;
          const before = await sessionRows(ctx);
          const res = await rpc(ctx, `/a2a/plugins/${t.id}`, m.method, m.params);
          assert.equal(res.status, 404, res.text);
          assert.equal(res.body.error?.message, "plugin agent not found");
          assert.equal(published.length, 0, "something was published for a plugin the caller cannot view");
          assert.equal(await sessionRows(ctx), before, "a session was created for a plugin the caller cannot view");
        });
      }
    }

    test("a private plugin and a missing one are told apart by nothing", async () => {
      ctx.user = ALICE;
      const asked = async (id: number) => {
        const res = await send(ctx, `/a2a/plugins/${id}`);
        return { status: res.status, body: res.text };
      };
      const privateOfBob = await asked(9);
      assert.deepEqual(privateOfBob, await asked(404));
      assert.ok(!privateOfBob.body.includes("bobs-secret-plugin"));
    });

    test("an unauthenticated request is refused before the plugin is looked at", async () => {
      ctx.user = null;
      const res = await send(ctx, "/a2a/plugins/7");
      assert.equal(res.status, 401, res.text);
      assert.equal(published.length, 0);
    });

    test("the same plugin is reachable by someone who can view it", async () => {
      await reset(ctx);
      ctx.user = BOB; // owner of 9
      const res = await send(ctx, "/a2a/plugins/9");
      assert.equal(res.status, 200, res.text);
      assert.equal(executes()[0]!.plugin_id, 9);
    });

    test("a request that is not JSON-RPC is refused the same way whatever the plugin", async () => {
      ctx.user = ALICE;
      const asked = async (id: number) => {
        const res = await ctx.app.inject({ method: "POST", url: `/a2a/plugins/${id}`, headers: { "a2a-version": "1.0" }, payload: { not: "rpc" } });
        return { status: res.statusCode, body: res.body };
      };
      assert.deepEqual(await asked(9), await asked(7));
    });
  });

  describe("R5 tasks stay the caller's", () => {
    test("another user cannot read, list or extend a task made on a plugin's endpoint", async () => {
      await reset(ctx);
      ctx.user = ALICE;
      const made = await send(ctx, "/a2a/plugins/7");
      const taskId = made.body.result.task.id as string;

      const own = await rpc(ctx, "/a2a/plugins/7", "GetTask", { id: taskId });
      assert.equal(own.body.result?.id, taskId, "the caller reads their own task");

      ctx.user = BOB; // can view plugin 7, so reaches the endpoint, but the task is not theirs
      const read = await rpc(ctx, "/a2a/plugins/7", "GetTask", { id: taskId });
      assert.equal(read.body.error?.code, -32001, `read another tenant's task: ${read.text}`);

      const list = await rpc(ctx, "/a2a/plugins/7", "ListTasks", {});
      assert.deepEqual(list.body.result?.tasks, [], "listed another tenant's task");

      published.length = 0;
      const extend = await send(ctx, "/a2a/plugins/7", undefined, { taskId });
      assert.equal(extend.body.error?.code, -32001, `extended another tenant's task: ${extend.text}`);
      assert.equal(executes().length, 0);

      const cancel = await rpc(ctx, "/a2a/plugins/7", "CancelTask", { id: taskId });
      assert.equal(cancel.body.error?.code, -32001);
    });

    test("a task made on one endpoint is the same caller's on the generic one", async () => {
      await reset(ctx);
      ctx.user = ALICE;
      const made = await send(ctx, "/a2a/plugins/7");
      const taskId = made.body.result.task.id as string;
      const viaGeneric = await rpc(ctx, "/a2a", "GetTask", { id: taskId });
      assert.equal(viaGeneric.body.result?.id, taskId);
    });
  });

  describe("R6 a streaming send", () => {
    test("is bound to the plugin and streams its events", async () => {
      await reset(ctx);
      ctx.user = ALICE;
      streamEvents = [{ type: "ResultMessage", data: { subtype: "success" } }];
      const res = await rpc(ctx, "/a2a/plugins/7", "SendStreamingMessage", {
        message: { messageId: "m-stream-ok", role: "ROLE_USER", parts: [{ text: "ls" }] },
      });
      assert.equal(res.status, 200, res.text);
      assert.match(res.text, /TASK_STATE_COMPLETED/, "the stream reached its terminal state");
      const sent = executes();
      assert.equal(sent.length, 1);
      assert.equal(sent[0]!.plugin_id, 7);
      assert.deepEqual((sent[0]!.plugin_tools as Array<{ name: string }>).map((t) => t.name), ["triage-steps", "cluster"]);
    });

    test("naming a different plugin is refused before any stream opens", async () => {
      await reset(ctx);
      ctx.user = ALICE;
      const res = await rpc(ctx, "/a2a/plugins/7", "SendStreamingMessage", {
        message: { messageId: "m-stream-bad", role: "ROLE_USER", parts: [{ text: "ls" }] },
        metadata: { plugin_id: 8 },
      });
      assert.equal(res.body.error?.code, -32602, res.text);
      assert.equal(executes().length, 0);
    });
  });

  describe("R7 the generic endpoint is what it was", () => {
    test("a send names no plugin of its own", async () => {
      await reset(ctx);
      ctx.user = ALICE;
      const res = await send(ctx, "/a2a");
      assert.equal(res.status, 200, res.text);
      const sent = executes();
      assert.equal(sent.length, 1);
      assert.equal("plugin_id" in sent[0]!, false);
    });

    test("metadata.plugin_id still selects a plugin, as it did", async () => {
      await reset(ctx);
      ctx.user = ALICE;
      await send(ctx, "/a2a", { plugin_id: 8 });
      assert.equal(executes()[0]!.plugin_id, 8);
    });

    test("a plugin the caller cannot view is still handed over as null, not refused", async () => {
      await reset(ctx);
      ctx.user = ALICE;
      const res = await send(ctx, "/a2a", { plugin_id: 9 });
      assert.equal(res.status, 200, res.text);
      assert.equal(executes()[0]!.plugin_tools, null);
    });
  });
});
