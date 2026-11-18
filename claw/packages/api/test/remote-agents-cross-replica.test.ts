// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Two API replicas on one Postgres, each with its own process and so its own `Waker`: a write through one must reach a stream
 * held open on the other at once, not at that stream's next idle poll. Production runs several replicas behind one Service, so a
 * connector's events and a reader's stream (and a person's prompt and the connector's command stream) are usually on different
 * ones; measured on the live fleet (4 replicas, 5 s poll), an agent's first words reached the reader up to 5 s late, 5.1 s after
 * the prompt at the median.
 *
 * The idle poll here is far longer than any wait below, so a frame can only arrive in time if the other replica was woken.
 * Skipped without DATABASE_URL, and a skip is not a pass.
 */
import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startAdmissionCluster, type AdmissionCluster } from "./support/admission-cluster.js";
import { SseClient } from "./support/sse-client.js";
import type { Waker } from "../src/remote-agents/waker.js";

const skip = postgresSkipReason();
const AGENT = { agent_id: "a1", kind: "example-kind", name: "Agent One", capabilities: {} };
const USER = "u-cross-replica";
/** The idle poll of both replicas: nothing in this file waits anywhere near it. */
const POLL_MS = 30_000;
/** How long a woken frame may take: a local wake is milliseconds, a relayed one one round trip through Postgres. */
const PROMPT_MS = 2_000;

describe("remote agents across replicas", { skip }, () => {
  let h: AdmissionCluster;
  const apps: FastifyInstance[] = [];
  const wakers: Waker[] = [];
  const streams: SseClient[] = [];
  let a = "";
  let b = "";

  async function replica(): Promise<string> {
    const { Waker: W } = await import("../src/remote-agents/waker.js");
    const { registerRemoteAgentRoutes } = await import("../src/routes/remote-agents.js");
    const app = Fastify();
    app.addHook("preHandler", async (req) => {
      const id = req.headers["x-test-user"];
      if (typeof id === "string") (req as any).user = { userId: id, userName: id, platformKey: "", virtualKey: "", roles: ["default"] };
    });
    const waker = new W();
    // As index.ts registers it, with the timers that would only add noise turned off.
    await registerRemoteAgentRoutes(app, {
      pingMs: 60_000, pollMs: POLL_MS, waker, crossReplicaWake: true,
      retentionDays: 0, presenceSweepMs: 0, undeliveredSweepMs: 0,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    apps.push(app);
    wakers.push(waker);
    return `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  }

  before(async () => {
    h = await startAdmissionCluster({ CLAW_REMOTE_AGENTS_ENABLED: "true" });
    a = await replica();
    b = await replica();
  });
  after(async () => {
    for (const s of streams) await s.closed();
    for (const app of apps) await app.close();
    await h?.stop();
  });

  async function call(root: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
    const r = await fetch(root + path, {
      method,
      headers: { "x-test-user": USER, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  }
  async function open(url: string): Promise<SseClient> {
    const s = await SseClient.open(url, { "x-test-user": USER });
    streams.push(s);
    assert.equal(s.status, 200);
    return s;
  }
  /** A connector online through replica A, a session on it, and that session's reader on replica A. */
  async function setup(): Promise<{ cid: string; sid: string; commands: SseClient; reader: SseClient }> {
    const reg = await call(a, "POST", "/v1/remote-agents/connectors", { name: `laptop-${streams.length}` });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    const cid = reg.body.data.connector_id as string;
    const commands = await open(`${a}/v1/remote-agents/connectors/${cid}/commands`);
    await commands.nextEvent("ready");
    assert.equal((await call(a, "POST", `/v1/remote-agents/connectors/${cid}/heartbeat`, { agents: [AGENT] })).status, 200);
    const created = await call(a, "POST", "/v1/remote-agents/sessions", { connector_id: cid, agent_id: "a1", cwd: "/work" });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const sid = created.body.data.session_id as string;
    // The session.new command it was told about: from here on the command stream is idle.
    await commands.next((f) => f.event === "command" && f.json().type === "session.new");
    const reader = await open(`${a}/v1/remote-agents/sessions/${sid}/events`);
    await reader.nextEvent("historyComplete");
    return { cid, sid, commands, reader };
  }

  test("an event posted through another replica reaches an idle reader at once", async () => {
    const { cid, sid, reader } = await setup();
    // Both streams have read everything and are asleep in their idle poll.
    assert.ok(await reader.quiet(300));
    const posted = Date.now();
    const r = await call(b, "POST", `/v1/remote-agents/connectors/${cid}/events`, {
      batch_id: "x1", events: [{ session_id: sid, seq: 1, type: "agent_message_chunk", ts: Date.now(), data: { text: "hello" } }],
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.data.rejected, []);
    const frame = await reader.next((f) => f.event === "agent_message_chunk", PROMPT_MS);
    assert.equal(frame.json().data.text, "hello");
    assert.ok(Date.now() - posted < PROMPT_MS, `took ${Date.now() - posted} ms`);
  });

  test("a prompt issued through another replica reaches an idle command stream at once", async () => {
    const { sid, commands } = await setup();
    assert.ok(await commands.quiet(300, (f) => f.event === "command"));
    const r = await call(b, "POST", `/v1/remote-agents/sessions/${sid}/commands`, { type: "prompt", text: "hi" });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    const frame = await commands.next((f) => f.event === "command" && f.json().type === "prompt", PROMPT_MS);
    assert.equal(frame.json().session_id, sid);
  });

  test("a relay whose connection was dropped listens again and relays as before", async () => {
    const listeners = async () => (await h.app.db.db.query(
      "SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND query ILIKE 'LISTEN %'",
    )).rows.map((r) => r.pid as number);
    const before = await listeners();
    assert.equal(before.length, 2, "one listener per replica");
    // What a failover or a restarted server does to every connection.
    for (const pid of before) await h.app.db.db.query("SELECT pg_terminate_backend($1)", [pid]);
    for (const deadline = Date.now() + 10_000; ; await new Promise((r) => setTimeout(r, 50))) {
      const now = await listeners();
      if (now.length === 2 && now.every((pid) => !before.includes(pid))) break;
      assert.ok(Date.now() < deadline, `listeners now ${JSON.stringify(now)}, before ${JSON.stringify(before)}`);
    }
    const { cid, sid, reader } = await setup();
    assert.ok(await reader.quiet(300));
    const r = await call(b, "POST", `/v1/remote-agents/connectors/${cid}/events`, {
      batch_id: "x2", events: [{ session_id: sid, seq: 1, type: "agent_message_chunk", ts: Date.now(), data: { text: "again" } }],
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await reader.next((f) => f.event === "agent_message_chunk", PROMPT_MS)).json().data.text, "again");
  });

  test("closing a replica stops its relay and leaves no stream waiting", async () => {
    for (const s of streams.splice(0)) await s.closed();
    for (const app of apps.splice(0)) await app.close();
    // A stream's server side sees its client go a moment later.
    for (const deadline = Date.now() + 2_000; wakers.some((w) => w.size > 0) && Date.now() < deadline;) await new Promise((r) => setTimeout(r, 20));
    for (const w of wakers) assert.equal(w.size, 0);
    // No relay connection is left behind on the server.
    const left = await h.app.db.db.query(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND query ILIKE 'LISTEN %'",
    );
    assert.equal(left.rows[0].n, 0);
  });
});
