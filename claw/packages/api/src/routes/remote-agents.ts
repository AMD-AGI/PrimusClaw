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
import { CONNECTOR_GRANT_METHOD, grantOf } from "../auth/connector-grant.js";
import { notifyPaired } from "../remote-agents/pairing.js";
import { registerPairingRoutes, type PairingRouteOptions } from "../remote-agents/pairing-routes.js";
import { CONNECTOR_SIDE_ROUTES } from "../remote-agents/connector-routes.js";
import { db, dedicatedClient, inTransaction } from "../infra/db.js";
import { redactPublicJson } from "../events/redaction.js";
import { Waker } from "../remote-agents/waker.js";
import { startWakeRelay } from "../remote-agents/wake-relay.js";
import * as store from "../remote-agents/store.js";
import { connectorSetup, connectorVersionPolicy, versionVerdict } from "../remote-agents/setup.js";
import { OFFLINE_NOTICE_MS, PRESENCE_SWEEP_MS, prunePresenceHistory, startPresenceSweep } from "../remote-agents/presence.js";
import { startTerminalWaitSweep, TERMINAL_WAIT_NOTICE_MS } from "../remote-agents/terminal-waits.js";
import { closeCardsOfConnector } from "../assistant/devenv-tools.js";
import { inRemoteSessionOrder, noteRemoteCancel, noteRemoteEvents, noteRemotePrompt, remoteEventMark } from "../assistant/remote-items.js";

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
  /**
   * Wake the streams of every replica, not only this one's, on a write (`remote-agents/wake-relay.ts`): one `pg_notify` per
   * wake and one listening connection per replica. On in production (`index.ts`); off, a write through another replica is seen
   * at a stream's next idle poll.
   */
  crossReplicaWake?: boolean;
  /** How often this replica sweeps presence (`remote-agents/presence.ts`); zero or less runs no sweep. */
  presenceSweepMs?: number;
  /** How long a connector stays offline before its owner is told. */
  offlineNoticeMs?: number;
  /** How long a conversation open in a terminal waits for its person before they are told. */
  terminalWaitNoticeMs?: number;
  /** Pairing a machine with a one-time code (`remote-agents/pairing-routes.ts`). */
  pairing?: PairingRouteOptions;
  /**
   * Aborted when this process starts to shut down (`GracefulShutdown.closing`). Every command stream then sends
   * `event: reconnect` and ends, and its connector is kept online (`markStreamClosed`'s `restart`) while it opens a
   * stream on another replica, so a Claw release is neither an offline transition nor a notice.
   */
  closing?: AbortSignal;
  /** How often this replica ends commands that were never delivered (`store.expireUndelivered`); zero or less runs no sweep. */
  undeliveredSweepMs?: number;
}

/**
 * Sessions that gained Claw's own event: a command that was never delivered (`store.expireUndelivered`), or a close because their
 * connector was revoked (`store.revokeConnector`, a row replaced in `store.registerConnector`). Their readers on this replica are
 * woken (others poll), and their items move, so the user is told now instead of waiting hours for an answer.
 */
async function sayUndelivered(
  list: store.Undelivered[], wake: (sessionId: string) => void, what: "undelivered" | "revoked" = "undelivered",
): Promise<void> {
  if (!list.length) return;
  for (const u of list) wake(u.session_id);
  const byOwner = new Map<string, string[]>();
  for (const u of list) byOwner.set(u.owner, [...(byOwner.get(u.owner) ?? []), u.session_id]);
  for (const [owner, sessionIds] of byOwner) {
    await noteRemoteEvents(owner, sessionIds).catch((err) => logger.warn({ err: (err as Error)?.message, what }, "remote_agents.claw_end_note_failed"));
  }
  logger.info({ sessions: list.length }, `remote_agents.${what}_ended`);
}

/**
 * How long an idle stream waits before it reads the database anyway. A write made
 * through this process wakes its streams at once, and one made through another
 * replica does too while the wake relay is up (`crossReplicaWake`), so this only
 * bounds how late a write is seen when a wake-up was lost. Long enough that a
 * stream with nothing to say costs a query every few seconds, not every second:
 * a ping every 25 s still keeps the connection itself alive.
 */
const IDLE_POLL_MS = 5_000;

/** How often each replica deletes sessions that are past the retention. */
const RETENTION_SWEEP_MS = 60 * 60 * 1000;

/** The commands a read-only session refuses: everything that would make its agent act. `cancel`, `resume` and `close` are harmless. */
const READ_ONLY_REFUSED = new Set<string>(["prompt", "set_mode", "decision"]);

/**
 * Whether a session is read-only, followed frame by frame: it starts as the session is now, and each `session_started` or
 * `session_resumed` says it again (`read_only`, set by the connector). Every frame of a read-only session carries the mark on
 * top, its `turn_end` and `session_closed` included.
 */
function readOnlyTracker(initial: boolean): (r: store.Row) => { read_only?: true } {
  let ro = initial;
  return (r) => {
    if (r.type === "session_started" || r.type === "session_resumed") {
      ro = typeof r.data === "object" && r.data !== null && (r.data as Record<string, unknown>).read_only === true;
    }
    return ro ? { read_only: true } : {};
  };
}

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
  if (side === "user" && (getAuthMethod(req) === CONNECTOR_TOKEN_METHOD || getAuthMethod(req) === CONNECTOR_GRANT_METHOD)) {
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
  /** The last frame a stream sends when the process shuts down (`RemoteAgentOptions.closing`); without it the stream just ends. */
  closingFrame?: () => string;
  /** Frames to send now, and whether more are already waiting; `stop` is a last frame that ends the stream. */
  poll: () => Promise<{ frames: string[]; more?: boolean; stop?: string }>;
  onPing?: () => Promise<void>;
  onClose?: () => Promise<void>;
}

/** The largest backlog a stalled reader may leave in this process before its stream is cut. */
const MAX_WRITE_BACKLOG = 4 * 1024 * 1024;

async function serveSse(
  req: FastifyRequest, reply: FastifyReply, waker: Waker, t: { pingMs: number; pollMs: number; closing?: AbortSignal }, s: SseStream,
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
  // The process is shutting down: say so (synchronously, before `GracefulShutdown` ends the response) and stop.
  const onClosing = () => {
    if (s.closingFrame) write(s.closingFrame());
    gone.abort();
  };
  try {
    for (const f of s.first ?? []) write(f);
    if (t.closing?.aborted) onClosing();
    else t.closing?.addEventListener("abort", onClosing, { once: true });
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
    t.closing?.removeEventListener("abort", onClosing);
    await s.onClose?.().catch((err) => logger.warn({ err: (err as Error)?.message }, "remote_agents.stream_close_failed"));
    if (!res.writableEnded) res.end();
  }
  return reply;
}

export async function registerRemoteAgentRoutes(app: FastifyInstance, opts: RemoteAgentOptions = {}): Promise<void> {
  if (!CLAW_REMOTE_AGENTS_ENABLED) return;
  const waker = opts.waker ?? new Waker();
  if (opts.crossReplicaWake) {
    const relay = startWakeRelay(waker, { client: dedicatedClient, query: (text, params) => db.query(text, params) });
    app.addHook("onClose", async () => relay.stop());
    await relay.ready;
  }
  // Commands the assistant issues for the user (`devenv_send`) wake this replica's command streams as a route's do.
  store.setCommandWaker((connectorId) => waker.wake(`c:${connectorId}`));
  store.setSessionWaker((sessionId) => waker.wake(`s:${sessionId}`));
  const pingMs = opts.pingMs ?? REMOTE_AGENT_TIMING.pingMs;
  const pollMs = opts.pollMs ?? IDLE_POLL_MS;
  const onlineWindowMs = opts.onlineWindowMs ?? REMOTE_AGENT_TIMING.onlineWindowMs;
  const commandsPerMinute = opts.commandsPerMinute ?? REMOTE_AGENT_LIMITS.commandsPerMinute;
  const maxConnectors = opts.maxConnectorsPerUser ?? REMOTE_AGENT_LIMITS.maxConnectorsPerUser;
  const maxActiveSessions = opts.maxActiveSessionsPerUser ?? REMOTE_AGENT_LIMITS.maxActiveSessionsPerUser;
  const maxStreams = opts.maxStreamsPerUser ?? 20;
  const timing = { pingMs, pollMs, closing: opts.closing };

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
          const t = await prunePresenceHistory(retentionDays);
          if (n > 0 || t > 0) logger.info({ sessions: n, presenceTransitions: t, retentionDays }, "remote_agents.retention_swept");
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
  // Presence over time, and telling an owner when a connector has gone (and come back). Every replica runs it; a lock
  // makes each sweep one replica's. Stops with the server.
  const presenceSweepMs = opts.presenceSweepMs ?? PRESENCE_SWEEP_MS;
  if (presenceSweepMs > 0) {
    const stop = startPresenceSweep({ onlineWindowMs, noticeAfterMs: opts.offlineNoticeMs ?? OFFLINE_NOTICE_MS, sweepMs: presenceSweepMs });
    app.addHook("onClose", async () => stop());
  }
  // A conversation open in a terminal that has waited a minute for its person: told once (`remote-agents/terminal-waits.ts`). On the
  // presence sweep's schedule; a lock makes each sweep one replica's.
  if (presenceSweepMs > 0) {
    const stop = startTerminalWaitSweep({ onlineWindowMs, noticeAfterMs: opts.terminalWaitNoticeMs ?? TERMINAL_WAIT_NOTICE_MS, sweepMs: presenceSweepMs });
    app.addHook("onClose", async () => stop());
  }
  // A command accepted while its machine still looked online (a laptop closed within the online window) and never collected:
  // every replica looks as often as presence is swept, whether or not the machine ever comes back; a delete hands each to one.
  const undeliveredSweepMs = opts.undeliveredSweepMs ?? PRESENCE_SWEEP_MS;
  if (undeliveredSweepMs > 0) {
    let timer: NodeJS.Timeout | undefined;
    let stopped = false;
    const tick = async () => {
      try {
        await sayUndelivered(await inTransaction((q) => store.expireUndelivered(q)), (sid) => waker.wake(`s:${sid}`));
      } catch (err) {
        logger.warn({ err: (err as Error)?.message }, "remote_agents.undelivered_sweep_failed");
      }
      if (stopped) return;
      timer = setTimeout(tick, undeliveredSweepMs);
      timer.unref();
    };
    timer = setTimeout(tick, undeliveredSweepMs);
    timer.unref();
    app.addHook("onClose", async () => { stopped = true; clearTimeout(timer); });
  }
  await registerPairingRoutes(app, opts.pairing);
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
    let row: Awaited<ReturnType<typeof store.registerConnector>>;
    try {
      row = await store.registerConnector(
        owner, body.value.name, body.value.version, clientLabel(req), maxConnectors, getAuthMethod(req), onlineWindowMs,
        // A replaced row is revoked: the cards that would continue one of its sessions close with it; one for a new session on that
        // machine stays, and follows the new registration when pressed (`executeSend`).
        (q, id) => closeCardsOfConnector(q, owner, id, { replaced: true }).then(() => undefined),
        grantOf(req),
      );
    } catch (err) {
      if (!(err instanceof store.GrantRegistrationRefused)) throw err;
      // As the auth hook answers: a revoked row's grant is over (401 revoked, the connector stops); another name is not this grant's.
      return err.reason === "revoked" ? fail(reply, 401, "revoked") : fail(reply, 403, "connector_grant_name_mismatch");
    }
    if (!row) return fail(reply, 409, "connector_limit_reached");
    // A paired machine's grant now follows this row (bound above, in its transaction): only its routes, over once it is revoked.
    const grant = grantOf(req);
    if (grant) await notifyPaired(grant, row.connector_id, row.name);
    // Offline rows under the same name (a connector that lost its state and registered again) were revoked in its place.
    if (row.replaced.length) logger.info({ owner, connectorId: row.connector_id, replaced: row.replaced }, "remote_agents.connector_replaced");
    for (const id of row.replaced) waker.wake(`c:${id}`);
    // The replaced rows' sessions closed with them (`session_closed` of Claw's own): their readers and items are told now.
    await sayUndelivered(row.closedSessions.map((sessionId) => ({ owner, session_id: sessionId })), (sid) => waker.wake(`s:${sid}`), "revoked");
    // The id every row of this connector is filed under. A connector whose token `sub` is not the id the
    // user's own clients resolve to is registered and online yet invisible to them, with no error; this
    // line is where an operator reads which id it was filed under (docs/remote-agents.md, "Connector access tokens").
    logger.info({ owner, connectorId: row.connector_id, credential: getAuthMethod(req) }, "remote_agents.connector_registered");
    return reply.status(201).send({ ok: true, data: { connector_id: row.connector_id, name: row.name, created_at: row.created_at } });
  });

  app.get("/v1/remote-agents/connectors", async (req, reply) => {
    const owner = requireOwner(req, reply);
    if (!owner) return;
    const policy = connectorVersionPolicy();
    const rows = await store.listConnectors(owner, onlineWindowMs);
    return reply.send({ ok: true, data: rows.map((r) => ({ ...r, ...versionVerdict(r.version as string | null, policy) })) });
  });

  /** How to connect a machine to this server: the package, the exact commands and this deployment's addresses (`remote-agents/setup.ts`). */
  app.get("/v1/remote-agents/setup", async (req, reply) => {
    const owner = requireOwner(req, reply);
    if (!owner) return;
    return reply.send({ ok: true, data: connectorSetup() });
  });

  /** Revoke one of the caller's connectors: the row stays revoked for good, its queued commands go and its sessions close. */
  async function revoke(req: FastifyRequest, reply: FastifyReply, owner: string) {
    const id = parseRemoteId((req.params as { cid?: string }).cid);
    const closed = id ? await store.revokeConnector(owner, id, clientLabel(req), (q) => closeCardsOfConnector(q, owner, id).then(() => undefined)) : null;
    if (!id || !closed) return notFound(reply);
    waker.wake(`c:${id}`);
    // Its sessions closed with it, each with a `session_closed` of Claw's own: their readers and items are told now.
    await sayUndelivered(closed.map((sessionId) => ({ owner, session_id: sessionId })), (sid) => waker.wake(`s:${sid}`), "revoked");
    return reply.send({ ok: true });
  }

  app.delete("/v1/remote-agents/connectors/:cid", async (req, reply) => {
    const owner = requireOwner(req, reply);
    if (!owner) return;
    return revoke(req, reply, owner);
  });

  // --- connector side --------------------------------------------------------

  // A connector signing out revokes its own row, so it can be sent nothing more. The same as the user-side DELETE,
  // reachable with the connector's own sign-in (a device sign-in's access token is refused on the user side). The
  // token names a user, not a connector, so it may revoke any connector of that user: a revocation stops the user's
  // own machine and reveals nothing, and the owner could do it anyway. 404 for a row that is not the caller's or is
  // already revoked.
  app.post(CONNECTOR_SIDE_ROUTES.revoke.url, async (req, reply) => {
    const owner = requireOwner(req, reply, "connector");
    if (!owner) return;
    return revoke(req, reply, owner);
  });

  app.post(CONNECTOR_SIDE_ROUTES.heartbeat.url, async (req, reply) => {
    const owner = requireOwner(req, reply, "connector");
    if (!owner) return;
    const connector = await ownConnector(req, reply, owner);
    if (!connector) return;
    const hb = parseHeartbeat(req.body);
    if (!hb.ok) return fail(reply, 400, hb.error);
    const undelivered = await store.recordHeartbeat(connector.connector_id, owner, hb.value);
    await sayUndelivered(undelivered, (sid) => waker.wake(`s:${sid}`));
    // Below the recommended version the answer says so, with the command that upgrades it; a connector may print it.
    const verdict = versionVerdict(hb.value.version ?? (connector.version as string | null));
    return reply.send({ ok: true, data: {
      server_time: new Date().toISOString(), online_window_ms: onlineWindowMs,
      ...(verdict.upgrade_command ? { connector_version: verdict } : {}),
    } });
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
    // The assistant's view of the work (`assistant/remote-items.ts`): after the events are stored, and never a reason to refuse them.
    // Every session the batch was for, not only those that gained an event: a retry of a batch whose events were stored but not
    // applied (the item's write failed) applies them then.
    const posted = [...new Set([...result.touched, ...Object.keys(result.acked)])];
    if (posted.length) await noteRemoteEvents(owner, posted);
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
      // The last frame this stream was ended with, kept on the connector so presence can say why it went.
      let endReason = "closed";
      const end = (frame: "token_expired" | "revoked" | "superseded") => { endReason = frame; return { frames: [], stop: sseFrame(frame, { connector_id: cid }) }; };
      await store.markStreamOpen(cid, streamConn);
      return serveSse(req, reply, waker, timing, {
        key: `c:${cid}`,
        // `ping_ms`: how often this stream pings, so a connector can tell a stream the network holds from a quiet one.
        first: [sseFrame("ready", { v: REMOTE_AGENT_PROTOCOL_VERSION, connector_id: cid, server_time: new Date().toISOString(), ping_ms: pingMs })],
        pingFrame: () => sseFrame("ping", { t: Date.now() }),
        // A Claw release: reconnect now (to another replica), not after a backoff. Its connector stays online meanwhile.
        closingFrame: () => { endReason = "restart"; return sseFrame("reconnect", { connector_id: cid }); },
        async poll() {
          // A stream opened with an access token ends when the token does (the
          // connector reconnects with a fresh one), and when the provider says
          // its grant was revoked (checked as often as a ping, when introspection is on).
          if (tokenExpired(req)) return end("token_expired");
          if (Date.now() >= nextTokenCheck) {
            nextTokenCheck = Date.now() + pingMs;
            if (await tokenRevoked(req)) return end("revoked");
          }
          const verdict = await store.streamVerdict(cid, streamConn);
          if (verdict) return end(verdict);
          const rows = await store.commandsAfter(cid, cursor, 100);
          const frames = rows.map((r) => {
            cursor = Number(r.cmd_seq);
            // The fixed fields go last so a payload can never overwrite them.
            // `issued_at` (when it was queued, ms): a connector that gets a command later than the live TTL asks before it runs it.
            // `sent_at` (this replica's clock, the one `ready` and `ping` carry, ms): a frame the network held back for more than a
            // few seconds is asked about too, before it runs.
            return sseFrame("command", {
              ...r.payload, v: REMOTE_AGENT_PROTOCOL_VERSION, cmd_id: r.cmd_id, type: r.type, session_id: r.session_id,
              issued_at: new Date(r.created_at as string | Date).getTime(), sent_at: Date.now(),
            }, cursor);
          });
          return { frames, more: rows.length === 100 };
        },
        onPing: () => store.touchStream(cid, streamConn),
        onClose: () => store.markStreamClosed(cid, streamConn, endReason),
      });
    },
  );

  /**
   * A connector asks whether a command it received may still be carried out, before it does: after its machine slept or its
   * process was stopped (a closed laptop), for a frame the network held back, or for a command older than the live TTL. A frame
   * can sit in a buffer through that, and the person may meanwhile have closed the session or removed the machine and been told
   * so. Answered with the command's status (`store.commandLiveness`); only `live` may run. A revoked connector gets 401 `revoked`,
   * as on every connector-side route. The body (optional): `received_late` (boolean; the command was past the live TTL when it
   * came, the only case it can be `expired`; taken as true when absent), `why` (the connector's reason, for the audit trail) and
   * `session_id` (the command's session: once that closed, Claw no longer holds the command, and answers `session_closed`, not
   * `gone`, only when told whose it was).
   */
  app.post<{ Params: { cid: string; cmd_id: string } }>(CONNECTOR_SIDE_ROUTES.confirm.url, async (req, reply) => {
    const owner = requireOwner(req, reply, "connector");
    if (!owner) return;
    const connector = await ownConnector(req, reply, owner);
    if (!connector) return;
    const cmdId = req.params.cmd_id;
    if (typeof cmdId !== "string" || cmdId.length < 1 || cmdId.length > 128 || /[\u0000-\u001f\u007f]/u.test(cmdId)) {
      return fail(reply, 400, "invalid_cmd_id");
    }
    const body = (req.body ?? {}) as { received_late?: unknown; why?: unknown; session_id?: unknown };
    if (typeof body !== "object" || Array.isArray(body)) return fail(reply, 400, "invalid_body");
    const receivedLate = body.received_late !== false;
    const why = typeof body.why === "string" && /^[a-z_]{1,32}$/u.test(body.why) ? body.why : null;
    const sessionId = parseRemoteId(body.session_id);
    const r = await store.commandLiveness(owner, connector.connector_id as string, cmdId, clientLabel(req), { receivedLate, why, sessionId });
    // Revoked between the check above and the lock the answer is given under.
    if (r.status === "connector_revoked") return fail(reply, 401, "revoked");
    if (r.status !== "live") logger.info({ owner, connectorId: connector.connector_id, cmdSeq: r.cmd_seq, status: r.status }, "remote_agents.command_refused_late");
    return reply.send({ ok: true, data: { cmd_id: cmdId, status: r.status } });
  });

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
    // Too old to be given a session: the owner is told which version and how to upgrade, instead of a session that fails on it.
    const verdict = versionVerdict(connector.version as string | null);
    if (verdict.version_status === "unsupported") {
      return reply.status(409).send({ ok: false, error: "connector_outdated", data: { version: connector.version, ...verdict } });
    }
    const out = await store.createSession({
      owner, client: clientLabel(req), connectorId: connector.connector_id, agentId: body.value.agent_id,
      cwd: body.value.cwd, mode: body.value.mode, resumeRef: body.value.resume_ref, takeover: body.value.takeover, maxActive: maxActiveSessions, commandsPerMinute,
      onlineWindowMs,
    });
    if (out.status === "limit") return fail(reply, 409, "session_limit_reached");
    if (out.status === "rate_limited") return fail(reply, 429, "rate_limited");
    if (out.status === "gone") return notFound(reply);
    waker.wake(`c:${connector.connector_id}`);
    // At the limit, sessions nobody was using were closed to make room: their connectors are told now, and the caller can say so.
    for (const c of new Set(out.reclaimed.map((r) => r.connector_id))) waker.wake(`c:${c}`);
    return reply.status(201).send({ ok: true, data: out.session, ...(out.reclaimed.length ? { reclaimed: out.reclaimed.map((r) => r.session_id) } : {}) });
  });

  app.get<{ Querystring: { connector_id?: string } }>("/v1/remote-agents/sessions", async (req, reply) => {
    const owner = requireOwner(req, reply);
    if (!owner) return;
    let connectorId: string | null = null;
    if (req.query.connector_id !== undefined) {
      connectorId = parseRemoteId(req.query.connector_id);
      if (!connectorId) return fail(reply, 400, "invalid_connector_id");
    }
    const sessions = await store.listSessions(owner, connectorId, 100);
    // What each active session waits on its user for (a permission request not yet answered): a client lists those first.
    const waiting = await store.sessionsWaiting(owner, sessions.filter((s) => s.status === "active").map((s) => String(s.session_id)));
    return reply.send({ ok: true, data: sessions.map((s) => ({ ...s, waiting: waiting.get(String(s.session_id)) ?? [] })) });
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
    // A conversation open in a terminal, watched: nothing typed here may reach it (a second writer forks its transcript).
    // Refused before it is queued; the connector refuses it too.
    if (session.read_only === true && READ_ONLY_REFUSED.has(type)) return fail(reply, 409, "session_read_only");
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
    const send = async () => {
      const since = type === "prompt" || type === "cancel" ? await remoteEventMark(sessionId).catch(() => undefined) : undefined;
      const queued = await store.issueCommand({
        owner, client: clientLabel(req), connectorId: session.connector_id, agentId: session.agent_id, sessionId,
        type, cmdId, payload, auditDetail: spec.audit(parsed.value), closesSession: spec.closesSession, commandsPerMinute,
      });
      if (queued.status !== "queued") return queued;
      // A stop pressed in the attached chat (queued now, not a retry): its turn_end ends what was sent before it, not a prompt after it.
      if (type === "cancel" && since !== undefined) {
        await noteRemoteCancel(owner, sessionId, since).catch((err) => logger.warn({ err: (err as Error)?.message, sessionId }, "remote_agents.item_note_failed"));
      }
      // A prompt typed into an attached chat is an item the assistant can name ("did it finish?"), told to nobody: the chat shows it.
      if (type === "prompt") {
        await noteRemotePrompt({
          owner, sessionId, connectorId: session.connector_id, agentId: session.agent_id, text: (parsed.value as { text: string }).text, origin: "chat",
          since, cmdSeq: Number(queued.row.cmd_seq),
        }).catch((err) => logger.warn({ err: (err as Error)?.message, sessionId }, "remote_agents.item_note_failed"));
      }
      return queued;
    };
    // A prompt, a stop and a withdraw are queued one at a time per session, so the connector gets them in the order they were asked
    // (a withdraw sent right after a prompt takes that prompt back) and the item counts them in that order.
    const ordered = type === "prompt" || type === "cancel" || type === "withdraw";
    const out = ordered ? await inRemoteSessionOrder(sessionId, send) : await send();
    if (out.status === "rate_limited") return fail(reply, 429, "rate_limited");
    if (out.status === "gone") return notFound(reply);
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

      // History is read from its start or from a cursor: what the session is now is the best guess until a lifecycle event says.
      const mark = readOnlyTracker(cursor === 0 ? false : session.read_only === true);
      const frameOf = (r: store.Row) =>
        sseFrame(r.type, { type: r.type, session_id: sessionId, seq: Number(r.seq), ts: r.ts, ...mark(r), data: r.data }, String(r.id));

      if (req.query.mode === "replay") {
        const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 500));
        const rows = await store.eventsAfter(sessionId, cursor, limit);
        return reply.send({
          ok: true,
          data: rows.map((r) => ({ id: String(r.id), seq: Number(r.seq), type: r.type, ts: r.ts, ...mark(r), data: r.data })),
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
