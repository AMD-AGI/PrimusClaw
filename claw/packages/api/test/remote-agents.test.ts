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
    await register(app, { pingMs: 150, pollMs: 40, waker, retentionDays: 0, presenceSweepMs: 0, undeliveredSweepMs: 0, ...opts });
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
  /** A frame's `issued_at`, checked to be when Claw queued it (its clock, ms; the database and this test share a host). */
  const issuedAt = (frame: { issued_at?: unknown }): number => {
    assert.ok(typeof frame.issued_at === "number" && Math.abs(Date.now() - frame.issued_at) < 60_000, `issued_at ${String(frame.issued_at)}`);
    return frame.issued_at;
  };
  // (The tests of what was never delivered read Claw's own ends of turns: the `user_prompt` each prompt also records is not one.)
  /** The presence sweep recorded the connector going offline `minutesAgo` (its laptop closed), as it does every 15 s. */
  const wentOffline = (cid: string, minutesAgo: number) => q(
    `INSERT INTO claw_remote_connector_transitions (connector_id, owner_user_id, from_state, to_state, reason, at)
     SELECT connector_id, owner_user_id, 'online', 'offline', 'no_heartbeat', NOW() - make_interval(mins => $2::int)
       FROM claw_remote_connectors WHERE connector_id = $1`, [cid, minutesAgo],
  );
  /**
   * The connector's command stream has ended (the server recorded it) and stayed gone for a minute: past the grace a connector is
   * given to open the next one (`STREAM_GRACE_SECS`), so offline from then on even with a fresh heartbeat.
   */
  async function streamEnded(cid: string, stream: SseClient): Promise<void> {
    await stream.closed();
    for (let i = 0; i < 100; i++) {
      const r = (await q("SELECT stream_closed_at FROM claw_remote_connectors WHERE connector_id = $1", [cid])).rows[0];
      if (r?.stream_closed_at) break;
      await new Promise((res) => setTimeout(res, 20));
    }
    await q("UPDATE claw_remote_connectors SET stream_closed_at = stream_closed_at - interval '1 minute' WHERE connector_id = $1", [cid]);
  }

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

    test("registering again under a name whose old row is offline revokes that row; an online, a just-made, another name's or another user's is left alone", async () => {
      const old = async (cid: string) => q("UPDATE claw_remote_connectors SET created_at = NOW() - interval '1 hour' WHERE connector_id = $1", [cid]);
      // All made first (none old yet, so none replaces another), then all but `fresh` made an hour ago.
      const stale = await connector("u1", "laptop");
      await heartbeat("u1", stale);
      const sid = await q("INSERT INTO claw_remote_sessions (session_id, owner_user_id, connector_id, agent_id, cwd, mode) VALUES (gen_random_uuid(), 'u1', $1, 'a1', '/w', 'default') RETURNING session_id::text AS session_id", [stale]);
      const { cid: live } = await online("u1");
      const fresh = await connector("u1", "laptop");
      const desk = await connector("u1", "desk");
      const theirs = await connector("u2", "laptop");
      for (const cid of [stale, live, desk, theirs]) await old(cid);
      await q("UPDATE claw_remote_connectors SET heartbeat_at = NOW() - interval '1 hour' WHERE connector_id = $1", [stale]);

      const again = await as("u1").post("/v1/remote-agents/connectors", { name: "laptop" });
      assert.equal(again.status, 201, JSON.stringify(again.body));
      const revoked = (await q("SELECT connector_id FROM claw_remote_connectors WHERE revoked_at IS NOT NULL")).rows.map((r: any) => r.connector_id);
      assert.deepEqual(revoked, [stale], "only the offline twin");
      const listed = (await as("u1").get("/v1/remote-agents/connectors")).body.data.map((c: any) => c.connector_id).sort();
      assert.deepEqual(listed, [live, fresh, desk, again.body.data.connector_id].sort());
      assert.equal((await q("SELECT status FROM claw_remote_sessions WHERE session_id = $1", [sid.rows[0].session_id])).rows[0].status, "closed");
      const audit = async (cid: string, action: string) =>
        (await q("SELECT detail FROM claw_remote_audit WHERE connector_id = $1 AND action = $2", [cid, action])).rows.map((r: any) => r.detail);
      assert.deepEqual((await audit(again.body.data.connector_id, "connector.registered")).map((d: any) => d.replaced), [[stale]]);
      assert.deepEqual((await audit(stale, "connector.revoked")).map((d: any) => [d.reason, d.sessions_closed]), [["replaced_by_same_name", 1]]);
      // The old one, should it come back, is told it was revoked.
      assert.deepEqual([(await heartbeat("u1", stale)).status, (await heartbeat("u1", stale)).body.error], [401, "revoked"]);
      // The twin no longer takes a place: live, fresh, desk and the new one.
      assert.equal((await q("SELECT COUNT(*)::int AS n FROM claw_remote_connectors WHERE owner_user_id = 'u1' AND revoked_at IS NULL")).rows[0].n, 4);
    });

    test("a registration refused at the limit leaves the offline twin it would have replaced as it was: not revoked, its sessions open", async () => {
      // Already past the limit (it was lowered, say): five machines plus one more. `laptop` is an offline twin, an hour old.
      const twin = await connector("u1", "laptop");
      for (let i = 1; i < 5; i++) await connector("u1", `m${i}`);
      await q("INSERT INTO claw_remote_connectors (connector_id, owner_user_id, name) VALUES (gen_random_uuid(), 'u1', 'over')");
      await q("UPDATE claw_remote_connectors SET created_at = NOW() - interval '1 hour' WHERE connector_id = $1", [twin]);
      const sid = (await q(
        "INSERT INTO claw_remote_sessions (session_id, owner_user_id, connector_id, agent_id, cwd, mode) VALUES (gen_random_uuid(), 'u1', $1, 'a1', '/w', 'default') RETURNING session_id::text AS session_id",
        [twin],
      )).rows[0].session_id;
      const again = await as("u1").post("/v1/remote-agents/connectors", { name: "laptop" });
      assert.deepEqual([again.status, again.body.error], [409, "connector_limit_reached"]);
      // Nothing was registered, so nothing was replaced: had the twin been revoked here, its session would have closed with nobody
      // told (the refusal returns before the closes are said), and a paired machine's grant would point at a revoked row for good.
      assert.equal((await q("SELECT revoked_at FROM claw_remote_connectors WHERE connector_id = $1", [twin])).rows[0].revoked_at, null);
      assert.equal((await q("SELECT status FROM claw_remote_sessions WHERE session_id = $1", [sid])).rows[0].status, "active");
      assert.deepEqual((await q("SELECT type FROM claw_remote_events WHERE session_id = $1", [sid])).rows, []);
      assert.deepEqual((await q("SELECT action FROM claw_remote_audit WHERE owner_user_id = 'u1' AND action <> 'connector.registered'")).rows, []);
      assert.equal((await q("SELECT COUNT(*)::int AS n FROM claw_remote_connectors WHERE owner_user_id = 'u1' AND revoked_at IS NULL")).rows[0].n, 6);
    });

    test("anonymous and 'default' callers are refused", async () => {
      assert.equal((await call(null, "GET", "/v1/remote-agents/connectors")).status, 403);
      assert.equal((await as("default").get("/v1/remote-agents/connectors")).status, 403);
    });

    test("online needs both a heartbeat and an open stream; a stream that has just ended is given the time to reconnect, and no more", async () => {
      const cid = await connector();
      const state = async () => (await as("u1").get("/v1/remote-agents/connectors")).body.data[0];
      assert.equal((await state()).online, false, "registered only");
      await heartbeat("u1", cid);
      assert.equal((await state()).online, false, "heartbeat without a stream");
      const stream = await openCommands("u1", cid);
      await stream.nextEvent("ready");
      assert.equal((await state()).online, true, "heartbeat and stream");
      await stream.closed();
      for (let i = 0; i < 100; i++) {
        if ((await q("SELECT stream_closed_at FROM claw_remote_connectors WHERE connector_id = $1", [cid])).rows[0].stream_closed_at) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      // A Claw release, an ingress restart or a token refresh ends every stream; the connector is back within seconds.
      assert.equal((await state()).online, true, "stream ended just now, heartbeat fresh: still online");
      await q("UPDATE claw_remote_connectors SET stream_closed_at = NOW() - interval '44 seconds' WHERE connector_id = $1", [cid]);
      assert.equal((await state()).online, true, "within the grace");
      await q("UPDATE claw_remote_connectors SET stream_closed_at = NOW() - interval '46 seconds' WHERE connector_id = $1", [cid]);
      assert.equal((await state()).online, false, "stream gone past the grace");
      // The grace never outlasts the heartbeat: a stream that just ended with a stale heartbeat is offline.
      await q("UPDATE claw_remote_connectors SET stream_closed_at = NOW(), heartbeat_at = NOW() - interval '200 seconds' WHERE connector_id = $1", [cid]);
      assert.equal((await state()).online, false, "stale heartbeat");
    });

    test("a session asked for while the stream is being reopened (a Claw release) is queued and delivered on the new stream", async () => {
      const { cid, stream } = await online1();
      await stream.closed();
      for (let i = 0; i < 100; i++) {
        if ((await q("SELECT stream_closed_at FROM claw_remote_connectors WHERE connector_id = $1", [cid])).rows[0].stream_closed_at) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      const made = await as("u1").post("/v1/remote-agents/sessions", { connector_id: cid, agent_id: "a1", cwd: "/work/repo" });
      assert.equal(made.status, 201, `not refused as connector_offline: ${JSON.stringify(made.body)}`);
      const sid = made.body.data.session_id;
      assert.equal((await as("u1").post(`/v1/remote-agents/sessions/${sid}/commands`, { type: "prompt", text: "hi" })).status, 202);
      const back = await openCommands("u1", cid);
      const got: string[] = [];
      for (let i = 0; i < 2; i++) got.push((await back.nextEvent("command")).json().type);
      assert.deepEqual(got, ["session.new", "prompt"]);
    });

    test("the list says when an offline connector was last seen and why it went, and nothing of either while online", async () => {
      const state = async () => (await as("u1").get("/v1/remote-agents/connectors")).body.data[0];
      const { cid, stream } = await online1();
      const up = await state();
      assert.equal(up.online, true);
      assert.ok(up.last_seen_at, "last seen");
      assert.equal(up.offline_since, null);
      assert.equal(up.offline_reason, null);
      const before = Date.now();
      await streamEnded(cid, stream);
      const down = await state();
      assert.equal(down.online, false);
      assert.equal(down.offline_reason, "no_heartbeat");
      assert.ok(Math.abs(new Date(down.offline_since).getTime() - before) < 5_000, `offline since the stream closed: ${down.offline_since}`);
      assert.equal(down.offline_since, down.last_seen_at);
      const row = (await q("SELECT stream_end_reason FROM claw_remote_connectors WHERE connector_id = $1", [cid])).rows[0];
      assert.equal(row.stream_end_reason, "closed");
      // Never seen at all: no time to name.
      await connector("u2");
      const never = (await as("u2").get("/v1/remote-agents/connectors")).body.data[0];
      assert.deepEqual([never.online, never.last_seen_at, never.offline_since, never.offline_reason], [false, null, null, "no_heartbeat"]);
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

  describe("connector versions and setup", () => {
    test("a connector below the minimum is listed with the command that upgrades it, and starts no session", async () => {
      const body = (cid: string) => ({ connector_id: cid, agent_id: "a1", cwd: "/work" });
      const at = async (version: string | null) => {
        const cid = await connector("u1", `m-${version ?? "none"}`);
        const stream = await openCommands("u1", cid);
        await stream.nextEvent("ready");
        assert.equal((await heartbeat("u1", cid, version ? { version } : {})).status, 200);
        return cid;
      };
      const old = await at("0.1.2");
      const outdated = await at("0.1.3");
      const current = await at("0.1.4");
      const unknown = await at(null);
      const list = (await as("u1").get("/v1/remote-agents/connectors")).body.data as Array<Record<string, any>>;
      const by = (cid: string) => list.find((c) => c.connector_id === cid)!;
      assert.deepEqual([by(old).version_status, by(outdated).version_status, by(current).version_status, by(unknown).version_status],
        ["unsupported", "outdated", "current", "unknown"]);
      const upgrade = "npm install -g @primusclaw/connector@latest && claw-connector stop && claw-connector service install";
      assert.equal(by(old).upgrade_command, upgrade);
      assert.equal(by(outdated).upgrade_command, upgrade);
      assert.equal(by(current).upgrade_command, undefined);
      // Below the minimum: refused by name, with what to run; nothing is queued for it.
      const refused = await as("u1").post("/v1/remote-agents/sessions", body(old));
      assert.deepEqual([refused.status, refused.body.error, refused.body.data.version, refused.body.data.upgrade_command],
        [409, "connector_outdated", "0.1.2", upgrade]);
      assert.equal((await q("SELECT COUNT(*)::int AS n FROM claw_remote_sessions WHERE connector_id = $1", [old])).rows[0].n, 0);
      // An outdated one, a current one and one that reports no version all still work.
      for (const cid of [outdated, current, unknown]) assert.equal((await as("u1").post("/v1/remote-agents/sessions", body(cid))).status, 201);
      // The heartbeat answer tells an old connector to upgrade, and a current one nothing.
      const hbOld = await heartbeat("u1", outdated, { version: "0.1.3" });
      assert.deepEqual([hbOld.body.data.connector_version.version_status, hbOld.body.data.connector_version.upgrade_command], ["outdated", upgrade]);
      assert.equal((await heartbeat("u1", current, { version: "0.1.4" })).body.data.connector_version, undefined);
    });

    test("the minimum and recommended versions follow the server's settings", async () => {
      const { cid } = await online();
      await heartbeat("u1", cid, { version: "0.1.4" });
      process.env.CLAW_REMOTE_AGENTS_MIN_CONNECTOR_VERSION = "0.2.0";
      try {
        const r = await as("u1").post("/v1/remote-agents/sessions", { connector_id: cid, agent_id: "a1", cwd: "/work" });
        assert.deepEqual([r.status, r.body.error, r.body.data.minimum_version, r.body.data.recommended_version], [409, "connector_outdated", "0.2.0", "0.2.0"]);
        process.env.CLAW_REMOTE_AGENTS_MIN_CONNECTOR_VERSION = "not a version";
        assert.equal((await as("u1").post("/v1/remote-agents/sessions", { connector_id: cid, agent_id: "a1", cwd: "/work" })).status, 201);
      } finally {
        delete process.env.CLAW_REMOTE_AGENTS_MIN_CONNECTOR_VERSION;
      }
    });

    test("setup gives the exact commands, with this server's addresses", async () => {
      const keep = { pub: process.env.CLAW_PUBLIC_URL, iss: process.env.IDENTITY_ISSUER_URL };
      process.env.CLAW_PUBLIC_URL = "https://claw.example.com/claw-api/";
      process.env.IDENTITY_ISSUER_URL = "https://id.example.com";
      try {
        const r = await as("u1").get("/v1/remote-agents/setup");
        assert.equal(r.status, 200);
        const d = r.body.data;
        assert.deepEqual(d.steps.map((s: Record<string, string>) => s.command), [
          "npm install -g @primusclaw/connector",
          "claw-connector init",
          "claw-connector login --server https://claw.example.com/claw-api --identity-url https://id.example.com",
          "claw-connector service install",
        ]);
        assert.deepEqual([d.package, d.server, d.identity_url, d.minimum_version, d.recommended_version], [
          "@primusclaw/connector", "https://claw.example.com/claw-api", "https://id.example.com", "0.1.3", "0.1.4"]);
        for (const text of [d.text.en, d.text.zh]) {
          for (const s of d.steps) assert.ok(text.includes(s.command), s.command);
          assert.doesNotMatch(text, /(^|\n)connector (login|run)/, "the command is claw-connector, never a bare connector");
        }
        // An identity service named for the connector wins over the issuer.
        process.env.CLAW_CONNECTOR_IDENTITY_URL = "https://device.example.com/";
        assert.match((await as("u1").get("/v1/remote-agents/setup")).body.data.steps[2].command, /--identity-url https:\/\/device\.example\.com$/);
        // Only for a signed-in user, like every user-side route.
        assert.equal((await call(null, "GET", "/v1/remote-agents/setup")).status, 403);
      } finally {
        delete process.env.CLAW_CONNECTOR_IDENTITY_URL;
        for (const [k, v] of [["CLAW_PUBLIC_URL", keep.pub], ["IDENTITY_ISSUER_URL", keep.iss]] as const) {
          if (v === undefined) delete process.env[k]; else process.env[k] = v;
        }
      }
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
        v: 1, cmd_id: created.json().cmd_id, type: "session.new", session_id: sid, issued_at: issuedAt(created.json()),
      });
      const sent = await as("u1").post(`/v1/remote-agents/sessions/${sid}/commands`, { type: "prompt", text: "do it" });
      assert.equal(sent.status, 202);
      const prompt = await stream.nextEvent("command");
      assert.equal(prompt.id, "2");
      assert.deepEqual(prompt.json(), { text: "do it", v: 1, cmd_id: sent.body.data.cmd_id, type: "prompt", session_id: sid, issued_at: issuedAt(prompt.json()) });
    });

    test("a session that names an existing session passes the reference to the connector as given, and a malformed one is refused", async () => {
      const { cid, stream } = await online1();
      const ref = "0f8fad5b-d9cb-469f-a165-70867728950e";
      const made = await as("u1").post("/v1/remote-agents/sessions", { connector_id: cid, agent_id: "a1", cwd: "/work/repo", resume_ref: ref });
      assert.equal(made.status, 201, JSON.stringify(made.body));
      const cmd = (await stream.nextEvent("command")).json();
      assert.deepEqual(cmd, {
        agent_id: "a1", cwd: "/work/repo", mode: null, resume_ref: ref,
        v: 1, cmd_id: cmd.cmd_id, type: "session.new", session_id: made.body.data.session_id, issued_at: issuedAt(cmd),
      });   // (no takeover unless asked for: the connector then only watches a conversation a terminal has open)
      assert.equal("resume_ref" in made.body.data, false, "the row does not keep it: the connector does");
      const audited = (await as("u1").get(`/v1/remote-agents/audit?session_id=${made.body.data.session_id}`)).body.data;
      assert.ok(audited.some((r: any) => r.action === "session.created" && r.detail.resume_ref === ref));
      for (const bad of ["", "x".repeat(129), "a\nb", 5]) {
        const r = await as("u1").post("/v1/remote-agents/sessions", { connector_id: cid, agent_id: "a1", cwd: "/work/repo", resume_ref: bad });
        assert.equal(r.status, 400, JSON.stringify(bad));
        assert.equal(r.body.error, "invalid_resume_ref");
      }
      // A takeover the person confirmed is passed on with it; one without a reference is refused before anything is queued.
      const taken = await as("u1").post("/v1/remote-agents/sessions", { connector_id: cid, agent_id: "a1", cwd: "/work/repo", resume_ref: ref, takeover: true });
      assert.equal(taken.status, 201, JSON.stringify(taken.body));
      const tcmd = (await stream.nextEvent("command")).json();
      assert.deepEqual([tcmd.type, tcmd.resume_ref, tcmd.takeover], ["session.new", ref, true]);
      const tAudit = (await as("u1").get(`/v1/remote-agents/audit?session_id=${taken.body.data.session_id}`)).body.data;
      assert.ok(tAudit.some((r: any) => r.action === "session.created" && r.detail.takeover === true), "who asked to end a terminal is on the record");
      const noRef = await as("u1").post("/v1/remote-agents/sessions", { connector_id: cid, agent_id: "a1", cwd: "/work/repo", takeover: true });
      assert.deepEqual([noRef.status, noRef.body.error], [400, "takeover_needs_resume_ref"]);
      // Without one, the command is what it always was.
      const plain = await session("u1", cid);
      assert.equal("resume_ref" in (await stream.nextEvent("command")).json(), false, plain);
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

    test("a prompt, set_mode, resume or session.new nobody collected within minutes is dropped, not replayed when the connector returns", async () => {
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
      // The laptop had closed (its last beat) a minute before they were sent.
      await q("UPDATE claw_remote_connectors SET heartbeat_at = NOW() - interval '11 minutes' WHERE connector_id = $1", [cid]);
      await wentOffline(cid, 9);

      // The machine wakes and reconnects. Only what could still be wanted comes: the prompt from four minutes ago, and the
      // cancel (which keeps a whole day). Not the session it never started: nobody is watching it start hours later.
      const back = await openCommands("u1", cid);
      const got: string[] = [];
      for (let i = 0; i < 2; i++) {
        const f = (await back.nextEvent("command")).json();
        got.push(`${f.type}${f.text ? `:${f.text}` : ""}`);
      }
      assert.deepEqual(got, ["prompt:fresh", "cancel"]);
      assert.equal(await back.quiet(150), true, "the stale session.new, prompt, set_mode and resume are not sent");

      // And they do not sit in the table as a second archive of what was typed: the next beat clears
      // them even though it acknowledges nothing.
      const types = async () => (await q("SELECT type FROM claw_remote_commands WHERE connector_id = $1 ORDER BY cmd_seq", [cid])).rows.map((r: any) => r.type);
      assert.equal((await types()).length, 6);
      assert.equal((await heartbeat("u1", cid)).status, 200);
      assert.deepEqual(await types(), ["prompt", "cancel"]);
      // The stale prompt's turn is ended, said as unconfirmed (Claw cannot tell whether the machine took it), so a chat or an item
      // waiting on it is not left waiting. The session is left open: the machine may be starting it.
      const evs = (await q("SELECT seq, type, data FROM claw_remote_events WHERE type <> 'user_prompt' AND session_id = $1 ORDER BY id", [sid])).rows;
      assert.deepEqual(evs.map((e: any) => [Number(e.seq), e.type, e.data]),
        [[-2, "turn_end", { stopReason: "error", error: "delivery_unconfirmed", cmd_seq: 2, by: "claw" }]]);
      assert.equal((await as("u1").get(`/v1/remote-agents/sessions/${sid}`)).body.data.status, "active");
      const audit = (await q("SELECT detail FROM claw_remote_audit WHERE connector_id = $1 AND action = 'command.expired' ORDER BY id", [cid])).rows;
      assert.deepEqual(audit.map((a: any) => a.detail.type), ["session.new", "prompt", "set_mode", "resume"]);
      assert.equal((await heartbeat("u1", cid)).status, 200);
      assert.equal((await q("SELECT COUNT(*)::int AS n FROM claw_remote_events WHERE type <> 'user_prompt' AND session_id = $1", [sid])).rows[0].n, 1, "said once");
    });

    test("a prompt a started session never received ends its turn by name; one just past its time is given the heartbeat's slack", async () => {
      const { cid, stream } = await online1();
      const sid = await session("u1", cid);
      assert.equal((await stream.nextEvent("command")).json().type, "session.new");
      // The connector started the session and said so (its cursor), then its laptop was closed.
      assert.equal((await heartbeat("u1", cid, { cmd_cursor: 1 })).status, 200);
      assert.equal((await post("u1", cid, [ev(sid, "session_started", {})])).status, 200);
      assert.equal((await as("u1").post(`/v1/remote-agents/sessions/${sid}/commands`, { type: "prompt", text: "lost" })).status, 202);
      assert.equal((await as("u1").post(`/v1/remote-agents/sessions/${sid}/commands`, { type: "prompt", text: "late" })).status, 202);
      await q("UPDATE claw_remote_events SET created_at = NOW() - interval '15 minutes' WHERE session_id = $1", [sid]);   // (it started before)
      await q("UPDATE claw_remote_commands SET created_at = NOW() - interval '10 minutes' WHERE connector_id = $1 AND payload->>'text' = 'lost'", [cid]);
      // Past the time it may be delivered (5 minutes), not yet past the slack for an acknowledgement on its way.
      await q("UPDATE claw_remote_commands SET created_at = NOW() - interval '330 seconds' WHERE connector_id = $1 AND payload->>'text' = 'late'", [cid]);
      // Still online, never away: either may be waiting behind a long turn on the machine. Kept, however old.
      assert.equal((await heartbeat("u1", cid, { cmd_cursor: 1 })).status, 200);
      assert.equal((await q("SELECT COUNT(*)::int AS n FROM claw_remote_events WHERE type <> 'user_prompt' AND session_id = $1", [sid])).rows[0].n, 1);
      assert.equal((await q("SELECT COUNT(*)::int AS n FROM claw_remote_commands WHERE connector_id = $1 AND type = 'prompt'", [cid])).rows[0].n, 2);
      // The laptop had closed (its last beat) before they were queued; the sweep recorded it, and it comes back.
      await q("UPDATE claw_remote_connectors SET heartbeat_at = NOW() - interval '11 minutes' WHERE connector_id = $1", [cid]);
      await wentOffline(cid, 4);
      assert.equal((await heartbeat("u1", cid, { cmd_cursor: 1 })).status, 200);
      const evs = (await q("SELECT seq, type, data FROM claw_remote_events WHERE type <> 'user_prompt' AND session_id = $1 ORDER BY id", [sid])).rows;
      assert.deepEqual(evs.map((e: any) => [Number(e.seq), e.type]), [[1, "session_started"], [-2, "turn_end"]]);
      assert.deepEqual(evs[1].data, { stopReason: "error", error: "delivery_unconfirmed", cmd_seq: 2, by: "claw" });
      assert.equal((await as("u1").get(`/v1/remote-agents/sessions/${sid}`)).body.data.status, "active", "the session itself goes on");
      assert.deepEqual((await q("SELECT payload->>'text' AS t FROM claw_remote_commands WHERE connector_id = $1 AND type = 'prompt'", [cid])).rows.map((r: any) => r.t), ["late"]);
      // The connector's own events still number from where it was: Claw's never take one of its numbers.
      const more = await post("u1", cid, [ev(sid, "agent_message_chunk", { update: {} })]);
      assert.deepEqual([more.status, more.body.data.acked[sid]], [200, 2]);
    });

    test("a prompt queued behind a long turn is never called undelivered, however long that turn runs or wherever its machine goes", async () => {
      const { cid, stream } = await online1();
      const sid = await session("u1", cid);
      assert.equal((await stream.nextEvent("command")).json().type, "session.new");
      assert.equal((await heartbeat("u1", cid, { cmd_cursor: 1 })).status, 200);
      assert.equal((await post("u1", cid, [ev(sid, "session_started", {})])).status, 200);
      // The first turn runs; the second prompt waits on the machine behind it, unacknowledged (connector.ts acknowledges a prompt
      // when it reaches the agent).
      for (const text of ["build", "then test"]) {
        assert.equal((await as("u1").post(`/v1/remote-agents/sessions/${sid}/commands`, { type: "prompt", text })).status, 202);
      }
      await q("UPDATE claw_remote_commands SET created_at = NOW() - interval '20 minutes' WHERE connector_id = $1", [cid]);
      await q("UPDATE claw_remote_events SET created_at = NOW() - interval '30 minutes' WHERE session_id = $1", [sid]);
      // A silent tool call for twenty minutes on a machine that never went away: nothing ends.
      assert.equal((await heartbeat("u1", cid, { cmd_cursor: 2 })).status, 200);
      assert.equal((await q("SELECT COUNT(*)::int AS n FROM claw_remote_events WHERE type <> 'user_prompt' AND session_id = $1 AND seq < 0", [sid])).rows[0].n, 0);
      // The turn said something after they were queued, and then the laptop closed: the machine had them. Nothing ends either.
      assert.equal((await post("u1", cid, [ev(sid, "agent_message_chunk", { update: {} })])).status, 200);
      await wentOffline(cid, 1);
      await q("UPDATE claw_remote_connectors SET heartbeat_at = NOW() - interval '5 minutes' WHERE connector_id = $1", [cid]);
      const { inTransaction } = await import("../src/infra/db.js");
      const st = await import("../src/remote-agents/store.js");
      assert.deepEqual(await inTransaction((tx) => st.expireUndelivered(tx)), []);
      assert.equal((await q("SELECT COUNT(*)::int AS n FROM claw_remote_commands WHERE connector_id = $1 AND type = 'prompt'", [cid])).rows[0].n, 1);
    });

    test("a prompt behind a silent turn is the machine's even when the laptop then closes; two never sent both end", async () => {
      const { inTransaction } = await import("../src/infra/db.js");
      const st = await import("../src/remote-agents/store.js");
      const { cid, stream } = await online1();
      const sid = await session("u1", cid);
      assert.equal((await stream.nextEvent("command")).json().type, "session.new");
      assert.equal((await post("u1", cid, [ev(sid, "session_started", {})])).status, 200);
      const say = (text: string) => as("u1").post(`/v1/remote-agents/sessions/${sid}/commands`, { type: "prompt", text });
      // A first turn reaches the agent (acknowledged) and runs a long tool call that says nothing; a second waits behind it.
      assert.equal((await say("long build")).status, 202);
      assert.equal((await heartbeat("u1", cid, { cmd_cursor: 2 })).status, 200);
      assert.equal((await say("then test")).status, 202);
      // Twenty minutes on, the laptop has closed: offline, recorded, nothing heard since the second was queued.
      await q("UPDATE claw_remote_events SET created_at = NOW() - interval '30 minutes' WHERE session_id = $1", [sid]);
      await q("UPDATE claw_remote_audit SET ts = ts - interval '20 minutes' WHERE session_id = $1 AND detail->>'type' = 'prompt' AND ts > NOW() - interval '5 minutes'", [sid]);
      await q("UPDATE claw_remote_commands SET created_at = NOW() - interval '20 minutes' WHERE connector_id = $1", [cid]);
      await wentOffline(cid, 10);
      await q("UPDATE claw_remote_connectors SET heartbeat_at = NOW() - interval '10 minutes' WHERE connector_id = $1", [cid]);
      assert.deepEqual(await inTransaction((tx) => st.expireUndelivered(tx)), [], "it waits behind the silent turn");
      // The turn ends; two more are sent into the idle session as the laptop closes, and neither is ever collected: both end.
      await q("DELETE FROM claw_remote_commands WHERE connector_id = $1", [cid]);
      assert.equal((await post("u1", cid, [ev(sid, "turn_end", { stopReason: "end_turn", cmd_seq: 2 })])).status, 200);
      await q("UPDATE claw_remote_events SET created_at = NOW() - interval '9 minutes' WHERE session_id = $1 AND type = 'turn_end'", [sid]);
      await q("UPDATE claw_remote_connectors SET heartbeat_at = NOW(), stream_seen_at = NOW() WHERE connector_id = $1", [cid]);
      for (const text of ["one", "two"]) assert.equal((await say(text)).status, 202);
      await q("UPDATE claw_remote_commands SET created_at = NOW() - interval '8 minutes' WHERE connector_id = $1", [cid]);
      await q("UPDATE claw_remote_audit SET ts = NOW() - interval '8 minutes' WHERE session_id = $1 AND ts > NOW() - interval '1 minute'", [sid]);
      await wentOffline(cid, 7);
      await q("UPDATE claw_remote_connectors SET heartbeat_at = NOW() - interval '9 minutes' WHERE connector_id = $1", [cid]);
      const ended = await inTransaction((tx) => st.expireUndelivered(tx));
      assert.equal(ended.length, 1);
      const ends = (await q("SELECT data FROM claw_remote_events WHERE type <> 'user_prompt' AND session_id = $1 AND seq < 0 ORDER BY id", [sid])).rows;
      assert.deepEqual(ends.map((e: any) => [e.data.error, e.data.cmd_seq]), [["delivery_unconfirmed", 4], ["delivery_unconfirmed", 5]]);
    });

    test("a prompt sent moments before its machine went is ended as unconfirmed too, and a new session is left open", async () => {
      const { inTransaction } = await import("../src/infra/db.js");
      const st = await import("../src/remote-agents/store.js");
      const { cid, stream } = await online1();
      const sid = await session("u1", cid);
      assert.equal((await stream.nextEvent("command")).json().type, "session.new");
      assert.equal((await heartbeat("u1", cid, { cmd_cursor: 1 })).status, 200);
      assert.equal((await post("u1", cid, [ev(sid, "session_started", {})])).status, 200);
      assert.equal((await as("u1").post(`/v1/remote-agents/sessions/${sid}/commands`, { type: "prompt", text: "go" })).status, 202);
      const fresh = await as("u1").post("/v1/remote-agents/sessions", { connector_id: cid, agent_id: "a1", cwd: "/work/other" });
      assert.equal(fresh.status, 201);
      await stream.closed();
      // Its last beat was 10 s before they were queued: it may have taken them just before the laptop closed.
      await q("UPDATE claw_remote_events SET created_at = NOW() - interval '15 minutes' WHERE session_id = $1", [sid]);
      await q("UPDATE claw_remote_commands SET created_at = NOW() - interval '10 minutes' WHERE connector_id = $1", [cid]);
      await q("UPDATE claw_remote_connectors SET heartbeat_at = NOW() - interval '610 seconds' WHERE connector_id = $1", [cid]);
      await inTransaction((tx) => st.expireUndelivered(tx));
      const ends = (await q("SELECT session_id::text AS s, type, data FROM claw_remote_events WHERE type <> 'user_prompt' AND seq < 0 ORDER BY id")).rows;
      assert.deepEqual(ends.map((e: any) => [e.s, e.type, e.data.error ?? e.data.reason]), [[sid, "turn_end", "delivery_unconfirmed"]],
        "the session it may be starting gets no end");
      assert.equal((await as("u1").get(`/v1/remote-agents/sessions/${fresh.body.data.session_id}`)).body.data.status, "active");
      const audit = (await q("SELECT detail FROM claw_remote_audit WHERE connector_id = $1 AND action = 'command.expired' ORDER BY id", [cid])).rows;
      assert.deepEqual(audit.map((a: any) => [a.detail.type, a.detail.reason]), [["prompt", "delivery_unconfirmed"], ["session.new", "delivery_unconfirmed"]]);
    });

    test("a prompt sent after one Claw already ended is not taken to wait behind it: it ends too", async () => {
      const { inTransaction } = await import("../src/infra/db.js");
      const st = await import("../src/remote-agents/store.js");
      const { cid, stream } = await online1();
      const sid = await session("u1", cid);
      assert.equal((await stream.nextEvent("command")).json().type, "session.new");
      assert.equal((await heartbeat("u1", cid, { cmd_cursor: 1 })).status, 200);
      await stream.closed();
      const say = (text: string) => as("u1").post(`/v1/remote-agents/sessions/${sid}/commands`, { type: "prompt", text });
      // The first goes into the dead connection and is ended by Claw.
      await q("UPDATE claw_remote_connectors SET stream_seen_at = NOW(), stream_closed_at = NULL WHERE connector_id = $1", [cid]);
      assert.equal((await say("first")).status, 202);
      await q("UPDATE claw_remote_commands SET created_at = NOW() - interval '12 minutes' WHERE connector_id = $1", [cid]);
      await q("UPDATE claw_remote_audit SET ts = NOW() - interval '12 minutes' WHERE session_id = $1 AND action = 'command.issued' AND detail->>'type' = 'prompt'", [sid]);
      await q("UPDATE claw_remote_connectors SET heartbeat_at = NOW() - interval '13 minutes', stream_seen_at = NULL WHERE connector_id = $1", [cid]);
      assert.equal((await inTransaction((tx) => st.expireUndelivered(tx))).length, 1);
      // The user tries again before the machine is back (it looked online a moment): the second is never collected either.
      await q("UPDATE claw_remote_connectors SET heartbeat_at = NOW(), stream_seen_at = NOW() WHERE connector_id = $1", [cid]);
      assert.equal((await say("second")).status, 202);
      await q("UPDATE claw_remote_commands SET created_at = NOW() - interval '7 minutes' WHERE connector_id = $1", [cid]);
      await q("UPDATE claw_remote_connectors SET heartbeat_at = NOW() - interval '8 minutes', stream_seen_at = NULL WHERE connector_id = $1", [cid]);
      assert.equal((await inTransaction((tx) => st.expireUndelivered(tx))).length, 1, "not held as if behind the first");
      const ends = (await q("SELECT data FROM claw_remote_events WHERE type <> 'user_prompt' AND session_id = $1 AND seq < 0 ORDER BY id", [sid])).rows;
      assert.deepEqual(ends.map((e: any) => e.data.cmd_seq), [2, 3]);
    });

    test("a prompt after one the machine refused (command_rejected) is not taken to wait behind it", async () => {
      const { inTransaction } = await import("../src/infra/db.js");
      const st = await import("../src/remote-agents/store.js");
      const { cid, stream } = await online1();
      const sid = await session("u1", cid);
      assert.equal((await stream.nextEvent("command")).json().type, "session.new");
      const first = await as("u1").post(`/v1/remote-agents/sessions/${sid}/commands`, { type: "prompt", text: "first" });
      assert.equal(first.status, 202);
      const firstId = first.body.data.cmd_id;
      // The machine took it and refused it (a session it no longer has): acknowledged, and no turn will end for it.
      assert.equal((await heartbeat("u1", cid, { cmd_cursor: 2 })).status, 200);
      assert.equal((await post("u1", cid, [ev(sid, "command_rejected", { type: "prompt", cmd_id: firstId, reason: "unknown_session" })])).status, 200);
      await q("UPDATE claw_remote_events SET created_at = NOW() - interval '15 minutes' WHERE session_id = $1", [sid]);
      await q("UPDATE claw_remote_audit SET ts = NOW() - interval '12 minutes' WHERE session_id = $1", [sid]);
      assert.equal((await as("u1").post(`/v1/remote-agents/sessions/${sid}/commands`, { type: "prompt", text: "second" })).status, 202);
      await stream.closed();
      await q("UPDATE claw_remote_commands SET created_at = NOW() - interval '10 minutes' WHERE connector_id = $1", [cid]);
      await q("UPDATE claw_remote_connectors SET heartbeat_at = NOW() - interval '11 minutes', stream_seen_at = NULL WHERE connector_id = $1", [cid]);
      assert.equal((await inTransaction((tx) => st.expireUndelivered(tx))).length, 1);
      assert.equal((await q("SELECT COUNT(*)::int AS n FROM claw_remote_commands WHERE connector_id = $1", [cid])).rows[0].n, 0);
    });

    test("a sweep ends what was never delivered to a machine that does not come back", async () => {
      const root = await serve({ undeliveredSweepMs: 50 });
      const { cid, stream } = await online1();
      const sid = await session("u1", cid);
      assert.equal((await stream.nextEvent("command")).json().type, "session.new");
      assert.equal((await heartbeat("u1", cid, { cmd_cursor: 1 })).status, 200);
      assert.equal((await as("u1").post(`/v1/remote-agents/sessions/${sid}/commands`, { type: "prompt", text: "hi" }, {}, root)).status, 202);
      await stream.closed();
      // The laptop closed a minute before: no heartbeat since, and the sweep has not recorded it yet. Offline now is enough.
      await q("UPDATE claw_remote_commands SET created_at = NOW() - interval '10 minutes' WHERE connector_id = $1", [cid]);
      await q("UPDATE claw_remote_connectors SET heartbeat_at = NOW() - interval '11 minutes' WHERE connector_id = $1", [cid]);
      let evs: any[] = [];
      for (let i = 0; i < 100 && !evs.length; i++) {
        await new Promise((r) => setTimeout(r, 30));
        evs = (await q("SELECT type, data FROM claw_remote_events WHERE type <> 'user_prompt' AND session_id = $1", [sid])).rows;
      }
      assert.deepEqual(evs.map((e: any) => [e.type, e.data.error]), [["turn_end", "delivery_unconfirmed"]], "no heartbeat needed");
      assert.equal((await q("SELECT COUNT(*)::int AS n FROM claw_remote_commands WHERE connector_id = $1", [cid])).rows[0].n, 0);
      await apps.pop()!.close();   // (its sweep stops with it, before another test ages commands)
    });

    test("a takeover carries until when its confirmation holds, and one nobody collected within minutes is not delivered", async () => {
      const { cid, stream } = await online1();
      const ref = "0f8fad5b-d9cb-469f-a165-70867728950e";
      const before = Date.now();
      const taken = await as("u1").post("/v1/remote-agents/sessions", { connector_id: cid, agent_id: "a1", cwd: "/work/repo", resume_ref: ref, takeover: true });
      assert.equal(taken.status, 201, JSON.stringify(taken.body));
      const fresh = (await stream.nextEvent("command")).json();
      // the connector is told until when the confirmation holds: the live-command TTL from now
      assert.ok(fresh.takeover_until >= before + 5 * 60_000 - 1_000 && fresh.takeover_until <= Date.now() + 5 * 60_000 + 1_000, String(fresh.takeover_until));
      // The laptop lid closed before it was collected; the machine comes back ten minutes later.
      await stream.closed();
      await q("UPDATE claw_remote_commands SET created_at = NOW() - interval '10 minutes' WHERE connector_id = $1", [cid]);
      const back = await openCommands("u1", cid, "0"); // replayed from the start: only its `ready` comes, no command
      assert.equal(await back.quiet(300, (f) => f.event === "command"), true, "the stale takeover is not sent");
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
      await streamEnded(cid, stream);
      assert.equal((await as("u1").get("/v1/remote-agents/connectors")).body.data[0].online, false);
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

    test("what the person sent is in the session's events, from any client, once, masked, before the answer, and a connector cannot post one", async () => {
      const { cid, stream } = await online1();
      const sid = await session("u1", cid);
      const reader = await SseClient.open(`${base}/v1/remote-agents/sessions/${sid}/events`, { "x-test-user": "u1" });
      streams.push(reader);
      assert.equal((await reader.next()).event, "historyComplete");
      // Sent from Teams (a client label, an Idempotency-Key): a reader elsewhere is told at once, not on its next poll.
      const sent = await as("u1").post(`/v1/remote-agents/sessions/${sid}/commands`,
        { type: "prompt", text: "what is 2+2? use Authorization: Bearer supersecretvalue123456" }, { "idempotency-key": "teams-1", "x-claw-client": "teams" });
      assert.equal(sent.status, 202);
      const live = (await reader.next(undefined, 1000)).json();
      assert.deepEqual([live.type, live.data.cmd_id, live.data.cmd_seq, live.data.client, live.data.by], ["user_prompt", "k:teams-1", sent.body.data.cmd_seq, "teams", "claw"]);
      assert.match(live.data.text, /^what is 2\+2\? use .*<redacted>$/);
      assert.ok(!JSON.stringify(live).includes("supersecretvalue"), "masked as the agent's output is");
      assert.ok(live.seq < 0, "Claw's own numbering, never a connector's");
      // A retry queues nothing and says nothing twice; the agent's answer comes after it.
      const again = await as("u1").post(`/v1/remote-agents/sessions/${sid}/commands`,
        { type: "prompt", text: "what is 2+2? use Authorization: Bearer supersecretvalue123456" }, { "idempotency-key": "teams-1", "x-claw-client": "teams" });
      assert.equal(again.body.data.duplicate, true);
      await post("u1", cid, [ev(sid, "agent_message_chunk", { text: "4" }), ev(sid, "turn_end", { stopReason: "end_turn" })]);
      // The command the connector receives is unchanged: the text as typed.
      const cmd = (await stream.next((f) => f.event === "command" && f.json().type === "prompt")).json();
      assert.deepEqual([cmd.type, cmd.text], ["prompt", "what is 2+2? use Authorization: Bearer supersecretvalue123456"]);
      // The assistant's own instruction is recorded the same way, and a stop is not a prompt.
      const { issueCommand } = await import("../src/remote-agents/store.js");
      const out = await issueCommand({
        owner: "u1", client: "assistant", connectorId: cid, agentId: "a1", sessionId: sid, type: "prompt", cmdId: "k:asst-1",
        payload: { text: "run the tests" }, auditDetail: {}, closesSession: false, commandsPerMinute: 60,
      });
      assert.equal(out.status, "queued");
      assert.equal((await as("u1").post(`/v1/remote-agents/sessions/${sid}/commands`, { type: "cancel" })).status, 202);
      const replay = (await as("u1").get(`/v1/remote-agents/sessions/${sid}/events?mode=replay`)).body.data;
      assert.deepEqual(replay.map((r: any) => [r.type, r.data.text ?? null, r.data.client ?? null]), [
        ["user_prompt", replay[0].data.text, "teams"], ["agent_message_chunk", "4", null], ["turn_end", null, null], ["user_prompt", "run the tests", "assistant"],
      ]);
      // The audit trail still keeps no text.
      const audit = (await q("SELECT detail FROM claw_remote_audit WHERE session_id = $1 AND action = 'command.issued'", [sid])).rows;
      assert.ok(!JSON.stringify(audit).includes("what is 2+2") && !JSON.stringify(audit).includes("run the tests"));
      // Only Claw writes one: a connector's is refused by name, and the rest of its batch is kept.
      const forged = await post("u1", cid, [ev(sid, "user_prompt", { text: "I never said this" }), ev(sid, "agent_message_chunk", { text: "ok" })], "b2");
      assert.deepEqual(forged.body.data.rejected.map((r: any) => r.reason), ["reserved_type"]);
      assert.deepEqual((await q("SELECT COUNT(*)::int AS n FROM claw_remote_events WHERE session_id = $1 AND type = 'user_prompt'", [sid])).rows[0].n, 2);
    });

    test("what a connector says about a session running without per-step approval reaches the user's client unchanged", async () => {
      // `unattended` is not interpreted here: the API relays whatever the connector reports, in the agent's
      // capabilities and in the session events that name a mode. Nothing in it is a product name.
      const caps = { ask_mode: "no-approval-mode", modes: ["a", "b"], unattended: true, unattended_allowed: true, protocol: 1 };
      const asking = { ask_mode: "default", modes: ["a", "b"], unattended: false, unattended_allowed: false, protocol: 1 };
      const cid = await connector();
      await heartbeat("u1", cid, {}, [{ ...AGENT, capabilities: caps }, { agent_id: "a2", kind: "other", name: "Two", capabilities: asking }]);
      const listed = (await as("u1").get("/v1/remote-agents/connectors")).body.data[0].agents;
      assert.deepEqual(listed.map((a: any) => [a.agent_id, a.capabilities]), [["a1", caps], ["a2", asking]]);

      const { cid: online, stream: _s } = await online1();
      const sid = await session("u1", online);
      const started = { acp_session_id: "x", agent_id: "a1", kind: "example-kind", cwd: "/work/repo", currentMode: "no-approval-mode", unattended: true, modes: [{ id: "a", unattended: false }, { id: "no-approval-mode", unattended: true }] };
      const changed = { currentMode: "a", unattended: false };
      const posted = await post("u1", online, [ev(sid, "session_started", started), ev(sid, "mode_update", changed), ev(sid, "session_resumed", { ...started })]);
      assert.deepEqual(posted.body.data.rejected, []);
      const s = await SseClient.open(`${base}/v1/remote-agents/sessions/${sid}/events`, { "x-test-user": "u1" });
      streams.push(s);
      assert.deepEqual([(await s.next()).json().data, (await s.next()).json().data, (await s.next()).json().data], [started, changed, started]);
    });

    test("a session that watches a terminal's conversation is read-only: said on the session and on every frame, and nothing typed is queued", async () => {
      const { cid } = await online1();
      const sid = await session("u1", cid);
      const types = async () => (await q("SELECT type FROM claw_remote_commands WHERE session_id = $1 ORDER BY cmd_seq", [sid])).rows.map((r: any) => r.type);
      // Before the connector says so, the session takes prompts as any other.
      assert.equal((await as("u1").get(`/v1/remote-agents/sessions/${sid}`)).body.data.read_only, false);
      await post("u1", cid, [
        ev(sid, "session_started", { attached: true, read_only: true, read_only_reason: "session_live", modes: [], currentMode: null }),
        ev(sid, "agent_message_chunk", { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "from the terminal" } }, read_only: true }),
      ]);
      assert.equal((await as("u1").get(`/v1/remote-agents/sessions/${sid}`)).body.data.read_only, true);
      assert.equal((await as("u1").get("/v1/remote-agents/sessions")).body.data.find((x: any) => x.session_id === sid).read_only, true);
      const before = await types();
      for (const body of [{ type: "prompt", text: "do something else" }, { type: "set_mode", mode_id: "plan" }]) {
        const r = await as("u1").post(`/v1/remote-agents/sessions/${sid}/commands`, body);
        assert.deepEqual([r.status, r.body.error], [409, "session_read_only"], body.type);
      }
      assert.deepEqual(await types(), before, "nothing was queued for the connector");
      assert.equal((await as("u1").post(`/v1/remote-agents/sessions/${sid}/commands`, { type: "cancel" })).status, 202, "a stop is harmless and goes through");
      // What the connector answers it with does not repeat the mark: the frame carries it all the same.
      await post("u1", cid, [ev(sid, "turn_end", { stopReason: "cancelled", cmd_id: null })], "b8");
      const s = await SseClient.open(`${base}/v1/remote-agents/sessions/${sid}/events`, { "x-test-user": "u1" });
      streams.push(s);
      const [f1, f2, f3] = [(await s.next()).json(), (await s.next()).json(), (await s.next()).json()];
      assert.deepEqual([f1.type, f1.read_only, f2.type, f2.read_only, f2.data.update.content.text], ["session_started", true, "agent_message_chunk", true, "from the terminal"]);
      assert.deepEqual([f3.type, f3.read_only, f3.data.read_only], ["turn_end", true, undefined]);
      const replay = (await as("u1").get(`/v1/remote-agents/sessions/${sid}/events?mode=replay`)).body.data;
      assert.deepEqual(replay.map((r: any) => r.read_only), [true, true, true]);
      // The terminal closed and the conversation was taken over in a new session: that one is not read-only.
      const other = await session("u1", cid, "/work/other");
      await post("u1", cid, [ev(other, "session_started", { attached: true, modes: [], currentMode: "default" })], "b9");
      assert.equal((await as("u1").get(`/v1/remote-agents/sessions/${other}`)).body.data.read_only, false);
      assert.equal((await as("u1").post(`/v1/remote-agents/sessions/${other}/commands`, { type: "prompt", text: "go" })).status, 202);
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
        v: 1, cmd_id: "dec:" + sid + ":act-1", type: "decision", session_id: sid, issued_at: issuedAt(frame),
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
      await streamEnded(cid, stream);
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

    test("at the limit an idle session is closed to make room, but never one whose events are being stored as it is chosen", async () => {
      const small = await serve({ maxActiveSessionsPerUser: 2 });
      const cid = (await as("u1").post("/v1/remote-agents/connectors", { name: "m" }, undefined, small)).body.data.connector_id;
      const s = await SseClient.open(`${small}/v1/remote-agents/connectors/${cid}/commands`, { "x-test-user": "u1" });
      streams.push(s);
      await as("u1").post(`/v1/remote-agents/connectors/${cid}/heartbeat`, { agents: [AGENT] }, undefined, small);
      const make = () => as("u1").post("/v1/remote-agents/sessions", { connector_id: cid, agent_id: "a1", cwd: "/w" }, undefined, small);
      const a = (await make()).body.data.session_id as string;
      const b = (await make()).body.data.session_id as string;
      let madeId = "";
      // Both collected by the connector, and unused for an hour; b the longer, so b is the one chosen.
      await q("DELETE FROM claw_remote_commands WHERE session_id = ANY($1::uuid[])", [[a, b]]);
      await q("UPDATE claw_remote_sessions SET updated_at = NOW() - interval '1 hour' WHERE session_id = $1", [a]);
      await q("UPDATE claw_remote_sessions SET updated_at = NOW() - interval '2 hours' WHERE session_id = $1", [b]);
      // b's connector is storing a batch right now: the real ingest (POST .../events) is held just after it has written the event
      // (a test-only trigger waits on a lock this test holds), not yet committed, when the new session is asked for.
      const gate = await h.connect();
      await gate.query("SELECT pg_advisory_lock(424242)");
      await q(`CREATE OR REPLACE FUNCTION test_hold_ingest() RETURNS trigger LANGUAGE plpgsql AS
        $f$ BEGIN PERFORM pg_advisory_xact_lock_shared(424242); RETURN NULL; END $f$`);
      await q("CREATE TRIGGER test_hold_ingest AFTER INSERT ON claw_remote_events FOR EACH STATEMENT EXECUTE FUNCTION test_hold_ingest()");
      try {
        const posted = as("u1").post(`/v1/remote-agents/connectors/${cid}/events`,
          { batch_id: "held", events: [{ session_id: b, seq: 1, type: "agent_message_chunk", ts: Date.now(), data: {} }] }, undefined, small);
        const waiting = async () => Number((await q(
          "SELECT COUNT(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND objid = 424242 AND NOT granted")).rows[0].n);
        for (let i = 0; i < 100 && await waiting() === 0; i++) await new Promise((r) => setTimeout(r, 20));
        assert.equal(await waiting(), 1, "the batch is held after writing its event");
        let settled = false;
        const third = make().then((r) => { settled = true; return r; });
        await new Promise((r) => setTimeout(r, 400));
        assert.equal(settled, false, "choosing b waits for the batch being stored");
        await gate.query("SELECT pg_advisory_unlock(424242)");
        assert.equal((await posted).status, 200);
        const made = await third;
        assert.equal(made.status, 201, JSON.stringify(made.body));
        assert.deepEqual(made.body.reclaimed, [a], "b is at work now: the other idle one makes room");
        madeId = made.body.data.session_id;
      } finally {
        await q("DROP TRIGGER IF EXISTS test_hold_ingest ON claw_remote_events");
        await gate.query("SELECT pg_advisory_unlock_all()");
      }
      const status = async (sid: string) => (await q("SELECT status FROM claw_remote_sessions WHERE session_id = $1", [sid])).rows[0].status;
      assert.deepEqual([await status(a), await status(b)], ["closed", "active"]);
      const close = (await q("SELECT type, session_id::text AS session_id FROM claw_remote_commands WHERE connector_id = $1 AND type = 'close'", [cid])).rows;
      assert.deepEqual(close, [{ type: "close", session_id: a }], "its connector is told to close it");
      const frame = await s.next((f) => f.event === "command" && JSON.parse(f.data).type === "close");
      assert.equal(JSON.parse(frame.data).session_id, a, "and the close reaches the connector's stream");
      const audit = (await q("SELECT detail FROM claw_remote_audit WHERE action = 'session.reclaimed' AND session_id = $1", [a])).rows[0];
      assert.equal(audit.detail.for_session, madeId);
    });

    test("at the limit a read-only session is closed to make room first, even while its terminal is writing", async () => {
      const small = await serve({ maxActiveSessionsPerUser: 2 });
      const cid = (await as("u1").post("/v1/remote-agents/connectors", { name: "m" }, undefined, small)).body.data.connector_id;
      const s = await SseClient.open(`${small}/v1/remote-agents/connectors/${cid}/commands`, { "x-test-user": "u1" });
      streams.push(s);
      await as("u1").post(`/v1/remote-agents/connectors/${cid}/heartbeat`, { agents: [AGENT] }, undefined, small);
      const make = () => as("u1").post("/v1/remote-agents/sessions", { connector_id: cid, agent_id: "a1", cwd: "/w" }, undefined, small);
      const idle = (await make()).body.data.session_id as string;
      const watch = (await make()).body.data.session_id as string;
      await q("DELETE FROM claw_remote_commands WHERE session_id = ANY($1::uuid[])", [[idle, watch]]);
      const chunk = { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "from the terminal" } }, read_only: true };
      // The watch: its terminal wrote just now, after the last turn_end it ever had (none), so by its events a turn is under way.
      const posted = await as("u1").post(`/v1/remote-agents/connectors/${cid}/events`, { batch_id: "w1", events: [
        { session_id: watch, seq: 1, type: "session_started", ts: Date.now(), data: { attached: true, read_only: true, modes: [], currentMode: null } },
        { session_id: watch, seq: 2, type: "agent_message_chunk", ts: Date.now(), data: chunk },
        { session_id: watch, seq: 3, type: "tool_call", ts: Date.now(), data: { update: { sessionUpdate: "tool_call", title: "Bash" }, read_only: true } },
      ] }, undefined, small);
      assert.deepEqual(posted.body.data.rejected, []);
      // The other one is idle and unused for longer: by age alone it would be the one.
      await q("UPDATE claw_remote_sessions SET updated_at = NOW() - interval '2 hours' WHERE session_id = $1", [idle]);
      const made = await make();
      assert.equal(made.status, 201, JSON.stringify(made.body));
      assert.deepEqual(made.body.reclaimed, [watch], "the watch makes room: closing it ends only the watch");
      const status = async (sid: string) => (await q("SELECT status FROM claw_remote_sessions WHERE session_id = $1", [sid])).rows[0].status;
      assert.deepEqual([await status(watch), await status(idle)], ["closed", "active"]);
      const frame = await s.next((f) => f.event === "command" && JSON.parse(f.data).type === "close");
      assert.equal(JSON.parse(frame.data).session_id, watch, "its connector is told to close it");
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

    test("a replica shutting down (a Claw release) tells its command streams to reconnect, and their connectors stay online", async () => {
      const closing = new AbortController();
      const root = await serve({ closing: closing.signal });
      const cid = await connector();
      await heartbeat("u1", cid);
      const open = async () => {
        const s = await SseClient.open(`${root}/v1/remote-agents/connectors/${cid}/commands`, { "x-test-user": "u1" });
        streams.push(s);
        return s;
      };
      const stream = await open();
      await stream.nextEvent("ready");
      closing.abort();
      assert.deepEqual((await stream.nextEvent("reconnect")).json(), { connector_id: cid });
      await stream.waitEnded();
      const row = (await q("SELECT stream_seen_at, stream_closed_at, stream_end_reason FROM claw_remote_connectors WHERE connector_id = $1", [cid])).rows[0];
      assert.equal(row.stream_end_reason, "restart");
      assert.ok(row.stream_seen_at, "still seen: the connector is on its way to another replica");
      assert.ok(row.stream_closed_at);
      assert.equal((await as("u1").get("/v1/remote-agents/connectors")).body.data[0].online, true, "online through the handover");
      // A stream that reaches this replica after it started closing is sent on at once.
      const late = await open();
      await late.nextEvent("ready");
      await late.nextEvent("reconnect");
      await late.waitEnded();
      // A connector that does not come back is offline once the online window has passed, as with any stream.
      await q("UPDATE claw_remote_connectors SET stream_seen_at = NOW() - interval '91 seconds' WHERE connector_id = $1", [cid]);
      assert.equal((await as("u1").get("/v1/remote-agents/connectors")).body.data[0].online, false);
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

    test("a command received late is confirmed before it runs: live while its session is open, refused once it closed or was cancelled, 401 once revoked", async () => {
      const { cid, stream } = await online1();
      const sid = await session("u1", cid);
      const opened = (await stream.nextEvent("command")).json();
      assert.equal(opened.type, "session.new");
      // Each frame says when Claw queued it, on Claw's clock, so a connector can tell one older than the live TTL.
      issuedAt(opened);
      const confirm = (cmdId: string, user = "u1") => as(user).post(`/v1/remote-agents/connectors/${cid}/commands/${encodeURIComponent(cmdId)}/confirm`);
      const sent = async (body: Record<string, unknown>) => {
        assert.equal((await as("u1").post(`/v1/remote-agents/sessions/${sid}/commands`, body)).status, 202);
        return (await stream.nextEvent("command")).json();
      };
      const p1 = await sent({ type: "prompt", text: "ls" });
      assert.deepEqual((await confirm(p1.cmd_id)).body, { ok: true, data: { cmd_id: p1.cmd_id, status: "live" } });
      assert.equal((await confirm(opened.cmd_id)).body.data.status, "live");
      // Another user asking about this connector is told nothing different from a missing one.
      assert.deepEqual((await confirm(p1.cmd_id, "u2")).body, { ok: false, error: "not_found" });
      assert.equal((await confirm("never-issued")).body.data.status, "gone");
      // A cancel queued after it: the prompt is no longer wanted; the cancel itself always is.
      const c1 = await sent({ type: "cancel" });
      assert.equal((await confirm(p1.cmd_id)).body.data.status, "cancelled");
      assert.equal((await confirm(c1.cmd_id)).body.data.status, "live");
      // Past the live TTL a prompt is expired.
      await q("UPDATE claw_remote_commands SET created_at = NOW() - interval '6 minutes' WHERE cmd_id = $1", [p1.cmd_id]);
      assert.equal((await confirm(p1.cmd_id)).body.data.status, "expired");
      // The person closes the session: what would make its agent act is dead at once (deleted from the queue, refused when asked
      // about); the close is delivered.
      const p2 = await sent({ type: "prompt", text: "rm -rf build" });
      assert.equal((await confirm(p2.cmd_id)).body.data.status, "live");
      const closed = await sent({ type: "close" });
      assert.deepEqual((await q("SELECT type FROM claw_remote_commands WHERE connector_id = $1 AND session_id = $2 ORDER BY cmd_seq", [cid, sid])).rows.map((r) => r.type),
        ["cancel", "close"]);
      assert.equal((await confirm(p2.cmd_id)).body.data.status, "gone");
      assert.equal((await confirm(opened.cmd_id)).body.data.status, "gone");
      assert.equal((await confirm(closed.cmd_id)).body.data.status, "live");
      const refused = (await q("SELECT detail FROM claw_remote_audit WHERE action = 'command.refused_late' ORDER BY id")).rows.map((r) => [r.detail.cmd_id, r.detail.status]);
      assert.deepEqual(refused, [["never-issued", "gone"], [p1.cmd_id, "cancelled"], [p1.cmd_id, "expired"], [p2.cmd_id, "gone"], [opened.cmd_id, "gone"]]);
      // A session its machine reported closed: a prompt queued before that is refused as such.
      const sid3 = await session("u1", cid);
      assert.equal((await stream.nextEvent("command")).json().session_id, sid3);
      assert.equal((await as("u1").post(`/v1/remote-agents/sessions/${sid3}/commands`, { type: "prompt", text: "ls" })).status, 202);
      const p4 = (await stream.nextEvent("command")).json();
      assert.equal((await post("u1", cid, [ev(sid3, "session_closed", { reason: "adapter_exited" })])).status, 200);
      assert.equal((await confirm(p4.cmd_id)).body.data.status, "session_closed");
      assert.ok((await q("SELECT detail FROM claw_remote_audit WHERE action = 'command.confirmed'")).rows.some((r) => r.detail.cmd_id === p1.cmd_id), "a live answer is recorded");
      // The machine is removed: whatever it still holds in a buffer is answered 401 revoked, which stops it.
      const sid2 = await session("u1", cid);
      const p3 = await (async () => {
        assert.equal((await stream.nextEvent("command")).json().session_id, sid2);
        assert.equal((await as("u1").post(`/v1/remote-agents/sessions/${sid2}/commands`, { type: "prompt", text: "ls" })).status, 202);
        return (await stream.nextEvent("command")).json();
      })();
      // Answered under the connector row's lock, the one a revocation takes: one in progress is waited for, and once it has
      // committed the answer is 401 `revoked`, never `live`.
      const revoking = await h.connect();
      try {
        await revoking.query("BEGIN");
        await revoking.query("UPDATE claw_remote_connectors SET revoked_at = NOW() WHERE connector_id = $1", [cid]);
        let settled = false;
        const asked = confirm(p3.cmd_id).finally(() => { settled = true; });
        await new Promise((r) => setTimeout(r, 400));
        assert.equal(settled, false, "the answer waits for the revocation in progress");
        await revoking.query("COMMIT");
        const r = await asked;
        assert.deepEqual([r.status, r.body], [401, { ok: false, error: "revoked" }], "never live once the revocation committed");
      } finally {
        await revoking.query("ROLLBACK").catch(() => undefined); // (a failed assertion leaves no lock behind; the cluster closes it)
      }
      assert.deepEqual([(await confirm(p3.cmd_id)).status, (await confirm(p3.cmd_id)).body], [401, { ok: false, error: "revoked" }]);
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
