// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A stand-in for the Claw remote-agents API over real HTTP and real SSE. It
 * follows the contract in claw/docs/remote-agents.md (every command still held
 * is sent on every connect; a heartbeat's cmd_cursor forgets commands; events
 * are stored once per (session, seq) and acknowledged by highest seq) and parses
 * every body with the SAME parsers the real server uses, so a request the real
 * server would refuse is refused here.
 */
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { parseEventBatch, parseHeartbeat } from "../../../claw/packages/protocol/src/remote-agents.js";

export interface StoredEvent { session_id: string; seq: number; type: string; ts: number; data: any }

export class FakeClaw {
  url = "";
  tokens = new Set<string>(["good-token"]);
  connectorId = randomUUID();
  registered = 0;
  /** Rows the owner revoked. As on the real server a revoked row stays revoked for good; registering makes a new row. */
  readonly revokedIds = new Set<string>();
  pingMs = 100;
  muted = false;
  /** Answer the next N event posts with 503. */
  failPosts = 0;
  /** Answer the next N requests, whatever they are, with 503. */
  unavailable = 0;
  /** Refuse (name in `rejected`, as the real server does) every event of this type. */
  rejectType: string | null = null;
  /** Store the next N event posts but close the socket before answering (a lost acknowledgement). */
  loseAcks = 0;
  readonly commands: Array<{ seq: number; payload: Record<string, unknown> }> = [];
  readonly stored = new Map<string, Map<number, StoredEvent>>();
  readonly arrivals: StoredEvent[] = [];
  readonly heartbeats: any[] = [];
  readonly requests: Array<{ method: string; path: string; auth: string | undefined; client: string | undefined }> = [];
  readonly streamHeaders: Array<Record<string, string | string[] | undefined>> = [];
  duplicatesSeen = 0;
  cursor = 0;
  nextSeq = 1;
  private readonly streams = new Set<http.ServerResponse>();
  private readonly sockets = new Set<import("node:net").Socket>();
  private server!: http.Server;
  private waker: Array<() => void> = [];

  static async start(opts: Partial<Pick<FakeClaw, "pingMs">> = {}): Promise<FakeClaw> {
    const f = new FakeClaw();
    Object.assign(f, opts);
    f.server = http.createServer((req, res) => void f.handle(req, res));
    f.server.on("connection", (s) => { f.sockets.add(s); s.on("close", () => f.sockets.delete(s)); });
    await new Promise<void>((r) => f.server.listen(0, "127.0.0.1", r));
    f.url = `http://127.0.0.1:${(f.server.address() as AddressInfo).port}/claw-api`;
    return f;
  }

  async close(): Promise<void> {
    for (const r of this.streams) r.destroy();
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  // --- the user side, as tests drive it -----------------------------------------------------

  issue(type: string, sessionId: string, payload: Record<string, unknown> = {}): number {
    const seq = this.nextSeq++;
    this.commands.push({ seq, payload: { ...payload, cmd_id: payload.cmd_id ?? randomUUID(), type, session_id: sessionId, v: 1 } });
    this.wake();
    return seq;
  }

  newSession(agentId: string, cwd: string, mode?: string): string {
    const id = randomUUID();
    this.issue("session.new", id, { agent_id: agentId, cwd, mode: mode ?? null });
    return id;
  }

  /** Cut every command stream's connection (a network drop). */
  dropStreams(): void {
    for (const r of this.streams) r.destroy();
    this.streams.clear();
  }

  get online(): boolean { return this.streams.size > 0; }

  /** Whether the connector row a client registered last is revoked. */
  get revoked(): boolean { return this.revokedIds.has(this.connectorId); }
  set revoked(v: boolean) { if (v) this.revokedIds.add(this.connectorId); else this.revokedIds.delete(this.connectorId); }

  revoke(): void {
    this.revoked = true;
    for (const r of this.streams) { try { r.write(`event: revoked\ndata: {}\n\n`); r.end(); } catch { /* gone */ } }
    this.streams.clear();
  }

  eventsOf(sid: string, type?: string): StoredEvent[] {
    return [...(this.stored.get(sid)?.values() ?? [])].sort((a, b) => a.seq - b.seq).filter((e) => !type || e.type === type);
  }

  async until<T>(what: string, fn: () => T | undefined | false, timeoutMs = 8000): Promise<T> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const v = fn();
      if (v) return v as T;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await new Promise<void>((r) => { const t = setTimeout(r, 20); this.waker.push(() => { clearTimeout(t); r(); }); });
    }
  }

  private wake(): void {
    const w = this.waker; this.waker = [];
    for (const f of w) f();
  }

  // --- HTTP -------------------------------------------------------------------------------

  private json(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  private async readBody(req: http.IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "null"); } catch { return null; }
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname.replace(/^\/claw-api/, "");
    this.requests.push({ method: req.method ?? "", path, auth: req.headers.authorization, client: req.headers["x-claw-client"] as string | undefined });
    if (this.unavailable > 0) { this.unavailable--; return this.json(res, 503, { ok: false, error: "unavailable" }); }
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (!this.tokens.has(token)) return this.json(res, 401, { ok: false, error: "unauthorized" });
    const m = /^\/v1\/remote-agents\/connectors(?:\/([^/]+)\/(heartbeat|events|commands))?$/.exec(path);
    if (!m) return this.json(res, 404, { ok: false, error: "not_found" });
    if (!m[1]) {
      if (req.method === "GET") return this.json(res, 200, { ok: true, data: [] });
      this.registered++;
      if (this.revoked) this.connectorId = randomUUID(); // a revoked row is never reused
      return this.json(res, 201, { ok: true, data: { connector_id: this.connectorId } });
    }
    if (this.revokedIds.has(m[1])) return this.json(res, 401, { ok: false, error: "revoked" });
    if (m[1] !== this.connectorId) return this.json(res, 404, { ok: false, error: "not_found" });
    const body = req.method === "POST" ? await this.readBody(req) : null;
    switch (m[2]) {
      case "heartbeat": {
        const hb = parseHeartbeat(body);
        if (!hb.ok) return this.json(res, 400, { ok: false, error: hb.error });
        this.heartbeats.push(body);
        if (hb.value.cmdCursor !== null) { this.cursor = Math.max(this.cursor, hb.value.cmdCursor); }
        this.wake();
        return this.json(res, 200, { ok: true, data: { server_time: new Date().toISOString(), online_window_ms: 90000 } });
      }
      case "events": {
        if (this.failPosts > 0) { this.failPosts--; return this.json(res, 503, { ok: false, error: "unavailable" }); }
        const batch = parseEventBatch(body);
        if (!batch.ok) return this.json(res, 400, { ok: false, error: batch.error });
        const acked: Record<string, number> = {};
        const refused: Array<{ index: number; session_id: string | null; seq: number | null; reason: string }> = [...batch.value.rejected];
        for (const e of batch.value.events) {
          if (this.rejectType && e.type === this.rejectType) { refused.push({ index: e.index, session_id: e.session_id, seq: e.seq, reason: "invalid_type" }); continue; }
          const per = this.stored.get(e.session_id) ?? new Map<number, StoredEvent>();
          this.stored.set(e.session_id, per);
          this.arrivals.push({ session_id: e.session_id, seq: e.seq, type: e.type, ts: e.ts, data: e.data });
          if (per.has(e.seq)) this.duplicatesSeen++; else per.set(e.seq, { session_id: e.session_id, seq: e.seq, type: e.type, ts: e.ts, data: e.data });
          acked[e.session_id] = Math.max(...per.keys());
        }
        this.wake();
        if (this.loseAcks > 0) { this.loseAcks--; req.socket.destroy(); return; }
        return this.json(res, 200, { ok: true, data: { batch_id: batch.value.batchId, acked, rejected: refused } });
      }
      case "commands": {
        this.streamHeaders.push(req.headers);
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write(`event: ready\ndata: ${JSON.stringify({ v: 1, connector_id: this.connectorId })}\n\n`);
        this.streams.add(res);
        res.on("close", () => { this.streams.delete(res); this.wake(); });
        let sent = 0;
        const pump = () => {
          if (res.destroyed || res.writableEnded) return;
          for (const c of this.commands) {
            if (c.seq <= this.cursor || c.seq <= sent) continue;
            sent = c.seq;
            res.write(`id: ${c.seq}\nevent: command\ndata: ${JSON.stringify(c.payload)}\n\n`);
          }
        };
        // Everything still held is sent on every connect, in order; a cursor in the heartbeat is what forgets one.
        for (const c of this.commands) if (c.seq > this.cursor) { sent = c.seq; res.write(`id: ${c.seq}\nevent: command\ndata: ${JSON.stringify(c.payload)}\n\n`); }
        const pinger = setInterval(() => { if (!this.muted) res.write(`event: ping\ndata: {}\n\n`); }, this.pingMs);
        const poller = setInterval(pump, 10);
        res.on("close", () => { clearInterval(pinger); clearInterval(poller); });
        return;
      }
    }
    return this.json(res, 404, { ok: false, error: "not_found" });
  }
}
