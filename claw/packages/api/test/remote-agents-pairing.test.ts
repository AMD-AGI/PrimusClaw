// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Pairing a machine with a one-time code, over real HTTP with the real global auth hook, against a real Postgres: the code is
 * the person's and works once and briefly; the grant it is traded for reaches only the connector routes, only its own
 * connector, and ends when that connector is revoked; the owner hears once that a machine was paired.
 * Skipped without DATABASE_URL, and a skip is not a pass.
 *
 * A request carrying `x-test-user` stands for a signed-in person on the user side; every other request meets the global hook.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import Fastify, { type FastifyInstance } from "fastify";

import { postgresSkipReason } from "./support/pg-cluster.js";
import { startAdmissionCluster, type AdmissionCluster } from "./support/admission-cluster.js";

const skip = postgresSkipReason();
const SERVER = "https://claw.example.com/claw-api";

describe("pairing a machine with a one-time code", { skip }, () => {
  let h: AdmissionCluster;
  let app: FastifyInstance;
  let base = "";
  let pairing: typeof import("../src/remote-agents/pairing.js");
  let told: Array<{ owner: string; name: string }> = [];
  const q = (text: string, params: unknown[] = []) => h.app.db.db.query(text, params);

  before(async () => {
    h = await startAdmissionCluster({ CLAW_REMOTE_AGENTS_ENABLED: "true", SAFE_API_URL: "http://127.0.0.1:9", AUTH_INTERNAL_TOKEN: "t" });
    pairing = await import("../src/remote-agents/pairing.js");
    pairing.pairingPorts.tell = async (n) => { told.push({ owner: n.owner, name: n.name }); return true; };
    const { authMiddleware } = await import("../src/auth/middleware.js");
    const { registerRemoteAgentRoutes } = await import("../src/routes/remote-agents.js");
    app = Fastify();
    app.addHook("preHandler", async (req, reply) => {
      const id = req.headers["x-test-user"];
      if (typeof id === "string") {
        (req as any).user = { userId: id, userName: id, platformKey: "", virtualKey: "", roles: ["default"] };
        return;
      }
      return authMiddleware(req, reply);
    });
    await registerRemoteAgentRoutes(app, {
      pingMs: 150, pollMs: 40, retentionDays: 0, presenceSweepMs: 0, pairing: { publicUrl: SERVER, claimsPerMinute: 1000, codesPerMinute: 1000 },
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  });
  after(async () => {
    await app?.close();
    await h?.stop();
  });
  beforeEach(async () => {
    told = [];
    await q("DELETE FROM claw_remote_pairings");
    await q("DELETE FROM claw_remote_grants");
    await q("DELETE FROM claw_remote_audit");
    await q("DELETE FROM claw_remote_connectors");
  });

  type Res = { status: number; body: any };
  async function call(method: string, path: string, opts: { user?: string; bearer?: string; body?: unknown } = {}): Promise<Res> {
    const r = await fetch(base + path, {
      method,
      headers: {
        ...(opts.user ? { "x-test-user": opts.user } : {}),
        ...(opts.bearer ? { authorization: `Bearer ${opts.bearer}` } : {}),
        ...(opts.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const text = await r.text();
    let body: any = null;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: r.status, body };
  }
  const newCode = async (user: string) => {
    const r = await call("POST", "/v1/remote-agents/pairings", { user });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.data as { code: string; command: string; expires_at: string; expires_in: number; server: string };
  };
  const claim = (code: string, name = "laptop") => call("POST", "/v1/remote-agents/pairings/claim", { body: { code, name } });
  const register = (bearer: string, name = "laptop") => call("POST", "/v1/remote-agents/connectors", { bearer, body: { name, version: "0.1.6" } });
  const heartbeat = (bearer: string, cid: string) =>
    call("POST", `/v1/remote-agents/connectors/${cid}/heartbeat`, { bearer, body: { version: "0.1.6", agents: [], cmd_cursor: null } });

  test("P1 the person's code is in one command line; it works once, and the grant registers a connector that is theirs", async () => {
    const d = await newCode("alice");
    assert.match(d.code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    assert.equal(d.command, `npm install -g @primusclaw/connector@latest && claw-connector pair ${d.code} --server ${SERVER}`);
    assert.equal(d.expires_in, 600);
    assert.equal(d.server, SERVER);
    // Only a hash of the code is kept.
    const stored = await q("SELECT code_hash FROM claw_remote_pairings");
    assert.equal(stored.rows.length, 1);
    assert.ok(!JSON.stringify(stored.rows).includes(d.code.replace(/-/g, "")));

    const c = await claim(d.code.toLowerCase());
    assert.equal(c.status, 201, JSON.stringify(c.body));
    const token = c.body.data.token as string;
    assert.match(token, /^cpg_[A-Za-z0-9_-]{43}$/);
    assert.equal(c.body.data.server, SERVER);
    assert.deepEqual((await claim(d.code)).body, { ok: false, error: "invalid_code" }, "a code works once");

    const reg = await register(token);
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    const cid = reg.body.data.connector_id as string;
    assert.equal((await heartbeat(token, cid)).status, 200);
    const mine = await call("GET", "/v1/remote-agents/connectors", { user: "alice" });
    assert.deepEqual(mine.body.data.map((x: any) => [x.connector_id, x.name]), [[cid, "laptop"]]);
    assert.deepEqual((await call("GET", "/v1/remote-agents/connectors", { user: "bob" })).body.data, []);
    const audit = (await q("SELECT action, detail FROM claw_remote_audit WHERE owner_user_id = 'alice' ORDER BY id")).rows;
    assert.deepEqual(audit.map((a) => a.action), ["pairing.created", "pairing.claimed", "connector.registered"]);
    assert.equal(audit[2].detail.credential, "connector_grant");
    assert.ok(!JSON.stringify(audit).includes(token), "the grant is not in the audit trail");
    assert.deepEqual(told, [{ owner: "alice", name: "laptop" }], "the owner is told once that a machine was paired");
  });

  test("P2 a wrong, expired or retired code gets one answer, and nothing is created", async () => {
    assert.deepEqual((await claim("not-a-code")).body, { ok: false, error: "invalid_code" });
    assert.deepEqual((await claim("ABCD-EFGH-JKMN")).body, { ok: false, error: "invalid_code" });
    const old = await newCode("alice");
    await q("UPDATE claw_remote_pairings SET expires_at = NOW() - interval '1 second'");
    assert.deepEqual((await claim(old.code)).body, { ok: false, error: "invalid_code" }, "an expired code");
    const codes = [];
    for (let i = 0; i < pairing.MAX_LIVE_CODES + 1; i++) codes.push((await newCode("alice")).code);
    assert.deepEqual((await claim(codes[0]!)).body, { ok: false, error: "invalid_code" }, "the oldest live code beyond the limit is retired");
    assert.equal((await claim(codes[codes.length - 1]!)).status, 201);
    assert.equal(Number((await q("SELECT COUNT(*) AS n FROM claw_remote_grants")).rows[0].n), 1);
  });

  test("P3 the grant reaches its own connector's routes and nothing else", async () => {
    const token = (await claim((await newCode("alice")).code)).body.data.token as string;
    // Before it registers, it reaches none of the person's existing connectors (their command streams included).
    const existing = await call("POST", "/v1/remote-agents/connectors", { user: "alice", body: { name: "existing", version: "0.1.6" } });
    const eid = existing.body.data.connector_id as string;
    for (const [method, path] of [["POST", `/v1/remote-agents/connectors/${eid}/heartbeat`], ["GET", `/v1/remote-agents/connectors/${eid}/commands`],
      ["POST", `/v1/remote-agents/connectors/${eid}/events`], ["POST", `/v1/remote-agents/connectors/${eid}/revoke`]] as const) {
      const r = await call(method, path, { bearer: token, ...(method === "POST" ? { body: {} } : {}) });
      assert.deepEqual([r.status, r.body.error], [403, "connector_grant_mismatch"], `unbound ${method} ${path}`);
    }
    const cid = (await register(token)).body.data.connector_id as string;
    // Another connector of the same person, registered otherwise.
    const other = await call("POST", "/v1/remote-agents/connectors", { user: "alice", body: { name: "desktop", version: "0.1.6" } });
    assert.equal(other.status, 201);
    const hb = await heartbeat(token, other.body.data.connector_id);
    assert.deepEqual([hb.status, hb.body.error], [403, "connector_grant_mismatch"]);
    for (const [method, path] of [["GET", "/v1/remote-agents/connectors"], ["GET", "/v1/remote-agents/sessions"], ["POST", "/v1/remote-agents/pairings"],
      ["DELETE", `/v1/remote-agents/connectors/${cid}`]] as const) {
      const r = await call(method, path, { bearer: token, ...(method === "POST" ? { body: {} } : {}) });
      assert.deepEqual([r.status, r.body.error], [403, "connector_grant_not_accepted"], `${method} ${path}`);
    }
    const forged = await heartbeat(`cpg_${"A".repeat(43)}`, cid);
    assert.deepEqual([forged.status, forged.body.error], [401, "invalid_token"]);
  });

  test("P4 revoking the connector ends the grant: 401 revoked everywhere, registering again included", async () => {
    const token = (await claim((await newCode("alice")).code)).body.data.token as string;
    const cid = (await register(token)).body.data.connector_id as string;
    assert.equal((await call("DELETE", `/v1/remote-agents/connectors/${cid}`, { user: "alice" })).status, 200);
    for (const r of [await heartbeat(token, cid), await register(token)]) assert.deepEqual([r.status, r.body.error], [401, "revoked"]);
    assert.equal(told.length, 1);
  });

  test("P5 registering again rebinds the grant to the new row, without telling the owner again", async () => {
    const token = (await claim((await newCode("alice")).code)).body.data.token as string;
    const first = (await register(token)).body.data.connector_id as string;
    const second = (await register(token)).body.data.connector_id as string;
    assert.notEqual(first, second);
    assert.equal((await heartbeat(token, second)).status, 200);
    assert.equal((await heartbeat(token, first)).body.error, "connector_grant_mismatch");
    assert.equal(told.length, 1);
  });

  test("P5c a paired machine that lost its state registers again under its name: its stale row is replaced and the grant follows", async () => {
    const token = (await claim((await newCode("alice")).code)).body.data.token as string;
    const first = (await register(token)).body.data.connector_id as string;
    // Long offline, as a machine whose local state was wiped (the row is past the online window and was made before it).
    await q("UPDATE claw_remote_connectors SET heartbeat_at = NOW() - interval '1 hour', stream_seen_at = NULL, created_at = NOW() - interval '1 hour' WHERE connector_id = $1", [first]);
    const again = await register(token);
    assert.equal(again.status, 201, JSON.stringify(again.body));
    const second = again.body.data.connector_id as string;
    assert.ok((await q("SELECT revoked_at FROM claw_remote_connectors WHERE connector_id = $1", [first])).rows[0].revoked_at, "the stale row was replaced");
    assert.equal((await heartbeat(token, second)).status, 200, "the grant works on the new row");
    assert.equal((await heartbeat(token, first)).body.error, "connector_grant_mismatch", "and no longer names the old one");
    assert.equal((await register(token)).status, 201, "registering again still works");
    // The binding is part of the registration's own transaction: what it commits already names the new row.
    const store = await import("../src/remote-agents/store.js");
    const grantId = (await q("SELECT grant_id::text AS id FROM claw_remote_grants")).rows[0].id as string;
    const row = await store.registerConnector("alice", "laptop", "0.1.6", null, 10, "connector_grant", 90_000, undefined, grantId);
    assert.ok(row);
    assert.equal((await q("SELECT connector_id::text AS c FROM claw_remote_grants WHERE grant_id = $1", [grantId])).rows[0].c, row!.connector_id);
  });

  test("P5b a notice that could not be said is said at the next registration, once", async () => {
    const saved = pairing.pairingPorts.tell;
    let fail = true;
    pairing.pairingPorts.tell = async (n) => { if (fail) throw new Error("assistant down"); told.push({ owner: n.owner, name: n.name }); return true; };
    try {
      const token = (await claim((await newCode("alice")).code)).body.data.token as string;
      assert.equal((await register(token)).status, 201);
      assert.deepEqual(told, []);
      fail = false;
      assert.equal((await register(token)).status, 201);
      assert.equal((await register(token)).status, 201);
      assert.deepEqual(told, [{ owner: "alice", name: "laptop" }]);
    } finally {
      pairing.pairingPorts.tell = saved;
    }
  });

  test("P6 a grant that never registered runs out after an hour", async () => {
    const token = (await claim((await newCode("alice")).code)).body.data.token as string;
    await q("UPDATE claw_remote_grants SET created_at = NOW() - interval '61 minutes'");
    const r = await register(token);
    assert.deepEqual([r.status, r.body.error], [401, "invalid_token"]);
    assert.equal(await pairing.pruneUnboundGrants(), 1);
  });

  test("P7 codes are only for a signed-in person, at most a few a minute; wrong claims are throttled per client address", async () => {
    const anon = await call("POST", "/v1/remote-agents/pairings", { body: {} });
    assert.equal(anon.status, 401);
    const limited = Fastify();
    limited.addHook("preHandler", async (req) => { (req as any).user = { userId: "carol", userName: "carol", platformKey: "", virtualKey: "", roles: ["default"] }; });
    const { registerPairingRoutes } = await import("../src/remote-agents/pairing-routes.js");
    await registerPairingRoutes(limited, { publicUrl: SERVER, claimsPerMinute: 2, codesPerMinute: 2 });
    // As the ingress passes requests on: it appends the address it saw to whatever X-Forwarded-For the caller sent.
    const inject = (url: string, payload: unknown, chain = "203.0.113.7") =>
      limited.inject({ method: "POST", url, payload: payload as object, headers: { "x-forwarded-for": chain } });
    const good = (await inject("/v1/remote-agents/pairings", {})).json().data.code as string;
    assert.equal((await inject("/v1/remote-agents/pairings", {})).statusCode, 201);
    assert.equal((await inject("/v1/remote-agents/pairings", {})).statusCode, 429, "a third code in a minute");
    // The limit is the person's, whichever route asks (the assistant's devenv_pair calls the same function).
    await assert.rejects(pairing.createPairing("carol", null, new Date(), 2), pairing.PairingRateLimited);
    // An attacker writes the victim's address first; the ingress appends the attacker's own. Their wrong claims fill their own key...
    const forged = "198.51.100.9, 203.0.113.66";
    assert.equal((await inject("/v1/remote-agents/pairings/claim", { code: "x" }, forged)).statusCode, 400);
    assert.equal((await inject("/v1/remote-agents/pairings/claim", { code: "x" }, forged)).statusCode, 400);
    assert.equal((await inject("/v1/remote-agents/pairings/claim", { code: "x" }, forged)).statusCode, 429);
    // ...and never the victim's, whose chain ends with the address the ingress saw for them.
    assert.equal((await inject("/v1/remote-agents/pairings/claim", { code: good }, "198.51.100.9")).statusCode, 201);
    const noServer = Fastify();
    noServer.addHook("preHandler", async (req) => { (req as any).user = { userId: "dave", userName: "dave", platformKey: "", virtualKey: "", roles: ["default"] }; });
    const saved = process.env.CLAW_PUBLIC_URL;
    delete process.env.CLAW_PUBLIC_URL;
    try {
      await registerPairingRoutes(noServer);
      const r = await noServer.inject({ method: "POST", url: "/v1/remote-agents/pairings", payload: {} });
      assert.deepEqual([r.statusCode, r.json().error], [503, "pairing_unavailable"]);
    } finally {
      if (saved !== undefined) process.env.CLAW_PUBLIC_URL = saved;
      await limited.close();
      await noServer.close();
    }
  });

  test("P9 a grant revokes no other machine of the owner's: not by registering under its name, not by renaming itself", async () => {
    // The owner's own machine, signed in otherwise, offline for a long time under the name "workstation".
    const ws = await call("POST", "/v1/remote-agents/connectors", { user: "alice", body: { name: "workstation", version: "0.1.6" } });
    const wsId = ws.body.data.connector_id as string;
    await q("UPDATE claw_remote_connectors SET heartbeat_at = NOW() - interval '1 hour', stream_seen_at = NULL, created_at = NOW() - interval '1 hour' WHERE connector_id = $1", [wsId]);
    const token = (await claim((await newCode("alice")).code)).body.data.token as string;
    const mine = await register(token, "workstation");
    assert.equal(mine.status, 201);
    assert.deepEqual(mine.body.data.replaced ?? [], []);
    assert.equal((await q("SELECT revoked_at FROM claw_remote_connectors WHERE connector_id = $1", [wsId])).rows[0].revoked_at, null,
      "the owner's own workstation is not revoked by a grant taking its name");
    // Bound now: another name is refused, and the grant stays on its row...
    const renamed = await register(token, "x");
    assert.deepEqual([renamed.status, renamed.body.error], [403, "connector_grant_name_mismatch"]);
    const cid = mine.body.data.connector_id as string;
    assert.equal((await heartbeat(token, cid)).status, 200);
    // ...so /agent off on the name the owner was told ends it, registering again included.
    assert.equal((await call("DELETE", `/v1/remote-agents/connectors/${cid}`, { user: "alice" })).status, 200);
    for (const r of [await register(token, "workstation"), await register(token, "x")]) assert.deepEqual([r.status, r.body.error], [401, "revoked"]);
  });

  test("P10 a revocation that lands between the auth check and the registration is honoured in the registration's transaction", async () => {
    const store = await import("../src/remote-agents/store.js");
    const token = (await claim((await newCode("alice")).code)).body.data.token as string;
    const cid = (await register(token)).body.data.connector_id as string;
    const grantId = (await q("SELECT grant_id::text AS id FROM claw_remote_grants")).rows[0].id as string;
    assert.ok(await store.revokeConnector("alice", cid, null));
    await assert.rejects(store.registerConnector("alice", "laptop", "0.1.6", null, 10, "connector_grant", 90_000, undefined, grantId),
      (e: unknown) => e instanceof store.GrantRegistrationRefused && e.reason === "revoked");
    // A bound row that is gone altogether counts as revoked too.
    const t2 = (await claim((await newCode("alice")).code)).body.data.token as string;
    const c2 = (await register(t2, "box")).body.data.connector_id as string;
    await q("DELETE FROM claw_remote_connectors WHERE connector_id = $1", [c2]);
    const r = await register(t2, "box");
    assert.deepEqual([r.status, r.body.error], [401, "revoked"]);
  });

  test("P11 what claims may spend is bounded apart from their keys: the table of callers, and claims at the database at once", async () => {
    const routes = await import("../src/remote-agents/pairing-routes.js");
    const w = routes.failureWindow(1, 3);
    for (let i = 0; i < 10; i++) w.count(`k${i}`, 1_000);
    assert.equal(w.size(), 3, "made-up keys do not grow the table past its bound");
    assert.ok(w.full("k9", 1_000) && !w.full("k0", 1_000), "the oldest went first");
    const gate = new routes.Gate(1, 1);
    assert.equal(await gate.enter(), true);
    let second = false;
    const waiting = gate.enter().then((v) => { second = v; });
    assert.equal(await gate.enter(), false, "beyond the queue: refused (busy), not waited for");
    gate.leave();
    await waiting;
    assert.equal(second, true, "the waiting one goes in when one leaves");
    gate.leave();
    assert.equal(await gate.enter(), true);
  });

  test("P8 codes are read as typed: case, dashes and the letters base32 reads as digits", () => {
    assert.equal(pairing.normalizeCode("abcd-efgh-jkmn"), "ABCDEFGHJKMN");
    assert.equal(pairing.normalizeCode(" ABCD EFGH JKMN "), "ABCDEFGHJKMN");
    assert.equal(pairing.normalizeCode("OOOO-IIII-LLLL"), "000011111111");
    assert.equal(pairing.normalizeCode("ABCD-EFGH-JKMU"), null, "U is not in the alphabet");
    assert.equal(pairing.normalizeCode("ABCD-EFGH"), null);
    assert.equal(pairing.normalizeCode(42), null);
    const seen = new Set(Array.from({ length: 50 }, () => pairing.newCode()));
    assert.equal(seen.size, 50);
    for (const c of seen) assert.equal(pairing.normalizeCode(c), c.replace(/-/g, ""));
  });
});
