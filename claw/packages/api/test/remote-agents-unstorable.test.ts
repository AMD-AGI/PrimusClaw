// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Text PostgreSQL refuses, on the remote-agents path and the stores beside it, against a real Postgres whose schema
 * `initDb` built with `CLAW_REMOTE_AGENTS_ENABLED` on. Skipped without DATABASE_URL, and a skip is not a pass.
 *
 * A NUL (from a terminal) or half a surrogate pair (a cut through an emoji) in a connector's event made `jsonb` refuse the
 * whole INSERT: the API answered 500 to that batch, the connector posted it again for ever, and every later event of the
 * machine waited behind it. Such a character is stored as U+FFFD; an event the database still refuses is refused alone.
 */
import assert from "node:assert/strict";
import test, { after, before, beforeEach, describe } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startAdmissionCluster, type AdmissionCluster } from "./support/admission-cluster.js";
import { SseClient } from "./support/sse-client.js";

const skip = postgresSkipReason();
const AGENT = { agent_id: "a1", kind: "example-kind", name: "Agent One", capabilities: { loadSession: true } };
const FFFD = "�";

describe("remote agents: text the database cannot store", { skip }, () => {
  let h: AdmissionCluster;
  let app: FastifyInstance;
  let base = "";
  const streams: SseClient[] = [];
  const q = (text: string, params: unknown[] = []) => h.app.db.db.query(text, params);

  before(async () => {
    h = await startAdmissionCluster({ CLAW_REMOTE_AGENTS_ENABLED: "true" });
    const { Waker } = await import("../src/remote-agents/waker.js");
    const { registerRemoteAgentRoutes } = await import("../src/routes/remote-agents.js");
    app = Fastify();
    app.addHook("preHandler", async (req) => {
      const id = req.headers["x-test-user"];
      if (typeof id === "string") (req as any).user = { userId: id, userName: id, platformKey: "", virtualKey: "", roles: ["default"] };
    });
    await registerRemoteAgentRoutes(app, { pingMs: 150, pollMs: 40, waker: new Waker(), retentionDays: 0, presenceSweepMs: 0, undeliveredSweepMs: 0 });
    await app.listen({ port: 0, host: "127.0.0.1" });
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  });
  after(async () => {
    for (const s of streams) await s.closed();
    await app?.close();
    await h?.stop();
  });
  beforeEach(async () => {
    await q("DROP TRIGGER IF EXISTS refuse_marked ON claw_remote_events");
    await q("DELETE FROM claw_remote_audit");
    await q("DELETE FROM claw_remote_connectors");
  });

  type Res = { status: number; body: any };
  async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
    const r = await fetch(base + path, {
      method,
      headers: { "x-test-user": "u1", ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null };
  }
  /** A connector with its agent advertised and its command stream open, and one session on it. */
  async function sessionOnline(capabilities: Record<string, unknown> = AGENT.capabilities): Promise<{ cid: string; sid: string; hb: Res }> {
    const reg = await call("POST", "/v1/remote-agents/connectors", { name: "laptop" });
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    const cid = reg.body.data.connector_id;
    const stream = await SseClient.open(`${base}/v1/remote-agents/connectors/${cid}/commands`, { "x-test-user": "u1" });
    streams.push(stream);
    await stream.nextEvent("ready");
    const hb = await call("POST", `/v1/remote-agents/connectors/${cid}/heartbeat`, { agents: [{ ...AGENT, capabilities }] });
    const s = await call("POST", "/v1/remote-agents/sessions", { connector_id: cid, agent_id: "a1", cwd: "/work/repo" });
    assert.equal(s.status, 201, JSON.stringify(s.body));
    return { cid, sid: s.body.data.session_id, hb };
  }
  const ev = (sid: string, seq: number, type: string, data: Record<string, unknown>) => ({ session_id: sid, seq, type, ts: Date.now(), data });
  const post = (cid: string, events: unknown[], batch = "b1") => call("POST", `/v1/remote-agents/connectors/${cid}/events`, { batch_id: batch, events });
  const stored = async (sid: string) =>
    (await q("SELECT seq, type, data FROM claw_remote_events WHERE session_id = $1 AND seq > 0 ORDER BY seq", [sid])).rows
      .map((r) => ({ seq: Number(r.seq), type: r.type, data: r.data }));

  test("a batch whose events carry NUL and unpaired surrogates, in keys and values at any depth, is stored whole with U+FFFD", async () => {
    const { cid, sid } = await sessionOnline();
    const events = [
      ev(sid, 1, "agent_message_chunk", { text: "before" }),
      // As the incident's: a tool's terminal output with a NUL in it.
      ev(sid, 2, "tool_call_update", { toolCallId: "t1", content: [{ type: "terminal", output: "ab\u0000cd\u0000" }] }),
      ev(sid, 3, "tool_call_update", { ["k\u0000ey"]: { deep: ["x\uD800", "\uDC00y", "ok 😀"] } }),
      ev(sid, 4, "turn_end", { stopReason: "end_turn" }),
    ];
    const r = await post(cid, events);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.data.rejected, []);
    assert.deepEqual(r.body.data.acked, { [sid]: 4 });
    const rows = await stored(sid);
    assert.deepEqual(rows.map((x) => [x.seq, x.type]), [[1, "agent_message_chunk"], [2, "tool_call_update"], [3, "tool_call_update"], [4, "turn_end"]]);
    assert.equal(rows[1]!.data.content[0].output, `ab${FFFD}cd${FFFD}`);
    assert.deepEqual(rows[2]!.data, { [`k${FFFD}ey`]: { deep: [`x${FFFD}`, `${FFFD}y`, "ok 😀"] } }, "a whole surrogate pair is kept");
    // A reader gets it as stored.
    const read = await call("GET", `/v1/remote-agents/sessions/${sid}/events?mode=replay`);
    assert.equal(read.status, 200);
    assert.equal(read.body.data.find((x: any) => x.seq === 2).data.content[0].output, `ab${FFFD}cd${FFFD}`);
  });

  test("a permission request is audited even when the audit trail's cut of a field splits a surrogate pair, and with a NUL in it", async () => {
    const { cid, sid } = await sessionOnline();
    // The trail keeps the first 200 UTF-16 units of `tool`: here that ends inside the emoji, leaving its first half alone.
    const tool = `${"x".repeat(199)}\uD83D\uDE00`;
    const r = await post(cid, [ev(sid, 1, "permissionRequest", { actionId: "act\u0000-1", tool, kind: "execute", options: [] })]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.data.acked, { [sid]: 1 });
    const audit = (await q("SELECT detail FROM claw_remote_audit WHERE action = 'permission.requested' AND session_id = $1", [sid])).rows;
    assert.deepEqual([audit[0]?.detail.action_id, audit[0]?.detail.tool], [`act${FFFD}-1`, `${"x".repeat(199)}${FFFD}`]);
    assert.equal((await stored(sid))[0]!.data.tool, tool, "the event itself keeps the whole pair");
  });

  test("a heartbeat whose capabilities carry a conversation title with a NUL is taken", async () => {
    const { hb, cid } = await sessionOnline({ loadSession: true, resumable: [{ ref: "r1", title: "fix \u0000 the build \uDBFF", state: "idle" }] });
    assert.equal(hb.status, 200, JSON.stringify(hb.body));
    const caps = (await q("SELECT capabilities FROM claw_remote_agents WHERE connector_id = $1", [cid])).rows[0].capabilities;
    assert.equal(caps.resumable[0].title, `fix ${FFFD} the build ${FFFD}`);
  });

  test("a prompt with a NUL in it is queued, and what the person sent is stored with U+FFFD", async () => {
    const { sid } = await sessionOnline();
    const sent = await call("POST", `/v1/remote-agents/sessions/${sid}/commands`, { type: "prompt", text: "what is \u0000 this" });
    assert.equal(sent.status, 202, JSON.stringify(sent.body));
    const asked = (await q("SELECT data FROM claw_remote_events WHERE session_id = $1 AND type = 'user_prompt'", [sid])).rows;
    assert.equal(asked[0]?.data.text, `what is ${FFFD} this`);
    const queued = (await q("SELECT payload FROM claw_remote_commands WHERE session_id = $1 AND type = 'prompt'", [sid])).rows;
    assert.equal(queued[0]?.payload.text, `what is ${FFFD} this`);
  });

  test("an event the database still refuses for its value is refused alone, by index and seq, and the rest of the batch is stored", async () => {
    const { cid, sid } = await sessionOnline();
    // Something other than a character this code knows to replace: the database refuses the value itself (SQLSTATE 22023).
    await q(`CREATE OR REPLACE FUNCTION refuse_marked() RETURNS trigger LANGUAGE plpgsql AS $$
             BEGIN IF NEW.data ? 'refuse_me' THEN RAISE EXCEPTION 'refused for the test' USING ERRCODE = '22023'; END IF; RETURN NEW; END $$`);
    await q("CREATE TRIGGER refuse_marked BEFORE INSERT ON claw_remote_events FOR EACH ROW EXECUTE FUNCTION refuse_marked()");
    const r = await post(cid, [
      ev(sid, 1, "agent_message_chunk", { text: "one" }),
      ev(sid, 2, "tool_call_update", { refuse_me: true }),
      ev(sid, 3, "agent_message_chunk", { text: "three\u0000" }),
      ev(sid, 4, "turn_end", { stopReason: "end_turn" }),
    ]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.data.rejected, [{ index: 1, session_id: sid, seq: 2, reason: "unstorable" }]);
    assert.deepEqual(r.body.data.acked, { [sid]: 4 });
    assert.deepEqual((await stored(sid)).map((x) => x.seq), [1, 3, 4]);
    // Later batches are not held up by it.
    assert.equal((await post(cid, [ev(sid, 5, "agent_message_chunk", { text: "five" })], "b2")).body.data.acked[sid], 5);
  });

  test("a failure that is not about a value fails the batch (500) and stores none of it, so the connector retries", async () => {
    const { cid, sid } = await sessionOnline();
    await q(`CREATE OR REPLACE FUNCTION refuse_marked() RETURNS trigger LANGUAGE plpgsql AS $$
             BEGIN IF NEW.data ? 'refuse_me' THEN RAISE EXCEPTION 'not about the value' USING ERRCODE = '40001'; END IF; RETURN NEW; END $$`);
    await q("CREATE TRIGGER refuse_marked BEFORE INSERT ON claw_remote_events FOR EACH ROW EXECUTE FUNCTION refuse_marked()");
    const r = await post(cid, [ev(sid, 1, "agent_message_chunk", { text: "one" }), ev(sid, 2, "tool_call_update", { refuse_me: true })]);
    assert.equal(r.status, 500);
    assert.deepEqual(await stored(sid), []);
  });

  test("what the stores beside it write through redactStoredValue (session events, transcripts) takes a NUL too", async () => {
    const { redactStoredValue } = await import("@claw/utils");
    const sessionId = "s-unstorable";
    const event = { type: "AgentMessage", data: { content: [{ type: "text", text: "out\u0000put \uD800" }], ["n\u0000"]: 1 } };
    // The statement the event consumer and dispatch run (`events/consumer.ts`, `sessions/dispatch.ts`), with the value they pass.
    await q("INSERT INTO claw_session_events (event_id, session_id, event, data) VALUES ($1, $2, $3, $4)",
      ["e-unstorable-1", sessionId, "AgentMessage", redactStoredValue(event)]);
    const row = (await q("SELECT data FROM claw_session_events WHERE event_id = 'e-unstorable-1'")).rows[0];
    assert.equal(row.data.data.content[0].text, `out${FFFD}put ${FFFD}`);
    assert.equal(row.data.data[`n${FFFD}`], 1);
  });
});
