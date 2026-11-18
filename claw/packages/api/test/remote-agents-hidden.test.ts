// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Hiding conversations of a machine from the owner's lists (`POST /v1/remote-agents/connectors/:cid/hidden`, `store.setHidden`),
 * over real HTTP against a real Postgres: what the listing then shows, that a conversation a process has open is never hidden,
 * that showing again undoes it, and that nobody else's machine can be touched. Skipped without DATABASE_URL, and a skip is not a pass.
 */
import assert from "node:assert/strict";
import test, { after, before, beforeEach, describe } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startAdmissionCluster, type AdmissionCluster } from "./support/admission-cluster.js";

const skip = postgresSkipReason();
const REFS = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"];
const ATTACH = {
  agent_id: "claude-sessions", kind: "attach", name: "Claude Code (existing sessions)",
  capabilities: { resumable: [
    { ref: REFS[0], title: "autopilot重构", cwd: "/w", updated_at: 3, state: "idle" },
    { ref: REFS[1], title: "blog", cwd: "/w", updated_at: 2, state: "live", input: "terminal" },
    { ref: REFS[2], title: "数字1到400逐行列出", cwd: "/w", updated_at: 1, state: "idle" },
  ] },
};

describe("hiding a machine's conversations from the lists", { skip }, () => {
  let h: AdmissionCluster;
  let app: FastifyInstance;
  let base = "";
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
  after(async () => { await app?.close(); await h?.stop(); });
  beforeEach(async () => { await q("DELETE FROM claw_remote_audit"); await q("DELETE FROM claw_remote_connectors"); });

  async function call(user: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
    const r = await fetch(base + path, {
      method, headers: { "x-test-user": user, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  }
  async function machine(user = "u1"): Promise<string> {
    const r = await call(user, "POST", "/v1/remote-agents/connectors", { name: "autopilot-devpod" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const cid = r.body.data.connector_id as string;
    assert.equal((await call(user, "POST", `/v1/remote-agents/connectors/${cid}/heartbeat`, { agents: [ATTACH] })).status, 200);
    return cid;
  }
  const listed = async (user = "u1", query = "") => {
    const r = await call(user, "GET", `/v1/remote-agents/connectors${query}`);
    assert.equal(r.status, 200);
    return r.body.data[0].agents[0].capabilities as { resumable: Array<{ ref: string; hidden?: boolean }>; hidden_count?: number };
  };
  const hide = (cid: string, refs: string[], hidden = true, user = "u1") => call(user, "POST", `/v1/remote-agents/connectors/${cid}/hidden`, { refs, hidden });

  test("a hidden conversation is not listed and is counted; one a process has open is refused and stays; showing again undoes it", async () => {
    const cid = await machine();
    const r = await hide(cid, [REFS[0], REFS[1], REFS[2], "44444444-4444-4444-8444-444444444444"]);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.data, {
      changed: [REFS[0], REFS[2]],
      refused: [{ ref: REFS[1], reason: "live" }, { ref: "44444444-4444-4444-8444-444444444444", reason: "unknown_conversation" }],
    });
    const now = await listed();
    assert.deepEqual([now.resumable.map((x) => x.ref), now.hidden_count], [[REFS[1]], 2]);
    // with ?hidden=include, every one, the hidden ones marked
    const all = await listed("u1", "?hidden=include");
    assert.deepEqual(all.resumable.map((x) => [x.ref, x.hidden === true]), [[REFS[0], true], [REFS[1], false], [REFS[2], true]]);
    // a heartbeat replaces the machine's list: what was hidden stays hidden
    assert.equal((await call("u1", "POST", `/v1/remote-agents/connectors/${cid}/heartbeat`, { agents: [ATTACH] })).status, 200);
    assert.deepEqual((await listed()).resumable.map((x) => x.ref), [REFS[1]]);
    // shown again
    assert.deepEqual((await hide(cid, [REFS[0]], false)).body.data, { changed: [REFS[0]], refused: [] });
    assert.deepEqual((await listed()).resumable.map((x) => x.ref), [REFS[0], REFS[1]]);
  });

  test("a hidden conversation a process opens again is listed: a live one is never hidden", async () => {
    const cid = await machine();
    await hide(cid, [REFS[2]]);
    const opened = { ...ATTACH, capabilities: { resumable: ATTACH.capabilities.resumable.map((x) => (x.ref === REFS[2] ? { ...x, state: "live" } : x)) } };
    assert.equal((await call("u1", "POST", `/v1/remote-agents/connectors/${cid}/heartbeat`, { agents: [opened] })).status, 200);
    assert.deepEqual((await listed()).resumable.map((x) => x.ref), REFS);
  });

  test("only the owner's machine, and only well-formed requests", async () => {
    const cid = await machine("u1");
    assert.equal((await hide(cid, [REFS[0]], true, "u2")).status, 404, "another user's machine is not found");
    assert.equal((await listed("u1")).resumable.length, 3);
    for (const body of [{ refs: [REFS[0]] }, { refs: [], hidden: true }, { refs: ["has space"], hidden: true }, { refs: "x", hidden: true }]) {
      assert.equal((await call("u1", "POST", `/v1/remote-agents/connectors/${cid}/hidden`, body)).status, 400, JSON.stringify(body));
    }
    await call("u1", "DELETE", `/v1/remote-agents/connectors/${cid}`);
    assert.equal((await hide(cid, [REFS[0]])).status, 404, "a revoked machine is not found");
  });
});
