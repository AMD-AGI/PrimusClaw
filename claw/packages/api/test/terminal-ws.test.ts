// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * `GET /v1/sessions/:id/terminal/ws`: the WebSocket upgrade, end to end.
 *
 * A real API server, a real browser-side socket, and a stand-in SaFE with a real
 * webshell socket behind it. What is asserted is what each end sees: whether the
 * upgrade was refused and with what status, which credential and query the shell
 * was opened with, the frames that crossed in each direction, and how each side
 * learned the other had gone.
 */
import test, { after, afterEach, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Fastify, { type FastifyInstance } from "fastify";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";

import type { UserInfo } from "../src/auth/models.js";
import { terminalPorts, terminalRegistry, terminalSettings, registerTerminalRoutes } from "../src/routes/terminal.js";
import { terminalTicketsSchemaSql } from "../src/terminal/schema.js";
import { CLOSE_IDLE } from "../src/terminal/proxy.js";
import { mintTicket, type TicketGrant } from "../src/terminal/tickets.js";
import { seedSession, startHarness, type Harness } from "./scenario-harness.js";
import {
  SAFE_KEY, nextClose, nextMessage, openSocket, startFakeSafe, until, withRunningSandbox, type FakeSafe,
} from "./terminal-fixtures.js";

const OWNER: UserInfo = { userId: "u-1", userName: "owner", roles: ["default"], platformKey: SAFE_KEY, virtualKey: "vk-1" };

let h: Harness;
let safe: FakeSafe;
let app: FastifyInstance;
let port = 0;
const pristine = { ...terminalSettings };
const pristinePorts = { ...terminalPorts };
const open: WebSocket[] = [];

const GRANT: TicketGrant = {
  userId: OWNER.userId,
  sessionId: "s1",
  target: { workloadId: "wl-1", workspaceId: "ws-a", pod: "wl-1-pod-0", container: "main" },
  cols: 132,
  rows: 43,
  platformKey: SAFE_KEY,
};

before(async () => {
  h = await startHarness();
  for (const sql of terminalTicketsSchemaSql()) await h.sql(sql);
  safe = await startFakeSafe();
  app = Fastify();
  app.addHook("preHandler", async (req) => { (req as unknown as { user: UserInfo }).user = OWNER; });
  await registerTerminalRoutes(app);
  await app.listen({ port: 0, host: "127.0.0.1" });
  port = (app.server.address() as AddressInfo).port;
});

beforeEach(async () => {
  await h.reset();
  await h.sql("DELETE FROM claw_terminal_tickets");
  Object.assign(terminalSettings, pristine, { safeApiUrl: safe.url });
  Object.assign(terminalPorts, pristinePorts);
  terminalPorts.readBinding = async () => ({ provider: "safe-workload", workloadId: "wl-1" });
  safe.workloads = {};
  safe.list = [];
  safe.containers = {};
  safe.calls.length = 0;
  safe.shells.length = 0;
  safe.refuseShell = null;
  safe.upgradeDelayMs = 0;
  safe.onShell = null;
  safe.key = SAFE_KEY;
  withRunningSandbox(safe);
  await seedSession(h, "s1", { agentStatus: "idle", userId: OWNER.userId });
});

afterEach(async () => {
  for (const ws of open.splice(0)) ws.terminate();
  await until(() => terminalRegistry.size === 0, "every terminal released");
});

after(async () => {
  Object.assign(terminalSettings, pristine);
  Object.assign(terminalPorts, pristinePorts);
  await app?.close();
  await safe?.close();
  await h?.close();
});

const wsUrl = (ticket: string, id = "s1", extra = "") =>
  `ws://127.0.0.1:${port}/v1/sessions/${id}/terminal/ws?ticket=${ticket}${extra}`;

async function connect(ticket: string, id = "s1", extra = ""): Promise<WebSocket> {
  const r = await openSocket(wsUrl(ticket, id, extra));
  if (!("ws" in r)) throw new Error(`upgrade refused with ${r.status}: ${r.body}`);
  open.push(r.ws);
  return r.ws;
}

async function refused(url: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await openSocket(url);
  if ("ws" in r) { r.ws.terminate(); throw new Error("the upgrade was accepted"); }
  return { status: r.status, body: JSON.parse(r.body) as Record<string, unknown> };
}

async function shellOf(): Promise<ReturnType<typeof firstShell>> {
  await until(() => safe.shells.length > 0, "the shell to be opened");
  return firstShell();
}
function firstShell() { return safe.shells[0]; }

test("the shell is opened with the caller's key and a URL built here, not one the browser chose", async () => {
  const ticket = await mintTicket(GRANT);
  // The browser tries to steer the upstream; none of it may arrive.
  await connect(ticket, "s1", "&namespace=evil&container=other&cmd=bash&cols=1&rows=1&pod=x");
  const shell = await shellOf();
  assert.equal(shell.headers.authorization, `Bearer ${SAFE_KEY}`);
  assert.equal(shell.url.pathname, "/api/v1/workloads/wl-1/pods/wl-1-pod-0/webshell");
  assert.deepEqual(Object.fromEntries(shell.url.searchParams), {
    namespace: "ws-a", container: "main", cmd: "sh", cols: "132", rows: "43",
  });
  assert.equal(shell.headers.cookie, undefined, "nothing of the browser's request is forwarded");
});

test("frames cross untouched in both directions, text as text and binary as binary", async () => {
  const ticket = await mintTicket(GRANT);
  const browser = await connect(ticket);
  const shell = await shellOf();

  browser.send("ls -la\n");
  browser.send("RESIZE 100 40");
  browser.send(Buffer.from([0x03, 0x04, 0xff]), { binary: true });
  await until(() => shell.received.length === 3, "three frames at the shell");
  assert.deepEqual(shell.received.map((f) => [f.data.toString("latin1"), f.isBinary]), [
    ["ls -la\n", false],
    ["RESIZE 100 40", false],
    ["\u0003\u0004ÿ", true],
  ]);

  const out = nextMessage(browser);
  shell.socket.send(Buffer.from("total 0\r\n"), { binary: true });
  const got = await out;
  assert.equal(got.isBinary, true);
  assert.equal(got.data.toString(), "total 0\r\n");

  const text = nextMessage(browser);
  shell.socket.send('{"type":"keepalive"}');
  const t = await text;
  assert.equal(t.isBinary, false);
  assert.equal(t.data.toString(), '{"type":"keepalive"}');
});

test("a large burst of output arrives complete and in order", async () => {
  const ticket = await mintTicket(GRANT);
  const browser = await connect(ticket);
  const shell = await shellOf();
  const chunks = 200;
  const size = 16 * 1024;
  let total = 0;
  let order = 0;
  let outOfOrder = false;
  browser.on("message", (data: Buffer) => {
    if (data[0] !== order % 251) outOfOrder = true;
    order += 1;
    total += data.length;
  });
  for (let i = 0; i < chunks; i++) shell.socket.send(Buffer.alloc(size, i % 251), { binary: true });
  await until(() => order === chunks, "every chunk");
  assert.equal(total, chunks * size);
  assert.equal(outOfOrder, false);
});

test("a ticket opens one connection: the second presentation is refused", async () => {
  const ticket = await mintTicket(GRANT);
  await connect(ticket);
  const again = await refused(wsUrl(ticket));
  assert.equal(again.status, 401);
  assert.equal(again.body.error, "invalid_ticket");
  assert.equal(safe.shells.length, 1, "the shell was opened once");
});

test("an expired ticket is refused before any shell is opened", async () => {
  const ticket = await mintTicket(GRANT, -1);
  const res = await refused(wsUrl(ticket));
  assert.equal(res.status, 401);
  assert.equal(safe.shells.length, 0);
  assert.equal(safe.calls.length, 0, "SaFE was never reached");
});

test("a ticket is bound to its session: presented on another it is refused, and spent", async () => {
  await seedSession(h, "s2", { agentStatus: "idle", userId: OWNER.userId });
  const ticket = await mintTicket(GRANT);
  assert.equal((await refused(wsUrl(ticket, "s2"))).status, 401);
  assert.equal((await refused(wsUrl(ticket, "s1"))).status, 401);
  assert.equal(safe.shells.length, 0);
});

test("missing, repeated, malformed and made-up tickets are refused the same way", async () => {
  const real = await mintTicket(GRANT);
  const urls = [
    `ws://127.0.0.1:${port}/v1/sessions/s1/terminal/ws`,
    `ws://127.0.0.1:${port}/v1/sessions/s1/terminal/ws?ticket=`,
    `ws://127.0.0.1:${port}/v1/sessions/s1/terminal/ws?ticket=${real}&ticket=${real}`,
    wsUrl("short"),
    wsUrl("A".repeat(43)),
    wsUrl(`${"A".repeat(42)}%27`),
  ];
  for (const url of urls) {
    const res = await refused(url);
    assert.equal(res.status, 401, url);
    assert.equal(res.body.error, "invalid_ticket", url);
  }
  assert.equal(safe.shells.length, 0);
  // The doubled ticket was refused without being spent.
  await connect(real);
});

test("the ticket is only as good as its owner's claim on the session at the time of the upgrade", async () => {
  // Minted for a user who does not own the session: the ownership is asked again.
  const stranger = await mintTicket({ ...GRANT, userId: "u-2" });
  const res = await refused(wsUrl(stranger));
  assert.equal(res.status, 404);
  assert.equal(safe.shells.length, 0);

  // Deleted between mint and upgrade.
  const ticket = await mintTicket(GRANT);
  await h.sql("UPDATE claw_sessions SET deleted_at = NOW() WHERE session_id = 's1'");
  assert.equal((await refused(wsUrl(ticket))).status, 404);
  assert.equal(safe.shells.length, 0);
});

test("the shell closing closes the browser's socket too, with its code and reason", async () => {
  const ticket = await mintTicket(GRANT);
  const browser = await connect(ticket);
  const shell = await shellOf();
  const closed = nextClose(browser);
  shell.socket.close(1000, "bye");
  assert.deepEqual(await closed, { code: 1000, reason: "bye" });
  await until(() => terminalRegistry.size === 0, "the slot to be released");
});

test("the shell vanishing is a failure to the browser, not a normal close", async () => {
  const ticket = await mintTicket(GRANT);
  const browser = await connect(ticket);
  const shell = await shellOf();
  const closed = nextClose(browser);
  shell.socket.terminate();
  const c = await closed;
  assert.equal(c.code, 1011);
  assert.match(c.reason, /shell|upstream|connection/i);
});

test("the browser closing closes the shell too", async () => {
  const ticket = await mintTicket(GRANT);
  const browser = await connect(ticket);
  const shell = await shellOf();
  browser.close(1000, "done");
  await until(() => shell.closed !== null, "the shell's socket to close");
  assert.equal(shell.closed?.code, 1000);
  await until(() => terminalRegistry.size === 0, "the slot to be released");
});

test("a browser that disappears without closing frees the shell", async () => {
  const ticket = await mintTicket(GRANT);
  const browser = await connect(ticket);
  const shell = await shellOf();
  browser.terminate();
  await until(() => shell.closed !== null, "the shell's socket to close");
  await until(() => terminalRegistry.size === 0, "the slot to be released");
});

test("one user may hold only so many terminals, and closing one makes room", async () => {
  terminalSettings.maxConnectionsPerUser = 2;
  const a = await connect(await mintTicket(GRANT));
  await connect(await mintTicket(GRANT));
  const third = await refused(wsUrl(await mintTicket(GRANT)));
  assert.equal(third.status, 429);
  assert.equal(third.body.error, "too_many_terminals");
  assert.equal(safe.shells.length, 2, "no shell was opened for the refused one");
  // Another user is not held to this user's count.
  await seedSession(h, "s-other", { agentStatus: "idle", userId: "u-9" });
  await connect(await mintTicket({ ...GRANT, userId: "u-9", sessionId: "s-other" }), "s-other");
  a.close(1000);
  await until(() => terminalRegistry.size === 2, "the first terminal to be released");
  await connect(await mintTicket(GRANT));
});

test("the server as a whole holds only so many terminals", async () => {
  terminalSettings.maxConnections = 1;
  await connect(await mintTicket(GRANT));
  await seedSession(h, "s-other", { agentStatus: "idle", userId: "u-9" });
  const res = await refused(wsUrl(await mintTicket({ ...GRANT, userId: "u-9", sessionId: "s-other" }), "s-other"));
  assert.equal(res.status, 503);
  assert.equal(res.body.error, "terminal_capacity");
});

test("a terminal with no traffic is closed after the idle timeout, on both sides", async () => {
  terminalSettings.idleMs = 200;
  const browser = await connect(await mintTicket(GRANT));
  const shell = await shellOf();
  const closed = nextClose(browser);
  const c = await closed;
  assert.equal(c.code, CLOSE_IDLE);
  assert.match(c.reason, /idle/);
  await until(() => shell.closed !== null, "the shell's socket to close");
  assert.equal(shell.closed?.code, CLOSE_IDLE);
  await until(() => terminalRegistry.size === 0, "the slot to be released");
});

test("traffic in either direction keeps a terminal from going idle", async () => {
  terminalSettings.idleMs = 300;
  const browser = await connect(await mintTicket(GRANT));
  const shell = await shellOf();
  let closedEarly = false;
  browser.once("close", () => { closedEarly = true; });
  // 600 ms of a conversation, alternating directions every 100 ms: twice the idle timeout.
  for (let i = 0; i < 6; i++) {
    if (i % 2 === 0) browser.send("x"); else shell.socket.send(Buffer.from("y"), { binary: true });
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(closedEarly, false, "a terminal in use must not be closed as idle");
  assert.equal(browser.readyState, WebSocket.OPEN);
});

test("a shell that cannot be reached is a 502 on the upgrade, and no slot is kept", async () => {
  terminalSettings.safeApiUrl = "http://127.0.0.1:1";
  const res = await refused(wsUrl(await mintTicket(GRANT)));
  assert.equal(res.status, 502);
  assert.equal(res.body.error, "terminal_upstream_unavailable");
  assert.equal(res.body.ok, false);
  assert.equal(terminalRegistry.size, 0);
});

test("a shell that refuses is a 502 that says so, and the refusal's body is not passed on", async () => {
  safe.refuseShell = 403;
  const res = await refused(wsUrl(await mintTicket(GRANT)));
  assert.equal(res.status, 502);
  assert.equal(res.body.error, "terminal_upstream_refused");
  assert.match(String(res.body.reason), /HTTP 403/);
  assert.equal(terminalRegistry.size, 0);

  safe.refuseShell = null;
  safe.key = "rotated";
  const bad = await refused(wsUrl(await mintTicket(GRANT)));
  assert.equal(bad.status, 502);
  assert.equal(bad.body.error, "terminal_upstream_refused");
});

test("a browser that gives up while the shell is being reached leaves no shell and no slot behind", async () => {
  safe.upgradeDelayMs = 300;
  const pending = new WebSocket(wsUrl(await mintTicket(GRANT)));
  pending.on("error", () => {});
  await until(() => terminalRegistry.size === 1, "the slot to be taken while the shell is being reached");
  pending.terminate();
  await until(() => safe.shells.length === 1, "the shell to answer");
  await until(() => safe.shells[0].closed !== null, "the shell that nobody wanted to be closed");
  await until(() => terminalRegistry.size === 0, "the slot to be released");
});

test("the upgrade of any other path is refused rather than left hanging", async () => {
  for (const p of ["/v1/sessions/s1/terminal", "/v1/sessions/s1/terminal/ws/x", "/health", "/v1/sessions/s1/events", "/"]) {
    const res = await refused(`ws://127.0.0.1:${port}${p}`);
    assert.equal(res.status, 404, p);
  }
});

test("shutting the server down closes the open terminals", async () => {
  const other = Fastify();
  other.addHook("preHandler", async (req) => { (req as unknown as { user: UserInfo }).user = OWNER; });
  await registerTerminalRoutes(other);
  await other.listen({ port: 0, host: "127.0.0.1" });
  const p = (other.server.address() as AddressInfo).port;
  const r = await openSocket(`ws://127.0.0.1:${p}/v1/sessions/s1/terminal/ws?ticket=${await mintTicket(GRANT)}`);
  assert.ok("ws" in r);
  const ws = (r as { ws: WebSocket }).ws;
  open.push(ws);
  const shell = await shellOf();
  const closed = nextClose(ws);
  await other.close();
  assert.equal((await closed).code, 1001);
  await until(() => shell.closed !== null, "the shell's socket to close");
});
