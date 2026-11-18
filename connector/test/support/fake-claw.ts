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
  /** The `ready` frame says how often this Claw pings (`ping_ms`), as the real one does; false: a Claw from before that. */
  readyPingMs = true;
  /** Answer the next N event posts with 503. */
  failPosts = 0;
  /** Answer the next N requests, whatever they are, with 503. */
  unavailable = 0;
  /**
   * Claw's identity service is down: every request is answered, in turn, 503 `authentication_service_unavailable` and
   * 401 `invalid_api_key` (an API that could not ask SaFE about a key that is fine), as on 2026-11-07 09:50-10:15Z.
   */
  outage = false;
  /** The answers an outage cycles through. */
  outagePattern: Array<401 | 503> = [503, 401];
  private outageN = 0;
  /** Requests answered 401 during an outage. */
  outageRefusals = 0;
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
  /** Refuse every registration with 409 `connector_limit_reached`, as Claw does once a person has the most connectors allowed. */
  atConnectorLimit = false;
  limitRefusals = 0;
  /** Whether the connector-side `POST .../connectors/:cid/revoke` exists; false is a Claw from before it. */
  revokeRoute = true;
  /** `POST .../terminal-sessions` (approvals asked in a terminal): what was asked, the session each ref got, and the owner's switch. */
  readonly terminalOpens: any[] = [];
  readonly terminalSessions = new Map<string, string>();
  approvalsOff = false;
  /** Every revocation asked of this Claw, by either route, and what was asked with. */
  readonly revocations: Array<{ method: string; id: string; auth: string | undefined }> = [];
  cursor = 0;
  nextSeq = 1;
  /** Sessions closed on Claw's side (the person closed one, or removed the machine): their commands are no longer live. */
  readonly closedSessions = new Set<string>();
  /** What `POST .../commands/:cmd_id/confirm` answers for a command, instead of judging it. */
  readonly commandStatus = new Map<string, string>();
  /** Every confirmation asked, in order, and what was answered. */
  readonly confirmations: Array<{ cmd_id: string; status: string }> = [];
  /** Every confirmation asked, answered or not yet. */
  readonly confirmAsked: string[] = [];
  /** What each confirmation asked was sent with (`why`, `received_late`), in order. */
  readonly confirmBodies: Array<{ cmd_id: string; body: any }> = [];
  /** Whether `POST .../commands/:cmd_id/confirm` exists; false is a Claw from before it (404 from the router, not `not_found`). */
  confirmRoute = true;
  /**
   * The network holds what the next command stream's first frames (its `ready` and the commands sent on connect) carry for this
   * long: they are made (and stamped) at once, and written this much later.
   */
  streamDelayMs = 0;
  /** Whether command frames carry `sent_at`; false is a Claw from before it (and before the confirm route). */
  sentAt = true;
  /** Every frame after the `ready` of the next command stream reaches the connector this much later (a buffering link). */
  streamLagMs = 0;
  /** Answer the next N confirmations with 503 (Claw, or the network to it, not there yet). */
  failConfirms = 0;
  /** Hold every confirmation's answer until `releaseConfirms` (a slow Claw). */
  holdConfirms = false;
  private heldConfirms: Array<() => void> = [];
  releaseConfirms(): void { const h = this.heldConfirms; this.heldConfirms = []; for (const f of h) f(); }
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
    this.commands.push({ seq, payload: { issued_at: Date.now(), ...payload, cmd_id: payload.cmd_id ?? randomUUID(), type, session_id: sessionId, v: 1 } });
    this.wake();
    return seq;
  }

  newSession(agentId: string, cwd: string, mode?: string, extra: Record<string, unknown> = {}): string {
    const id = randomUUID();
    this.issue("session.new", id, { agent_id: agentId, cwd, mode: mode ?? null, ...extra });
    return id;
  }

  /** Cut every command stream's connection (a network drop). */
  dropStreams(): void {
    for (const r of this.streams) r.destroy();
    this.streams.clear();
  }

  /**
   * What a Claw replica does when it shuts down for a release: `event: reconnect` on every command stream, then the
   * end of the response. `hold` keeps the response open after the frame, as a gateway that does not pass the end on.
   */
  restart(opts: { hold?: boolean } = {}): void {
    for (const r of this.streams) {
      try { r.write(`event: reconnect\ndata: ${JSON.stringify({ connector_id: this.connectorId })}\n\n`); if (!opts.hold) r.end(); } catch { /* gone */ }
    }
    if (!opts.hold) this.streams.clear();
  }

  get online(): boolean { return this.streams.size > 0; }

  /** Whether the connector row a client registered last is revoked. */
  get revoked(): boolean { return this.revokedIds.has(this.connectorId); }
  set revoked(v: boolean) { if (v) this.revokedIds.add(this.connectorId); else this.revokedIds.delete(this.connectorId); }

  /**
   * As Claw judges a command a connector asks about: live while held and its session open (`store.commandLiveness`). Claw deletes
   * the acting commands of a session it closes, so it answers `session_closed` for one only when the connector names the session.
   */
  liveness(cmdId: string, sessionId?: unknown): string {
    const set = this.commandStatus.get(cmdId);
    if (set) return set;
    const c = this.commands.find((x) => x.payload.cmd_id === cmdId);
    if (!c || c.seq <= this.cursor) return "gone";
    if (this.closedSessions.has(String(c.payload.session_id)) && c.payload.type !== "close" && c.payload.type !== "cancel") {
      return sessionId === c.payload.session_id ? "session_closed" : "gone";
    }
    return "live";
  }

  revoke(): void {
    this.revoked = true;
    // As on the real server: a revoked connector's sessions close with it.
    for (const c of this.commands) this.closedSessions.add(String(c.payload.session_id));
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
    if (this.outage) {
      if (this.outagePattern[this.outageN++ % this.outagePattern.length] === 503) return this.json(res, 503, { ok: false, error: "authentication_service_unavailable" });
      this.outageRefusals++;
      return this.json(res, 401, { ok: false, error: "invalid_api_key" });
    }
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (!this.tokens.has(token)) return this.json(res, 401, { ok: false, error: "unauthorized" });
    const rv = /^\/v1\/remote-agents\/connectors\/([^/]+)(\/revoke)?$/.exec(path);
    if (rv && (rv[2] ? req.method === "POST" : req.method === "DELETE")) {
      // As on the real server: the user-side DELETE takes a key, and a connector's access token (`access-N`, from
      // FakeIdentity) is no credential there; the connector-side route takes either; a Claw from before that route has none.
      const connectorToken = token.startsWith("access-");
      if ((!rv[2] && connectorToken) || (rv[2] && !this.revokeRoute && connectorToken)) return this.json(res, 401, { ok: false, error: "authentication_required" });
      if (rv[2] && !this.revokeRoute) return this.json(res, 404, { message: `Route POST:${path} not found`, error: "Not Found", statusCode: 404 });
      this.revocations.push({ method: req.method ?? "", id: rv[1]!, auth: req.headers.authorization });
      if (rv[1] !== this.connectorId || this.revoked) return this.json(res, 404, { ok: false, error: "not_found" });
      this.revoke();
      return this.json(res, 200, { ok: true });
    }
    const cf = /^\/v1\/remote-agents\/connectors\/([^/]+)\/commands\/([^/]+)\/confirm$/.exec(path);
    if (cf && req.method === "POST") {
      if (!this.confirmRoute) return this.json(res, 404, { message: `Route POST:${path} not found`, error: "Not Found", statusCode: 404 });
      if (this.failConfirms > 0) { this.failConfirms--; this.confirmAsked.push(decodeURIComponent(cf[2]!)); this.wake(); return this.json(res, 503, { ok: false, error: "unavailable" }); }
      if (this.revokedIds.has(cf[1]!)) return this.json(res, 401, { ok: false, error: "revoked" });
      if (cf[1] !== this.connectorId) return this.json(res, 404, { ok: false, error: "not_found" });
      const cmdId = decodeURIComponent(cf[2]!);
      const body = await this.readBody(req);
      this.confirmBodies.push({ cmd_id: cmdId, body });
      this.confirmAsked.push(cmdId);
      this.wake();
      const answer = () => {
        const status = this.liveness(cmdId, (body as { session_id?: unknown } | null)?.session_id);
        this.confirmations.push({ cmd_id: cmdId, status });
        this.wake();
        try { this.json(res, 200, { ok: true, data: { cmd_id: cmdId, status } }); } catch { /* the connector went */ }
      };
      if (this.holdConfirms) { this.heldConfirms.push(answer); return; }
      return answer();
    }
    const ts = /^\/v1\/remote-agents\/connectors\/([^/]+)\/terminal-sessions$/.exec(path);
    if (ts && req.method === "POST") {
      if (ts[1] !== this.connectorId) return this.json(res, 404, { ok: false, error: "not_found" });
      const body = await this.readBody(req) as any;
      this.terminalOpens.push(body);
      this.wake();
      if (this.approvalsOff) return this.json(res, 409, { ok: false, error: "approvals_off" });
      const known = this.terminalSessions.get(String(body?.ref));
      const sid = known ?? randomUUID();
      this.terminalSessions.set(String(body?.ref), sid);
      return this.json(res, 200, { ok: true, data: { session_id: sid, created: !known } });
    }
    const m = /^\/v1\/remote-agents\/connectors(?:\/([^/]+)\/(heartbeat|events|commands))?$/.exec(path);
    if (!m) return this.json(res, 404, { ok: false, error: "not_found" });
    if (!m[1]) {
      if (req.method === "GET") return this.json(res, 200, { ok: true, data: [] });
      if (this.atConnectorLimit) { this.limitRefusals++; return this.json(res, 409, { ok: false, error: "connector_limit_reached" }); }
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
        const delay = this.streamDelayMs;
        this.streamDelayMs = 0;
        const held: string[] = [];
        let released = delay <= 0;
        const lag = this.streamLagMs;
        this.streamLagMs = 0;
        const out = (chunk: string) => { if (lag > 0) setTimeout(() => { if (!res.destroyed) res.write(chunk); }, lag); else res.write(chunk); };
        let readySent = false;
        const write = (chunk: string) => {
          if (!released) held.push(chunk);
          else if (!readySent) { readySent = true; res.write(chunk); } else out(chunk);
        };
        if (!released) setTimeout(() => { released = true; if (!res.destroyed) for (const c of held) res.write(c); }, delay);
        write(`event: ready\ndata: ${JSON.stringify({ v: 1, connector_id: this.connectorId, server_time: new Date().toISOString(), ...(this.readyPingMs ? { ping_ms: this.pingMs } : {}) })}\n\n`);
        this.streams.add(res);
        res.on("close", () => { this.streams.delete(res); this.wake(); });
        let sent = 0;
        // `sent_at` stamped as the frame is written, as the real server does: how long the frame then takes is the connector's to see.
        const frame = (c: { seq: number; payload: Record<string, unknown> }) => `id: ${c.seq}\nevent: command\ndata: ${JSON.stringify(this.sentAt ? { sent_at: Date.now(), ...c.payload } : c.payload)}\n\n`;
        const pump = () => {
          if (res.destroyed || res.writableEnded) return;
          for (const c of this.commands) {
            if (c.seq <= this.cursor || c.seq <= sent) continue;
            sent = c.seq;
            write(frame(c));
          }
        };
        // Everything still held is sent on every connect, in order; a cursor in the heartbeat is what forgets one.
        for (const c of this.commands) if (c.seq > this.cursor) { sent = c.seq; write(frame(c)); }
        const pinger = setInterval(() => { if (!this.muted) write(`event: ping\ndata: ${JSON.stringify({ t: Date.now() })}\n\n`); }, this.pingMs);
        const poller = setInterval(pump, 10);
        res.on("close", () => { clearInterval(pinger); clearInterval(poller); });
        return;
      }
    }
    return this.json(res, 404, { ok: false, error: "not_found" });
  }
}
