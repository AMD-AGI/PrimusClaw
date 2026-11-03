// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Where a request's own `mcp_servers` may point, against the real session routes and a real PostgreSQL engine (PGlite).
 *
 * Brain connects to every server a turn carries, from inside the cluster, so a server named in a request is a URL fetched
 * on the requester's behalf. Both routes that take one -- a message, and a new session's first message -- refuse a server
 * that is not https or that resolves to a loopback, link-local or private address, unless the operator allowed its host;
 * and a refused request leaves nothing behind. Hosts are IP literals or `localhost`, so no row depends on outside DNS.
 */
import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import type { FastifyInstance } from "fastify";

// Before anything reads the configuration, which is read when its module loads.
process.env.MCP_SERVER_ALLOWED_HOSTS = "localhost";

type Mod<T> = T extends Promise<infer U> ? U : never;
let h: Mod<ReturnType<typeof import("./scenario-harness.js").startHarness>>;
let db: typeof import("../src/infra/db.js").db;
let app: FastifyInstance;
let published: Record<string, unknown>[] = [];
let originalConnect: unknown;
let pristinePorts: Record<string, unknown> = {};

before(async () => {
  h = await (await import("./scenario-harness.js")).startHarness();
  db = (await import("../src/infra/db.js")).db;
  const { sessionDispatchPorts } = await import("../src/sessions/dispatch.js");
  pristinePorts = { ...sessionDispatchPorts };
  originalConnect = db.pool.connect;
  db.pool.connect = (async () => ({ query: (text: string, params?: unknown[]) => db.query(text, params), release: () => {} })) as unknown as typeof db.pool.connect;
  const { closedDoorbellBarrier } = await import("./doorbell-barrier-stub.js");
  (globalThis as unknown as { __closed: unknown }).__closed = closedDoorbellBarrier;
  const Fastify = (await import("fastify")).default;
  const { registerSessionRoutes } = await import("../src/routes/sessions.js");
  app = Fastify();
  app.addHook("preHandler", async (req) => {
    (req as unknown as { user: unknown }).user = { userId: "u-alice", userName: "Alice", roles: ["default"], platformKey: "pk", virtualKey: "vk" };
    (req as unknown as { authMethod: string }).authMethod = "identity_token";
  });
  await registerSessionRoutes(app);
  await app.ready();
});

beforeEach(async () => {
  await h.reset();
  const { sessionDispatchPorts } = await import("../src/sessions/dispatch.js");
  Object.assign(sessionDispatchPorts, pristinePorts);
  published = [];
  sessionDispatchPorts.doorbellDispatch = (globalThis as unknown as { __closed: typeof sessionDispatchPorts.doorbellDispatch }).__closed;
  sessionDispatchPorts.publishSse = () => {};
  sessionDispatchPorts.publishTask = async (_subject: string, payload: string) => {
    published.push(JSON.parse(payload) as Record<string, unknown>);
    return published.length;
  };
});

after(async () => {
  const { sessionDispatchPorts } = await import("../src/sessions/dispatch.js");
  Object.assign(sessionDispatchPorts, pristinePorts);
  db.pool.connect = originalConnect as typeof db.pool.connect;
  await app?.close();
  await h?.close();
});

const post = async (url: string, payload: unknown) => {
  const res = await app.inject({ method: "POST", url, payload: payload as never });
  return { status: res.statusCode, body: res.json() as { ok: boolean; error?: string; data?: { session_id: string } } };
};
const count = async (table: string): Promise<number> => Number((await h.sql(`SELECT count(*)::int AS n FROM ${table}`))[0]?.n);
const server = (url: unknown) => ({ probe: { type: "http", url, token: "<SAFE_API_KEY>" } });

const rows: Array<{ name: string; servers: unknown; refused: RegExp | null }> = [
  { name: "loopback", servers: server("https://127.0.0.1:8080/mcp"), refused: /mcp_servers\.probe\.url refused: private_address/ },
  { name: "link-local metadata address", servers: server("https://169.254.169.254/latest"), refused: /private_address/ },
  { name: "cluster-internal private address", servers: server("https://10.96.0.1/mcp"), refused: /private_address/ },
  { name: "IPv4-mapped loopback", servers: server("https://[::ffff:127.0.0.1]/mcp"), refused: /private_address/ },
  { name: "plain http to a public address", servers: server("http://93.184.215.14/mcp"), refused: /https_required/ },
  { name: "not http at all", servers: server("file:///etc/passwd"), refused: /https_required/ },
  { name: "no url", servers: { probe: { command: "sh" } }, refused: /mcp_servers\.probe\.url must be an http\(s\) URL/ },
  { name: "not an object", servers: ["https://93.184.215.14/mcp"], refused: /mcp_servers must be a JSON object/ },
  { name: "https to a public address", servers: server("https://93.184.215.14/mcp"), refused: null },
  { name: "a host the operator allowed, over http", servers: server("http://localhost:8080/mcp"), refused: null },
  { name: "none", servers: undefined, refused: null },
];

for (const row of rows) {
  test(`a message: ${row.name}`, async () => {
    const created = await post("/v1/sessions", { name: "s", config: { notify_on_finish: true } });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const id = created.body.data!.session_id;
    const r = await post(`/v1/sessions/${id}/messages`, { content: "hello", mcp_servers: row.servers });
    if (row.refused) {
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.match(r.body.error ?? "", row.refused);
      assert.equal(published.length, 0, "nothing was published");
      assert.equal(await count("claw_pending_messages"), 0, "nothing was queued");
    } else {
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(published.length, 1, "the turn was dispatched");
      assert.deepEqual(published[0]?.mcp_servers ?? null, row.servers ?? null, "with the servers as sent");
    }
  });

  test(`a new session's first message: ${row.name}`, async () => {
    const r = await post("/v1/sessions", { name: "s", message: { content: "hello", mcp_servers: row.servers } });
    if (row.refused) {
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.match(r.body.error ?? "", row.refused);
      assert.ok((r.body.error ?? "").startsWith("message.mcp_servers"), "the error names the field it is about");
      assert.equal(await count("claw_sessions"), 0, "no session was created");
      assert.equal(published.length, 0, "nothing was published");
    } else {
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(published.length, 1, "the first turn was dispatched");
    }
  });
}
