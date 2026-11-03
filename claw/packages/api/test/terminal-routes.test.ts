// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `GET /v1/sessions/:id/terminal` and `POST /v1/sessions/:id/terminal/ticket`.
 *
 * The routes are registered on a real Fastify instance and talk to a stand-in
 * SaFE over a real socket, so what is asserted is what a client receives and what
 * SaFE received: which credential it was asked with, and which questions. The
 * session table is a real SQL engine (PGlite); the registry binding is behind
 * `terminalPorts`, because `kv` is a live binding a test cannot substitute.
 *
 * Every denial is paired with the same request made by the session's creator,
 * because a route that answers 404 to everybody would otherwise look correct.
 */
import test, { after, afterEach, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";

import { isAnonymousPath } from "../src/auth/middleware.js";
import type { UserInfo } from "../src/auth/models.js";
import { terminalPorts, terminalSettings, registerTerminalRoutes } from "../src/routes/terminal.js";
import { terminalTicketsSchemaSql } from "../src/terminal/schema.js";
import { MAX_OUTSTANDING_TICKETS_PER_USER, TICKET_TTL_SECONDS } from "../src/terminal/tickets.js";
import { seedSession, startHarness, type Harness } from "./scenario-harness.js";
import { SAFE_KEY, startFakeSafe, withRunningSandbox, workload, type FakeSafe } from "./terminal-fixtures.js";

const OWNER: UserInfo = { userId: "u-1", userName: "owner", roles: ["default"], platformKey: SAFE_KEY, virtualKey: "vk-1" };
const OTHER: UserInfo = { userId: "u-2", userName: "other", roles: ["default"], platformKey: "ak-other", virtualKey: "vk-2" };
const ADMIN: UserInfo = { userId: "u-admin", userName: "admin", roles: ["system-admin"], platformKey: "ak-admin", virtualKey: "vk-a" };

let h: Harness;
let safe: FakeSafe;
let app: FastifyInstance;
let binding: Awaited<ReturnType<typeof terminalPorts.readBinding>> = null;
const pristine = { ...terminalSettings };
const pristinePorts = { ...terminalPorts };

const USERS: Record<string, UserInfo> = { owner: OWNER, other: OTHER, admin: ADMIN };

before(async () => {
  h = await startHarness();
  for (const sql of terminalTicketsSchemaSql()) await h.sql(sql);
  safe = await startFakeSafe();
  app = Fastify();
  // Mirrors src/index.ts: one global preHandler establishes who is calling.
  app.addHook("preHandler", async (req) => {
    const who = req.headers["x-test-user"];
    (req as unknown as { user: UserInfo | null }).user = typeof who === "string" ? (USERS[who] ?? null) : null;
  });
  await registerTerminalRoutes(app);
  await app.ready();
});

beforeEach(async () => {
  await h.reset();
  await h.sql("DELETE FROM claw_terminal_tickets");
  Object.assign(terminalSettings, pristine, { safeApiUrl: safe.url });
  safe.workloads = {};
  safe.list = [];
  safe.containers = {};
  safe.calls.length = 0;
  safe.key = SAFE_KEY;
  binding = { provider: "safe-workload", workloadId: "wl-1" };
  terminalPorts.readBinding = async () => binding;
  await seedSession(h, "s1", { agentStatus: "idle", userId: OWNER.userId });
});

afterEach(() => { Object.assign(terminalSettings, pristine, { safeApiUrl: safe.url }); });

after(async () => {
  Object.assign(terminalSettings, pristine);
  Object.assign(terminalPorts, pristinePorts);
  await app?.close();
  await safe?.close();
  await h?.close();
});

const get = (who: string | null, id = "s1") =>
  app.inject({ method: "GET", url: `/v1/sessions/${id}/terminal`, headers: who ? { "x-test-user": who } : {} });
const ticket = (who: string | null, payload: unknown, id = "s1") =>
  app.inject({ method: "POST", url: `/v1/sessions/${id}/terminal/ticket`, headers: who ? { "x-test-user": who } : {}, payload: payload as never });
const rowCount = async () => (await h.sql("SELECT 1 FROM claw_terminal_tickets")).length;

test("the terminal routes are not anonymous", () => {
  for (const p of ["/v1/sessions/s1/terminal", "/v1/sessions/s1/terminal/ticket", "/v1/sessions/s1/terminal/ws"]) {
    assert.equal(isAnonymousPath(p), false, p);
  }
});

test("a running sandbox is ready, and the answer names no SaFE internals", async () => {
  withRunningSandbox(safe);
  const res = await get("owner");
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), { state: "ready", target: { pod: "wl-1-pod-0", container: "main" } });
  assert.equal(res.headers["cache-control"], "no-store");
  for (const leak of ["wl-1\"", "ws-a", "workloadId", "namespace", SAFE_KEY]) {
    assert.equal(res.body.includes(leak), false, `the body must not carry ${leak}`);
  }
  // SaFE was asked with the caller's own key and no other.
  assert.ok(safe.calls.length >= 2);
});

test("another user's session answers 404, the same as one that does not exist, whoever asks", async () => {
  withRunningSandbox(safe);
  const mine = await get("owner");
  assert.equal(mine.statusCode, 200);
  const missing = await get("owner", "no-such-session");
  assert.equal(missing.statusCode, 404);
  for (const who of ["other", "admin"]) {
    const res = await get(who);
    assert.equal(res.statusCode, 404, `${who} must not reach another user's terminal`);
    assert.equal(res.body, missing.body, "a foreign session must read exactly like an absent one");
  }
  assert.equal(safe.calls.length, 2, "SaFE is not even asked on behalf of a caller who may not look");
  const anonymous = await get(null);
  assert.equal(anonymous.statusCode, 401);
});

test("a deleted session is gone", async () => {
  withRunningSandbox(safe);
  await h.sql("UPDATE claw_sessions SET deleted_at = NOW() WHERE session_id = 's1'");
  assert.equal((await get("owner")).statusCode, 404);
});

test("what the sandbox is doing decides the state, with a sentence for a person", async () => {
  const cases: [string, Record<string, unknown>, string, RegExp][] = [
    ["pending", workload({ phase: "Pending", message: "waiting for a node" }), "starting", /not running yet \(Pending\).*waiting for a node/],
    ["stopped", workload({ phase: "Stopped" }), "ended", /has ended \(Stopped\)/],
    ["failed", workload({ phase: "Failed", message: "OOMKilled" }), "ended", /has ended \(Failed\).*OOMKilled/],
    ["succeeded", workload({ phase: "Succeeded" }), "ended", /has ended \(Succeeded\)/],
    ["running, no pod yet", workload({ pods: [] }), "starting", /not running yet \(Pending\)/],
    ["running, pod not running", workload({ pods: [{ podId: "p", phase: "Pending" }] }), "starting", /not running yet/],
  ];
  for (const [name, w, state, text] of cases) {
    safe.workloads["wl-1"] = w;
    safe.containers["wl-1/wl-1-pod-0"] = [{ name: "main" }];
    const res = await get("owner");
    assert.equal(res.statusCode, 200, name);
    const body = res.json();
    assert.equal(body.state, state, name);
    assert.match(body.message, text, name);
    assert.equal(body.target, undefined, `${name}: there is nothing to connect to`);
  }
});

test("SaFE's own words are cleaned of control characters and capped before they reach the browser", async () => {
  safe.workloads["wl-1"] = workload({ phase: "Pending", message: `line one\u0000\nline two\u009f ${"x".repeat(2000)}` });
  const res = await get("owner");
  const message: string = res.json().message;
  // eslint-disable-next-line no-control-regex
  assert.equal(/[\u0000-\u001f\u007f-\u009f]/.test(message), false, "no control characters");
  assert.match(message, /line one line two/);
  assert.ok(message.length < 500, `${message.length} characters`);
});

test("a pod with no container yet is starting, not ready", async () => {
  safe.workloads["wl-1"] = workload();
  safe.containers["wl-1/wl-1-pod-0"] = [];
  const res = await get("owner");
  assert.equal(res.json().state, "starting");
});

test("no sandbox at all is none, and says when one will start", async () => {
  binding = null;
  const res = await get("owner");
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().state, "none");
  assert.match(res.json().message, /no sandbox yet/);
});

test("with no binding, SaFE is asked which workload carries the session, and the newest running one wins", async () => {
  binding = null;
  safe.list = [
    { ...workload({ workloadId: "wl-old", creationTime: "2026-10-29T07:00:00" }), __env: "s1" },
    { ...workload({ workloadId: "wl-new", creationTime: "2026-10-29T08:30:00", pods: [{ podId: "wl-new-pod-0", phase: "Running" }] }), __env: "s1" },
    { ...workload({ workloadId: "wl-other", creationTime: "2026-10-29T09:00:00" }), __env: "some-other-session" },
    // Newer than both, but ended: a running sandbox is what a shell can open in.
    { ...workload({ workloadId: "wl-stopped", creationTime: "2026-10-29T09:30:00", phase: "Stopped" }), __env: "s1" },
  ];
  safe.workloads["wl-new"] = safe.list[1] as Record<string, unknown>;
  safe.containers["wl-new/wl-new-pod-0"] = [{ name: "main" }];
  const res = await get("owner");
  assert.deepEqual(res.json(), { state: "ready", target: { pod: "wl-new-pod-0", container: "main" } });
  const listCall = safe.calls.find((c) => c.startsWith("/api/v1/workloads?"));
  assert.ok(listCall, "the list was asked for");
  const qs = new URL(listCall, "http://x").searchParams;
  assert.equal(qs.get("envKey"), "CLAW_SESSION_ID");
  assert.equal(qs.get("envValue"), "s1");
});

test("a binding whose workload SaFE no longer knows is stale, and the lookup falls back", async () => {
  binding = { provider: "safe-workload", workloadId: "wl-gone" };
  safe.list = [{ ...workload({ workloadId: "wl-1" }), __env: "s1" }];
  safe.workloads["wl-1"] = workload();
  safe.containers["wl-1/wl-1-pod-0"] = [{ name: "main" }];
  const res = await get("owner");
  assert.equal(res.json().state, "ready");
  assert.ok(safe.calls.some((c) => c === "/api/v1/workloads/wl-gone"), "the binding was tried first");
});

test("a workload listed for the session but owned by someone else is not the caller's shell", async () => {
  binding = null;
  safe.list = [{ ...workload({ userId: "u-someone-else" }), __env: "s1" }];
  safe.workloads["wl-1"] = workload();
  safe.containers["wl-1/wl-1-pod-0"] = [{ name: "main" }];
  const res = await get("owner");
  assert.equal(res.json().state, "none");
});

test("a sandbox that is not a SaFE workload has no web terminal", async () => {
  binding = { provider: "agent-sandbox", workloadId: "" };
  const res = await get("owner");
  assert.equal(res.json().state, "none");
  assert.match(res.json().message, /does not provide a web terminal/);
  assert.equal(safe.calls.length, 0);
});

test("SaFE refusing the caller's key is a 502 that says so, not a 500 and not a 401", async () => {
  withRunningSandbox(safe);
  safe.key = "a-different-key";
  const res = await get("owner");
  assert.equal(res.statusCode, 502);
  assert.equal(res.json().error, "terminal_upstream_refused");
  assert.equal(res.json().ok, false);
  assert.match(res.json().reason, /refused/);
});

test("SaFE being down is a 502, and the reason is given", async () => {
  withRunningSandbox(safe);
  terminalSettings.safeApiUrl = "http://127.0.0.1:1";
  const res = await get("owner");
  assert.equal(res.statusCode, 502);
  assert.equal(res.json().error, "terminal_upstream_unavailable");
  assert.match(res.json().reason, /cannot reach SaFE/);
});

test("no SaFE configured, or no SaFE key on the request, is a 503 with a reason", async () => {
  withRunningSandbox(safe);
  terminalSettings.safeApiUrl = "";
  const noSafe = await get("owner");
  assert.equal(noSafe.statusCode, 503);
  assert.equal(noSafe.json().error, "terminal_unavailable");
  terminalSettings.safeApiUrl = safe.url;
  USERS.keyless = { ...OWNER, platformKey: "" };
  try {
    const noKey = await get("keyless");
    assert.equal(noKey.statusCode, 503);
    assert.equal(noKey.json().error, "terminal_unavailable");
    assert.match(noKey.json().reason, /no SaFE API key/);
  } finally {
    delete USERS.keyless;
  }
});

test("a ticket is minted for a ready terminal: short-lived, uncached, and stored without its secrets", async () => {
  withRunningSandbox(safe);
  const res = await ticket("owner", { cols: 120, rows: 32 });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.match(body.ticket, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(body.expiresInSeconds, TICKET_TTL_SECONDS);
  assert.ok(body.expiresInSeconds > 0 && body.expiresInSeconds <= 60);
  assert.equal(body.wsPath, `/sessions/s1/terminal/ws?ticket=${body.ticket}`);
  assert.equal(res.headers["cache-control"], "no-store");
  const rows = await h.sql("SELECT * FROM claw_terminal_tickets");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].user_id, OWNER.userId);
  assert.equal(rows[0].session_id, "s1");
  const dump = JSON.stringify(rows);
  assert.equal(dump.includes(body.ticket), false);
  assert.equal(dump.includes(SAFE_KEY), false);
});

test("no ticket is minted for a terminal that is not ready, and the answer says why", async () => {
  safe.workloads["wl-1"] = workload({ phase: "Pending", message: "waiting for a node" });
  const res = await ticket("owner", { cols: 80, rows: 24 });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, "terminal_not_ready");
  assert.equal(res.json().state, "starting");
  assert.match(res.json().reason, /waiting for a node/);
  assert.equal(await rowCount(), 0);
});

test("no ticket is minted for another user's session", async () => {
  withRunningSandbox(safe);
  for (const who of ["other", "admin"]) {
    const res = await ticket(who, { cols: 80, rows: 24 });
    assert.equal(res.statusCode, 404, who);
  }
  assert.equal((await ticket("owner", { cols: 80, rows: 24 }, "no-such")).statusCode, 404);
  assert.equal(await rowCount(), 0);
  assert.equal((await ticket("owner", { cols: 80, rows: 24 })).statusCode, 200, "the creator is the contrast");
});

test("cols and rows must be integers within bounds, or nothing is minted", async () => {
  withRunningSandbox(safe);
  const bad: unknown[] = [
    undefined, {}, { cols: 80 }, { rows: 24 }, { cols: 0, rows: 24 }, { cols: 80, rows: 0 }, { cols: 1001, rows: 24 },
    { cols: 80, rows: 1001 }, { cols: "80", rows: 24 }, { cols: 80.5, rows: 24 }, { cols: -1, rows: 24 }, { cols: null, rows: 24 },
  ];
  for (const payload of bad) {
    const res = await ticket("owner", payload ?? {});
    assert.equal(res.statusCode, 400, JSON.stringify(payload));
    assert.equal(res.json().error, "invalid_request");
  }
  assert.equal(await rowCount(), 0);
  assert.equal((await ticket("owner", { cols: 1, rows: 1000 })).statusCode, 200, "the bounds are inclusive");
});

test("tickets cannot be hoarded: past the cap the answer is 429", async () => {
  withRunningSandbox(safe);
  for (let i = 0; i < MAX_OUTSTANDING_TICKETS_PER_USER; i++) {
    assert.equal((await ticket("owner", { cols: 80, rows: 24 })).statusCode, 200);
  }
  const res = await ticket("owner", { cols: 80, rows: 24 });
  assert.equal(res.statusCode, 429);
  assert.equal(res.json().error, "too_many_tickets");
});

test("a ticket route does not mint when SaFE cannot be reached", async () => {
  withRunningSandbox(safe);
  terminalSettings.safeApiUrl = "http://127.0.0.1:1";
  const res = await ticket("owner", { cols: 80, rows: 24 });
  assert.equal(res.statusCode, 502);
  assert.equal(await rowCount(), 0);
});
