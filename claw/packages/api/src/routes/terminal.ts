// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * A shell in a session's sandbox, for the browser.
 *
 *   GET  /v1/sessions/:id/terminal          is there a shell to connect to?
 *   POST /v1/sessions/:id/terminal/ticket   a one-time ticket for the socket
 *   GET  /v1/sessions/:id/terminal/ws       WebSocket: the shell itself
 *
 * The browser talks to this API only. SaFE is reached from here, with the
 * caller's own SaFE key, so what the shell can touch is what SaFE lets that user
 * touch. Only the session's creator may use any of the three: another user's
 * session answers 404, the same as one that does not exist, and an admin role
 * does not change that -- a shell is write access to the creator's workspace.
 *
 * Why a ticket: a browser WebSocket cannot send an Authorization header, so the
 * socket cannot carry an API key or a bearer token, and the cookie that would
 * authenticate it is not what every deployment authenticates with. The caller
 * asks for a ticket over an ordinary authenticated request; the upgrade presents
 * it. See terminal/tickets.ts.
 *
 * The upgrade is not a Fastify route. Fastify's hooks -- including the global
 * authentication -- run on requests it routes, and an `upgrade` event is not one;
 * the handler here authenticates the ticket itself, and nothing else reaches it.
 * It is attached to the server, so a path other than the terminal's is refused
 * rather than left to hang.
 *
 * What goes over the socket is SaFE's webshell protocol, untouched:
 *   browser -> shell   text or binary frames of input, and the text frame
 *                      `RESIZE <cols> <rows>` to change the window
 *   shell -> browser   binary frames of output; the close frame carries a reason
 * Beyond that the proxy adds one close code, 4408, for a terminal closed after
 * sitting idle. No subprotocol is negotiated.
 */
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import type { FastifyInstance, FastifyReply } from "fastify";
import pino from "pino";
import { WebSocketServer } from "ws";
import { getUser } from "../auth/middleware.js";
import { canAccessSession } from "../auth/models.js";
import {
  SAFE_API_URL, TERMINAL_IDLE_TIMEOUT_SECONDS, TERMINAL_MAX_CONNECTIONS, TERMINAL_MAX_CONNECTIONS_PER_USER,
} from "../config.js";
import { db } from "../infra/db.js";
import { kv } from "../infra/nats.js";
import { handsSessionKey } from "@claw/protocol";
import {
  resolveTerminal, TerminalUpstreamError, type SandboxBinding, type TerminalResolution,
} from "../terminal/resolve.js";
import {
  bridge, CLOSE_SHUTDOWN, connectUpstream, TerminalRegistry, UpstreamConnectError,
} from "../terminal/proxy.js";
import {
  mintTicket, redeemTicket, TICKET_TTL_SECONDS, TooManyTicketsError, type ShellTarget,
} from "../terminal/tickets.js";

const logger = pino({ name: "terminal" });

/** Read per request, so a test can change them; the environment sets them at boot. */
export const terminalSettings = {
  safeApiUrl: SAFE_API_URL,
  maxConnections: TERMINAL_MAX_CONNECTIONS,
  maxConnectionsPerUser: TERMINAL_MAX_CONNECTIONS_PER_USER,
  idleMs: TERMINAL_IDLE_TIMEOUT_SECONDS * 1000,
  pingMs: 30_000,
  upstreamConnectTimeoutMs: 10_000,
  /** Largest frame the browser may send (typed or pasted input) and the shell may send (output). */
  clientMaxPayload: 1024 * 1024,
  upstreamMaxPayload: 8 * 1024 * 1024,
};

/** Behind a seam because `kv` is a live binding a test cannot substitute. */
export const terminalPorts = {
  /** What the registry says about the session's sandbox; unreadable reads as none. */
  async readBinding(sessionId: string): Promise<SandboxBinding | null> {
    try {
      const entry = await kv.get(handsSessionKey(sessionId));
      if (!entry || entry.operation === "DEL" || entry.operation === "PURGE" || entry.value.length === 0) return null;
      const info = JSON.parse(new TextDecoder().decode(entry.value)) as { provider?: unknown; workloadId?: unknown };
      if (info.provider === "agent-sandbox") return { provider: "agent-sandbox", workloadId: "" };
      return typeof info.workloadId === "string" && info.workloadId
        ? { provider: "safe-workload", workloadId: info.workloadId }
        : null;
    } catch {
      return null;
    }
  },
};

export const terminalRegistry = new TerminalRegistry({
  maxConnections: terminalSettings.maxConnections,
  maxPerUser: terminalSettings.maxConnectionsPerUser,
});

const MAX_DIMENSION = 1000;
const WS_PATH_RE = /^\/v1\/sessions\/([^/]+)\/terminal\/ws$/;

/** `{ok:false, error, reason}`: a code a client can branch on, and a sentence for a person. */
function failure(error: string, reason: string, extra: Record<string, unknown> = {}) {
  return { ok: false, error, reason, ...extra };
}

/**
 * Who may open this session's terminal: its creator, and nobody else.
 *
 * A session that is not the caller's reads as 404 and not 403, so the answer
 * does not say which session ids exist.
 */
async function requireOwnedSession(
  req: Parameters<typeof getUser>[0],
  reply: FastifyReply,
  sessionId: string,
): Promise<{ userId: string; platformKey: string } | null> {
  const user = getUser(req);
  if (!user) {
    reply.status(401).send({ ok: false, error: "authentication_required" });
    return null;
  }
  const row = (await db.query(
    "SELECT user_id FROM claw_sessions WHERE session_id = $1 AND deleted_at IS NULL",
    [sessionId],
  )).rows[0] as { user_id: string | null } | undefined;
  if (!row || !canAccessSession(row.user_id, user.userId)) {
    reply.status(404).send({ ok: false, error: "session not found" });
    return null;
  }
  return { userId: user.userId, platformKey: user.platformKey };
}

/** Resolve the terminal, or send the 502/503 that says why it could not be. */
async function resolveOrReply(
  caller: { userId: string; platformKey: string },
  sessionId: string,
  reply: FastifyReply,
): Promise<TerminalResolution | null> {
  if (!terminalSettings.safeApiUrl) {
    reply.status(503).send(failure("terminal_unavailable", "this deployment has no SaFE to open a shell through"));
    return null;
  }
  if (!caller.platformKey) {
    reply.status(503).send(failure(
      "terminal_unavailable",
      "this request carries no SaFE API key to reach the sandbox with",
    ));
    return null;
  }
  try {
    return await resolveTerminal({
      safeApiUrl: terminalSettings.safeApiUrl.replace(/\/+$/, ""),
      sessionId,
      userId: caller.userId,
      apiKey: caller.platformKey,
      binding: await terminalPorts.readBinding(sessionId),
    });
  } catch (err) {
    if (err instanceof TerminalUpstreamError) {
      logger.warn({ sessionId, kind: err.kind, reason: err.reason }, "terminal.resolve_failed");
      reply.status(502).send(failure(
        err.kind === "refused" ? "terminal_upstream_refused" : "terminal_upstream_unavailable",
        err.reason,
      ));
      return null;
    }
    throw err;
  }
}

/** The upstream shell URL: SaFE's webshell, with everything but the window size fixed here. */
export function buildWebshellUrl(safeApiUrl: string, target: ShellTarget, cols: number, rows: number): string {
  const base = safeApiUrl.replace(/\/+$/, "").replace(/^http/i, "ws");
  const query = new URLSearchParams({
    namespace: target.workspaceId,
    container: target.container,
    cmd: "sh",
    cols: String(cols),
    rows: String(rows),
  });
  return `${base}/api/v1/workloads/${encodeURIComponent(target.workloadId)}/pods/${encodeURIComponent(target.pod)}/webshell?${query.toString()}`;
}

/** Answer an upgrade request with a plain HTTP error and close the connection. */
function refuseUpgrade(socket: Duplex, status: number, body: Record<string, unknown>): void {
  const text = JSON.stringify(body);
  const phrase = ({ 400: "Bad Request", 401: "Unauthorized", 404: "Not Found", 429: "Too Many Requests", 502: "Bad Gateway", 503: "Service Unavailable" } as Record<number, string>)[status] ?? "Error";
  if (socket.writable) {
    socket.write(
      `HTTP/1.1 ${status} ${phrase}\r\n`
      + "Content-Type: application/json\r\n"
      + `Content-Length: ${Buffer.byteLength(text)}\r\n`
      + "Cache-Control: no-store\r\n"
      + "Connection: close\r\n\r\n"
      + text,
    );
  }
  socket.destroy();
}

async function handleUpgrade(
  wss: WebSocketServer,
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): Promise<void> {
  // An error on a socket nobody is listening to is an uncaught exception.
  socket.on("error", () => { /* the connection ending is handled where it matters */ });
  let url: URL;
  try {
    url = new URL(req.url ?? "", "http://localhost");
  } catch {
    return refuseUpgrade(socket, 400, failure("bad_request", "malformed request target"));
  }
  const match = WS_PATH_RE.exec(url.pathname);
  if (!match) return refuseUpgrade(socket, 404, failure("not_found", "no such WebSocket route"));
  let sessionId: string;
  try {
    sessionId = decodeURIComponent(match[1]);
  } catch {
    return refuseUpgrade(socket, 400, failure("bad_request", "malformed session id"));
  }
  const tickets = url.searchParams.getAll("ticket");
  if (tickets.length !== 1) {
    return refuseUpgrade(socket, 401, failure("invalid_ticket", "a ticket is required, and it is good for one connection"));
  }

  // An upgraded socket is not read until something reads it, so a browser that
  // gives up while the ticket is redeemed and the shell is reached would not be
  // noticed until the handshake was tried on a dead socket. Reading it (nothing a
  // conforming client sends before the handshake completes is lost) is what makes
  // its end show as `readable` turning false in time to be seen below.
  socket.resume();

  let grant;
  try {
    grant = await redeemTicket(tickets[0], sessionId);
  } catch (err) {
    logger.error({ sessionId, err: (err as Error)?.message }, "terminal.ticket_store_failed");
    return refuseUpgrade(socket, 503, failure("terminal_unavailable", "the ticket store is unavailable"));
  }
  if (!grant) {
    return refuseUpgrade(socket, 401, failure("invalid_ticket", "a ticket is required, and it is good for one connection"));
  }

  // The ticket vouches for who asked and for which session; whether that is
  // still the session's creator is asked again now, because the session may have
  // been deleted since the ticket was minted.
  let ownerRow: { user_id: string | null } | undefined;
  try {
    ownerRow = (await db.query(
      "SELECT user_id FROM claw_sessions WHERE session_id = $1 AND deleted_at IS NULL",
      [sessionId],
    )).rows[0] as { user_id: string | null } | undefined;
  } catch (err) {
    logger.error({ sessionId, err: (err as Error)?.message }, "terminal.session_read_failed");
    return refuseUpgrade(socket, 503, failure("terminal_unavailable", "the session store is unavailable"));
  }
  if (!ownerRow || !canAccessSession(ownerRow.user_id, grant.userId)) {
    return refuseUpgrade(socket, 404, { ok: false, error: "session not found" });
  }
  if (!terminalSettings.safeApiUrl) {
    return refuseUpgrade(socket, 503, failure("terminal_unavailable", "this deployment has no SaFE to open a shell through"));
  }

  terminalRegistry.setLimits({
    maxConnections: terminalSettings.maxConnections,
    maxPerUser: terminalSettings.maxConnectionsPerUser,
  });
  const slot = terminalRegistry.acquire(grant.userId);
  if (!slot.ok) {
    return refuseUpgrade(socket, slot.reason === "user_limit" ? 429 : 503, failure(
      slot.reason === "user_limit" ? "too_many_terminals" : "terminal_capacity",
      slot.reason === "user_limit"
        ? "too many terminals are open for this user; close one and try again"
        : "this server has reached its limit of open terminals; try again shortly",
    ));
  }

  let upstream;
  try {
    upstream = await connectUpstream(
      buildWebshellUrl(terminalSettings.safeApiUrl, grant.target, grant.cols, grant.rows),
      {
        headers: { Authorization: `Bearer ${grant.platformKey}` },
        timeoutMs: terminalSettings.upstreamConnectTimeoutMs,
        maxPayload: terminalSettings.upstreamMaxPayload,
      },
    );
  } catch (err) {
    slot.release();
    const e = err as UpstreamConnectError;
    logger.warn({ sessionId, kind: e.kind, status: e.status ?? null }, "terminal.upstream_failed");
    return refuseUpgrade(socket, 502, failure(
      e.kind === "refused" ? "terminal_upstream_refused" : "terminal_upstream_unavailable",
      e.reason,
    ));
  }
  if (socket.destroyed || !socket.readable || !socket.writable) {
    // The browser gave up while the shell was being reached. Its half of the
    // connection is closed here, or it stays open for as long as the process does.
    upstream.terminate();
    slot.release();
    socket.destroy();
    return;
  }

  let bridged = false;
  wss.handleUpgrade(req, socket, head, (client) => {
    bridged = true;
    const pair = bridge(client, upstream, {
      idleMs: terminalSettings.idleMs,
      pingMs: terminalSettings.pingMs,
      onEnd: (why) => {
        slot.release();
        logger.info({ sessionId, userId: grant.userId, why }, "terminal.closed");
      },
    });
    slot.lease.closeNow = (code, reason) => pair.close(code, reason, "shutdown");
    logger.info({ sessionId, userId: grant.userId }, "terminal.opened");
  });
  // `ws` completes the handshake synchronously, or refuses it and never calls
  // back (a socket that closed in the meantime, a server that is shutting down).
  // The shell and the place held for it must not outlive a handshake that did not happen.
  if (!bridged) {
    upstream.terminate();
    slot.release();
    socket.destroy();
  }
}

function dimension(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= MAX_DIMENSION ? v : null;
}

export async function registerTerminalRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>("/v1/sessions/:id/terminal", async (req, reply) => {
    // authz: creator-only, through requireOwnedSession (canAccessSession); 404 for anyone else.
    const caller = await requireOwnedSession(req, reply, req.params.id);
    if (!caller) return reply;
    const resolved = await resolveOrReply(caller, req.params.id, reply);
    if (!resolved) return reply;
    reply.header("Cache-Control", "no-store");
    if (resolved.state === "ready") {
      return { state: "ready", target: { pod: resolved.target.pod, container: resolved.target.container } };
    }
    return { state: resolved.state, message: resolved.message };
  });

  app.post<{ Params: { id: string }; Body: { cols?: unknown; rows?: unknown } | undefined }>(
    "/v1/sessions/:id/terminal/ticket",
    async (req, reply) => {
      // authz: creator-only, through requireOwnedSession (canAccessSession); 404 for anyone else.
      const caller = await requireOwnedSession(req, reply, req.params.id);
      if (!caller) return reply;
      const cols = dimension(req.body?.cols);
      const rows = dimension(req.body?.rows);
      if (cols === null || rows === null) {
        return reply.status(400).send(failure(
          "invalid_request",
          `cols and rows must be integers from 1 to ${MAX_DIMENSION}`,
        ));
      }
      const resolved = await resolveOrReply(caller, req.params.id, reply);
      if (!resolved) return reply;
      if (resolved.state !== "ready") {
        return reply.status(409).send(failure("terminal_not_ready", resolved.message, { state: resolved.state }));
      }
      let ticket: string;
      try {
        ticket = await mintTicket({
          userId: caller.userId,
          sessionId: req.params.id,
          target: resolved.target,
          cols,
          rows,
          platformKey: caller.platformKey,
        });
      } catch (err) {
        if (err instanceof TooManyTicketsError) {
          return reply.status(429).send(failure("too_many_tickets", "too many terminal tickets are outstanding; use or wait out the last"));
        }
        throw err;
      }
      reply.header("Cache-Control", "no-store");
      return {
        ticket,
        expiresInSeconds: TICKET_TTL_SECONDS,
        // Relative to the API's /v1 root, which is what the browser's API client
        // already prefixes its requests with; the scheme and host are the page's.
        wsPath: `/sessions/${encodeURIComponent(req.params.id)}/terminal/ws?ticket=${ticket}`,
      };
    },
  );

  const wss = new WebSocketServer({ noServer: true, maxPayload: terminalSettings.clientMaxPayload, perMessageDeflate: false });
  const server: Server = app.server;
  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    handleUpgrade(wss, req, socket, head).catch((err) => {
      logger.error({ err: (err as Error)?.message }, "terminal.upgrade_failed");
      refuseUpgrade(socket, 503, failure("terminal_unavailable", "the terminal could not be opened"));
    });
  };
  server.on("upgrade", onUpgrade);
  // preClose, not onClose: Fastify's own close hook waits for every connection to
  // end before the next hook runs, and an open terminal never ends by itself.
  app.addHook("preClose", async () => {
    server.off("upgrade", onUpgrade);
    terminalRegistry.closeAll(CLOSE_SHUTDOWN, "server shutting down");
    wss.close();
  });
}
