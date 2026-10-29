// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Remote agents over real HTTP against a real Postgres whose schema `initDb`
 * built with `CLAW_REMOTE_AGENTS_ENABLED` on: registry, presence, command relay,
 * event relay with resume, decisions, limits, revocation and owner isolation.
 * Skipped without DATABASE_URL, and a skip is not a pass.
 *
 * The caller is whoever the `x-test-user` header names, standing in for the
 * verified identity the global auth hook would attach.
 */
import assert from "node:assert/strict";
import test, { after, afterEach, before, beforeEach, describe } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startAdmissionCluster, type AdmissionCluster } from "./support/admission-cluster.js";
import { SseClient } from "./support/sse-client.js";
import type { Waker } from "../src/remote-agents/waker.js";
import type { RemoteAgentOptions } from "../src/routes/remote-agents.js";

const skip = postgresSkipReason();
const AGENT = { agent_id: "a1", kind: "example-kind", name: "Agent One", capabilities: { loadSession: true } };
const NOBODY = "00000000-0000-4000-8000-000000000000";

describe("remote agents", { skip }, () => {
  let h: AdmissionCluster;
  let waker: Waker;
  let register: typeof import("../src/routes/remote-agents.js").registerRemoteAgentRoutes;
  const apps: FastifyInstance[] = [];
  let base = "";
  let streams: SseClient[] = [];
  const q = (text: string, params: unknown[] = []) => h.app.db.db.query(text, params);

  async function serve(opts: RemoteAgentOptions = {}): Promise<string> {
    const app = Fastify();
    app.addHook("preHandler", async (req) => {
      const id = req.headers["x-test-user"];
      if (typeof id === "string") {
        (req as any).user = {
          userId: id, userName: id, platformKey: "", virtualKey: "",
          roles: req.headers["x-test-admin"] ? ["default", "system-admin"] : ["default"],
        };
      }
    });
    await register(app, { pingMs: 150, pollMs: 40, waker, retentionDays: 0, ...opts });
    await app.listen({ port: 0, host: "127.0.0.1" });
    apps.push(app);
    return `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  }

  before(async () => {
    h = await startAdmissionCluster({ CLAW_REMOTE_AGENTS_ENABLED: "true" });
    const { Waker: W } = await import("../src/remote-agents/waker.js");
    waker = new W();
    register = (await import("../src/routes/remote-agents.js")).registerRemoteAgentRoutes;
    base = await serve();
  });
  after(async () => {
    for (const s of streams) await s.closed();
    for (const a of apps) await a.close();
    await h?.stop();
  });
  beforeEach(async () => {
    await q("DELETE FROM claw_remote_audit");
    await q("DELETE FROM claw_remote_connectors");
  });
  afterEach(async () => {
    for (const s of streams) await s.closed();
    streams = [];
  });

  type Res = { status: number; body: any };
  async function call(user: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}, root = base): Promise<Res> {
    const r = await fetch(root + path, {
      method,
      headers: { ...(user ? { "x-test-user": user } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  }
  const as = (user: string) => ({
    get: (p: string, root?: string) => call(user, "GET", p, undefined, {}, root),
    post: (p: string, b?: unknown, hd?: Record<string, string>, root?: string) => call(user, "POST", p, b ?? {}, hd, root),
    del: (p: string) => call(user, "DELETE", p),
  });

  async function connector(user = "u1", name = "laptop"): Promise<string> {
    const r = await as(user).post("/v1/remote-agents/connectors", { name });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.data.connector_id;
  }
  const heartbeat = (user: string, cid: string, extra: Record<string, unknown> = {}, agents: unknown[] = [AGENT]) =>
    as(user).post(`/v1/remote-agents/connectors/${cid}/heartbeat`, { agents, ...extra });
  async function openCommands(user: string, cid: string, cursor?: string): Promise<SseClient> {
    const s = await SseClient.open(`${base}/v1/remote-agents/connectors/${cid}/commands`, {
      "x-test-user": user, ...(cursor === undefined ? {} : { "last-event-id": cursor }),
    });
    streams.push(s);
    return s;
  }
  /** A connector that is online: agent advertised and its command stream open. */
  async function online(user = "u1"): Promise<{ cid: string; stream: SseClient }> {
    const cid = await connector(user);
    const stream = await openCommands(user, cid);
    assert.equal(stream.status, 200);
    await stream.nextEvent("ready");
    assert.equal((await heartbeat(user, cid)).status, 200);
    return { cid, stream };
  }
  async function session(user: string, cid: string, cwd = "/work/repo"): Promise<string> {
    const r = await as(user).post("/v1/remote-agents/sessions", { connector_id: cid, agent_id: "a1", cwd });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.data.session_id;
  }
  let nextSeq = new Map<string, number>();
  const ev = (sid: string, type: string, data: Record<string, unknown> = {}, seq?: number) => {
    const n = seq ?? (nextSeq.get(sid) ?? 0) + 1;
    nextSeq.set(sid, Math.max(n, nextSeq.get(sid) ?? 0));
    return { session_id: sid, seq: n, type, ts: Date.now(), data };
  };
  const post = (user: string, cid: string, events: unknown[], batch = "b1") =>
    as(user).post(`/v1/remote-agents/connectors/${cid}/events`, { batch_id: batch, events });
  const online1 = async () => { nextSeq = new Map(); return online(); };

  // ---------------------------------------------------------------- registry

  describe("registry and presence", () => {
    test("registration is validated and limited per user", async () => {
      for (const body of [{}, { name: "" }, { name: "x".repeat(65) }, { name: "bad\nname" }, { name: "ok", version: 5 }]) {
        assert.equal((await as("u1").post("/v1/remote-agents/connectors", body)).status, 400, JSON.stringify(body));
      }
      for (let i = 0; i < 5; i++) await connector("u1", `m${i}`);
      const sixth = await as("u1").post("/v1/remote-agents/connectors", { name: "m5" });
      assert.deepEqual([sixth.status, sixth.body.error], [409, "connector_limit_reached"]);
      // The limit is per user, and a revoked connector frees its place.
      await connector("u2");
      const list = (await as("u1").get("/v1/remote-agents/connectors")).body.data;
      assert.equal(list.length, 5);
      assert.equal((await as("u1").del(`/v1/remote-agents/connectors/${list[0].connector_id}`)).status, 200);
      await connector("u1", "again");
    });

    test("anonymous and 'default' callers are refused", async () => {
      assert.equal((await call(null, "GET", "/v1/remote-agents/connectors")).status, 403);
      assert.equal((await as("default").get("/v1/remote-agents/connectors")).status, 403);
    });

    test("online needs both a heartbeat and an open stream, and ends the moment the stream does", async () => {
      const cid = await connector();
      const state = async () => (await as("u1").get("/v1/remote-agents/connectors")).body.data[0];
      assert.equal((await state()).online, false, "registered only");
      await heartbeat("u1", cid);
      assert.equal((await state()).online, false, "heartbeat without a stream");
      const stream = await openCommands("u1", cid);
      await stream.nextEvent("ready");
      assert.equal((await state()).online, true, "heartbeat and stream");
      await stream.closed();
      for (let i = 0; i < 50 && (await state()).online; i++) await new Promise((r) => setTimeout(r, 20));
      assert.equal((await state()).online, false, "stream gone");
    });

    test("a heartbeat older than the window is offline, however open the stream", async () => {
      const { cid } = await online1();
      await q("UPDATE claw_remote_connectors SET heartbeat_at = NOW() - interval '200 seconds' WHERE connector_id = $1", [cid]);
      assert.equal((await as("u1").get("/v1/remote-agents/connectors")).body.data[0].online, false);
      await heartbeat("u1", cid);
      assert.equal((await as("u1").get("/v1/remote-agents/connectors")).body.data[0].online, true);
    });

    test("a heartbeat replaces the advertised agents and validates what it is told", async () => {
      const cid = await connector();
      await heartbeat("u1", cid, {}, [AGENT, { agent_id: "a2", kind: "other", name: "Two" }]);
      const names = async () => (await as("u1").get("/v1/remote-agents/connectors")).body.data[0].agents.map((a: any) => a.agent_id);
      assert.deepEqual(await names(), ["a1", "a2"]);
      await heartbeat("u1", cid, {}, [{ agent_id: "a2", kind: "other", name: "Two" }]);
      assert.deepEqual(await names(), ["a2"]);
      const bad: Array<[string, unknown]> = [
        ["agents missing", {}],
        ["agent id with a slash", { agents: [{ agent_id: "a/b", kind: "k", name: "n" }] }],
        ["duplicate ids", { agents: [AGENT, AGENT] }],
        ["kind with spaces", { agents: [{ agent_id: "a", kind: "has space", name: "n" }] }],
        ["too many agents", { agents: Array.from({ length: 21 }, (_, i) => ({ agent_id: `a${i}`, kind: "k", name: "n" })) }],
        ["capabilities too large", { agents: [{ ...AGENT, capabilities: { x: "y".repeat(5000) } }] }],
        ["cursor negative", { agents: [], cmd_cursor: -1 }],
      ];
      for (const [label, body] of bad) {
        assert.equal((await as("u1").post(`/v1/remote-agents/connectors/${cid}/heartbeat`, body)).status, 400, label);
      }
      assert.deepEqual(await names(), ["a2"], "a refused heartbeat changed nothing");
    });

    test("a session needs a known agent on an online connector", async () => {
      const cid = await connector();
      await heartbeat("u1", cid);
      const body = { connector_id: cid, agent_id: "a1", cwd: "/work" };
      const offline = await as("u1").post("/v1/remote-agents/sessions", body);
      assert.deepEqual([offline.status, offline.body.error], [409, "connector_offline"]);
      const stream = await openCommands("u1", cid);
      await stream.nextEvent("ready");
      const unknown = await as("u1").post("/v1/remote-agents/sessions", { ...body, agent_id: "nope" });
      assert.deepEqual([unknown.status, unknown.body.error], [404, "agent_not_found"]);
      for (const bad of [{ ...body, cwd: "" }, { ...body, cwd: "a\u0000b" }, { ...body, mode: "bad mode" }, { agent_id: "a1", cwd: "/x" }]) {
        assert.equal((await as("u1").post("/v1/remote-agents/sessions", bad)).status, 400, JSON.stringify(bad));
      }
      assert.equal((await as("u1").post("/v1/remote-agents/sessions", { ...body, mode: "ask" })).status, 201);
    });
  });

  // ------------------------------------------------------------- isolation

  describe("owner isolation", () => {
    test("every route answers another user, and an administrator, exactly as it answers a missing id", async () => {
      const { cid } = await online1();
      const sid = await session("u1", cid);
      const sessionsBefore = (await q("SELECT COUNT(*) AS n FROM claw_remote_sessions")).rows[0].n;
      const commandsBefore = (await q("SELECT COUNT(*) AS n FROM claw_remote_commands")).rows[0].n;
      const auditBefore = (await q("SELECT COUNT(*) AS n FROM claw_remote_audit")).rows[0].n;

      const cases: Array<[string, (c: string, s: string) => string, unknown?]> = [
        ["DELETE", (c) => `/v1/remote-agents/connectors/${c}`],
        ["POST", (c) => `/v1/remote-agents/connectors/${c}/heartbeat`, { agents: [] }],
        ["POST", (c) => `/v1/remote-agents/connectors/${c}/events`, { batch_id: "b", events: [] }],
        ["GET", (c) => `/v1/remote-agents/connectors/${c}/commands`],
        ["GET", (_c, s) => `/v1/remote-agents/sessions/${s}`],
        ["POST", (_c, s) => `/v1/remote-agents/sessions/${s}/commands`, { type: "prompt", text: "hi" }],
        ["POST", (_c, s) => `/v1/remote-agents/sessions/${s}/commands`, { type: "close" }],
        ["POST", (_c, s) => `/v1/remote-agents/sessions/${s}/decisions`, { action_id: "x", option_id: "y" }],
        ["GET", (_c, s) => `/v1/remote-agents/sessions/${s}/events`],
        ["GET", (_c, s) => `/v1/remote-agents/sessions/${s}/events?mode=replay`],
        ["POST", (c) => `/v1/remote-agents/sessions`, { connector_id: "", agent_id: "a1", cwd: "/x" }],
      ];
      for (const intruder of [{ id: "u2", admin: false }, { id: "root", admin: true }]) {
        for (const [method, path, body] of cases) {
          const withIds = (c: string, s: string) => {
            const p = path(c, s);
            return body && (body as any).connector_id === "" ? { p, b: { ...(body as object), connector_id: c } } : { p, b: body };
          };
          const hd = intruder.admin ? { "x-test-admin": "1" } : {};
          const real = withIds(cid, sid);
          const none = withIds(NOBODY, NOBODY);
          const got = await call(intruder.id, method, real.p, real.b, hd);
          const missing = await call(intruder.id, method, none.p, none.b, hd);
          assert.deepEqual([got.status, got.body], [404, { ok: false, error: "not_found" }], `${intruder.id} ${method} ${real.p}`);
          assert.deepEqual(got, missing, `${intruder.id} ${method} ${real.p} differs from a missing id`);
        }
      }
      // Nothing was created, queued or written on the owner's behalf.
      assert.equal((await q("SELECT COUNT(*) AS n FROM claw_remote_sessions")).rows[0].n, sessionsBefore);
      assert.equal((await q("SELECT COUNT(*) AS n FROM claw_remote_commands")).rows[0].n, commandsBefore);
      assert.equal((await q("SELECT COUNT(*) AS n FROM claw_remote_audit")).rows[0].n, auditBefore);
      assert.equal((await as("u1").get("/v1/remote-agents/connectors")).body.data.length, 1, "owner's connector still there");
    });

    test("lists and the audit trail show only the caller's own rows", async () => {
      const a = await online1();
      const b = await online("u2");
      const sa = await session("u1", a.cid);
      const sb = await session("u2", b.cid);
      assert.deepEqual((await as("u2").get("/v1/remote-agents/connectors")).body.data.map((c: any) => c.connector_id), [b.cid]);
      assert.deepEqual((await as("u1").get("/v1/remote-agents/sessions")).body.data.map((s: any) => s.session_id), [sa]);
      assert.deepEqual((await as("root").get("/v1/remote-agents/sessions")).body.data, []);
      const audit = (await as("u2").get("/v1/remote-agents/audit")).body.data;
      assert.ok(audit.length > 0);
      assert.ok(audit.every((r: any) => r.session_id === null || r.session_id === sb), "no row of u1's");
      assert.deepEqual((await as("u2").get(`/v1/remote-agents/audit?session_id=${sa}`)).body.data, []);
      assert.equal((await as("u2").get("/v1/remote-agents/audit?session_id=nope")).status, 400);
      // A filter naming another user's connector or session yields nothing, not an error that says it exists.
      assert.deepEqual((await as("u2").get(`/v1/remote-agents/sessions?connector_id=${a.cid}`)).body.data, []);
    });

    test("a connector cannot post events into a session that is not its own", async () => {
      const a = await online1();
      const mine = await session("u1", a.cid);
      const other = await online("u2");
      const theirs = await session("u2", other.cid);
      // The same owner's second connector, too.
      const sibling = await online("u1");
      const siblingSession = await session("u1", sibling.cid);
      for (const target of [theirs, siblingSession, NOBODY]) {
        const r = await post("u1", a.cid, [ev(target, "agent_message_chunk", { text: "x" }, 1), ev(mine, "agent_message_chunk", { text: "ok" }, 1)]);
        assert.equal(r.status, 200);
        assert.deepEqual(r.body.data.rejected.map((x: any) => [x.index, x.reason]), [[0, "unknown_session"]], "refused without saying whether it exists");
        assert.deepEqual(Object.keys(r.body.data.acked), [mine]);
        assert.equal((await q("SELECT COUNT(*) AS n FROM claw_remote_events WHERE session_id = $1", [target])).rows[0].n, "0");
        await q("DELETE FROM claw_remote_events");
      }
    });
  });

  // -------------------------------------------------------- command relay

  describe("command relay", () => {
    test("a command reaches the connector as a framed event with a monotonic id", async () => {
      const { cid, stream } = await online1();
      const sid = await session("u1", cid, "/work/repo");
      const created = await stream.nextEvent("command");
      assert.equal(created.id, "1");
      assert.deepEqual(created.json(), {
        agent_id: "a1", cwd: "/work/repo", mode: null,
        v: 1, cmd_id: created.json().cmd_id, type: "session.new", session_id: sid,
      });
      const sent = await as("u1").post(`/v1/remote-agents/sessions/${sid}/commands`, { type: "prompt", text: "do it" });
      assert.equal(sent.status, 202);
      const prompt = await stream.nextEvent("command");
      assert.equal(prompt.id, "2");
      assert.deepEqual(prompt.json(), { text: "do it", v: 1, cmd_id: sent.body.data.cmd_id, type: "prompt", session_id: sid });
    });

    test("a reconnect is sent every command not yet acknowledged, whatever cursor it presents", async () => {
      const { cid, stream } = await online1();
      const sid = await session("u1", cid);
      for (const text of ["one", "two", "three"]) await as("u1").post(`/v1/remote-agents/sessions/${sid}/commands`, { type: "prompt", text });
      for (let i = 0; i < 4; i++) await stream.nextEvent("command");
      await stream.closed();

      // A client that says it has seen frame 4 may have lost the connection before acting on it,
      // so a cursor never skips anything: only an acknowledgement (a heartbeat's cmd_cursor) does.
      for (const cursor of [undefined, "0", "2", "4", "99"]) {
        const again = await openCommands("u1", cid, cursor);
        const ids: string[] = [];
        for (let i = 0; i < 4; i++) ids.push((await again.nextEvent("command")).id!);
        assert.deepEqual(ids, ["1", "2", "3", "4"], `cursor ${cursor}`);
        assert.equal(await again.quiet(100), true);
        await again.closed();
      }
      assert.equal((await q("SELECT COUNT(*) AS n FROM claw_remote_commands WHERE connector_id = $1", [cid])).rows[0].n, "4", "presenting a cursor forgot nothing");
      // The cursor may be given as ?after= too, and a malformed one is refused.
      const viaQuery = await SseClient.open(`${base}/v1/remote-agents/connectors/${cid}/commands?after=3`, { "x-test-user": "u1" });
      streams.push(viaQuery);
      assert.equal((await viaQuery.nextEvent("command")).id, "1");
      assert.equal((await SseClient.open(`${base}/v1/remote-agents/connectors/${cid}/commands?after=-1`, { "x-test-user": "u1" })).status, 400);
      assert.equal((await SseClient.open(`${base}/v1/remote-agents/connectors/${cid}/commands`, { "x-test-user": "u1", "last-event-id": "x" })).status, 400);
    });

    test("a heartbeat cursor lets the server forget what the connector has handled", async () => {
      const { cid } = await online1();
      const sid = await session("u1", cid);
      for (const text of ["a", "b"]) await as("u1").post(`/v1/remote-agents/sessions/${sid}/commands`, { type: "prompt", text });
      const left = async () => (await q("SELECT cmd_seq FROM claw_remote_commands WHERE connector_id = $1 ORDER BY cmd_seq", [cid])).rows.map((r: any) => Number(r.cmd_seq));
      assert.deepEqual(await left(), [1, 2, 3]);
      await heartbeat("u1", cid, { cmd_cursor: 2 });
      assert.deepEqual(await left(), [3]);
      // Once acknowledged they are not delivered again, even to a connector that asks from the start.
      const again = await openCommands("u1", cid, "0");
      assert.equal((await again.nextEvent("command")).id, "3");
    });

    test("a command nobody acknowledged is forgotten after a day, when the next one is queued", async () => {
      const { cid } = await online1();
      const sid = await session("u1", cid);
      await as("u1").post(`/v1/remote-agents/sessions/${sid}/commands`, { type: "prompt", text: "private words" });
      await q("UPDATE claw_remote_commands SET created_at = NOW() - interval '25 hours' WHERE connector_id = $1", [cid]);
      await as("u1").post(`/v1/remote-agents/sessions/${sid}/commands`, { type: "cancel" });
      assert.deepEqual((await q("SELECT type FROM claw_remote_commands WHERE connector_id = $1", [cid])).rows.map((r: any) => r.type), ["cancel"]);
    });

    test("a prompt, set_mode or resume nobody collected within minutes is dropped, not replayed when the connector returns", async () => {
      const { cid, stream } = await online1();
      const sid = await session("u1", cid);
      const send = (c: unknown) => as("u1").post(`/v1/remote-agents/sessions/${sid}/commands`, c);
      // Accepted while the connector still looked online, and sent into a connection that had died:
      // the first stream never acts on any of it, and nothing acknowledges it.
      for (const c of [{ type: "prompt", text: "stale" }, { type: "set_mode", mode_id: "ask" }, { type: "resume" }, { type: "prompt", text: "fresh" }, { type: "cancel" }]) {
        assert.equal((await send(c)).status, 202, JSON.stringify(c));
      }
      await stream.closed();
      await q("UPDATE claw_remote_commands SET created_at = NOW() - interval '10 minutes' WHERE connector_id = $1", [cid]);
      await q("UPDATE claw_remote_commands SET created_at = NOW() - interval '4 minutes' WHERE connector_id = $1 AND payload->>'text' = 'fresh'", [cid]);

      // The machine wakes and reconnects. Only what could still be wanted comes: the session it
      // never started, the prompt from four minutes ago, and the cancel (which keeps a whole day).
      const back = await openCommands("u1", cid);
      const got: string[] = [];
      for (let i = 0; i < 3; i++) {
        const f = (await back.nextEvent("command")).json();
        got.push(`${f.type}${f.text ? `:${f.text}` : ""}`);
      }
      assert.deepEqual(got, ["session.new", "prompt:fresh", "cancel"]);
      assert.equal(await back.quiet(150), true, "the stale prompt, set_mode and resume are not sent");

      // And they do not sit in the table as a second archive of what was typed: the next beat clears
      // them even though it acknowledges nothing.
      const types = async () => (await q("SELECT type FROM claw_remote_commands WHERE connector_id = $1 ORDER BY cmd_seq", [cid])).rows.map((r: any) => r.type);
      assert.equal((await types()).length, 6);
      assert.equal((await heartbeat("u1", cid)).status, 200);
      assert.deepEqual(await types(), ["session.new", "prompt", "cancel"]);
    });

    test("concurrent commands get consecutive numbers and arrive in that order", async () => {
      const { cid, stream } = await online1();
      const sid = await session("u1", cid);
      await stream.nextEvent("command");
      const sends = await Promise.all(Array.from({ length: 25 }, (_, i) =>
        as("u1").post(`/v1/remote-agents/sessions/${sid}/commands`, { type: "prompt", text: `m${i}` })));
      assert.ok(sends.every((r) => r.status === 202));
      assert.deepEqual(sends.map((r) => r.body.data.cmd_seq).sort((x, y) => x - y), Array.from({ length: 25 }, (_, i) => i + 2));
      const got: number[] = [];
      for (let i = 0; i < 25; i++) got.push(Number((await stream.nextEvent("command")).id));
      assert.deepEqual(got, Array.from({ length: 25 }, (_, i) => i + 2), "strictly increasing, none skipped");
    });

    test("only commands that can wait are queued while the connector is offline", async () => {
      const { cid, stream } = await online1();
      const sid = await session("u1", cid);
      await stream.closed();
      for (let i = 0; i < 50; i++) {
        if (!(await as("u1").get("/v1/remote-agents/connectors")).body.data[0].online) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      const send = (c: unknown) => as("u1").post(`/v1/remote-agents/sessions/${sid}/commands`, c);
      for (const c of [{ type: "prompt", text: "hi" }, { type: "set_mode", mode_id: "ask" }, { type: "resume" }]) {
        const r = await send(c);
        assert.deepEqual([r.status, r.body.error], [409, "connector_offline"], JSON.stringify(c));
      }
      assert.equal((await send({ type: "cancel" })).status, 202);
      const reconnected = await openCommands("u1", cid);
      const types: string[] = [];
      for (let i = 0; i < 2; i++) types.push((await reconnected.nextEvent("command")).json().type);
      assert.deepEqual(types, ["session.new", "cancel"], "the cancel is delivered when it comes back, after what it never acknowledged");
    });

    test("only the closed set of command types is accepted, and each is validated", async () => {
      const { cid } = await online1();
      const sid = await session("u1", cid);
      const bad: Array<[string, unknown, string]> = [
        ["unknown type", { type: "exec", cmd: "rm -rf /" }, "unknown_command_type"],
        ["no type", { text: "x" }, "unknown_command_type"],
        ["session.new here", { type: "session.new" }, "unknown_command_type"],
        ["empty prompt", { type: "prompt", text: "  " }, "text_required"],
        ["huge prompt", { type: "prompt", text: "x".repeat(70_000) }, "prompt_too_large"],
        ["mode with a space", { type: "set_mode", mode_id: "a b" }, "invalid_mode_id"],
        ["decision without ids", { type: "decision" }, "invalid_action_id"],
      ];
      for (const [label, body, error] of bad) {
        const r = await as("u1").post(`/v1/remote-agents/sessions/${sid}/commands`, body);
        assert.deepEqual([r.status, r.body.error], [400, error], label);
      }
      assert.equal((await q("SELECT COUNT(*) AS n FROM claw_remote_commands WHERE type NOT IN ('session.new')")).rows[0].n, "0");
    });

    test("a repeated Idempotency-Key queues one command", async () => {
      const { cid } = await online1();
      const sid = await session("u1", cid);
      const send = (type: string, key: string, extra: object = {}) =>
        as("u1").post(`/v1/remote-agents/sessions/${sid}/commands`, { type, ...extra }, { "idempotency-key": key });
      const first = await send("prompt", "k1", { text: "once" });
      const again = await send("prompt", "k1", { text: "once" });
      assert.deepEqual([first.status, again.status, again.body.data.duplicate], [202, 200, true]);
      assert.equal((await q("SELECT COUNT(*) AS n FROM claw_remote_commands WHERE type = 'prompt'")).rows[0].n, "1");
      const reused = await send("cancel", "k1");
      assert.deepEqual([reused.status, reused.body.error], [409, "idempotency_key_reused"]);
    });

    test("an Idempotency-Key still protects a retry after the connector has acknowledged the command", async () => {
      const { cid } = await online1();
      const sid = await session("u1", cid);
      const elsewhere = await session("u1", cid, "/work/other");
      const send = (on: string, type: string, key: string, extra: object = {}) =>
        as("u1").post(`/v1/remote-agents/sessions/${on}/commands`, { type, ...extra }, { "idempotency-key": key });
      const queued = async (type: string) => (await q("SELECT COUNT(*) AS n FROM claw_remote_commands WHERE type = $1", [type])).rows[0].n;
      const first = await send(sid, "prompt", "lost-reply", { text: "once" });
      assert.equal(first.status, 202);
      // The response never reached the client. The connector ran the prompt, and its next heartbeat
      // acknowledged it, which deletes the queued row.
      assert.equal((await heartbeat("u1", cid, { cmd_cursor: first.body.data.cmd_seq })).status, 200);
      assert.equal(await queued("prompt"), "0", "the queue no longer remembers the command");

      const retry = await send(sid, "prompt", "lost-reply", { text: "once" });
      assert.deepEqual([retry.status, retry.body.data], [200, { cmd_id: "k:lost-reply", duplicate: true }]);
      assert.equal(await queued("prompt"), "0", "the retry queued nothing, so the agent does not run the prompt twice");
      const audited = (await as("u1").get(`/v1/remote-agents/audit?session_id=${sid}`)).body.data
        .filter((r: any) => r.action === "command.issued" && r.detail.type === "prompt");
      assert.equal(audited.length, 1, "issued once, audited once");

      // The key still names one command: another type, or another session, is a different request.
      const type = await send(sid, "cancel", "lost-reply");
      assert.deepEqual([type.status, type.body.error], [409, "idempotency_key_reused"]);
      const session2 = await send(elsewhere, "prompt", "lost-reply", { text: "once" });
      assert.deepEqual([session2.status, session2.body.error], [409, "idempotency_key_reused"]);
      assert.equal(await queued("prompt"), "0");
      // A different key is a different command.
      const mine = await send(sid, "prompt", "fresh-key", { text: "next" });
      assert.equal(mine.status, 202);
    });

    test("closing a session closes it for further commands", async () => {
      const { cid } = await online1();
      const sid = await session("u1", cid);
      assert.equal((await as("u1").post(`/v1/remote-agents/sessions/${sid}/commands`, { type: "close" })).status, 202);
      assert.equal((await as("u1").get(`/v1/remote-agents/sessions/${sid}`)).body.data.status, "closed");
      const r = await as("u1").post(`/v1/remote-agents/sessions/${sid}/commands`, { type: "prompt", text: "late" });
      assert.deepEqual([r.status, r.body.error], [409, "session_closed"]);
    });
  });

  // ---------------------------------------------------------- event relay

  describe("event relay", () => {
    test("events are stored once, acknowledged by highest seq, and a repeated batch changes nothing", async () => {
      const { cid } = await online1();
      const sid = await session("u1", cid);
      const batch = [ev(sid, "agent_message_chunk", { text: "a" }), ev(sid, "agent_message_chunk", { text: "b" }), ev(sid, "turn_end", { stopReason: "end_turn" })];
      const first = await post("u1", cid, batch);
      assert.deepEqual([first.status, first.body.data.acked, first.body.data.rejected], [200, { [sid]: 3 }, []]);
      const again = await post("u1", cid, batch, "b2");
      assert.deepEqual(again.body.data.acked, { [sid]: 3 });
      assert.equal((await q("SELECT COUNT(*) AS n FROM claw_remote_events WHERE session_id = $1", [sid])).rows[0].n, "3");
      // An event is immutable: a repeat of a stored (session, seq) with other content changes nothing,
      // and a repeated permission request is not audited a second time.
      const changed = ev(sid, "agent_message_chunk", { text: "CHANGED" }, 1);
      const asked = ev(sid, "permissionRequest", { actionId: "act-r", options: [{ optionId: "o" }] }, 4);
      await post("u1", cid, [changed, asked], "b2b");
      await post("u1", cid, [changed, asked], "b2c");
      assert.deepEqual((await q("SELECT data FROM claw_remote_events WHERE session_id = $1 AND seq = 1", [sid])).rows[0].data, { text: "a" });
      assert.equal((await q("SELECT COUNT(*) AS n FROM claw_remote_audit WHERE action = 'permission.requested' AND session_id = $1", [sid])).rows[0].n, "1");
      // A gap is allowed (a connector may drop chunk events); the ack is the highest stored.
      const gap = await post("u1", cid, [ev(sid, "agent_message_chunk", { text: "z" }, 9)], "b3");
      assert.deepEqual(gap.body.data.acked, { [sid]: 9 });
    });

    test("each event is judged alone: bad ones are named and refused, good ones in the same batch are kept", async () => {
      const { cid } = await online1();
      const sid = await session("u1", cid);
      const good = ev(sid, "tool_call", { title: "t" }, 1);
      const events: unknown[] = [
        good,
        { ...ev(sid, "tool_call", {}, 2), seq: 0 },
        { ...ev(sid, "tool_call", {}, 3), seq: 1.5 },
        { ...ev(sid, "bad type!", {}, 4) },
        { ...ev(sid, "tool_call", {}, 5), ts: "now" },
        { ...ev(sid, "tool_call", {}, 6), data: [1] },
        { ...ev(sid, "tool_call", { blob: "x".repeat(70_000) }, 7) },
        { ...ev("not-a-uuid", "tool_call", {}, 8) },
        "garbage",
      ];
      const r = await post("u1", cid, events);
      assert.equal(r.status, 200);
      assert.deepEqual(r.body.data.rejected.map((x: any) => [x.index, x.reason]), [
        [1, "invalid_seq"], [2, "invalid_seq"], [3, "invalid_type"], [4, "invalid_ts"], [5, "invalid_data"],
        [6, "event_too_large"], [7, "invalid_session_id"], [8, "invalid_event"],
      ]);
      assert.deepEqual(r.body.data.acked, { [sid]: 1 });
      const envelope: Array<[string, unknown]> = [
        ["no batch id", { events: [] }], ["events not an array", { batch_id: "b", events: {} }],
        ["too many events", { batch_id: "b", events: Array.from({ length: 201 }, (_, i) => ev(sid, "t", {}, i + 10)) }],
      ];
      for (const [label, body] of envelope) {
        assert.equal((await as("u1").post(`/v1/remote-agents/connectors/${cid}/events`, body)).status, 400, label);
      }
    });

    test("credentials in an event are masked before storage, but option ids are not", async () => {
      const { cid } = await online1();
      const sid = await session("u1", cid);
      await post("u1", cid, [ev(sid, "permissionRequest", {
        actionId: "act-1", tool: "Run", kind: "execute", api_key: "sk-supersecretvalue123456", note: "Authorization: Bearer abcdef0123456789",
        options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }],
      })]);
      const stored = (await q("SELECT data FROM claw_remote_events WHERE session_id = $1", [sid])).rows[0].data;
      assert.equal(stored.api_key, "[REDACTED]");
      assert.ok(!JSON.stringify(stored).includes("abcdef0123456789"));
      assert.equal(stored.options[0].optionId, "allow-once");
      assert.equal(stored.actionId, "act-1");
    });

    test("a reader gets history, a marker, then live events, in the ordinary session frame format", async () => {
      const { cid } = await online1();
      const sid = await session("u1", cid);
      await post("u1", cid, [ev(sid, "agent_message_chunk", { text: "one" }), ev(sid, "tool_call", { title: "t" })]);
      const s = await SseClient.open(`${base}/v1/remote-agents/sessions/${sid}/events`, { "x-test-user": "u1" });
      streams.push(s);
      assert.equal(s.status, 200);
      const f1 = await s.next();
      assert.equal(f1.event, "agent_message_chunk");
      assert.match(f1.id!, /^\d+$/);
      assert.deepEqual(f1.json(), { type: "agent_message_chunk", session_id: sid, seq: 1, ts: f1.json().ts, data: { text: "one" } });
      assert.equal((await s.next()).event, "tool_call");
      const marker = await s.next();
      assert.deepEqual([marker.event, marker.id, marker.json()], ["historyComplete", undefined, { type: "historyComplete", count: 2 }]);
      await post("u1", cid, [ev(sid, "turn_end", { stopReason: "end_turn" })], "b2");
      const live = await s.next();
      assert.equal(live.event, "turn_end");
      assert.equal((await s.next((f) => !!f.comment, 1500)).comment, true, "a keepalive follows while idle");
    });

    test("a session with no events still gets its marker", async () => {
      const { cid } = await online1();
      const sid = await session("u1", cid);
      const s = await SseClient.open(`${base}/v1/remote-agents/sessions/${sid}/events`, { "x-test-user": "u1" });
      streams.push(s);
      assert.equal((await s.next()).json().count, 0);
    });

    test("a reader that drops and resumes from its last id sees every event exactly once", async () => {
      const { cid } = await online1();
      const sid = await session("u1", cid);
      const seen: number[] = [];
      let lastId = "0";
      let n = 0;
      const batch = (k: number) => Array.from({ length: k }, () => { n++; return ev(sid, "agent_message_chunk", { n }, n); });
      for (let round = 0; round < 4; round++) {
        await post("u1", cid, batch(5), `r${round}`);
        const s = await SseClient.open(`${base}/v1/remote-agents/sessions/${sid}/events?after=${lastId}`, { "x-test-user": "u1" });
        streams.push(s);
        // New events land while this reader is connected, too.
        const during = post("u1", cid, batch(3), `r${round}b`);
        const target = (round + 1) * 8;
        while (seen.length < target) {
          const f = await s.next((x) => x.event === "agent_message_chunk");
          seen.push(f.json().seq);
          lastId = f.id!;
        }
        await during;
        await s.closed();
      }
      assert.deepEqual(seen, Array.from({ length: 32 }, (_, i) => i + 1), "every event once, in order, across four reconnects");
      // Replay mode pages by the same cursor.
      const page = await as("u1").get(`/v1/remote-agents/sessions/${sid}/events?mode=replay&limit=10`);
      assert.equal(page.body.data.length, 10);
      const rest = await as("u1").get(`/v1/remote-agents/sessions/${sid}/events?mode=replay&after=${page.body.data[9].id}&limit=100`);
      assert.equal(page.body.data.length + rest.body.data.length, 32);
      assert.equal((await as("u1").get(`/v1/remote-agents/sessions/${sid}/events?after=x`)).status, 400);
    });

    test("a reconnect resumes from Last-Event-ID, not from the ?after= the stream was first opened with", async () => {
      const { cid } = await online1();
      const sid = await session("u1", cid);
      await post("u1", cid, [1, 2, 3, 4].map((n) => ev(sid, "agent_message_chunk", { n })));
      const path = `/v1/remote-agents/sessions/${sid}/events`;
      const ids: string[] = (await as("u1").get(`${path}?mode=replay`)).body.data.map((r: any) => r.id);
      assert.equal(ids.length, 4);
      // An EventSource opened with ?after=<first> and has delivered up to the third event reconnects
      // to the same URL and changes only the header. Starting over from the first would send 2 and 3 again.
      const s = await SseClient.open(`${base}${path}?after=${ids[0]}`, { "x-test-user": "u1", "last-event-id": ids[2]! });
      streams.push(s);
      assert.equal((await s.next()).id, ids[3]);
      assert.equal((await s.nextEvent("historyComplete")).json().count, 1, "only the event after the header's id was replayed");
      const replay = await call("u1", "GET", `${path}?mode=replay&after=${ids[0]}`, undefined, { "last-event-id": ids[2]! });
      assert.deepEqual(replay.body.data.map((r: any) => r.id), [ids[3]], "replay pages by the same position");
      // Without a header the query is still what it says.
      assert.equal((await as("u1").get(`${path}?mode=replay&after=${ids[1]}`)).body.data.length, 2);
    });

    test("overlapping posts of the same batch cannot reorder or duplicate a session's events", async () => {
      const { cid } = await online1();
      const sid = await session("u1", cid);
      const batch = Array.from({ length: 30 }, (_, i) => ev(sid, "agent_message_chunk", { i }, i + 1));
      const rs = await Promise.all([1, 2, 3, 4].map((n) => post("u1", cid, batch, `p${n}`)));
      assert.ok(rs.every((r) => r.status === 200 && r.body.data.acked[sid] === 30));
      const rows = (await q("SELECT id, seq FROM claw_remote_events WHERE session_id = $1 ORDER BY id", [sid])).rows;
      assert.deepEqual(rows.map((r: any) => Number(r.seq)), Array.from({ length: 30 }, (_, i) => i + 1), "row order is seq order");
    });

    test("one connector's batches queue behind its own ingest lock, and another connector's do not", async () => {
      // The lock is what makes commit order equal id order, which is what lets a
      // reader that has seen event N rely on never finding N-1 appear later.
      const a = await online1();
      const sa = await session("u1", a.cid);
      const b = await online("u2");
      const sb = await session("u2", b.cid);
      const holder = await h.connect();
      await holder.query("BEGIN");
      await holder.query("SELECT pg_advisory_xact_lock(7001, hashtext($1))", [`ingest:${a.cid}`]);
      let done = false;
      const blocked = post("u1", a.cid, [ev(sa, "tool_call", {}, 1)]).then((r) => { done = true; return r; });
      assert.equal((await post("u2", b.cid, [ev(sb, "tool_call", {}, 1)])).status, 200, "another connector is not held up");
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(done, false, "this connector's batch waits for the lock");
      await holder.query("COMMIT");
      assert.equal((await blocked).status, 200);
    });
  });

  // ------------------------------------------------------------ decisions

  describe("decisions", () => {
    const request = (sid: string, actionId = "act-1") => ev(sid, "permissionRequest", {
      actionId, tool: "Edit README.md", kind: "edit", input: { path: "README.md" }, timeout_ms: 600_000,
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    });
    const decide = (sid: string, body: unknown, user = "u1") => as(user).post(`/v1/remote-agents/sessions/${sid}/decisions`, body);

    test("an offered option is relayed to the connector with who chose it, and only an offered option", async () => {
      const { cid, stream } = await online1();
      const sid = await session("u1", cid);
      await stream.nextEvent("command");
      await post("u1", cid, [request(sid)]);
      const table: Array<[string, unknown, number, string?]> = [
        ["option never offered", { action_id: "act-1", option_id: "allow-forever" }, 400, "unknown_option"],
        ["unknown action", { action_id: "act-9", option_id: "reject" }, 404, "action_not_found"],
        ["missing option", { action_id: "act-1" }, 400, "invalid_option_id"],
      ];
      for (const [label, body, status, error] of table) {
        const r = await decide(sid, body);
        assert.deepEqual([r.status, r.body.error], [status, error], label);
      }
      assert.equal(await stream.quiet(150), true, "nothing relayed for a refused decision");
      const ok = await decide(sid, { actionId: "act-1", optionId: "allow-once" });
      assert.equal(ok.status, 202);
      const frame = (await stream.nextEvent("command")).json();
      assert.deepEqual(frame, {
        action_id: "act-1", option_id: "allow-once", by: "u1", client: null,
        v: 1, cmd_id: "dec:" + sid + ":act-1", type: "decision", session_id: sid,
      });
    });

    test("a second click counts once, a different second choice is refused, and an answered request is closed", async () => {
      const { cid } = await online1();
      const sid = await session("u1", cid);
      await post("u1", cid, [request(sid)]);
      const body = { action_id: "act-1", option_id: "allow-once" };
      const [one, two] = await Promise.all([decide(sid, body), decide(sid, body)]);
      assert.deepEqual([one.status, two.status].sort(), [200, 202]);
      assert.equal((await q("SELECT COUNT(*) AS n FROM claw_remote_commands WHERE type = 'decision'")).rows[0].n, "1");
      const other = await decide(sid, { action_id: "act-1", option_id: "reject" });
      assert.deepEqual([other.status, other.body.error], [409, "already_decided"]);
      await post("u1", cid, [ev(sid, "permission_resolved", { actionId: "act-1", optionId: "allow-once", by: "u1" })], "b2");
      const late = await decide(sid, body);
      assert.deepEqual([late.status, late.body.error], [409, "already_resolved"]);
    });

    test("a different second choice is refused after a heartbeat forgot the first and before the connector reported it resolved", async () => {
      const { cid } = await online1();
      const sid = await session("u1", cid);
      await post("u1", cid, [request(sid)]);
      const first = await decide(sid, { action_id: "act-1", option_id: "allow-once" });
      assert.equal(first.status, 202);
      // The connector handled it and said so in a heartbeat, which deletes the queued row; the
      // permission_resolved event that would close the request has not been posted yet.
      assert.equal((await heartbeat("u1", cid, { cmd_cursor: first.body.data.cmd_seq })).status, 200);
      const queued = async () => (await q("SELECT COUNT(*) AS n FROM claw_remote_commands WHERE type = 'decision'")).rows[0].n;
      assert.equal(await queued(), "0", "the queue no longer remembers the decision");
      const other = await decide(sid, { action_id: "act-1", option_id: "reject" });
      assert.deepEqual([other.status, other.body.error], [409, "already_decided"]);
      const again = await decide(sid, { action_id: "act-1", option_id: "allow-once" });
      assert.deepEqual([again.status, again.body.data], [200, { cmd_id: `dec:${sid}:act-1`, duplicate: true }]);
      assert.equal(await queued(), "0", "neither was queued");
      const audited = (await as("u1").get(`/v1/remote-agents/audit?session_id=${sid}`)).body.data
        .filter((r: any) => r.action === "command.issued" && r.detail.type === "decision");
      assert.deepEqual(audited.map((r: any) => r.detail.option_id), ["allow-once"], "answered twice, audited once");
      // Another action in the same session is its own question.
      await post("u1", cid, [request(sid, "act-2")], "b2");
      assert.equal((await decide(sid, { action_id: "act-2", option_id: "reject" })).status, 202);
    });

    test("a decision may be given while the connector is offline, since the request outlives the connection", async () => {
      const { cid, stream } = await online1();
      const sid = await session("u1", cid);
      await post("u1", cid, [request(sid)]);
      await stream.closed();
      await q("UPDATE claw_remote_connectors SET stream_seen_at = NULL WHERE connector_id = $1", [cid]);
      const r = await decide(sid, { action_id: "act-1", option_id: "reject" });
      assert.deepEqual([r.status, r.body.data.connector_online], [202, false]);
    });

    test("the audit trail records the request, the decision and the resolution, with ids and never the prompt text", async () => {
      const { cid } = await online1();
      const sid = await session("u1", cid);
      await as("u1").post(`/v1/remote-agents/sessions/${sid}/commands`, { type: "prompt", text: "a secret plan about the thing" }, { "x-claw-client": "phone" });
      await post("u1", cid, [request(sid)]);
      await decide(sid, { action_id: "act-1", option_id: "allow-once" });
      await post("u1", cid, [ev(sid, "permission_resolved", { actionId: "act-1", optionId: "allow-once", by: "u1" })], "b2");
      const rows = (await as("u1").get(`/v1/remote-agents/audit?session_id=${sid}`)).body.data;
      const actions = rows.map((r: any) => r.action).sort();
      assert.deepEqual(actions, ["command.issued", "command.issued", "command.issued", "permission.requested", "permission.resolved", "session.created"], "session.new, prompt and decision");
      const issued = rows.filter((r: any) => r.action === "command.issued" && r.detail.type === "prompt")[0];
      assert.equal(issued.client, "phone");
      assert.deepEqual(Object.keys(issued.detail).sort(), ["cmd_id", "length", "sha256", "type"]);
      assert.equal(issued.detail.length, "a secret plan about the thing".length);
      assert.ok(!JSON.stringify(rows).includes("secret plan"), "the text is not in the trail");
      const resolved = rows.find((r: any) => r.action === "permission.resolved");
      assert.deepEqual(resolved.detail, { action_id: "act-1", option_id: "allow-once", by: "u1" });
      const decision = rows.find((r: any) => r.action === "command.issued" && r.detail.type === "decision");
      assert.equal(decision.actor, "u1");
      assert.equal(decision.detail.option_id, "allow-once");
    });
  });

  // ---------------------------------------------------------------- limits

  describe("limits", () => {
    test("commands are rate limited per user, retries of one command are free, and another user is unaffected", async () => {
      const small = await serve({ commandsPerMinute: 4 });
      const mk = async (user: string) => {
        const cid = (await as(user).post("/v1/remote-agents/connectors", { name: "m" }, undefined, small)).body.data.connector_id;
        const s = await SseClient.open(`${small}/v1/remote-agents/connectors/${cid}/commands`, { "x-test-user": user });
        streams.push(s);
        await as(user).post(`/v1/remote-agents/connectors/${cid}/heartbeat`, { agents: [AGENT] }, undefined, small);
        return cid;
      };
      const cid = await mk("u1");
      const other = await mk("u2");
      const make = async (user: string, c: string) =>
        (await as(user).post("/v1/remote-agents/sessions", { connector_id: c, agent_id: "a1", cwd: "/w" }, undefined, small));
      const first = await make("u1", cid);
      assert.equal(first.status, 201);
      const sid = first.body.data.session_id;
      const prompt = (user: string, s: string, key?: string) =>
        as(user).post(`/v1/remote-agents/sessions/${s}/commands`, { type: "prompt", text: "x" }, key ? { "idempotency-key": key } : undefined, small);
      // session.new counted one; three more fill the minute.
      for (let i = 0; i < 3; i++) assert.equal((await prompt("u1", sid, `k${i}`)).status, 202);
      assert.equal((await prompt("u1", sid, "k0")).status, 200, "a retry of a queued command is not a new one");
      const over = await prompt("u1", sid, "k9");
      assert.deepEqual([over.status, over.body.error], [429, "rate_limited"]);
      assert.equal((await make("u1", cid)).status, 429, "creating a session is a command too");
      assert.equal((await make("u2", other)).status, 201);
    });

    test("active sessions are limited per user, and closing one frees its place", async () => {
      const small = await serve({ maxActiveSessionsPerUser: 2 });
      const cid = (await as("u1").post("/v1/remote-agents/connectors", { name: "m" }, undefined, small)).body.data.connector_id;
      const s = await SseClient.open(`${small}/v1/remote-agents/connectors/${cid}/commands`, { "x-test-user": "u1" });
      streams.push(s);
      await as("u1").post(`/v1/remote-agents/connectors/${cid}/heartbeat`, { agents: [AGENT] }, undefined, small);
      const make = () => as("u1").post("/v1/remote-agents/sessions", { connector_id: cid, agent_id: "a1", cwd: "/w" }, undefined, small);
      const a = await make();
      await make();
      const third = await make();
      assert.deepEqual([third.status, third.body.error], [409, "session_limit_reached"]);
      await as("u1").post(`/v1/remote-agents/sessions/${a.body.data.session_id}/commands`, { type: "close" }, undefined, small);
      assert.equal((await make()).status, 201);
    });

    test("one user may hold only so many event streams open, and closing one frees its place", async () => {
      const small = await serve({ maxStreamsPerUser: 2 });
      const cid = (await as("u1").post("/v1/remote-agents/connectors", { name: "m" }, undefined, small)).body.data.connector_id;
      const c = await SseClient.open(`${small}/v1/remote-agents/connectors/${cid}/commands`, { "x-test-user": "u1" });
      streams.push(c);
      await as("u1").post(`/v1/remote-agents/connectors/${cid}/heartbeat`, { agents: [AGENT] }, undefined, small);
      const sid = (await as("u1").post("/v1/remote-agents/sessions", { connector_id: cid, agent_id: "a1", cwd: "/w" }, undefined, small)).body.data.session_id;
      const open = async (user = "u1") => {
        const s = await SseClient.open(`${small}/v1/remote-agents/sessions/${sid}/events`, { "x-test-user": user });
        streams.push(s);
        return s;
      };
      const a = await open();
      await open();
      const third = await open();
      assert.deepEqual([third.status, third.body], [429, { ok: false, error: "too_many_streams" }]);
      await a.closed();
      for (let i = 0; i < 50; i++) {
        const again = await open();
        if (again.status === 200) return;
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.fail("closing a stream never freed its place");
    });

    test("a session is closed by the connector reporting it, and then takes no commands", async () => {
      const { cid } = await online1();
      const sid = await session("u1", cid);
      await post("u1", cid, [ev(sid, "session_closed", { reason: "idle" })]);
      assert.equal((await as("u1").get(`/v1/remote-agents/sessions/${sid}`)).body.data.status, "closed");
    });
  });

  // ------------------------------------------------- streams and keepalive

  describe("streams", () => {
    test("both streams send keepalives while idle, and leave nothing waiting when they end", async () => {
      const { cid, stream } = await online1();
      const sid = await session("u1", cid);
      await stream.nextEvent("command");
      const ping = await stream.nextEvent("ping", 1500);
      assert.equal(ping.id, undefined, "a ping must not move the resume position");
      const user = await SseClient.open(`${base}/v1/remote-agents/sessions/${sid}/events`, { "x-test-user": "u1" });
      streams.push(user);
      await user.next((f) => !!f.comment, 1500);
      await stream.closed();
      await user.closed();
      for (let i = 0; i < 50 && waker.size > 0; i++) await new Promise((r) => setTimeout(r, 20));
      assert.equal(waker.size, 0);
    });

    test("a ping also proves the stream alive, so presence holds across a long quiet", async () => {
      const { cid } = await online1();
      await q("UPDATE claw_remote_connectors SET stream_seen_at = NOW() - interval '80 seconds' WHERE connector_id = $1", [cid]);
      const before = (await q("SELECT stream_seen_at FROM claw_remote_connectors WHERE connector_id = $1", [cid])).rows[0].stream_seen_at;
      await new Promise((r) => setTimeout(r, 500));
      const after = (await q("SELECT stream_seen_at FROM claw_remote_connectors WHERE connector_id = $1", [cid])).rows[0].stream_seen_at;
      assert.ok(after > before, "refreshed by pings");
    });

    test("a newer stream supersedes the older one, and the old one closing does not take the connector offline", async () => {
      const cid = await connector();
      await heartbeat("u1", cid);
      const first = await openCommands("u1", cid);
      await first.nextEvent("ready");
      const second = await openCommands("u1", cid);
      await second.nextEvent("ready");
      const bye = await first.nextEvent("superseded");
      assert.deepEqual(bye.json(), { connector_id: cid });
      await first.waitEnded();
      assert.equal((await as("u1").get("/v1/remote-agents/connectors")).body.data[0].online, true);
    });

    test("revoking a connector ends its stream with a revoked frame, refuses it afterwards, and closes its sessions", async () => {
      const { cid, stream } = await online1();
      const sid = await session("u1", cid);
      assert.equal((await as("u1").del(`/v1/remote-agents/connectors/${cid}`)).status, 200);
      assert.deepEqual((await stream.nextEvent("revoked")).json(), { connector_id: cid });
      await stream.waitEnded();
      for (const r of [
        await heartbeat("u1", cid),
        await post("u1", cid, []),
        await as("u1").get(`/v1/remote-agents/connectors/${cid}/commands`),
      ]) assert.deepEqual([r.status, r.body], [401, { ok: false, error: "revoked" }]);
      assert.equal((await as("u1").get(`/v1/remote-agents/sessions/${sid}`)).body.data.status, "closed");
      assert.equal((await as("u1").get("/v1/remote-agents/connectors")).body.data.length, 0);
      assert.equal((await as("u1").del(`/v1/remote-agents/connectors/${cid}`)).status, 404, "already gone");
      assert.equal((await q("SELECT COUNT(*) AS n FROM claw_remote_commands WHERE connector_id = $1", [cid])).rows[0].n, "0", "queued commands dropped");
      // The intruder is told nothing different from a missing id.
      assert.deepEqual((await heartbeat("u2", cid)).body, { ok: false, error: "not_found" });
    });

    test("an idle stream reads the database only every few seconds, and a write through this process still reaches it at once", async () => {
      // The default poll interval, and a ping slower than the window, so only polling touches the database.
      const root = await serve({ pingMs: 60_000, pollMs: undefined });
      const u = as("u1");
      const cid = (await u.post("/v1/remote-agents/connectors", { name: "m" }, undefined, root)).body.data.connector_id;
      const commands = await SseClient.open(`${root}/v1/remote-agents/connectors/${cid}/commands`, { "x-test-user": "u1" });
      streams.push(commands);
      await commands.nextEvent("ready");
      await u.post(`/v1/remote-agents/connectors/${cid}/heartbeat`, { agents: [AGENT] }, undefined, root);
      const sid = (await u.post("/v1/remote-agents/sessions", { connector_id: cid, agent_id: "a1", cwd: "/w" }, undefined, root)).body.data.session_id;
      await commands.nextEvent("command");
      const reader = await SseClient.open(`${root}/v1/remote-agents/sessions/${sid}/events`, { "x-test-user": "u1" });
      streams.push(reader);
      await reader.nextEvent("historyComplete");

      const pool = h.app.db.db;
      const real = pool.query;
      let queries = 0;
      pool.query = ((text: string, params?: unknown[]) => { queries++; return real(text, params); }) as typeof pool.query;
      try {
        await new Promise((r) => setTimeout(r, 2500));
      } finally {
        pool.query = real;
      }
      assert.equal(queries, 0, `an idle command stream and an idle reader read the database ${queries} times in 2.5 s`);

      // The doorbell keeps them prompt: neither waits for its next poll. The shared waker stands for one process.
      assert.equal((await u.post(`/v1/remote-agents/sessions/${sid}/commands`, { type: "cancel" }, undefined, root)).status, 202);
      assert.equal((await commands.next((f) => f.event === "command", 1500)).json().type, "cancel");
      assert.equal((await post("u1", cid, [ev(sid, "turn_end", {})])).status, 200);
      assert.equal((await reader.nextEvent("turn_end", 1500)).json().type, "turn_end");
    });
  });

  // ------------------------------------------------------------- retention

  describe("retention", () => {
    const store = () => import("../src/remote-agents/store.js");
    const rows = async (table: string, sid: string) =>
      Number((await q(`SELECT COUNT(*) AS n FROM ${table} WHERE session_id = $1`, [sid])).rows[0].n);
    /** A session holding one event, `status` since `age`. */
    async function aged(cid: string, status: "active" | "closed", age: string): Promise<string> {
      const sid = await session("u1", cid);
      await post("u1", cid, [ev(sid, "agent_message_chunk", { text: "kept?" })], `b-${sid}`);
      await q("UPDATE claw_remote_sessions SET status = $2, updated_at = NOW() - $3::interval WHERE session_id = $1", [sid, status, age]);
      return sid;
    }

    test("a closed session past the window goes with its events, a live or recent one stays, and the audit trail stays", async () => {
      const { cid } = await online1();
      const old = await aged(cid, "closed", "31 days");
      const recent = await aged(cid, "closed", "29 days");
      const abandoned = await aged(cid, "active", "90 days");
      assert.equal(await (await store()).pruneClosedSessions(30), 1);
      assert.deepEqual([await rows("claw_remote_sessions", old), await rows("claw_remote_events", old)], [0, 0]);
      for (const kept of [recent, abandoned]) {
        assert.deepEqual([await rows("claw_remote_sessions", kept), await rows("claw_remote_events", kept)], [1, 1], kept);
      }
      assert.ok(await rows("claw_remote_audit", old) > 0, "the audit trail outlives the session it describes");
      assert.equal(await (await store()).pruneClosedSessions(30), 0, "nothing more to delete");
    });

    test("a backlog larger than one batch is cleared in one pass", async () => {
      const { cid } = await online1();
      const old: string[] = [];
      for (let i = 0; i < 5; i++) old.push(await aged(cid, "closed", "40 days"));
      assert.equal(await (await store()).pruneClosedSessions(30, 2), 5);
      for (const sid of old) assert.equal(await rows("claw_remote_sessions", sid), 0);
    });

    test("the sweep runs on its own where retention is on, and not where it is off", async () => {
      const { cid } = await online1();
      const old = await aged(cid, "closed", "31 days");
      await serve({ retentionDays: 0, retentionSweepMs: 30 });
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(await rows("claw_remote_sessions", old), 1, "retention 0 keeps everything");
      await apps.pop()!.close();
      await serve({ retentionDays: 30, retentionSweepMs: 30 });
      try {
        for (let i = 0; i < 100 && await rows("claw_remote_sessions", old) > 0; i++) await new Promise((r) => setTimeout(r, 30));
        assert.equal(await rows("claw_remote_sessions", old), 0, "swept without anyone calling it");
      } finally {
        await apps.pop()!.close();
      }
    });
  });
});
