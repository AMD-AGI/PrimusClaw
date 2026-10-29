// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The terminal proxy's own behaviour, below the routes: how two sockets are
 * joined, kept alive, bounded and let go of.
 *
 * Each case builds the same shape on loopback -- a browser socket, the server's
 * side of it, the proxy's socket to a shell, and the shell's side of that -- so
 * a test can misbehave at either end and watch what the other end is told.
 */
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer as createNetServer, type Server as NetServer, type Socket } from "node:net";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";

import {
  bridge, CLOSE_IDLE, CLOSE_MAX_LIFETIME, connectUpstream, relayCode, relayReason, TerminalRegistry, UpstreamConnectError,
  type BridgeOptions,
} from "../src/terminal/proxy.js";
import { nextClose, until } from "./terminal-fixtures.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0)) await c(); });

interface Pair {
  /** What the browser holds. */
  browser: WebSocket;
  /** What the proxy holds towards the browser, and towards the shell. */
  clientSide: WebSocket;
  upstream: WebSocket;
  /** What the shell holds. */
  shell: WebSocket;
}

async function listen(): Promise<{ wss: WebSocketServer; url: string; connections: Promise<WebSocket>[] }> {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1", perMessageDeflate: false });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  const connections: Promise<WebSocket>[] = [];
  const nextConnection = () => new Promise<WebSocket>((r) => wss.once("connection", (ws) => r(ws)));
  connections.push(nextConnection());
  wss.on("connection", () => connections.push(nextConnection()));
  cleanups.push(() => new Promise<void>((r) => { for (const c of wss.clients) c.terminate(); wss.close(() => r()); }));
  return { wss, url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`, connections };
}

async function pair(opts: Partial<BridgeOptions> = {}, browserOpts: { autoPong?: boolean } = {}): Promise<Pair & { end: Promise<string> }> {
  const a = await listen();
  const b = await listen();
  const browser = new WebSocket(a.url, { autoPong: browserOpts.autoPong ?? true, perMessageDeflate: false });
  const upstream = new WebSocket(b.url, { perMessageDeflate: false });
  const [clientSide, shell] = await Promise.all([a.connections[0], b.connections[0]]);
  await Promise.all([
    new Promise<void>((r) => browser.once("open", () => r())),
    new Promise<void>((r) => upstream.once("open", () => r())),
  ]);
  cleanups.push(() => { browser.terminate(); upstream.terminate(); });
  let resolveEnd!: (why: string) => void;
  const end = new Promise<string>((r) => { resolveEnd = r; });
  bridge(clientSide, upstream, { idleMs: 60_000, maxLifetimeMs: 60_000, pingMs: 60_000, ...opts, onEnd: resolveEnd });
  return { browser, clientSide, upstream, shell, end };
}

test("relayCode: a code that may be sent is passed on, one that only reports what was seen is not", () => {
  const cases: [number, number][] = [
    [1000, 1000], [1001, 1001], [1002, 1002], [1003, 1003], [1007, 1007], [1008, 1008], [1011, 1011], [1012, 1012], [1013, 1013], [1014, 1014],
    [3000, 3000], [4000, 4000], [4408, 4408], [4999, 4999],
    [1005, 1000], [1006, 1011], [1015, 1011], [1004, 1011], [1016, 1011], [999, 1011], [2999, 1011], [5000, 1011], [0, 1011],
  ];
  for (const [given, want] of cases) assert.equal(relayCode(given), want, `code ${given}`);
});

test("relayReason: fits a close frame, never splits a character, drops control characters", () => {
  assert.equal(relayReason("bye"), "bye");
  assert.equal(relayReason(Buffer.from("bye")), "bye");
  assert.equal(relayReason("a\u0000b\nc\u007f"), "a b c ");
  const long = relayReason("é".repeat(100));
  assert.ok(Buffer.byteLength(long) <= 123, `${Buffer.byteLength(long)} bytes`);
  assert.equal(long.includes("�"), false, "no character was cut in half");
  assert.equal(long, "é".repeat(61));
  assert.equal(Buffer.byteLength(relayReason("x".repeat(500))), 123);
});

test("a peer that does not answer our close is cut off after the grace period", async () => {
  const p = await pair({ closeGraceMs: 100 });
  // A browser that stops reading never sees the close frame, so it never answers it.
  p.browser.pause();
  p.shell.close(1000, "bye");
  await until(() => p.clientSide.readyState === WebSocket.CLOSED, "the unanswered side to be cut", 2000);
  assert.equal(await p.end, "upstream_closed");
});

test("output faster than the browser reads pauses the shell, and nothing is lost", async () => {
  const p = await pair({ highWaterBytes: 64 * 1024, lowWaterBytes: 16 * 1024 });
  let got = 0;
  p.browser.on("message", (d: Buffer) => { got += d.length; });
  p.browser.pause();
  const chunk = Buffer.alloc(256 * 1024, 7);
  const chunks = 160; // 40 MiB: more than loopback's socket buffers will hold
  for (let i = 0; i < chunks; i++) p.shell.send(chunk, { binary: true });
  await until(() => p.upstream.isPaused, "the shell side to be paused", 5000);
  p.browser.resume();
  await until(() => got === chunks * chunk.length, "every byte to arrive", 20_000);
  await until(() => !p.upstream.isPaused, "the shell side to be resumed", 5000);
});

test("a browser that stops answering pings is let go, and the shell with it", async () => {
  const p = await pair({ pingMs: 50 }, { autoPong: false });
  const closed = nextClose(p.browser);
  const c = await closed;
  assert.equal(c.code, 1011);
  assert.match(c.reason, /stopped answering/);
  await until(() => p.shell.readyState === WebSocket.CLOSED, "the shell's socket to close");
  assert.equal(await p.end, "client_unresponsive");
});

test("a browser that answers pings is not let go", async () => {
  const p = await pair({ pingMs: 40 });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(p.browser.readyState, WebSocket.OPEN);
  assert.equal(p.shell.readyState, WebSocket.OPEN);
});

test("a shell that never stops talking does not keep a terminal the browser has left from going idle", async () => {
  const p = await pair({ idleMs: 300 });
  let seen = 0;
  p.browser.on("message", () => { seen += 1; });
  // What `tail -f` or `top` does: output every 25 ms, for four times the idle timeout.
  const chatter = setInterval(() => {
    if (p.shell.readyState === WebSocket.OPEN) p.shell.send(Buffer.from("line\n"), { binary: true });
  }, 25);
  cleanups.push(() => clearInterval(chatter));
  const closed = nextClose(p.browser);
  const started = Date.now();
  const c = await closed;
  clearInterval(chatter);
  assert.equal(c.code, CLOSE_IDLE);
  assert.ok(Date.now() - started < 1200, `closed after ${Date.now() - started} ms`);
  assert.ok(seen > 3, "the output was still delivered while the terminal was open");
  assert.equal(await p.end, "idle");
});

test("a browser that keeps sending is not idle, and the shell's silence does not make it so", async () => {
  const p = await pair({ idleMs: 300 });
  let closedEarly = false;
  p.browser.once("close", () => { closedEarly = true; });
  for (let i = 0; i < 12; i++) {
    p.browser.send("x");
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(closedEarly, false, "twice the idle timeout of keystrokes, and not a byte back");
  assert.equal(p.browser.readyState, WebSocket.OPEN);
});

test("a terminal ends at its maximum lifetime however busy it is, and says so", async () => {
  const p = await pair({ idleMs: 60_000, maxLifetimeMs: 300 });
  const typing = setInterval(() => {
    if (p.browser.readyState === WebSocket.OPEN) p.browser.send("x");
    if (p.shell.readyState === WebSocket.OPEN) p.shell.send(Buffer.from("y"), { binary: true });
  }, 20);
  cleanups.push(() => clearInterval(typing));
  const closed = nextClose(p.browser);
  const started = Date.now();
  const c = await closed;
  clearInterval(typing);
  assert.equal(c.code, CLOSE_MAX_LIFETIME);
  assert.match(c.reason, /lifetime/);
  assert.ok(Date.now() - started >= 250, "not before its lifetime was up");
  await until(() => p.shell.readyState === WebSocket.CLOSED, "the shell's socket to close");
  assert.equal(await p.end, "max_lifetime");
});

test("a terminal that has ended leaves neither its idle timer nor its lifetime timer running", async () => {
  const a = await listen();
  const b = await listen();
  const browser = new WebSocket(a.url);
  const upstream = new WebSocket(b.url);
  const [clientSide] = await Promise.all([a.connections[0], b.connections[0]]);
  await Promise.all([new Promise((r) => browser.once("open", r)), new Promise((r) => upstream.once("open", r))]);
  cleanups.push(() => { browser.terminate(); upstream.terminate(); });
  // A live timer is a resource the process waits for: eight hours of it per closed terminal.
  const timers = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
  const before = timers();
  const ends: string[] = [];
  bridge(clientSide, upstream, { idleMs: 600_000, maxLifetimeMs: 600_000, pingMs: 600_000, onEnd: (why) => ends.push(why) });
  assert.equal(timers(), before + 3, "idle, lifetime and heartbeat");
  browser.close(1000, "done");
  await until(() => ends.length === 1, "the end");
  await until(() => timers() <= before, "every timer the pair held to be cleared");
  assert.deepEqual(ends, ["client_closed"]);
});

test("however it ends, it ends once", async () => {
  const ends: string[] = [];
  const a = await listen();
  const b = await listen();
  const browser = new WebSocket(a.url);
  const upstream = new WebSocket(b.url);
  const [clientSide, shell] = await Promise.all([a.connections[0], b.connections[0]]);
  await Promise.all([new Promise((r) => browser.once("open", r)), new Promise((r) => upstream.once("open", r))]);
  const handle = bridge(clientSide, upstream, { idleMs: 60_000, maxLifetimeMs: 60_000, pingMs: 60_000, onEnd: (why) => ends.push(why) });
  handle.close(1000, "first", "first");
  handle.close(1000, "second", "second");
  shell.close();
  browser.close();
  await until(() => clientSide.readyState === WebSocket.CLOSED && upstream.readyState === WebSocket.CLOSED, "both to close");
  assert.deepEqual(ends, ["first"]);
});

test("connectUpstream: a shell that never completes the handshake times out", async () => {
  const sockets: Socket[] = [];
  const net: NetServer = createNetServer((s) => { sockets.push(s); });
  await new Promise<void>((r) => net.listen(0, "127.0.0.1", r));
  cleanups.push(() => new Promise<void>((r) => { for (const s of sockets) s.destroy(); net.close(() => r()); }));
  const port = (net.address() as AddressInfo).port;
  const started = Date.now();
  await assert.rejects(
    () => connectUpstream(`ws://127.0.0.1:${port}/x`, { headers: {}, timeoutMs: 150, maxPayload: 1024 }),
    (err: unknown) => err instanceof UpstreamConnectError && err.kind === "timeout",
  );
  assert.ok(Date.now() - started < 2000);
});

test("connectUpstream: an HTTP refusal and a refused connection are told apart", async () => {
  const http: Server = createServer((_req, res) => { res.writeHead(403); res.end("secret-detail"); });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  cleanups.push(() => new Promise<void>((r) => { http.closeAllConnections(); http.close(() => r()); }));
  const port = (http.address() as AddressInfo).port;
  await assert.rejects(
    () => connectUpstream(`ws://127.0.0.1:${port}/x`, { headers: {}, timeoutMs: 1000, maxPayload: 1024 }),
    (err: unknown) => err instanceof UpstreamConnectError && err.kind === "refused" && err.status === 403
      && !err.reason.includes("secret-detail"),
  );
  await assert.rejects(
    () => connectUpstream("ws://127.0.0.1:1/x", { headers: {}, timeoutMs: 1000, maxPayload: 1024 }),
    (err: unknown) => err instanceof UpstreamConnectError && err.kind === "unreachable",
  );
});

test("the registry bounds terminals in total and per user, and a release makes exactly one place", () => {
  const reg = new TerminalRegistry({ maxConnections: 3, maxPerUser: 2 });
  const a1 = reg.acquire("a");
  const a2 = reg.acquire("a");
  assert.ok(a1.ok && a2.ok);
  assert.deepEqual(reg.acquire("a"), { ok: false, reason: "user_limit" });
  const b1 = reg.acquire("b");
  assert.ok(b1.ok);
  assert.deepEqual(reg.acquire("c"), { ok: false, reason: "server_full" });
  assert.equal(reg.size, 3);
  if (a1.ok) { a1.release(); a1.release(); a1.release(); }
  assert.equal(reg.size, 2, "releasing the same terminal again frees nothing more");
  assert.ok(reg.acquire("c").ok);
  assert.deepEqual(reg.acquire("c").ok, false);
  // Raising a limit takes effect on the next acquire.
  reg.setLimits({ maxConnections: 10, maxPerUser: 10 });
  assert.ok(reg.acquire("a").ok);
});

test("releasing a terminal again gives back no more than its one place to its user", () => {
  const reg = new TerminalRegistry({ maxConnections: 10, maxPerUser: 2 });
  const a1 = reg.acquire("a");
  const a2 = reg.acquire("a");
  assert.ok(a1.ok && a2.ok);
  if (a1.ok) { a1.release(); a1.release(); a1.release(); }
  // a2 is still open, so the user has one place left and not two.
  assert.ok(reg.acquire("a").ok, "the one released place is free again");
  assert.deepEqual(reg.acquire("a"), { ok: false, reason: "user_limit" });
});

test("the registry closes every open terminal on shutdown", () => {
  const reg = new TerminalRegistry({ maxConnections: 5, maxPerUser: 5 });
  const closed: string[] = [];
  for (const u of ["a", "b", "a"]) {
    const s = reg.acquire(u);
    assert.ok(s.ok);
    if (s.ok) s.lease.closeNow = (code, reason) => closed.push(`${u}:${code}:${reason}`);
  }
  reg.closeAll(1001, "bye");
  assert.deepEqual(closed.sort(), ["a:1001:bye", "a:1001:bye", "b:1001:bye"]);
});
