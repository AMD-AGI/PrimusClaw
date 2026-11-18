// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A Claw remote-agents server in memory, as `claw/docs/remote-agents.md` describes its user side, spoken over real HTTP and real
 * server-sent events so the agent's Claw client is exercised as it is in production: owner isolation by bearer key, `404
 * not_found` for anything that is not the caller's, `409 connector_offline` for a prompt to an offline machine, `Idempotency-Key`,
 * decisions checked against the options the agent offered, events in the frame format `id: N / event: type / data: {type,
 * session_id, seq, ts, data}` with `?after=`, a `historyComplete` marker and `: keepalive` comments.
 *
 * The agent side is not simulated: a test says what the agent does, by emitting events (`say`, `think`, `tool`, `ask`, `end`)
 * from its `onCommand` hook or directly, which is exactly what a connector posts.
 */
import { randomUUID } from "node:crypto";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";

import {
  type ConnectorOptions,
  type Failure,
  type FakeCommand,
  type FakeConnector,
  type FakeEvent,
  type FakeSession,
  type Json,
  KEYS,
  MAX_ACTIVE_SESSIONS,
  PREFIX,
  type PermissionOption,
  type StartedOptions,
  UPGRADE,
} from "./remote-fake-data.js";

import {
  type Reply,
  notARoute,
  numberParam,
  open,
  publicOf,
  readJson,
  refuse,
  reply,
  send,
} from "./remote-fake-http.js";
import { own } from "../packages/core/src/own.js";

export * from "./remote-fake-data.js";

export type CommandHook = (server: FakeRemote, command: FakeCommand) => Promise<void> | void;

export class FakeRemote {
  readonly connectors = new Map<string, FakeConnector>();
  readonly sessions = new Map<string, FakeSession>();
  readonly events = new Map<string, FakeEvent[]>();
  /** Every accepted command. */
  readonly commands: FakeCommand[] = [];
  /** (method, path, user): everything the agent asked. */
  readonly calls: [string, string, string][] = [];
  /** The bearer key of every call. */
  readonly keysSeen: string[] = [];
  readonly clientLabels: string[] = [];
  onCommand: CommandHook | null = null;
  readonly fail = new Map<string, Failure>();
  enabled = true;
  /** A Claw with `POST /pairings` (off: one from before it, which answers 404). */
  pairing = false;
  /** The user of every pairing code handed out. */
  readonly pairings: string[] = [];
  /** Fields that replace the pairing answer's (an answer of an unexpected shape). */
  pairAnswer: Json | null = null;
  /** What GET .../setup answers; null: 404, as a Claw from before that route. */
  setup: Json | null = null;
  /** Close the next event stream after this many frames (a dropped connection). */
  dropStreamAfter: number | null = null;
  /** (session, after) of every event stream opened. */
  readonly streamOpens: { session_id: string; after: number }[] = [];
  url = "";

  private nextEvent = 0;
  private version = 0;
  private waiters: (() => void)[] = [];
  private readonly idem = new Map<string, Json>();
  private server: Server | null = null;
  private readonly open = new Set<ServerResponse>();

  /** Inject a failure: `method` requests whose path ends with `suffix` are answered `failure`. */
  failOn(method: string, suffix: string, failure: Failure): void {
    this.fail.set(`${method} ${suffix}`, failure);
  }

  // --- the server ---------------------------------------------------------------------------------------------------

  async start(): Promise<string> {
    const server = createServer((req, res) => {
      void this.serve(req, res);
    });
    this.server = server;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${String(port)}`;
    return this.url;
  }

  async stop(): Promise<void> {
    this.wake();
    for (const res of this.open) res.destroy();
    const server = this.server;
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
  }

  private async serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://fake");
    const method = req.method ?? "GET";
    const key = (req.headers.authorization ?? "").replace(/^Bearer /u, "");
    const user = own(KEYS, key);
    this.keysSeen.push(key);
    this.calls.push([method, url.pathname, user ?? "?"]);
    const label = req.headers["x-claw-client"];
    this.clientLabels.push(typeof label === "string" ? label : "");
    const body = await readJson(req);
    const early = this.gate(method, url.pathname, user);
    if (early || user === undefined) {
      send(res, early ?? refuse(401, "unauthorized"));
      return;
    }
    if (
      method === "GET" &&
      /\/sessions\/[^/]+\/events$/u.test(url.pathname) &&
      url.searchParams.get("mode") !== "replay"
    ) {
      this.stream(res, user, url);
      return;
    }
    const idem = req.headers["idempotency-key"];
    send(
      res,
      await this.route({
        method,
        url,
        user,
        body,
        idem: typeof idem === "string" ? idem : null,
      }),
    );
  }

  /** What answers before any route: remote agents off, or an injected failure. */
  private gate(method: string, path: string, user: string | undefined): Reply | null {
    if (!this.enabled) return notARoute(method, path);
    for (const [where, failure] of this.fail) {
      const [m, suffix] = [where.slice(0, where.indexOf(" ")), where.slice(where.indexOf(" ") + 1)];
      if (method === m && path.endsWith(suffix)) {
        const [status, error] = typeof failure === "number" ? [failure, "injected"] : failure;
        return refuse(status, error);
      }
    }
    return user === undefined ? refuse(401, "unauthorized") : null;
  }

  /** The answer to one request of the user side (`ROUTES`). */
  private async route(req: RouteRequest): Promise<Reply> {
    for (const [method, pattern, handle] of ROUTES) {
      const match = req.method === method ? pattern.exec(req.url.pathname) : null;
      if (match) return handle(this, req, match[1] ?? "");
    }
    return notARoute(req.method, req.url.pathname);
  }

  /** What GET .../setup answers. */
  setupAnswer(path: string): Reply {
    return this.setup === null ? notARoute("GET", path) : reply(200, { ok: true, data: this.setup });
  }

  // --- state helpers a test uses -----------------------------------------------------------------------------------

  /** A machine of `owner`'s with `agents` as [agent_id, kind, name]. */
  addConnector(
    owner: string,
    name: string,
    agents: readonly (readonly [string, string, string])[],
    options: ConnectorOptions = {},
  ): string {
    const cid = randomUUID();
    this.connectors.set(cid, {
      connector_id: cid,
      owner,
      name,
      online: options.online ?? true,
      revoked: false,
      version: options.version ?? "0.1.4",
      version_status: options.versionStatus ?? "current",
      last_seen_at: options.lastSeenAt ?? null,
      paired: options.paired ?? null,
      agents: agents.map(([a, k, n]) => ({
        agent_id: a,
        kind: k,
        name: n,
        capabilities: { ...(options.caps ? (own(options.caps, a) ?? {}) : {}) },
      })),
    });
    return cid;
  }

  addSession(
    owner: string,
    cid: string,
    agentId: string,
    options: { cwd?: string; status?: string; sid?: string } = {},
  ): string {
    const sid = options.sid ?? randomUUID();
    this.sessions.set(sid, {
      session_id: sid,
      owner,
      connector_id: cid,
      agent_id: agentId,
      cwd: options.cwd ?? "/home/me/repo",
      mode: null,
      status: options.status ?? "active",
      created_at: "2026-10-29T06:00:00.000Z",
      updated_at: "2026-10-29T06:00:00.000Z",
    });
    this.events.set(sid, []);
    return sid;
  }

  connector(cid: string): FakeConnector {
    const c = this.connectors.get(cid);
    if (!c) throw new Error(`no connector ${cid}`);
    return c;
  }

  session(sid: string): FakeSession {
    const s = this.sessions.get(sid);
    if (!s) throw new Error(`no session ${sid}`);
    return s;
  }

  /** What a connector posts: one event of the session, stored with the next id and seq. */
  emit(sid: string, type: string, data: Json = {}): Promise<number> {
    this.nextEvent += 1;
    const rows = this.events.get(sid) ?? [];
    this.events.set(sid, rows);
    rows.push({
      id: this.nextEvent,
      seq: rows.length + 1,
      type,
      ts: 1_761_700_000_000 + rows.length,
      data,
    });
    this.version += 1;
    this.wake();
    return Promise.resolve(this.nextEvent);
  }

  // The ACP session/update shapes (`data` is the update's params as the agent sent them).
  acp(sid: string, updateType: string, fields: Json): Promise<number> {
    return this.emit(sid, updateType, {
      sessionId: "acp-1",
      update: { sessionUpdate: updateType, ...fields },
    });
  }

  say(sid: string, text: string): Promise<number> {
    return this.acp(sid, "agent_message_chunk", {
      content: { type: "text", text },
    });
  }

  think(sid: string, text: string): Promise<number> {
    return this.acp(sid, "agent_thought_chunk", {
      content: { type: "text", text },
    });
  }

  tool(sid: string, callId: string, title: string, status = "pending", kind = "execute"): Promise<number> {
    const name = status === "pending" ? "tool_call" : "tool_call_update";
    return this.acp(sid, name, { toolCallId: callId, title, kind, status });
  }

  ask(
    sid: string,
    actionId: string,
    tool: string,
    options: readonly PermissionOption[],
    extra: { kind?: string; input?: Json; timeoutMs?: number | null } = {},
  ): Promise<number> {
    const data: Json = {
      actionId,
      tool,
      kind: extra.kind ?? "edit",
      input: extra.input ?? {},
      options,
    };
    const timeout = extra.timeoutMs === undefined ? 600_000 : extra.timeoutMs;
    if (timeout !== null) data.timeout_ms = timeout;
    return this.emit(sid, "permissionRequest", data);
  }

  end(sid: string, reason = "end_turn"): Promise<number> {
    return this.emit(sid, "turn_end", { stopReason: reason });
  }

  /**
   * `session_started` as the connector posts it: `data.unattended` says whether the session, as it is now, does not ask;
   * `data.modes[].unattended` says it per mode. Both are left out when null / not in `flags`, as an older connector does.
   */
  started(sid: string, options: StartedOptions = {}): Promise<number> {
    const flags = options.flags ?? null;
    const data: Json = {
      acp_session_id: "acp-1",
      currentMode: options.mode ?? "default",
      modes: (options.modes ?? ["default", "plan", "acceptEdits"]).map((m) => ({
        id: m,
        name: m,
        ...(flags && Object.hasOwn(flags, m) ? { unattended: own(flags, m) } : {}),
      })),
    };
    if (options.unattended !== undefined && options.unattended !== null) data.unattended = options.unattended;
    return this.emit(sid, "session_started", data);
  }

  commandsOf(type: string): FakeCommand[] {
    return this.commands.filter((c) => c.type === type);
  }

  // --- routes ------------------------------------------------------------------------------------------------------

  private mine(user: string, sid: string): FakeSession | undefined {
    const row = this.sessions.get(sid);
    return row && row.owner === user ? row : undefined;
  }

  listConnectors(user: string): Reply {
    const out = [...this.connectors.values()]
      .filter((c) => c.owner === user && !c.revoked)
      .map((c) => ({
        connector_id: c.connector_id,
        name: c.name,
        version: c.version,
        online: c.online,
        version_status: c.version_status,
        ...(c.version_status === "outdated" || c.version_status === "unsupported" ? { upgrade_command: UPGRADE } : {}),
        ...(c.last_seen_at ? { last_seen_at: c.last_seen_at } : {}),
        ...(c.paired !== null ? { paired: c.paired } : {}),
        agents: c.agents,
      }));
    return reply(200, { ok: true, data: out });
  }

  pair(user: string, method: string, path: string): Reply {
    if (!this.pairing) return notARoute(method, path);
    this.pairings.push(user);
    const code = `ABCD-EFGH-${String(this.pairings.length).padStart(4, "0")}`;
    const data = {
      code,
      expires_at: "2026-11-07T00:10:00Z",
      expires_in: 600,
      server: this.url,
      command: `npm install -g --no-update-notifier @primusclaw/connector@latest && claw-connector pair ${code} --server ${this.url}`,
      ...(this.pairAnswer ?? {}),
    };
    return reply(201, { ok: true, data });
  }

  revoke(user: string, cid: string): Reply {
    const c = this.connectors.get(cid);
    if (!c || c.owner !== user || c.revoked) return refuse(404, "not_found");
    c.revoked = true;
    for (const s of this.sessions.values()) if (s.connector_id === c.connector_id) s.status = "closed";
    return reply(200, { ok: true });
  }

  async createSession(user: string, body: Json): Promise<Reply> {
    const c = this.connectors.get(String(body.connector_id));
    if (!c || c.owner !== user || c.revoked) return refuse(404, "not_found");
    if (!c.agents.some((a) => a.agent_id === body.agent_id)) return refuse(404, "agent_not_found");
    if (!c.online) return refuse(409, "connector_offline");
    if (c.version_status === "unsupported") return refuse(409, "connector_outdated");
    const active = [...this.sessions.values()].filter((s) => s.owner === user && s.status === "active");
    if (active.length >= MAX_ACTIVE_SESSIONS) return refuse(409, "session_limit_reached");
    const sid = this.addSession(user, c.connector_id, String(body.agent_id), {
      cwd: typeof body.cwd === "string" ? body.cwd : "",
    });
    await this.hook({ user, session_id: sid, type: "session.new", body });
    return reply(201, { ok: true, data: publicOf(this.session(sid)) });
  }

  listSessions(user: string): Reply {
    return reply(200, {
      ok: true,
      data: [...this.sessions.values()].filter((s) => s.owner === user).map(publicOf),
    });
  }

  getSession(user: string, sid: string): Reply {
    const s = this.mine(user, sid);
    if (!s) return refuse(404, "not_found");
    return reply(200, {
      ok: true,
      data: {
        ...publicOf(s),
        connector_online: this.connector(s.connector_id).online,
      },
    });
  }

  command(user: string, sid: string, body: Json, idem: string | null): Promise<Reply> {
    const type = body.type;
    if (typeof type !== "string" || !["prompt", "cancel", "set_mode", "resume", "close", "withdraw"].includes(type)) {
      return Promise.resolve(refuse(400, "unknown_command_type"));
    }
    return this.issue(user, sid, type, body, idem);
  }

  /** The decision's own checks: the request was asked, not resolved, and the option is one it offered. */
  private decisionRefusal(s: FakeSession, body: Json): Reply | null {
    const rows = this.events.get(s.session_id) ?? [];
    const asked = [...rows].reverse().find((e) => e.type === "permissionRequest" && e.data.actionId === body.action_id);
    if (!asked) return refuse(404, "action_not_found");
    if (rows.some((e) => e.type === "permission_resolved" && e.data.actionId === body.action_id))
      return refuse(409, "already_resolved");
    const offered = Array.isArray(asked.data.options) ? (asked.data.options as Json[]).map((o) => o.optionId) : [];
    return offered.includes(body.option_id) ? null : refuse(400, "unknown_option");
  }

  async issue(user: string, sid: string, type: string, body: Json, idempotency: string | null): Promise<Reply> {
    const s = this.mine(user, sid);
    if (!s) return refuse(404, "not_found");
    if (s.status !== "active") return refuse(409, "session_closed");
    const c = this.connector(s.connector_id);
    if (["prompt", "set_mode", "resume"].includes(type) && !c.online) return refuse(409, "connector_offline");
    let cmdId = idempotency !== null ? `k:${idempotency}` : randomUUID();
    if (type === "decision") {
      const refused = this.decisionRefusal(s, body);
      if (refused) return refused;
      cmdId = `dec:${s.session_id}:${String(body.action_id)}`;
    }
    if (this.idem.has(cmdId)) return reply(200, { ok: true, data: { cmd_id: cmdId, duplicate: true } });
    this.idem.set(cmdId, body);
    if (type === "close") s.status = "closed";
    await this.hook({
      user,
      session_id: s.session_id,
      type,
      body,
      cmd_id: cmdId,
      idempotency_key: idempotency,
    });
    return reply(202, {
      ok: true,
      data: {
        cmd_id: cmdId,
        cmd_seq: this.commands.length,
        connector_online: c.online,
      },
    });
  }

  private async hook(command: FakeCommand): Promise<void> {
    this.commands.push(command);
    if (this.onCommand) await this.onCommand(this, command);
  }

  replay(user: string, sid: string, url: URL): Reply {
    if (!this.mine(user, sid)) return refuse(404, "not_found");
    const after = numberParam(url, "after", 0);
    const limit = Math.min(1000, numberParam(url, "limit", 500));
    const rows = (this.events.get(sid) ?? []).filter((e) => e.id > after).slice(0, limit);
    return reply(200, {
      ok: true,
      data: rows.map((e) => ({
        id: String(e.id),
        seq: e.seq,
        type: e.type,
        ts: e.ts,
        data: e.data,
      })),
    });
  }

  private stream(res: ServerResponse, user: string, url: URL): void {
    const sid = /\/sessions\/([^/]+)\/events$/u.exec(url.pathname)?.[1] ?? "";
    if (!this.mine(user, sid)) {
      send(res, refuse(404, "not_found"));
      return;
    }
    let after = numberParam(url, "after", 0);
    this.streamOpens.push({ session_id: sid, after });
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    });
    this.open.add(res);
    res.on("close", () => this.open.delete(res));
    let sent = 0;
    let marked = false;
    const pump = async (): Promise<void> => {
      while (open(res)) {
        const version = this.version;
        for (const e of (this.events.get(sid) ?? []).filter((row) => row.id > after)) {
          const frame = {
            type: e.type,
            session_id: sid,
            seq: e.seq,
            ts: e.ts,
            data: e.data,
          };
          res.write(`id: ${String(e.id)}\nevent: ${e.type}\ndata: ${JSON.stringify(frame)}\n\n`);
          after = e.id;
          sent += 1;
          if (this.dropStreamAfter !== null && sent >= this.dropStreamAfter) {
            this.dropStreamAfter = null;
            res.end(); // the connection ends: the client must pick up from the last event it handled
            return;
          }
        }
        if (!marked) {
          marked = true;
          res.write(`event: historyComplete\ndata: ${JSON.stringify({ type: "historyComplete", count: sent })}\n\n`);
        }
        const changed = await this.changedSince(version, 500);
        if (!changed && open(res)) res.write(": keepalive\n\n");
      }
    };
    void pump();
  }

  /** Resolves true when an event was emitted after `version`, false after `ms` without one. */
  private changedSince(version: number, ms: number): Promise<boolean> {
    if (this.version !== version) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== done);
        resolve(false);
      }, ms);
      const done = (): void => {
        clearTimeout(timer);
        resolve(this.version !== version);
      };
      this.waiters.push(done);
    });
  }

  private wake(): void {
    const waiting = this.waiters;
    this.waiters = [];
    for (const w of waiting) w();
  }
}

/** One request as a route sees it. */
interface RouteRequest {
  readonly method: string;
  readonly url: URL;
  readonly user: string;
  readonly body: Json;
  readonly idem: string | null;
}

type Route = readonly [
  method: string,
  pattern: RegExp,
  handle: (srv: FakeRemote, req: RouteRequest, id: string) => Reply | Promise<Reply>,
];

const ID = "([^/]+)";
const at = (path: string): RegExp => new RegExp(`^${PREFIX}${path}$`, "u");

/** The user side of the remote-agents API, as `claw/docs/remote-agents.md` lists it (the event stream is served apart). */
const ROUTES: readonly Route[] = [
  ["GET", at("/connectors"), (srv, req) => srv.listConnectors(req.user)],
  ["POST", at("/pairings"), (srv, req) => srv.pair(req.user, req.method, req.url.pathname)],
  ["GET", at("/setup"), (srv, req) => srv.setupAnswer(req.url.pathname)],
  ["DELETE", at(`/connectors/${ID}`), (srv, req, id) => srv.revoke(req.user, id)],
  ["POST", at("/sessions"), (srv, req) => srv.createSession(req.user, req.body)],
  ["GET", at("/sessions"), (srv, req) => srv.listSessions(req.user)],
  ["GET", at(`/sessions/${ID}`), (srv, req, id) => srv.getSession(req.user, id)],
  ["POST", at(`/sessions/${ID}/commands`), (srv, req, id) => srv.command(req.user, id, req.body, req.idem)],
  ["POST", at(`/sessions/${ID}/decisions`), (srv, req, id) => srv.issue(req.user, id, "decision", req.body, req.idem)],
  ["GET", at(`/sessions/${ID}/events`), (srv, req, id) => srv.replay(req.user, id, req.url)],
];
