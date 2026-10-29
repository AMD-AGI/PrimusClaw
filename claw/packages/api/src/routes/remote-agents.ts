// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * Remote agents: programs on a user's own machine that dial out to Claw.
 *
 * A connector registers itself, then holds one `GET .../commands` stream open to
 * receive commands and posts what its agents produce to `POST .../events`. The
 * user's own clients read a session through `GET .../sessions/:id/events`, in
 * the frame format of `/v1/chat/sessions/:id/messages`, and send commands with
 * `POST .../sessions/:id/commands`. Claw relays, stores and audits; it never
 * interprets what an agent says, and it knows no agent product by name.
 *
 * Access is owner-only. Every row carries the verified caller's id, every query
 * filters on it, and anyone else's id answers 404 exactly as a missing one does.
 * The administrator roles get no special path here: an operator may disable the
 * whole capability, but cannot read a user's sessions.
 *
 * Registered only when `CLAW_REMOTE_AGENTS_ENABLED` is on; otherwise the paths
 * do not exist. Wire contract: `@claw/protocol` (remote-agents.ts).
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import pino from "pino";
import {
  REMOTE_AGENT_LIMITS, REMOTE_AGENT_PROTOCOL_VERSION, REMOTE_AGENT_TIMING, REMOTE_COMMANDS,
  isRemoteCommandType, parseConnectorRegistration, parseCursor, parseEventBatch, parseHeartbeat,
  parseRemoteId, parseSessionNew, sseFrame, type RemoteCommandType,
} from "@claw/protocol";
import { CLAW_REMOTE_AGENTS_ENABLED, CLAW_REMOTE_AGENTS_RETENTION_DAYS } from "../config.js";
import { getUser } from "../auth/middleware.js";
import { getAuthMethod } from "../auth/request-credential.js";
import { CONNECTOR_TOKEN_METHOD, tokenExpired, tokenRevoked } from "../auth/connector-token.js";
import { CONNECTOR_SIDE_ROUTES } from "../remote-agents/connector-routes.js";
import { db } from "../infra/db.js";
import { redactPublicJson } from "../events/redaction.js";
import { Waker } from "../remote-agents/waker.js";
import * as store from "../remote-agents/store.js";

const logger = pino({ name: "remote-agents" });

export interface RemoteAgentOptions {
  /** How often a stream sends a ping frame. */
  pingMs?: number;
  /** How often a stream re-reads the database when nothing wakes it. */
  pollMs?: number;
  /** Days a closed session and its events are kept; zero or less keeps them for ever. */
  retentionDays?: number;
  /** How often this replica looks for sessions past the retention. */
  retentionSweepMs?: number;
  onlineWindowMs?: number;
  commandsPerMinute?: number;
  maxConnectorsPerUser?: number;
  maxActiveSessionsPerUser?: number;
  /** Event streams one user may hold open at once on this replica. */
  maxStreamsPerUser?: number;
  /** Shared with the process, so a test can see a stream leave. */
  waker?: Waker;
}

/**
 * How long an idle stream waits before it reads the database anyway. A write made
 * through this process wakes its streams at once, so this only bounds how late a
 * write made through another replica is seen. Short enough for that, and long
 * enough that a stream with nothing to say costs a query every few seconds, not
 * every second: a ping every 25 s still keeps the connection itself alive.
 */
const IDLE_POLL_MS = 5_000;

/** How often each replica deletes sessions that are past the retention. */
const RETENTION_SWEEP_MS = 60 * 60 * 1000;

const notFound = (reply: FastifyReply) => reply.status(404).send({ ok: false, error: "not_found" });
const fail = (reply: FastifyReply, status: number, error: string) => reply.status(status).send({ ok: false, error });

/**
 * The verified caller, or a refusal. Administrators are ordinary callers here.
 *
 * `side` is which half of the API the route belongs to. A connector's access
 * token authenticates only on the connector side (`CONNECTOR_SIDE_ROUTES`, and
 * the global hook only offers it there), but the user side refuses it again
 * here, so no change to what the hook accepts can let a connector read a
 * session or issue a command.
 */
function requireOwner(req: FastifyRequest, reply: FastifyReply, side: "user" | "connector" = "user"): string | null {
  const userId = getUser(req)?.userId;
  if (!userId || userId === "default") {
    fail(reply, 403, "remote_agents_require_authenticated_user");
    return null;
  }
  if (side === "user" && getAuthMethod(req) === CONNECTOR_TOKEN_METHOD) {
    fail(reply, 403, "connector_token_not_accepted");
    return null;
  }
  return userId;
}

/** Which client acted, for the audit trail. A label the caller chose, so only ever a label. */
function clientLabel(req: FastifyRequest): string | null {
  const h = req.headers["x-claw-client"];
  const v = Array.isArray(h) ? h[0] : h;
  return typeof v === "string" && /^[A-Za-z0-9._-]{1,32}$/.test(v) ? v : null;
}

interface SseStream {
  /** What a write through this process wakes this stream on. */
  key: string;
  first?: string[];
  pingFrame: () => string;
  /** Frames to send now, and whether more are already waiting; `stop` is a last frame that ends the stream. */
  poll: () => Promise<{ frames: string[]; more?: boolean; stop?: string }>;
  onPing?: () => Promise<void>;
  onClose?: () => Promise<void>;
}

/** The largest backlog a stalled reader may leave in this process before its stream is cut. */
const MAX_WRITE_BACKLOG = 4 * 1024 * 1024;

async function serveSse(
  req: FastifyRequest, reply: FastifyReply, waker: Waker, t: { pingMs: number; pollMs: number }, s: SseStream,
): Promise<FastifyReply> {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  const gone = new AbortController();
  req.raw.on("close", () => gone.abort());
  res.on("close", () => gone.abort());
  const write = (frame: string): void => {
    if (res.writableEnded || res.destroyed) return;
    try { res.write(frame); } catch { gone.abort(); }
  };
  try {
    for (const f of s.first ?? []) write(f);
    let nextPing = Date.now() + t.pingMs;
    while (!gone.signal.aborted) {
      const out = await s.poll();
      for (const f of out.frames) write(f);
      if (out.stop) { write(out.stop); break; }
      if (res.writableLength > MAX_WRITE_BACKLOG) break;
      if (Date.now() >= nextPing) {
        nextPing = Date.now() + t.pingMs;
        write(s.pingFrame());
        await s.onPing?.();
      }
      if (out.more) continue;
      await waker.wait(s.key, Math.min(t.pollMs, Math.max(0, nextPing - Date.now())), gone.signal);
    }
  } catch (err) {
    // The client reconnects and resumes from its cursor; nothing here is lost.
    logger.warn({ err: (err as Error)?.message }, "remote_agents.stream_failed");
  } finally {
    await s.onClose?.().catch((err) => logger.warn({ err: (err as Error)?.message }, "remote_agents.stream_close_failed"));
    if (!res.writableEnded) res.end();
  }
  return reply;
}

export async function registerRemoteAgentRoutes(app: FastifyInstance, opts: RemoteAgentOptions = {}): Promise<void> {
  if (!CLAW_REMOTE_AGENTS_ENABLED) return;
  const waker = opts.waker ?? new Waker();
  const pingMs = opts.pingMs ?? REMOTE_AGENT_TIMING.pingMs;
  const pollMs = opts.pollMs ?? IDLE_POLL_MS;
  const onlineWindowMs = opts.onlineWindowMs ?? REMOTE_AGENT_TIMING.onlineWindowMs;
  const commandsPerMinute = opts.commandsPerMinute ?? REMOTE_AGENT_LIMITS.commandsPerMinute;
  const maxConnectors = opts.maxConnectorsPerUser ?? REMOTE_AGENT_LIMITS.maxConnectorsPerUser;
  const maxActiveSessions = opts.maxActiveSessionsPerUser ?? REMOTE_AGENT_LIMITS.maxActiveSessionsPerUser;
  const maxStreams = opts.maxStreamsPerUser ?? 20;
  const timing = { pingMs, pollMs };

  // Closed sessions and their events would otherwise be kept for ever. Every replica sweeps; the
  // delete is idempotent, so two sweeping at once only share the work. The timer neither keeps
  // the process alive nor outlives the server.
  const retentionDays = opts.retentionDays ?? CLAW_REMOTE_AGENTS_RETENTION_DAYS;
  const sweepMs = opts.retentionSweepMs ?? RETENTION_SWEEP_MS;
  if (retentionDays > 0) {
    let timer: NodeJS.Timeout | undefined;
    let stopped = false;
    const schedule = (ms: number) => {
      if (stopped) return;
      timer = setTimeout(async () => {
        try {
          const n = await store.pruneClosedSessions(retentionDays);
          if (n > 0) logger.info({ sessions: n, retentionDays }, "remote_agents.retention_swept");
        } catch (err) {
          logger.warn({ err: (err as Error)?.message }, "remote_agents.retention_sweep_failed");
        }
        schedule(sweepMs);
      }, ms);
      timer.unref();
    };
    schedule(Math.min(sweepMs, 60_000));
    app.addHook("onClose", async () => { stopped = true; clearTimeout(timer); });
  }
  // A reader's stream polls the database, so one user cannot hold an unbounded number open.
  const openReaders = new Map<string, number>();

  /**
   * The caller's own connector for a connector-side route. A connector that was
   * revoked gets 401 `revoked`, which tells it to stop, and is the only case
   * where a connector id owned by the caller is named in a refusal.
   */
  async function ownConnector(req: FastifyRequest, reply: FastifyReply, owner: string): Promise<store.Row | null> {
    const id = parseRemoteId((req.params as { cid?: string }).cid);
    const row = id ? await store.findConnector(owner, id, onlineWindowMs) : null;
    if (!row) { notFound(reply); return null; }
    if (row.revoked_at) { fail(reply, 401, "revoked"); return null; }
    return row;
  }

  // --- connectors (user side) ------------------------------------------------

  app.post(CONNECTOR_SIDE_ROUTES.register.url, async (req, reply) => {
    const owner = requireOwner(req, reply, "connector");
    if (!owner) return;
    const body = parseConnectorRegistration(req.body ?? {});
    if (!body.ok) return fail(reply, 400, body.error);
    const row = await store.registerConnector(
      owner, body.value.name, body.value.version, clientLabel(req), maxConnectors, getAuthMethod(req),
    );
    if (!row) return fail(reply, 409, "connector_limit_reached");
    return reply.status(201).send({ ok: true, data: { connector_id: row.connector_id, name: row.name, created_at: row.created_at } });
  });

  app.get("/v1/remote-agents/connectors", async (req, reply) => {
    const owner = requireOwner(req, reply);
    if (!owner) return;
    return reply.send({ ok: true, data: await store.listConnectors(owner, onlineWindowMs) });
  });

  app.delete("/v1/remote-agents/connectors/:cid", async (req, reply) => {
    const owner = requireOwner(req, reply);
    if (!owner) return;
    const id = parseRemoteId((req.params as { cid?: string }).cid);
    if (!id || !(await store.revokeConnector(owner, id, clientLabel(req)))) return notFound(reply);
    waker.wake(`c:${id}`);
    return reply.send({ ok: true });
  });

  // --- connector side --------------------------------------------------------

  app.post(CONNECTOR_SIDE_ROUTES.heartbeat.url, async (req, reply) => {
    const owner = requireOwner(req, reply, "connector");
    if (!owner) return;
    const connector = await ownConnector(req, reply, owner);
    if (!connector) return;
    const hb = parseHeartbeat(req.body);
    if (!hb.ok) return fail(reply, 400, hb.error);
    await store.recordHeartbeat(connector.connector_id, owner, hb.value);
    return reply.send({ ok: true, data: { server_time: new Date().toISOString(), online_window_ms: onlineWindowMs } });
  });

  app.post(CONNECTOR_SIDE_ROUTES.events.url, async (req, reply) => {
    const owner = requireOwner(req, reply, "connector");
    if (!owner) return;
    const connector = await ownConnector(req, reply, owner);
    if (!connector) return;
    const batch = parseEventBatch(req.body);
    if (!batch.ok) return fail(reply, 400, batch.error);
    // Second line of defence behind the connector's own scrub of what leaves the machine.
    const events = batch.value.events.map((e) => ({ ...e, data: redactPublicJson(e.data) as Record<string, unknown> }));
    const result = await store.ingestEvents(connector as { connector_id: string; owner_user_id: string }, events, getAuthMethod(req));
    for (const sid of result.touched) waker.wake(`s:${sid}`);
    const rejected = [...batch.value.rejected, ...result.rejected].sort((a, b) => a.index - b.index);
    return reply.send({ ok: true, data: { batch_id: batch.value.batchId, acked: result.acked, rejected } });
  });

  app.get<{ Params: { cid: string }; Querystring: { after?: string } }>(
    CONNECTOR_SIDE_ROUTES.commands.url,
    async (req, reply) => {
      const owner = requireOwner(req, reply, "connector");
      if (!owner) return;
      const connector = await ownConnector(req, reply, owner);
      if (!connector) return;
      // A presented cursor is checked and then not used to skip anything. An SSE
      // client sends the id of the last frame it *received*, and it may have lost
      // the connection before acting on it, so the position it names proves
      // nothing about what was handled. What proves it is a heartbeat's
      // `cmd_cursor`, which deletes the commands up to it; every command still
      // held is therefore unhandled and is sent again on every connect, in order.
      // A connector skips what it already did, by `cmd_seq` or `cmd_id`.
      const presented = parseCursor(req.headers["last-event-id"], req.query.after);
      if (!presented.ok) return fail(reply, 400, presented.error);
      const cid = connector.connector_id as string;
      const streamConn = randomUUID();
      let cursor = 0;
      let nextTokenCheck = Date.now() + pingMs;
      await store.markStreamOpen(cid, streamConn);
      return serveSse(req, reply, waker, timing, {
        key: `c:${cid}`,
        first: [sseFrame("ready", { v: REMOTE_AGENT_PROTOCOL_VERSION, connector_id: cid, server_time: new Date().toISOString() })],
        pingFrame: () => sseFrame("ping", { t: Date.now() }),
        async poll() {
          // A stream opened with an access token ends when the token does (the
          // connector reconnects with a fresh one), and when the provider says
          // its grant was revoked (checked as often as a ping, when introspection is on).
          if (tokenExpired(req)) return { frames: [], stop: sseFrame("token_expired", { connector_id: cid }) };
          if (Date.now() >= nextTokenCheck) {
            nextTokenCheck = Date.now() + pingMs;
            if (await tokenRevoked(req)) return { frames: [], stop: sseFrame("revoked", { connector_id: cid }) };
          }
          const verdict = await store.streamVerdict(cid, streamConn);
          if (verdict) return { frames: [], stop: sseFrame(verdict, { connector_id: cid }) };
          const rows = await store.commandsAfter(cid, cursor, 100);
          const frames = rows.map((r) => {
            cursor = Number(r.cmd_seq);
            // The fixed fields go last so a payload can never overwrite them.
            return sseFrame("command", {
              ...r.payload, v: REMOTE_AGENT_PROTOCOL_VERSION, cmd_id: r.cmd_id, type: r.type, session_id: r.session_id,
            }, cursor);
          });
          return { frames, more: rows.length === 100 };
        },
        onPing: () => store.touchStream(cid, streamConn),
        onClose: () => store.markStreamClosed(cid, streamConn),
      });
    },
  );

  // --- sessions (user side) --------------------------------------------------

  app.post("/v1/remote-agents/sessions", async (req, reply) => {
    const owner = requireOwner(req, reply);
    if (!owner) return;
    const body = parseSessionNew(req.body);
    if (!body.ok) return fail(reply, 400, body.error);
    const connector = await store.findConnector(owner, body.value.connector_id, onlineWindowMs);
    if (!connector || connector.revoked_at) return notFound(reply);
    const agents = (await db.query(
      "SELECT 1 FROM claw_remote_agents WHERE connector_id = $1 AND agent_id = $2", [connector.connector_id, body.value.agent_id],
    )).rows;
    if (!agents.length) return fail(reply, 404, "agent_not_found");
    if (!connector.online) return fail(reply, 409, "connector_offline");
    const out = await store.createSession({
      owner, client: clientLabel(req), connectorId: connector.connector_id, agentId: body.value.agent_id,
      cwd: body.value.cwd, mode: body.value.mode, maxActive: maxActiveSessions, commandsPerMinute,
    });
    if (out.status === "limit") return fail(reply, 409, "session_limit_reached");
    if (out.status === "rate_limited") return fail(reply, 429, "rate_limited");
    waker.wake(`c:${connector.connector_id}`);
    return reply.status(201).send({ ok: true, data: out.session });
  });

  app.get<{ Querystring: { connector_id?: string } }>("/v1/remote-agents/sessions", async (req, reply) => {
    const owner = requireOwner(req, reply);
    if (!owner) return;
    let connectorId: string | null = null;
    if (req.query.connector_id !== undefined) {
      connectorId = parseRemoteId(req.query.connector_id);
      if (!connectorId) return fail(reply, 400, "invalid_connector_id");
    }
    return reply.send({ ok: true, data: await store.listSessions(owner, connectorId, 100) });
  });

  app.get("/v1/remote-agents/sessions/:id", async (req, reply) => {
    const owner = requireOwner(req, reply);
    if (!owner) return;
    const id = parseRemoteId((req.params as { id?: string }).id);
    const session = id ? await store.findSession(owner, id) : null;
    if (!session) return notFound(reply);
    const connector = await store.findConnector(owner, session.connector_id, onlineWindowMs);
    return reply.send({ ok: true, data: { ...session, connector_online: !!connector?.online } });
  });

  /** Issue one command into a session the caller owns. */
  async function issue(req: FastifyRequest, reply: FastifyReply, type: unknown, body: Record<string, unknown>) {
    const owner = requireOwner(req, reply);
    if (!owner) return;
    const sessionId = parseRemoteId((req.params as { id?: string }).id);
    const session = sessionId ? await store.findSession(owner, sessionId) : null;
    if (!sessionId || !session) return notFound(reply);
    if (!isRemoteCommandType(type)) return fail(reply, 400, "unknown_command_type");
    if (session.status !== "active") return fail(reply, 409, "session_closed");
    const connector = await store.findConnector(owner, session.connector_id, onlineWindowMs);
    if (!connector || connector.revoked_at) return notFound(reply);
    const spec = REMOTE_COMMANDS[type as RemoteCommandType];
    const parsed = spec.parse(body);
    if (!parsed.ok) return fail(reply, 400, parsed.error);
    if (spec.needsOnline && !connector.online) return fail(reply, 409, "connector_offline");

    let cmdId: string;
    if (type === "decision") {
      // Checked against what the agent actually asked, so a client cannot answer
      // with an option that was never offered, or answer twice.
      const { action_id: actionId, option_id: optionId } = parsed.value as { action_id: string; option_id: string };
      const state = await store.permissionState(sessionId, actionId);
      if (!state.options) return fail(reply, 404, "action_not_found");
      if (state.resolved) return fail(reply, 409, "already_resolved");
      if (!state.options.includes(optionId)) return fail(reply, 400, "unknown_option");
      cmdId = `dec:${sessionId}:${actionId}`;
    } else {
      const key = req.headers["idempotency-key"];
      cmdId = typeof key === "string" && /^[A-Za-z0-9._:-]{1,64}$/.test(key) ? `k:${key}` : randomUUID();
    }
    const payload = type === "decision"
      ? { ...parsed.value, by: owner, client: clientLabel(req) }
      : parsed.value;
    const out = await store.issueCommand({
      owner, client: clientLabel(req), connectorId: session.connector_id, agentId: session.agent_id, sessionId,
      type, cmdId, payload, auditDetail: spec.audit(parsed.value), closesSession: spec.closesSession, commandsPerMinute,
    });
    if (out.status === "rate_limited") return fail(reply, 429, "rate_limited");
    if (out.status === "duplicate") {
      const same = out.row.type === type && out.row.session_id === sessionId
        && (type !== "decision" || out.row.payload?.option_id === (parsed.value as { option_id: string }).option_id);
      if (!same) return fail(reply, 409, type === "decision" ? "already_decided" : "idempotency_key_reused");
      return reply.send({ ok: true, data: { cmd_id: cmdId, duplicate: true } });
    }
    waker.wake(`c:${session.connector_id}`);
    return reply.status(202).send({
      ok: true, data: { cmd_id: cmdId, cmd_seq: Number(out.row.cmd_seq), connector_online: !!connector.online },
    });
  }

  app.post("/v1/remote-agents/sessions/:id/commands", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    return issue(req, reply, body.type, body);
  });

  // Same shape as `/v1/chat/sessions/:id/decisions`: an action id and a choice.
  // The choice is an option id the agent itself offered, passed through as is.
  app.post("/v1/remote-agents/sessions/:id/decisions", async (req, reply) => {
    return issue(req, reply, "decision", (req.body ?? {}) as Record<string, unknown>);
  });

  app.get<{ Params: { id: string }; Querystring: { after?: string; mode?: string; limit?: string } }>(
    "/v1/remote-agents/sessions/:id/events",
    async (req, reply) => {
      const owner = requireOwner(req, reply);
      if (!owner) return;
      const sessionId = parseRemoteId(req.params.id);
      const session = sessionId ? await store.findSession(owner, sessionId) : null;
      if (!sessionId || !session) return notFound(reply);
      // `Last-Event-ID` first: a browser reconnects to the same URL and only updates that header,
      // so `?after=` is where the stream began and goes stale as soon as one frame is delivered.
      const resume = parseCursor(req.headers["last-event-id"], req.query.after);
      if (!resume.ok) return fail(reply, 400, resume.error);
      let cursor = resume.value;

      const frameOf = (r: store.Row) =>
        sseFrame(r.type, { type: r.type, session_id: sessionId, seq: Number(r.seq), ts: r.ts, data: r.data }, String(r.id));

      if (req.query.mode === "replay") {
        const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 500));
        const rows = await store.eventsAfter(sessionId, cursor, limit);
        return reply.send({
          ok: true,
          data: rows.map((r) => ({ id: String(r.id), seq: Number(r.seq), type: r.type, ts: r.ts, data: r.data })),
        });
      }

      if ((openReaders.get(owner) ?? 0) >= maxStreams) return fail(reply, 429, "too_many_streams");
      openReaders.set(owner, (openReaders.get(owner) ?? 0) + 1);
      let historyDone = false;
      let sent = 0;
      try {
        return await serveSse(req, reply, waker, timing, {
          key: `s:${sessionId}`,
          // A comment, like the stream of an ordinary session, so one reader serves both.
          pingFrame: () => ": keepalive\n\n",
          async poll() {
            const rows = await store.eventsAfter(sessionId, cursor, 200);
            const frames = rows.map((r) => { cursor = Number(r.id); return frameOf(r); });
            sent += rows.length;
            const more = rows.length === 200;
            // The marker that separates "no history" from "history not here yet",
            // as on the ordinary session stream. It carries no id, so it can never
            // become a resume position.
            if (!historyDone && !more) {
              historyDone = true;
              frames.push(sseFrame("historyComplete", { type: "historyComplete", count: sent }));
            }
            return { frames, more };
          },
        });
      } finally {
        const left = (openReaders.get(owner) ?? 1) - 1;
        if (left > 0) openReaders.set(owner, left); else openReaders.delete(owner);
      }
    },
  );

  // --- audit -----------------------------------------------------------------

  app.get<{ Querystring: { session_id?: string; connector_id?: string; limit?: string } }>(
    "/v1/remote-agents/audit",
    async (req, reply) => {
      const owner = requireOwner(req, reply);
      if (!owner) return;
      const sessionId = req.query.session_id === undefined ? null : parseRemoteId(req.query.session_id);
      const connectorId = req.query.connector_id === undefined ? null : parseRemoteId(req.query.connector_id);
      if ((req.query.session_id !== undefined && !sessionId) || (req.query.connector_id !== undefined && !connectorId)) {
        return fail(reply, 400, "invalid_filter");
      }
      const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
      return reply.send({ ok: true, data: await store.listAudit(owner, { sessionId, connectorId }, limit) });
    },
  );
}
