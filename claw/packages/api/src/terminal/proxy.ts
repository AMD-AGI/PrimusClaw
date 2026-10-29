// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT

/**
 * The terminal's WebSocket proxy: the browser's socket on one side, SaFE's
 * webshell socket on the other, and nothing in between but the bookkeeping.
 *
 * Frames are passed through as they came, text as text and binary as binary,
 * because the two ends already speak a protocol -- keystrokes and `RESIZE <cols>
 * <rows>` going in, terminal output coming back -- and a proxy that reinterpreted
 * it would be a third thing to keep in step with both.
 *
 * Three things are the proxy's own:
 *   - It ends together. Either side closing closes the other, with the same code
 *     where one can be sent, and a side that does not answer the close is cut off.
 *   - It is bounded. A terminal the browser has sent nothing to for `idleMs` is
 *     closed, and none outlives `maxLifetimeMs` however busy it is; the number
 *     open is capped in total and per user (see {@link TerminalRegistry}).
 *   - It does not buffer without limit. Output faster than the browser reads
 *     pauses the upstream until the browser has caught up.
 */
import { WebSocket } from "ws";

/** Closed because the browser sent nothing for the idle timeout. */
export const CLOSE_IDLE = 4408;
/** Closed because it had been open for the longest a terminal may be. */
export const CLOSE_MAX_LIFETIME = 4409;
/** Closed because this process is shutting down. */
export const CLOSE_SHUTDOWN = 1001;
/** Closed because the other side's connection failed. */
export const CLOSE_UPSTREAM_FAILED = 1011;

/** How far behind a side may fall before the other is paused, and how near it must come back to resume. */
export const DEFAULT_HIGH_WATER_BYTES = 4 * 1024 * 1024;
export const DEFAULT_LOW_WATER_BYTES = 1 * 1024 * 1024;
const DRAIN_POLL_MS = 25;
/** How long a side may take to answer our close before its socket is cut. */
export const DEFAULT_CLOSE_GRACE_MS = 5_000;

export type RawData = Buffer | ArrayBuffer | Buffer[];

/** A close code that may be put on the wire (RFC 6455 section 7.4). */
function sendableCode(code: number): boolean {
  return (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999);
}

/**
 * The code to give the other side for a close that arrived with `code`.
 *
 * 1005 (no status) and 1006 (abnormal) are reports of what was seen, never codes
 * a peer sends, so they cannot be passed on: a peer that vanished is reported as
 * a failure of the connection, and one that simply closed as a normal close.
 */
export function relayCode(code: number): number {
  if (code === 1005) return 1000;
  return sendableCode(code) ? code : CLOSE_UPSTREAM_FAILED;
}

/** A close reason that fits the 123 bytes a close frame has room for. */
export function relayReason(reason: Buffer | string): string {
  const text = (typeof reason === "string" ? reason : reason.toString("utf8"))
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, " ");
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= 123) return text;
  // Cut on a character boundary rather than through the middle of one.
  let end = 123;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

/** Why connecting to the upstream shell did not work. */
export class UpstreamConnectError extends Error {
  constructor(
    public readonly kind: "unreachable" | "refused" | "timeout",
    public readonly reason: string,
    public readonly status?: number,
  ) {
    super(reason);
    this.name = "UpstreamConnectError";
  }
}

export interface ConnectOptions {
  headers: Record<string, string>;
  timeoutMs: number;
  maxPayload: number;
}

/**
 * Open the upstream socket, resolving once the handshake is complete.
 *
 * Nothing is told to the browser until this has: a shell that cannot be reached
 * is an HTTP error on the upgrade request rather than a socket that opens and
 * closes, and no browser input can arrive for an upstream that is not there yet.
 */
export function connectUpstream(url: string, opts: ConnectOptions): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, {
      headers: opts.headers,
      handshakeTimeout: opts.timeoutMs,
      maxPayload: opts.maxPayload,
      perMessageDeflate: false,
      followRedirects: false,
    });
    let settled = false;
    const fail = (err: UpstreamConnectError) => {
      if (settled) return;
      settled = true;
      ws.removeAllListeners();
      // A socket that never opened has nothing to close; this just frees it.
      ws.on("error", () => {});
      ws.terminate();
      reject(err);
    };
    ws.once("open", () => {
      if (settled) return;
      settled = true;
      ws.removeAllListeners("error");
      ws.removeAllListeners("unexpected-response");
      resolve(ws);
    });
    ws.once("unexpected-response", (_req, res) => {
      res.resume();
      fail(new UpstreamConnectError("refused", `the shell answered HTTP ${res.statusCode ?? 0}`, res.statusCode));
    });
    ws.once("error", (err: Error) => {
      const timedOut = /timed out|timeout/i.test(err.message);
      fail(new UpstreamConnectError(timedOut ? "timeout" : "unreachable",
        timedOut ? "the shell did not answer in time" : "cannot reach the shell"));
    });
  });
}

export interface BridgeOptions {
  /** Close after this long with no frame from the browser. The shell's output does not count. */
  idleMs: number;
  /** Close this long after opening, whatever has been going on. */
  maxLifetimeMs: number;
  pingMs: number;
  highWaterBytes?: number;
  lowWaterBytes?: number;
  closeGraceMs?: number;
  /** Called once, when the pair has ended, whichever way it did. */
  onEnd?: (why: string) => void;
}

export interface Bridge {
  /** Close both sides now. Safe to call more than once. */
  close(code: number, reason: string, why: string): void;
}

/**
 * Send one frame on, and stop reading `from` while `to` is far enough behind
 * that what it has not yet written would otherwise pile up in memory.
 */
function forward(
  from: WebSocket, to: WebSocket, data: RawData, isBinary: boolean, high: number, low: number,
): void {
  if (to.readyState !== WebSocket.OPEN) return;
  to.send(data, { binary: isBinary }, () => { /* a failed send ends in the socket's own close */ });
  if (to.bufferedAmount <= high) return;
  from.pause();
  const poll = setInterval(() => {
    if (to.readyState !== WebSocket.OPEN || from.readyState !== WebSocket.OPEN) {
      clearInterval(poll);
      return;
    }
    if (to.bufferedAmount < low) {
      clearInterval(poll);
      from.resume();
    }
  }, DRAIN_POLL_MS);
  poll.unref();
}

/** Join the two sockets. Both must already be open. */
export function bridge(client: WebSocket, upstream: WebSocket, opts: BridgeOptions): Bridge {
  let ended = false;
  let clientAlive = true;
  const closeGraceMs = opts.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS;

  // Only what the browser sends is a sign that someone is there. The shell's own
  // output is not: a forgotten tab on `tail -f`, `top` or `watch` produces it
  // forever, and would keep the idle timer from ever running out.
  const idle = setTimeout(
    () => end(CLOSE_IDLE, "idle timeout", "idle"),
    opts.idleMs,
  );
  const touch = () => { idle.refresh(); };

  // And a bound that does not depend on anyone being idle: the shell holds the
  // user's SaFE key for as long as it is open, and the key may be revoked, or the
  // session deleted, in the meantime. Nothing here is told of either.
  const lifetime = setTimeout(
    () => end(CLOSE_MAX_LIFETIME, "maximum lifetime reached", "max_lifetime"),
    opts.maxLifetimeMs,
  );

  // The browser's liveness: a ping each interval, and a socket that has not
  // answered the last one is gone and is cut rather than waited for. The
  // upstream pings us on its own and `ws` answers, so that side needs nothing.
  const heartbeat = setInterval(() => {
    if (!clientAlive) {
      end(CLOSE_UPSTREAM_FAILED, "client stopped answering", "client_unresponsive");
      return;
    }
    clientAlive = false;
    if (client.readyState === WebSocket.OPEN) client.ping();
  }, opts.pingMs);
  client.on("pong", () => { clientAlive = true; });

  function closeSide(ws: WebSocket, code: number, reason: string): void {
    if (ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) return;
    try {
      ws.close(code, reason);
    } catch {
      ws.terminate();
      return;
    }
    // A peer that does not complete the handshake is not waited for.
    const cut = setTimeout(() => { if (ws.readyState !== WebSocket.CLOSED) ws.terminate(); }, closeGraceMs);
    cut.unref();
    ws.once("close", () => clearTimeout(cut));
  }

  function end(code: number, reason: string, why: string): void {
    if (ended) return;
    ended = true;
    clearTimeout(idle);
    clearTimeout(lifetime);
    clearInterval(heartbeat);
    const safeReason = relayReason(reason);
    closeSide(client, code, safeReason);
    closeSide(upstream, code, safeReason);
    opts.onEnd?.(why);
  }

  const high = opts.highWaterBytes ?? DEFAULT_HIGH_WATER_BYTES;
  const low = opts.lowWaterBytes ?? DEFAULT_LOW_WATER_BYTES;
  client.on("message", (data: RawData, isBinary: boolean) => { touch(); forward(client, upstream, data, isBinary, high, low); });
  upstream.on("message", (data: RawData, isBinary: boolean) => { forward(upstream, client, data, isBinary, high, low); });

  client.on("close", (code: number, reason: Buffer) => end(relayCode(code), relayReason(reason), "client_closed"));
  upstream.on("close", (code: number, reason: Buffer) => {
    // An abnormal close carries no reason of its own; the browser is told what happened.
    const said = relayReason(reason);
    end(relayCode(code), said || (code === 1006 ? "shell connection lost" : ""), "upstream_closed");
  });
  client.on("error", () => end(CLOSE_UPSTREAM_FAILED, "client connection failed", "client_error"));
  upstream.on("error", () => end(CLOSE_UPSTREAM_FAILED, "shell connection failed", "upstream_error"));

  return { close: end };
}

/** A terminal this process has open, as the registry knows it. */
interface Lease {
  userId: string;
  closeNow?: (code: number, reason: string) => void;
}

/**
 * The terminals open on this replica, for the limits and for shutdown.
 *
 * In memory and per replica on purpose: what is being bounded is this process's
 * sockets and memory, and a limit that is a little loose across replicas still
 * bounds them.
 */
export class TerminalRegistry {
  private readonly leases = new Set<Lease>();
  private readonly perUser = new Map<string, number>();

  constructor(private limits: { maxConnections: number; maxPerUser: number }) {}

  setLimits(limits: { maxConnections: number; maxPerUser: number }): void {
    this.limits = limits;
  }

  get size(): number {
    return this.leases.size;
  }

  /** A place for one more terminal, or why there is none. */
  acquire(userId: string): { ok: true; lease: Lease; release: () => void } | { ok: false; reason: "server_full" | "user_limit" } {
    if (this.leases.size >= this.limits.maxConnections) return { ok: false, reason: "server_full" };
    if ((this.perUser.get(userId) ?? 0) >= this.limits.maxPerUser) return { ok: false, reason: "user_limit" };
    const lease: Lease = { userId };
    this.leases.add(lease);
    this.perUser.set(userId, (this.perUser.get(userId) ?? 0) + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.leases.delete(lease);
      const left = (this.perUser.get(userId) ?? 1) - 1;
      if (left <= 0) this.perUser.delete(userId); else this.perUser.set(userId, left);
    };
    return { ok: true, lease, release };
  }

  /** Close every open terminal. */
  closeAll(code: number, reason: string): void {
    for (const lease of [...this.leases]) lease.closeNow?.(code, reason);
  }
}
